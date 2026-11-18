import { assert, decrypt } from "./core";
import type { Env, Grant, Identity, VPS } from "./types";

export interface VergeNode {
  name: string;
  type: string;
  server: string;
  port: number;
  uuid: string;
  flow?: string;
  tls?: boolean;
  servername?: string;
  "client-fingerprint"?: string;
  "reality-opts"?: {
    "public-key": string;
    "short-id": string;
  };
  network?: string;
  udp?: boolean;
  [key: string]: unknown;
}

export function vergeScript(nodes: Record<string, unknown>[]) {
  const serialized = JSON.stringify(nodes)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `// Sensitive: contains one identity's credentials. Do not share.\nfunction main(config) {\n  const nodes = ${serialized};\n  const owner = 'proxysetting:v1';\n  const groupName = '自建节点';\n  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('proxysetting: config must be an object');\n  if (config.proxies !== undefined && !Array.isArray(config.proxies)) throw new Error('proxysetting: proxies must be an array');\n  if (config['proxy-groups'] !== undefined && !Array.isArray(config['proxy-groups'])) throw new Error('proxysetting: proxy-groups must be an array');\n  const proxies = config.proxies || [];\n  const groups = config['proxy-groups'] || [];\n  for (const node of nodes) {\n    if (groups.some(g => g.name === node.name)) throw new Error('proxysetting: node/group name conflict: ' + node.name);\n    const found = proxies.filter(p => p.name === node.name);\n    if (found.some(p => p['x-proxysetting-owner'] !== owner)) throw new Error('proxysetting: node name conflict: ' + node.name);\n  }\n  if (proxies.some(p => p.name === groupName)) throw new Error('proxysetting: group/proxy name conflict: ' + groupName);\n  const found = groups.filter(g => g.name === groupName);\n  if (found.some(g => g['x-proxysetting-owner'] !== owner || g.type !== 'select')) throw new Error('proxysetting: group name conflict: ' + groupName);\n  const result = { ...config };\n  // Only our explicitly marked entries are replaced; user entries are never overwritten.\n  result.proxies = proxies.filter(p => p['x-proxysetting-owner'] !== owner).concat(nodes.map(n => ({ ...n, 'x-proxysetting-owner': owner })));\n  result['proxy-groups'] = groups.filter(g => g.name !== groupName).map(g => {\n    if (g.type !== 'select') return g;\n    if (g.proxies !== undefined && !Array.isArray(g.proxies)) throw new Error('proxysetting: invalid select proxies: ' + g.name);\n    let included = false;\n    const members = (g.proxies || []).filter(n => { if (n !== groupName) return true; if (included) return false; included = true; return true; });\n    if (!included) members.push(groupName);\n    return { ...g, proxies: members };\n  }).concat([{ name: groupName, type: 'select', proxies: nodes.map(n => n.name), 'x-proxysetting-owner': owner }]);\n  return result;\n}\n`;
}

function dumpNodeYaml(node: VergeNode): string {
  const lines: string[] = [
    `  - name: ${JSON.stringify(node.name)}`,
    `    type: ${node.type || "vless"}`,
    `    server: ${JSON.stringify(node.server)}`,
    `    port: ${node.port}`,
    `    uuid: ${JSON.stringify(node.uuid)}`,
  ];
  if (node.flow) {
    lines.push(`    flow: ${node.flow}`);
  }
  if (node.tls !== undefined) {
    lines.push(`    tls: ${node.tls}`);
  }
  if (node.servername) {
    lines.push(`    servername: ${JSON.stringify(node.servername)}`);
  }
  if (node["client-fingerprint"]) {
    lines.push(`    client-fingerprint: ${node["client-fingerprint"]}`);
  }
  if (node["reality-opts"]) {
    lines.push(`    reality-opts:`);
    lines.push(`      public-key: ${JSON.stringify(node["reality-opts"]["public-key"])}`);
    lines.push(`      short-id: ${JSON.stringify(node["reality-opts"]["short-id"])}`);
  }
  if (node.network) {
    lines.push(`    network: ${node.network}`);
  }
  if (node.udp !== undefined) {
    lines.push(`    udp: ${node.udp}`);
  }
  return lines.join("\n");
}

