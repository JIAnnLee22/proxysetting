import { assert, decrypt } from "./core";
import type { Env, Grant, Identity, VPS } from "./types";
export function vergeScript(nodes: Record<string, unknown>[]) {
  const serialized = JSON.stringify(nodes)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `// Sensitive: contains one identity's credentials. Do not share.\nfunction main(config) {\n  const nodes = ${serialized};\n  const owner = 'proxysetting:v1';\n  const groupName = '自建节点';\n  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('proxysetting: config must be an object');\n  if (config.proxies !== undefined && !Array.isArray(config.proxies)) throw new Error('proxysetting: proxies must be an array');\n  if (config['proxy-groups'] !== undefined && !Array.isArray(config['proxy-groups'])) throw new Error('proxysetting: proxy-groups must be an array');\n  const proxies = config.proxies || [];\n  const groups = config['proxy-groups'] || [];\n  for (const node of nodes) {\n    if (groups.some(g => g.name === node.name)) throw new Error('proxysetting: node/group name conflict: ' + node.name);\n    const found = proxies.filter(p => p.name === node.name);\n    if (found.some(p => p['x-proxysetting-owner'] !== owner)) throw new Error('proxysetting: node name conflict: ' + node.name);\n  }\n  if (proxies.some(p => p.name === groupName)) throw new Error('proxysetting: group/proxy name conflict: ' + groupName);\n  const found = groups.filter(g => g.name === groupName);\n  if (found.some(g => g['x-proxysetting-owner'] !== owner || g.type !== 'select')) throw new Error('proxysetting: group name conflict: ' + groupName);\n  const result = { ...config };\n  // Only our explicitly marked entries are replaced; user entries are never overwritten.\n  result.proxies = proxies.filter(p => p['x-proxysetting-owner'] !== owner).concat(nodes.map(n => ({ ...n, 'x-proxysetting-owner': owner })));\n  result['proxy-groups'] = groups.filter(g => g.name !== groupName).map(g => {\n    if (g.type !== 'select') return g;\n    if (g.proxies !== undefined && !Array.isArray(g.proxies)) throw new Error('proxysetting: invalid select proxies: ' + g.name);\n    let included = false;\n    const members = (g.proxies || []).filter(n => { if (n !== groupName) return true; if (included) return false; included = true; return true; });\n    if (!included) members.push(groupName);\n    return { ...g, proxies: members };\n  }).concat([{ name: groupName, type: 'select', proxies: nodes.map(n => n.name), 'x-proxysetting-owner': owner }]);\n  return result;\n}\n`;
}
export async function exportVerge(env: Env, identityId: string) {
  const i = await env.DB.prepare(
    "SELECT * FROM identities WHERE id=? AND enabled=1",
  )
    .bind(identityId)
    .first<Identity>();
  assert(i, "Active identity not found", 404);
  const all = await env.DB.prepare("SELECT * FROM vps ORDER BY id").all<VPS>();
  assert(all.results.length, "No VPS available", 409);
  const grants = await env.DB.prepare(
    "SELECT * FROM grants WHERE identity_id=?",
  )
    .bind(identityId)
    .all<Grant>();
  const nodes = [];
  for (const v of all.results) {
    assert(
      (v.status === "ready" || v.status === "syncing") &&
        !v.revoked &&
        v.public_key &&
        v.short_id &&
        v.address &&
        v.server_name,
      `VPS ${v.id} is not ready or missing Reality parameters`,
      409,
    );
    const g = grants.results.find((x) => x.vps_id === v.id);
    assert(g && g.quota_bytes > 0, `Monthly quota missing on VPS ${v.id}`, 409);
    nodes.push({
      name: `VPS-${v.id}`,
      type: "vless",
      server: v.address,
      port: v.port,
      uuid: await decrypt(env, g.uuid_cipher, `${v.id}:${identityId}`),
      flow: "xtls-rprx-vision",
      tls: true,
      servername: v.server_name,
      "client-fingerprint": "chrome",
      "reality-opts": { "public-key": v.public_key, "short-id": v.short_id },
      network: "tcp",
      udp: true,
    });
  }
  return vergeScript(nodes);
}
