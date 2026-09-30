"use strict";
const $ = (id) => document.getElementById(id);
let state;
function message(s) {
  $("message").textContent = s;
}
async function api(path, method = "GET", data) {
  const response = await fetch("/api/admin/" + path, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    cache: "no-store",
  });
  if (!response.ok) {
    let error;
    try {
      error = (await response.json()).error;
    } catch {
      error = "请检查Access登录/部署";
    }
    throw new Error(`${response.status}: ${error}`);
  }
  return response;
}
async function action(fn) {
  try {
    message("");
    await fn();
  } catch (e) {
    message(e.message);
  }
}
function el(tag, text) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
}
function button(text, fn) {
  const b = el("button", text);
  b.onclick = () =>
    action(async () => {
      b.disabled = true;
      try {
        await fn();
      } finally {
        b.disabled = false;
      }
    });
  return b;
}
const gib = (n) => (n / 1073741824).toFixed(3) + " GiB";
async function refresh() {
  state = await (await api("state")).json();
  $("clock").textContent = "北京时间自然月 " + state.calendar.month;
  $("period").value ||= state.calendar.month;
  render();
}
function render() {
  const list = $("vps-list");
  list.replaceChildren();
  for (const v of state.vps) {
    const box = el("section");
    box.append(
      el("h3", `${v.name} — ${v.address}:${v.port}`),
      el(
        "p",
        `${v.status} / 版本 ${v.version || "未部署"} / 修订 ${v.revision} / 同步 ${v.last_sync || "尚无"}`,
      ),
    );
    if (v.error) box.append(el("p", v.error));
    const row = el("div");
    row.className = "actions";
    if (v.status === "pending" && !v.public_key)
      row.append(
        button("修改未部署参数", async () => {
          const port = prompt(
            "Reality端口（443冲突可选其他端口）",
            String(v.port),
          );
          if (port === null) return;
          const serverName = prompt("Reality TLS1.3目标", v.server_name);
          if (serverName === null) return;
          const address = prompt("公网IPv4/IPv6", v.address);
          if (address === null) return;
          await api(`vps/${v.id}`, "PATCH", {
            name: v.name,
            address,
            port: Number(port),
            serverName,
          });
          message("参数已更新，旧安装令牌失效；请重新生成命令。");
          await refresh();
        }),
      );
    row.append(
      button("安装/重新注册", async () => {
        if (
          v.status !== "pending" &&
          !confirm(
            "重新注册会撤销旧凭据。旧设备应先停止，已有用量需保留；确认？",
          )
        )
          return;
        const d = await (await api(`vps/${v.id}/enroll`, "POST", {})).json();
        $("command").value = d.command;
        $("expiry").textContent = "过期时间 " + d.expiresAt;
        $("install-dialog").showModal();
      }),
      button("撤销凭据", async () => {
        if (confirm("撤销后设备下次联系即停止；离线设备需人工停机。确认？")) {
          await api(`vps/${v.id}/revoke`, "POST", {});
          await refresh();
        }
      }),
      button("升级版本", async () => {
        const version = prompt("固定Release版本（如 v0.1.1）");
        if (version) {
          await api(`vps/${v.id}/upgrade`, "POST", { version });
          await refresh();
        }
      }),
    );
    box.append(row);
    list.append(box);
  }
  const identities = $("identities");
  identities.replaceChildren();
  const select = $("export-identity"),
    old = select.value;
  select.replaceChildren();
  for (const i of state.identities) {
    if (i.enabled) {
      const o = el("option", i.name);
      o.value = i.id;
      select.append(o);
    }
    const box = el("section");
    box.append(
      el("h3", i.name),
      button(i.enabled ? "停用身份" : "启用身份", async () => {
        await api(`identities/${i.id}`, "PATCH", {
          name: i.name,
          enabled: !i.enabled,
        });
        await refresh();
      }),
    );
    const table = el("table");
    const head = el("tr");
    for (const t of ["VPS", "月额度 GiB", "本月上行/下行", "状态/操作"])
      head.append(el("th", t));
    table.append(head);
    for (const v of state.vps) {
      const g = state.grants.find(
        (g) => g.vps_id === v.id && g.identity_id === i.id,
      );
      const snapshot = state.snapshots.find((s) => s.vps_id === v.id)?.payload;
      const usage =
        snapshot?.month === state.calendar.month
          ? snapshot.users.find((u) => u.id === i.id)
          : null;
      const tr = el("tr");
      tr.append(el("td", v.name));
      const cell = el("td"),
        input = el("input");
      input.className = "quota";
      input.type = "number";
      input.min = "0.000001";
      input.step = "any";
      input.required = true;
      input.placeholder = "必填";
      input.value = g ? g.quota_bytes / 1073741824 : "";
      cell.append(input);
      tr.append(
        cell,
        el(
          "td",
          usage
            ? `${gib(usage.uplink)} / ${gib(usage.downlink)} (总 ${gib(usage.uplink + usage.downlink)})`
            : "未同步本月",
        ),
      );
      const ops = el("td", usage?.disabled ? "额度耗尽/已停用" : "");
      ops.append(
        button("保存额度", async () => {
          const quotaGiB = Number(input.value);
          if (!input.value || !Number.isFinite(quotaGiB) || quotaGiB <= 0)
            throw new Error("必须填写正月额度");
          await api(`vps/${v.id}/grants`, "PUT", {
            identityId: i.id,
            quotaGiB,
          });
          await refresh();
        }),
      );
      if (g)
        ops.append(
          button("移除授权", async () => {
            await api(`vps/${v.id}/grants`, "DELETE", { identityId: i.id });
            await refresh();
          }),
        );
      tr.append(ops);
      table.append(tr);
    }
    box.append(table);
    identities.append(box);
  }
  if ([...select.options].some((o) => o.value === old)) select.value = old;
}
$("refresh").onclick = () => action(refresh);
$("vps-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    const d = Object.fromEntries(new FormData(e.target));
    d.port = Number(d.port);
    await api("vps", "POST", d);
    await refresh();
  });
};
$("identity-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    await api("identities", "POST", Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    await refresh();
  });
};
async function script() {
  if (!$("export-identity").value) throw new Error("请选择身份");
  return (
    await api(
      "export?identity=" + encodeURIComponent($("export-identity").value),
    )
  ).text();
}
$("copy").onclick = () =>
  action(async () => {
    await navigator.clipboard.writeText(await script());
    message("已复制敏感脚本");
  });
$("download").onclick = () =>
  action(async () => {
    const u = URL.createObjectURL(
      new Blob([await script()], { type: "application/javascript" }),
    );
    const a = el("a");
    a.href = u;
    a.download = "proxysetting-verge.js";
    a.click();
    URL.revokeObjectURL(u);
  });
$("copy-command").onclick = () =>
  action(() => navigator.clipboard.writeText($("command").value));
$("close-dialog").onclick = () => {
  $("install-dialog").close();
  $("command").value = "";
};
$("install-dialog").addEventListener("close", () => {
  $("command").value = "";
});
$("history").onclick = () =>
  action(async () => {
    $("history-result").textContent = JSON.stringify(
      await (
        await api("usage?period=" + encodeURIComponent($("period").value))
      ).json(),
      null,
      2,
    );
  });
action(refresh);