export const DEFAULT_CLASH_TEMPLATE = `# Clash Verge Rev / Mihomo 本地完整配置
# 分流：局域网/本机直连、国内域名直连、中国 IP 直连，其余走“代理选择”。
# 规则集由本面板自托管（{{RULES_BASE}}/rules/），不再依赖 jsdelivr。
# 规则优先顺序：直连优先项 → 广告拦截 → 代理域名 → 直连域名 → 中国/Telegram IP。
# 广告域名使用 REJECT（立即拒绝），避免像直连那样等待超时；如需放行广告，
# 可把 RULE-SET,reject,REJECT 改成 DIRECT，或删除该条规则。
# 当前不包含节点；未添加节点时“代理选择”只有 DIRECT，所有流量实际直连。
# 不会自动复用另一个订阅配置里的节点。
# 使用方法：保存为 .yaml，导入本地配置并启用，打开系统代理，模式选“规则”。
# 加入节点有两种方式：
# 1. 系统导出时已自动将你的专属节点注入到下方 proxies 中。
# 2. 或在下方配置中添加更多自定义 proxy-providers。
# 添加节点后，在“代理选择”中选择一个真实节点；DIRECT 表示直连。
# Clash Verge 的端口、DNS 等设置可能覆写本文件对应设置。

mixed-port: 7890
allow-lan: false
bind-address: 127.0.0.1
mode: rule
log-level: info
unified-delay: true
tcp-concurrent: true
ipv6: false

profile:
  store-selected: true

dns:
  enable: true
  ipv6: false
  enhanced-mode: redir-host
  respect-rules: true
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  nameserver:
    - https://doh.pub/dns-query
    - https://dns.alidns.com/dns-query
  proxy-server-nameserver:
    - https://doh.pub/dns-query
    - https://dns.alidns.com/dns-query

# TUN/浏览器自带 DoH 时连接可能只剩 IP；从 TLS/HTTP/QUIC 首包恢复域名，
# 让域名规则继续生效，避免被 GEOIP 误分到直连。
sniffer:
  enable: true
  force-dns-mapping: true
  parse-pure-ip: true
  override-destination: false
  sniff:
    HTTP:
      ports: [80, 8080-8880]
    TLS:
      ports: [443, 8443]
    QUIC:
      ports: [443, 8443]
  skip-domain:
    - "Mijia Cloud"
    - "+.push.apple.com"

proxies:
{{PROXIES}}

proxy-groups:
  - name: PROXY
    type: select
    include-all: false
    proxies:
{{PROXY_NAMES}}
      - DIRECT
      - REJECT

rule-providers:
  direct-priority:
    type: http
    behavior: domain
    format: mrs
    url: "{{RULES_BASE}}/rules/direct-priority.mrs"
    path: ./ruleset/direct-priority.mrs
    interval: 86400
    proxy: DIRECT

  reject:
    type: http
    behavior: domain
    format: mrs
    url: "{{RULES_BASE}}/rules/reject.mrs"
    path: ./ruleset/reject.mrs
    interval: 86400
    proxy: DIRECT

  proxy:
    type: http
    behavior: domain
    format: mrs
    url: "{{RULES_BASE}}/rules/proxy.mrs"
    path: ./ruleset/proxy.mrs
    interval: 86400
    proxy: DIRECT

  direct:
    type: http
    behavior: domain
    format: mrs
    url: "{{RULES_BASE}}/rules/direct.mrs"
    path: ./ruleset/direct.mrs
    interval: 86400
    proxy: DIRECT

  cn-ip:
    type: http
    behavior: ipcidr
    format: mrs
    url: "{{RULES_BASE}}/rules/cn-ip.mrs"
    path: ./ruleset/cn-ip.mrs
    interval: 86400
    proxy: DIRECT

  telegram-ip:
    type: http
    behavior: ipcidr
    format: mrs
    url: "{{RULES_BASE}}/rules/telegram-ip.mrs"
    path: ./ruleset/telegram-ip.mrs
    interval: 86400
    proxy: DIRECT

  applications:
    type: http
    behavior: classical
    url: "{{RULES_BASE}}/rules/applications.yaml"
    path: ./ruleset/applications.yaml
    interval: 86400
    proxy: DIRECT

rules:
  - RULE-SET,applications,DIRECT
  - DOMAIN,clash.razord.top,DIRECT
  - DOMAIN,yacd.haishan.me,DIRECT
  - DOMAIN,jiannlee22panel.ccwu.cc,DIRECT
  - DOMAIN-SUFFIX,local,DIRECT
  - DOMAIN-SUFFIX,lan,DIRECT
  - DOMAIN-SUFFIX,ntp.org,DIRECT
  - DOMAIN-SUFFIX,ntp.aliyun.com,DIRECT
  - DOMAIN-SUFFIX,ntp.tencent.com,DIRECT
  - DOMAIN-SUFFIX,time.apple.com,DIRECT
  - DOMAIN-SUFFIX,time.windows.com,DIRECT
  - DOMAIN-SUFFIX,time.cloudflare.com,DIRECT
  - RULE-SET,direct-priority,DIRECT
  - RULE-SET,reject,REJECT
  - RULE-SET,proxy,PROXY
  - RULE-SET,direct,DIRECT
  - RULE-SET,cn-ip,DIRECT
  - RULE-SET,telegram-ip,PROXY
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
`;

