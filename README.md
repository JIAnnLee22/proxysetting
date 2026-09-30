# Proxysetting
Cloudflare 免费版 Worker + D1 + Access 管理 1–10 台 Debian/Ubuntu/Arch Linux Xray VLESS/Reality VPS、1–50 个独立用户/设备。每台 VPS 独立月额度，上下行合计；北京时间月初恢复。无配额不开通，本地采样失效停止 Xray，Cloudflare 离线继续执行缓存额度。

> 限额仅阻止新连接，已有连接可以继续；采样/重启存在计量误差，不是计费级硬限额。导出脚本包含用户 UUID，禁止分享。

- [架构](docs/architecture.md) · [契约](docs/contract.md)
- [部署 Cloudflare](docs/deploy-cloudflare.md) · [安装/升级 VPS](docs/install-vps.md) · [安全边界](docs/security.md) · [验证记录](docs/verification.md)

开发：Node 24，`npm ci && npm run verify`。Go 工具链见 `agent/go.mod`；`cd agent && go test ./...`。`nix shell nixpkgs#go nixpkgs#shellcheck` 可临时提供工具链。真实部署须配置 D1 ID、Access team/audience/允许邮箱、GitHub Release repo 和版本、UUID_KEY、INSTALL_SHA256。不要把占位值用于生产。
