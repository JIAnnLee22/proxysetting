# Proxysetting
Cloudflare 免费版 Worker + D1 管理 1–10 台 Debian/Ubuntu/Arch Linux Xray VLESS/Reality VPS、1–50 个独立用户/设备。支持无root、无systemd节点：root且systemd可用时自动使用systemd，否则使用内置独立监管；普通账户安装到 `~/.local/share/proxysetting`，建议Reality端口8443。每台 VPS 独立月额度，上下行合计；北京时间月初恢复。无配额不开通，本地采样失效停止 Xray，Cloudflare 离线继续执行缓存额度。

> 限额仅阻止新连接，已有连接可以继续；采样/重启存在计量误差，不是计费级硬限额。导出脚本包含用户 UUID，禁止分享。

- [架构](docs/architecture.md) · [契约](docs/contract.md)
- [部署 Cloudflare](docs/deploy-cloudflare.md) · [安装/升级 VPS](docs/install-vps.md) · [安全边界](docs/security.md) · [验证记录](docs/verification.md)

## 批量更换节点公网 IP（原机换 IP）

`scripts/node-ips.py` 使用 Python 3 标准库和本仓库的 Wrangler，直接维护远端 D1；先执行 `npm ci`、`npx wrangler login`，账号须具备该 D1 的读写权限。无需面板管理员密码，也无需部署 Worker。

```bash
python3 scripts/node-ips.py export             # 生成 .tools/node-ips.txt
# 用文本编辑器打开 .tools/node-ips.txt，只修改 ip 列
python3 scripts/node-ips.py apply --dry-run    # 校验并预览，不写入
python3 scripts/node-ips.py apply              # 显示差异，输入 yes 后批量写入
```

文本为 Tab 分隔的 `name / ip / original_ip / id` 四列，首行记录数据库 ID。只修改 `ip` 列，保留其他列及 Tab 分隔符；可删除不处理的节点行。默认只导出已注册、未撤销节点，不含待安装、已撤销和已删除节点。可在 `export` / `apply` 后指定其他文件路径；默认文件位于 Git 忽略的 `.tools/`，权限为0600。重新导出不会覆盖已编辑文件，确需覆盖时用 `export --force`。

更新前校验公网 IPv4/IPv6、重复节点、数据库 ID、节点身份和旧 IP；仅提交有改动的行，已应用的地址可重复执行。确认后用单条原子 SQL 更新，期间若任一目标的旧 IP、注册公钥或撤销状态变动则整批不写入。写入前在 `.tools/node-ip-backups/` 保存反向映射，成功后回读确认；需要回滚时对备份文件先执行 `apply <备份路径> --dry-run`，确认后再执行 `apply <备份路径>`。非交互执行须显式加 `--yes`。网络中断可能导致提交结果未知，此时先重新导出到其他文件核对，不要盲目重试。

**仅适用于同一台 VPS 更换公网 IP**：只修改 D1 的 `address`，不改端口、Reality 参数、凭据、revision、授权或用量，也不会 SSH 修改 VPS 的网卡或本地配置；agent 运行时不使用登记地址监听。新 IP 必须已经指向原 VPS，并放行原端口。更新后刷新面板和客户端订阅；已导出的本地 JS/YAML 需重新导出。端口、Reality 目标变更或更换机器仍按[安装/恢复文档](docs/install-vps.md)处理。

## 分流规则集（自托管）

订阅 YAML 的 `rule-providers` 指向本 Worker 的 `/rules/`，不再依赖 jsdelivr，也不受第三方规则站可达性影响。`src/web/public/rules/` 下的 `.mrs` 由 `scripts/build-rules.mjs` 从固定提交的 `Loyalsoldier/clash-rules` 生成：统一规范为 `+.domain` 后缀匹配（Mihomo 中裸域名只匹配精确主机）、合并同类列表、删除未引用列表、把域名/IP 列表转为 MRS（体积从约 8.7 MiB 降到约 2.5 MiB）。

默认策略：广告/跟踪域名 `REJECT`（立即拒绝，避免直连超时）；Apple CDN 走代理；iCloud、私有网络、NTP/时间、本面板域名直连；国内域名和中国 IP 直连；其余走 `PROXY`。规则提供者使用 `proxy: DIRECT` 下载，避免规则更新依赖节点。更新规则：

```bash
MIHOMO_BIN="$(command -v verge-mihomo)" npm run rules:update
git diff --stat src/web/public/rules
npm run verify && npm run deploy
```

生成的 `manifest.json` 记录上游提交、条目数和 SHA256。MRS 需 Mihomo/Clash Verge Rev（当前验证版本 Mihomo 1.19.32、Clash Verge Rev 2.5.2）。模板中的 `{{RULES_BASE}}` 在导出订阅时自动替换为当前请求域名，切换 workers.dev 或自定义域名无需改模板。

开发：Node 24，`npm ci && npm run verify`。Go 工具链见 `agent/go.mod`；`cd agent && go test ./...`。`nix shell nixpkgs#go nixpkgs#shellcheck` 可临时提供工具链。管理端使用浏览器原生密码登录（用户名 `admin`），无需 Cloudflare Access/Zero Trust。真实部署须配置 D1 ID、GitHub Release repo 和版本、ADMIN_PASSWORD、UUID_KEY、INSTALL_SHA256。ADMIN_PASSWORD 为 16–256 字符随机密码，仅存 Worker secret；不要把占位值用于生产。已有部署需关闭原来的边缘 Access，详见部署文档。