export function renderClashConfig(template: string, nodes: VergeNode[]): string {
  let result = template;
  const nodesDump = nodes.map(dumpNodeYaml).join("\n");
  const nodesNames = nodes.map((n) => `      - ${JSON.stringify(n.name)}`).join("\n");

  // 1. Inject proxies: match only non-comment lines containing {{PROXIES}}
  const proxiesBlockRegex = /^[ \t]*proxies:[ \t]*\r?\n[ \t]*\{\{PROXIES\}\}[ \t]*$/m;
  const standaloneProxiesRegex = /^[ \t]*(?!#)[^#\r\n]*?\{\{PROXIES\}\}[ \t]*$/m;

  if (proxiesBlockRegex.test(result)) {
    result = result.replace(proxiesBlockRegex, () =>
      nodes.length > 0 ? `proxies:\n${nodesDump}` : "proxies: []",
    );
  } else if (standaloneProxiesRegex.test(result)) {
    result = result.replace(standaloneProxiesRegex, () =>
      nodes.length > 0 ? nodesDump : "  []",
    );
  } else if (/^[ \t]*proxies:[ \t]*\[\]/m.test(result)) {
    if (nodes.length > 0) {
      result = result.replace(/^[ \t]*proxies:[ \t]*\[\]/m, () => `proxies:\n${nodesDump}`);
    }
  } else if (/^[ \t]*proxies:[ \t]*$/m.test(result)) {
    if (nodes.length > 0) {
      result = result.replace(/^[ \t]*proxies:[ \t]*$/m, () => `proxies:\n${nodesDump}`);
    }
  } else if (nodes.length > 0) {
    result = `proxies:\n${nodesDump}\n\n` + result;
  }

  // 2. Inject proxy names into groups: match only non-comment lines containing {{PROXY_NAMES}}
  let proxyNamesReplaced = false;

  // Case A: {{PROXY_NAMES}} on its own line (with trailing newline or end of string)
  const proxyNamesLineRegex = /^[ \t]*(?!#)[ \t]*\{\{PROXY_NAMES\}\}[ \t]*(\r?\n|$)/gm;
  if (proxyNamesLineRegex.test(result)) {
    result = result.replace(proxyNamesLineRegex, () => {
      proxyNamesReplaced = true;
      return nodes.length > 0 ? `${nodesNames}\n` : "";
    });
  }

  // Case B: Inline {{PROXY_NAMES}} on a non-comment line (e.g. `{{PROXY_NAMES}}      - DIRECT`)
  const proxyNamesInlineRegex = /^((?!#)[^\r\n]*?)\{\{PROXY_NAMES\}\}/gm;
  if (proxyNamesInlineRegex.test(result)) {
    result = result.replace(proxyNamesInlineRegex, (_match, prefix) => {
      proxyNamesReplaced = true;
      return `${prefix}${nodes.length > 0 ? `${nodesNames}\n` : ""}`;
    });
  }

  // Fallback: If no {{PROXY_NAMES}} was replaced, inject into PROXY or first group
  if (!proxyNamesReplaced && nodes.length > 0) {
    const proxyGroupMatch = /(- name:\s*['"]?PROXY['"]?[\s\S]*?proxies:\s*\n)/i.exec(result);
    if (proxyGroupMatch) {
      result = result.replace(proxyGroupMatch[1], () => `${proxyGroupMatch[1]}${nodesNames}\n`);
    } else {
      const genericGroupMatch = /(proxy-groups:[\s\S]*?proxies:\s*\n)/i.exec(result);
      if (genericGroupMatch) {
        result = result.replace(genericGroupMatch[1], () => `${genericGroupMatch[1]}${nodesNames}\n`);
      }
    }
  }

  return result;
}

export const DEFAULT_RULES_BASE = "https://jiannlee22panel.ccwu.cc";

// Rule providers are served by this Worker under /rules/. The subscription
// origin is used when available so the workers.dev fallback and local dev
// keep working without editing the stored template.
export function clashConfig(
  nodes: VergeNode[],
  template?: string,
  rulesBase?: string,
): string {
  const rendered = renderClashConfig(template || DEFAULT_CLASH_TEMPLATE, nodes);
  const base = (rulesBase || DEFAULT_RULES_BASE).replace(/\/+$/, "");
  return rendered.replaceAll("{{RULES_BASE}}", base);
}

export async function getIdentityNodes(env: Env, identityId: string): Promise<VergeNode[]> {
  const i = await env.DB.prepare(
    "SELECT * FROM identities WHERE id=? AND enabled=1",
  )
    .bind(identityId)
    .first<Identity>();
  assert(i, "Active identity not found", 404);
  const all = await env.DB.prepare(
    "SELECT * FROM vps WHERE status != 'deleted' ORDER BY id",
  ).all<VPS>();
  assert(all.results.length, "No VPS available", 409);
  const grants = await env.DB.prepare(
    "SELECT * FROM grants WHERE identity_id=?",
  )
    .bind(identityId)
    .all<Grant>();
  const nodes: VergeNode[] = [];
  const invalidReasons: string[] = [];
  for (const v of all.results) {
    if (
      (v.status !== "ready" && v.status !== "syncing") ||
      v.revoked ||
      !v.public_key ||
      !v.short_id ||
      !v.address ||
      !v.server_name
    ) {
      invalidReasons.push(
        `VPS ${v.id} is not ready or missing Reality parameters`,
      );
      continue;
    }
    const g = grants.results.find((x) => x.vps_id === v.id);
    if (!g || !g.quota_bytes || g.quota_bytes <= 0 || !g.uuid_cipher) {
      invalidReasons.push(`Monthly quota missing on VPS ${v.id}`);
      continue;
    }
    try {
      const uuid = await decrypt(env, g.uuid_cipher, `${v.id}:${identityId}`);
      nodes.push({
        name: v.name,
        type: "vless",
        server: v.address,
        port: v.port,
        uuid,
        flow: "xtls-rprx-vision",
        tls: true,
        servername: v.server_name,
        "client-fingerprint": "chrome",
        "reality-opts": { "public-key": v.public_key, "short-id": v.short_id },
        network: "tcp",
        udp: true,
      });
    } catch {
      invalidReasons.push(`Credential decryption failed on VPS ${v.id}`);
      continue;
    }
  }
  assert(
    nodes.length > 0,
    invalidReasons[0] || "No ready VPS available",
    409,
  );
  return nodes;
}

export async function getSubTemplate(env: Env): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key='sub_template'"
    ).first<{ value: string }>();
    return row?.value || null;
  } catch {
    return null;
  }
}

export async function setSubTemplate(env: Env, template: string | null): Promise<void> {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
  ).run();
  if (template === null) {
    await env.DB.prepare("DELETE FROM settings WHERE key='sub_template'").run();
  } else {
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('sub_template', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    ).bind(template).run();
  }
}

export async function exportVerge(env: Env, identityId: string) {
  const nodes = await getIdentityNodes(env, identityId);
  return vergeScript(nodes);
}

export async function exportClash(
  env: Env,
  identityId: string,
  rulesBase?: string,
) {
  const nodes = await getIdentityNodes(env, identityId);
  const custom = await getSubTemplate(env);
  return clashConfig(nodes, custom || undefined, rulesBase);
}
