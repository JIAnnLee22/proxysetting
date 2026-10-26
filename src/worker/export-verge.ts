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
# 分流：局域网直连、常见国内站点直连、中国 IP 直连、其余走“代理选择”。
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
ipv6: false

profile:
  store-selected: true

dns:
  enable: true
  ipv6: false
  enhanced-mode: redir-host
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  nameserver:
    - 223.5.5.5
    - 119.29.29.29
  fallback:
    - https://1.1.1.1/dns-query
    - https://dns.google/dns-query
  fallback-filter:
    geoip: true
    geoip-code: CN
    ipcidr:
      - 240.0.0.0/4

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
  reject:
    type: http
    behavior: domain
    url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/reject.txt"
    path: ./ruleset/reject.yaml
    interval: 86400

  icloud:
    type: http
    behavior: domain
    url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/icloud.txt"
    path: ./ruleset/icloud.yaml
    interval: 86400

  apple:
    type: http
    behavior: domain
    url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/apple.txt"
    path: ./ruleset/apple.yaml
    interval: 86400

  google:
    type: http
    behavior: domain
    url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/google.txt"
    path: ./ruleset/google.yaml
    interval: 86400

  proxy:
    type: http
    behavior: domain
    url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/proxy.txt"
    path: ./ruleset/proxy.yaml
    interval: 86400

  direct:
    type: http
    behavior: domain
    url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/direct.txt"
    path: ./ruleset/direct.yaml
    interval: 86400

  private:
    type: http
    behavior: domain
    url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/private.txt"
    path: ./ruleset/private.yaml
    interval: 86400

  gfw:
    type: http
    behavior: domain
    url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/gfw.txt"
    path: ./ruleset/gfw.yaml
    interval: 86400

  tld-not-cn:
    type: http
    behavior: domain
    url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/tld-not-cn.txt"
    path: ./ruleset/tld-not-cn.yaml
    interval: 86400

  telegramcidr:
    type: http
    behavior: ipcidr
    url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/telegramcidr.txt"
    path: ./ruleset/telegramcidr.yaml
    interval: 86400

  cncidr:
    type: http
    behavior: ipcidr
    url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/cncidr.txt"
    path: ./ruleset/cncidr.yaml
    interval: 86400

  lancidr:
    type: http
    behavior: ipcidr
    url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/lancidr.txt"
    path: ./ruleset/lancidr.yaml
    interval: 86400

  applications:
    type: http
    behavior: classical
    url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/applications.txt"
    path: ./ruleset/applications.yaml
    interval: 86400

rules:
  - RULE-SET,applications,DIRECT
  - DOMAIN,clash.razord.top,DIRECT
  - DOMAIN,yacd.haishan.me,DIRECT
  - RULE-SET,private,DIRECT
  - RULE-SET,reject,DIRECT
  - RULE-SET,icloud,DIRECT
  - RULE-SET,apple,DIRECT
  - RULE-SET,google,PROXY
  - RULE-SET,proxy,PROXY
  - RULE-SET,direct,DIRECT
  - RULE-SET,lancidr,DIRECT
  - RULE-SET,cncidr,DIRECT
  - RULE-SET,telegramcidr,PROXY
  - GEOIP,LAN,DIRECT
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

export function clashConfig(nodes: VergeNode[], template?: string): string {
  return renderClashConfig(template || DEFAULT_CLASH_TEMPLATE, nodes);
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

export async function exportClash(env: Env, identityId: string) {
  const nodes = await getIdentityNodes(env, identityId);
  const custom = await getSubTemplate(env);
  return clashConfig(nodes, custom || undefined);
}
