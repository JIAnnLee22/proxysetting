# 实施验证记录
## 已通过
- Node 24：`npm run verify`（TypeScript、Vitest、真实本地D1 migration、Worker assets/API dry-run），24测试通过；`npm audit`零已知漏洞。
- Go 1.26.7：单测、`go vet ./...`、`go test -race ./...`；Linux amd64/arm64 `CGO_ENABLED=0 go build`，发布ldflags版本v0.1.0可核对。
- `python3 scripts/test-install.py`：27模拟测试（两架构/Debian、Ubuntu、Arch入口、二次执行、非空root、端口、注册失败、hash错误、archive成员、服务归属、升级回滚和状态不可回退）；`shellcheck scripts/*.sh`、Bash语法通过。
- SHA256校验官方Xray v26.3.27 amd64产物后真实集成：TLS1.3本地伪装目标+Reality客户端→TCP echo→用户上下行计量→持久化后RemoveUser→新连接失败、旧连接继续计量→北京时间次月AddUser恢复→控制面离线缓存额度→意外Xray停止检测。复现：`XRAY_BIN=/path/to/verified/xray CGO_ENABLED=0 go test ./internal/daemon -run TestRealXrayRuntime -v -count=1`。不依赖公网代理目标，不修改宿主systemd。
- 官方Mihomo v1.19.31 amd64产物SHA256校验后 `mihomo -t` 验证VLESS/Reality配置及ownership扩展字段；Verge脚本VM fixtures覆盖嵌套select、空配置、重复执行、同名冲突/恶意名称。

## 用户授权真实VPS（144.202.123.93）
机器实际为Arch Linux amd64，已有sing-box监听TCP/UDP443，UFW活动、仅放行22/443。不满足计划的Debian/Ubuntu首装支持；未覆盖sing-box、未改防火墙、未正式安装本项目。
隔离目录+未启用的临时systemd服务+随机高端口+本机HTTPS mock control；测试CA只通过临时service Environment传入，未修改系统信任仓库。通过：
- 生产安装器拒绝Arch且不创建安装根；agent拒绝占用的443且未消费注册token。
- 实际www.microsoft.com TLS1.3探测、一次注册、READY通知、当前月已耗尽quota持久化。
- agent SIGKILL→Xray BindsTo停止→自动重启后耗尽用户仍禁用。
- Xray SIGKILL→API持续失败检测→联动恢复且没有放行耗尽身份。
- 控制面503跨越真实60秒轮询，采样继续、缓存额度不变。
- agent SIGSTOP→45秒watchdog SIGKILL→Xray停止→恢复仍限额。
- 正常停止最终采样，关闭顺序无死锁，10秒内完成。
- 在同一VPS运行CGO禁用的真实Reality集成测试二进制：本机TLS1.3伪装/echo、双向用量、超额新连接失败/旧连接继续、受控北京时间跨月恢复全部通过（TestRealXrayRuntime，1.35秒）。
测试结束移除临时服务/目录；核对原443监听进程和UFW输出完全未变。可复现辅助脚本 `scripts/test-systemd-vps.py` 必须仅在明确授权的隔离/测试host上以root运行，默认拒绝既有proxysetting服务/root；它不是生产安装器，也不证明Cloudflare部署成功。

## 仍需外部验收
- 真实Cloudflare账户D1/Access/Worker部署、workers.dev路径策略、GitHub公开Release首次安装及升级链路。
- Debian/Ubuntu×amd64/arm64四种真实镜像/VM生产安装（当前仅cross-build/模拟入口验证，真实提供的机器是Arch）。
- Verge Rev桌面人工导入以及实际公网端口/云安全组可达性。
- 真实自然月长时运行边界；本地跨月验证使用受控时钟，不更改VPS系统时钟。
