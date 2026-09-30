import { it, expect } from "vitest";
import { runInNewContext } from "node:vm";
import { vergeScript } from "../src/worker/export-verge";
const nodes = [
  { name: "VPS-id", type: "vless", uuid: "secret", server: "203.0.113.1" },
];
function run(config: unknown, n = nodes) {
  return runInNewContext(vergeScript(n) + "\nmain(config)", {
    config: structuredClone(config),
  });
}
it("injects into every select including nested-reference groups, retaining fields/order", () => {
  const c = {
    proxies: [{ name: "original", type: "direct" }],
    "proxy-groups": [
      {
        name: "outer",
        type: "select",
        proxies: ["inner", "DIRECT"],
        icon: "x",
      },
      { name: "inner", type: "select", proxies: ["original"] },
      { name: "auto", type: "url-test", proxies: ["original"] },
    ],
  };
  const r = run(c);
  expect(r["proxy-groups"][0]).toMatchObject({
    name: "outer",
    proxies: ["inner", "DIRECT", "自建节点"],
    icon: "x",
  });
  expect(r["proxy-groups"][1].proxies).toEqual(["original", "自建节点"]);
  expect(r["proxy-groups"][2].proxies).toEqual(["original"]);
  expect(r["proxy-groups"][3].proxies).toEqual(["VPS-id"]);
  expect(c.proxies).toHaveLength(1);
  expect(run(r)).toEqual(r);
});
it("works for empty configuration, no groups or no select", () => {
  expect(run({}).proxies).toHaveLength(1);
  expect(run({ proxies: [], "proxy-groups": [] })).toEqual(run({}));
  expect(
    run({ "proxy-groups": [{ name: "auto", type: "url-test", proxies: [] }] })[
      "proxy-groups"
    ],
  ).toHaveLength(2);
});
it("rejects user-owned node/group names instead of overwriting", () => {
  expect(() => run({ proxies: [{ name: "VPS-id", type: "direct" }] })).toThrow(
    "node name conflict",
  );
  expect(() =>
    run({
      "proxy-groups": [
        { name: "自建节点", type: "select", proxies: ["DIRECT"] },
      ],
    }),
  ).toThrow("group name conflict");
  expect(() =>
    run({
      "proxy-groups": [
        {
          name: "自建节点",
          type: "url-test",
          "x-proxysetting-owner": "proxysetting:v1",
        },
      ],
    }),
  ).toThrow("group name conflict");
});
it("deduplicates own group reference and updates own nodes without duplicates", () => {
  const r = run({
    proxies: [],
    "proxy-groups": [
      {
        name: "choose",
        type: "select",
        proxies: ["自建节点", "DIRECT", "自建节点"],
      },
    ],
  });
  expect(r["proxy-groups"][0].proxies).toEqual(["自建节点", "DIRECT"]);
  expect(run(r, [{ ...nodes[0], uuid: "new" }]).proxies[0].uuid).toBe("new");
});
it("serializes hostile names/data as literals, not executable code", () => {
  const malicious = [
    {
      ...nodes[0],
      name: '\";throw new Error(\"INJECTED\");//</script>\u2028',
      server: "';globalThis.pwned=true;//",
    },
  ];
  const r = run({}, malicious);
  expect(r.proxies[0].name).toBe(malicious[0].name);
  expect(r.proxies[0].server).toBe(malicious[0].server);
  expect(vergeScript(malicious)).not.toContain("</script>");
});
it("rejects malformed config and select group proxies", () => {
  for (const c of [
    null,
    [],
    { proxies: {} },
    { "proxy-groups": {} },
    { "proxy-groups": [{ name: "x", type: "select", proxies: "DIRECT" }] },
  ])
    expect(() => run(c)).toThrow("proxysetting:");
});
