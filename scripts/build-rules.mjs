#!/usr/bin/env node
// Build self-hosted Mihomo rule sets from Loyalsoldier/clash-rules.
//
// Output goes to src/web/public/rules and is committed to the repository so
// deployments are reproducible and do not depend on a third-party CDN at
// runtime. Re-run this script only when intentionally updating the upstream
// snapshot:
//
//   MIHOMO_BIN=/run/current-system/sw/bin/verge-mihomo node scripts/build-rules.mjs
//
// The generated .mrs files are only understood by Mihomo/Clash Verge Rev
// (the same client family this project already targets for VLESS Reality).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "src/web/public/rules");
const TMP_OUT = path.join(ROOT, "src/web/public/.rules-tmp");

// Pinned upstream snapshot: Loyalsoldier/clash-rules release branch.
// Never point this at a moving branch; regenerate and review the diff instead.
const SOURCE_REPO = "Loyalsoldier/clash-rules";
const SOURCE_COMMIT = "430d8ba3689e1c5e968c4625630f32dac2c77cef";
const SOURCE_DATE = "2026-10-28T22:35:53Z";
const SOURCE_BASES = [
  `https://cdn.jsdelivr.net/gh/${SOURCE_REPO}@${SOURCE_COMMIT}`,
  `https://raw.githubusercontent.com/${SOURCE_REPO}/${SOURCE_COMMIT}`,
];

const UPSTREAM = {
  reject: "reject.txt",
  icloud: "icloud.txt",
  apple: "apple.txt",
  google: "google.txt",
  proxy: "proxy.txt",
  direct: "direct.txt",
  private: "private.txt",
  cncidr: "cncidr.txt",
  lancidr: "lancidr.txt",
  telegramcidr: "telegramcidr.txt",
  applications: "applications.txt",
};

// gfw.txt and tld-not-cn.txt were declared by the old template but never
// referenced by any rule, so they are intentionally not downloaded anymore.

const MIN_ENTRIES = {
  "direct-priority": 50,
  reject: 100_000,
  proxy: 20_000,
  direct: 100_000,
  "cn-ip": 9_000,
  "telegram-ip": 5,
};

function findMihomo() {
  const candidates = [
    process.env.MIHOMO_BIN,
    "verge-mihomo",
    "mihomo",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-v"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    "Mihomo binary not found. Set MIHOMO_BIN to a verge-mihomo/mihomo binary " +
      "(for example /run/current-system/sw/bin/verge-mihomo) to regenerate .mrs files.",
  );
}

function mihomoVersion(bin) {
  try {
    const out = execFileSync(bin, ["-v"], { encoding: "utf8" });
    return out.trim().split("\n")[0] || "unknown";
  } catch {
    return "unknown";
  }
}

async function fetchText(name) {
  let lastError;
  for (const base of SOURCE_BASES) {
    const url = `${base}/${name}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { "user-agent": "proxysetting-rule-builder/1" },
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (!text.trim()) throw new Error("empty body");
        return text;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
      }
    }
  }
  throw new Error(
    `Fetch ${name} failed from ${SOURCE_BASES.length} mirrors: ` +
      (lastError?.message || String(lastError)),
  );
}

function parsePayload(text, file) {
  const lines = text.split(/\r?\n/);
  if (!lines.some((line) => line.trim() === "payload:")) {
    throw new Error(`${file} does not look like a Clash rule provider payload`);
  }
  const entries = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line === "payload:") continue;
    const match = /^-\s*'?([^']+?)'?$/.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    if (!value) continue;
    if (value.startsWith("+.")) value = value.slice(2);
    else if (value.startsWith("*.")) value = value.slice(2);
    else if (value.startsWith(".")) value = value.slice(1);
    value = value.replace(/\.$/, "").toLowerCase();
    if (value) entries.push(value);
  }
  return entries;
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort();
}

// Everything is normalized to Mihomo's "+." (domain + subdomains) form.
// Important: a bare entry in a Mihomo domain provider matches that exact host
// only, while the upstream lists were written for Clash Premium where a bare
// entry is treated as a suffix. Without this normalization "google.com" does
// not cover "www.google.com" and rules silently fall through to GEOIP/MATCH.
function coveredBy(domain, suffixSet) {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length; i++) {
    if (suffixSet.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

function dropSubdomains(domains) {
  const set = new Set(domains);
  const kept = [];
  for (const domain of set) {
    const labels = domain.split(".");
    let covered = false;
    for (let i = 1; i < labels.length; i++) {
      if (set.has(labels.slice(i).join("."))) {
        covered = true;
        break;
      }
    }
    if (!covered) kept.push(domain);
  }
  return kept.sort();
}

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

// Remove CIDRs fully covered by a shorter prefix already in the set.
function dropSubnets(cidrs) {
  const parsed = [];
  const byNetwork = new Map();
  const passthrough = [];
  for (const entry of cidrs) {
    const [ip, prefixText] = entry.split("/");
    const prefix = Number(prefixText);
    const network = ipv4ToInt(ip);
    if (!network || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      passthrough.push(entry);
      continue;
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const base = (network & mask) >>> 0;
    parsed.push({ entry, prefix, base });
    byNetwork.set(`${base}/${prefix}`, true);
  }
  const kept = [];
  for (const { entry, prefix, base } of parsed) {
    let covered = false;
    for (let shorter = 0; shorter < prefix; shorter++) {
      const mask = shorter === 0 ? 0 : (0xffffffff << (32 - shorter)) >>> 0;
      const parent = (base & mask) >>> 0;
      if (byNetwork.has(`${parent}/${shorter}`)) {
        covered = true;
        break;
      }
    }
    if (!covered) kept.push(entry);
  }
  const sorted = kept.sort((a, b) => {
    const [aip, ap] = a.split("/");
    const [bip, bp] = b.split("/");
    return (ipv4ToInt(aip) - ipv4ToInt(bip)) || (Number(ap) - Number(bp));
  });
  return passthrough.length
    ? sorted.concat(passthrough.sort())
    : sorted;
}

function toPayloadYaml(entries, behavior) {
  const prefix = behavior === "domain" ? "+." : "";
  return `payload:\n${entries.map((entry) => `  - '${prefix}${entry}'`).join("\n")}\n`;
}

async function writeProvider(bin, name, behavior, entries, tempDir, outputDir) {
  const yamlPath = path.join(tempDir, `${name}.yaml`);
  const target = path.join(outputDir, `${name}.mrs`);
  await writeFile(yamlPath, toPayloadYaml(entries, behavior));
  execFileSync(bin, ["convert-ruleset", behavior, "yaml", yamlPath, target], {
    stdio: "pipe",
    timeout: 120_000,
  });
  const stat = await readFile(target);
  if (stat.length === 0) throw new Error(`convert-ruleset produced an empty ${name}.mrs`);
  return { entries: entries.length, bytes: stat.length, sha256: sha256(stat) };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const bin = findMihomo();
  await mkdir(OUT, { recursive: true });

  const files = Object.fromEntries(
    await Promise.all(
      Object.entries(UPSTREAM).map(async ([key, file]) => [key, await fetchText(file)]),
    ),
  );

  const lists = {};
  for (const key of [
    "reject",
    "icloud",
    "apple",
    "google",
    "proxy",
    "direct",
    "private",
    "cncidr",
    "lancidr",
    "telegramcidr",
  ]) {
    lists[key] = parsePayload(files[key], UPSTREAM[key]);
    if (lists[key].length === 0) throw new Error(`${UPSTREAM[key]} contained no entries`);
  }

  // Rule order is: direct-priority, reject, proxy, direct, cn-ip, telegram-ip.
  // Remove entries that are shadowed by an earlier policy (a child suffix is
  // covered when any parent suffix exists in an earlier set) so each file only
  // contains domains that can actually decide a connection.
  const priority = dropSubdomains(uniqueSorted([...lists.private, ...lists.icloud]));
  const prioritySet = new Set(priority);
  const reject = dropSubdomains(
    uniqueSorted(lists.reject).filter((domain) => !coveredBy(domain, prioritySet)),
  );
  const rejectSet = new Set(reject);
  const proxy = dropSubdomains(
    uniqueSorted([...lists.google, ...lists.proxy, ...lists.apple]).filter(
      (domain) => !coveredBy(domain, prioritySet) && !coveredBy(domain, rejectSet),
    ),
  );
  const proxySet = new Set(proxy);
  const direct = dropSubdomains(
    uniqueSorted(lists.direct).filter(
      (domain) =>
        !coveredBy(domain, prioritySet) &&
        !coveredBy(domain, rejectSet) &&
        !coveredBy(domain, proxySet),
    ),
  );

  const cnIp = dropSubnets(uniqueSorted([...lists.cncidr, ...lists.lancidr]));
  const telegramIp = uniqueSorted(lists.telegramcidr);

  const outputSets = {
    "direct-priority": priority,
    reject,
    proxy,
    direct,
    "cn-ip": cnIp,
    "telegram-ip": telegramIp,
  };

  for (const [name, minimum] of Object.entries(MIN_ENTRIES)) {
    if (outputSets[name].length < minimum) {
      throw new Error(
        `${name} has only ${outputSets[name].length} entries (expected at least ${minimum}); refusing to publish a truncated rule set`,
      );
    }
  }

  // Build into a staging directory: a failed download/conversion must never
  // leave a partially written rule set that a deploy could pick up.
  await rm(TMP_OUT, { recursive: true, force: true });
  await mkdir(TMP_OUT, { recursive: true });

  const tempDir = await mkdtemp(path.join(tmpdir(), "proxysetting-rules-"));

  const manifestFiles = {};
  const behaviors = {
    "direct-priority": "domain",
    reject: "domain",
    proxy: "domain",
    direct: "domain",
    "cn-ip": "ipcidr",
    "telegram-ip": "ipcidr",
  };
  for (const [name, behavior] of Object.entries(behaviors)) {
    const info = await writeProvider(bin, name, behavior, outputSets[name], tempDir, TMP_OUT);
    manifestFiles[`${name}.mrs`] = { behavior, ...info };
    console.log(
      `${name.padEnd(16)} ${String(info.entries).padStart(7)} entries  ${(info.bytes / 1024).toFixed(0).padStart(6)} KiB`,
    );
  }

  // Classical providers (PROCESS-NAME etc.) are not supported by the MRS
  // converter; keep the original small YAML payload verbatim.
  const applications = files.applications.trimEnd() + "\n";
  await writeFile(path.join(TMP_OUT, "applications.yaml"), applications);
  const appEntries = parsePayload(applications, UPSTREAM.applications).length;
  manifestFiles["applications.yaml"] = {
    behavior: "classical",
    entries: appEntries,
    bytes: Buffer.byteLength(applications),
    sha256: sha256(Buffer.from(applications)),
  };
  console.log(
    `${"applications".padEnd(16)} ${String(appEntries).padStart(7)} entries  ${(Buffer.byteLength(applications) / 1024).toFixed(0).padStart(6)} KiB`,
  );

  const manifest = {
    schema: 1,
    source: {
      repo: SOURCE_REPO,
      commit: SOURCE_COMMIT,
      date: SOURCE_DATE,
    },
    generator: {
      mihomo: mihomoVersion(bin),
    },
    precedence: ["direct-priority", "reject", "proxy", "direct", "cn-ip", "telegram-ip"],
    files: manifestFiles,
  };
  await writeFile(
    path.join(TMP_OUT, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  await rm(OUT, { recursive: true, force: true });
  await rename(TMP_OUT, OUT);
  await rm(tempDir, { recursive: true, force: true });
  const total = Object.values(manifestFiles).reduce((sum, file) => sum + file.bytes, 0);
  console.log(`\nsource ${SOURCE_REPO}@${SOURCE_COMMIT}`);
  console.log(`total  ${(total / 1024 / 1024).toFixed(2)} MiB in ${OUT}`);
}

main().catch((error) => {
  console.error(`build-rules: ${error.message}`);
  process.exitCode = 1;
});
