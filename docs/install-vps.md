# VPS 安装、升级与恢复
支持Debian/Ubuntu/Arch Linux、systemd、amd64/arm64，root执行。Xray固定官方 `v26.3.27`，ZIP SHA256内置；可用首发agent `v0.1.1`。VPS无需自有域名。**不要在已有代理机器上直接覆盖**：安装器拒绝非空root、同名systemd服务、443/所选端口和API10085占用。

## 安装
1. 先人工安装必要工具：Debian/Ubuntu上 `apt-get update && apt-get install -y curl tar unzip iproute2 util-linux coreutils`。Arch Linux使用 `pacman -Syu --needed curl tar unzip iproute2 util-linux coreutils ca-certificates`。安装器不自动改包管理器/防火墙。
2. Web添加名称、公网IPv4/IPv6（首版仅字面IP，不接受DNS或私网地址）、端口和Reality候选目标。候选如www.cloudflare.com/www.microsoft.com/www.apple.com；安装时TLS1.3不通则失败，不部署。TLS1.3仅是必要条件，不保证Reality握手兼容：本次Arch VPS上www.microsoft.com通过TLS探测但Reality失败，www.cloudflare.com通过实际公网客户端验证。目标须逐台实测，不要求属于自己。
3. 443冲突或目标TLS测试失败时，在Web“修改未部署参数”选择其他端口/目标；这会使旧令牌失效，需重新生成命令。已注册设备不能在线改地址/端口/目标，须显式重装。Web生成一次性命令，确认GitHub仓库/tag/脚本SHA256。root在**对应VPS**执行，15分钟有效一次消费；命令先下载校验脚本再运行，不直接curl|bash。token会出现在一次性命令里，关闭shell历史，勿贴入日志/聊天。
4. 安装器完成权限/系统/架构/端口检查，下载校验双组件，agent生成本地Reality私钥、公钥/shortId、Xray配置，测试后注册，原子切换current并启动独立服务。仅公有Reality参数上传Worker。
5. 手动检查主机防火墙和云安全组，放行Reality所选TCP端口（默认443），**不要开放10085**。安装器不关闭防火墙，也不能代替云控制台放行。
6. 创建身份，每VPS填写正GiB月额度后才开通，等待ready/最新revision，再导出JS。额度耗尽不删除导出节点。

## 文件与健康
默认 `/opt/proxysetting`：`releases/VERSION`固定产物，`current`/`previous`链接，`config/agent.json`/`xray.json`/`release.env`，`state/usage.json`。私钥和凭据/状态0600，目录0700；备份必须保密。
```
systemctl status proxysetting-agent.service proxysetting-xray.service
/opt/proxysetting/current/bin/proxysetting-agent check --root /opt/proxysetting
journalctl -u proxysetting-agent.service -u proxysetting-xray.service
```
Xray BindsTo/PartOf agent，仅由agent的Wants关系启动；agent需恢复允许用户并持久化才发READY，每成功采样发watchdog。Xray clients静态为空，启动不绕过本月停用状态。正常停止顺序agent先，最终采样后Xray停。配置轮询每60秒、云端用量上报每300秒，页面快照并非秒级实时。手动重启采用 `systemctl stop proxysetting-agent proxysetting-xray && systemctl start proxysetting-agent`；直接restart agent存在关停任务与启动任务抢占，可能先超时再自动恢复。

## 升级和回滚
Web“升级版本”输入固定 `vMAJOR.MINOR.PATCH`，Worker只读取已配置GitHub仓库该tag的SHA256SUMS，下发经hash验证的安装脚本；agent独立systemd-run执行，升级器读取本地root/config/release.env仓库，不接受任意URL。不得使用latest。升级前agent最终采样，保存并备份状态/配置；原子切换、Xray配置检查及agent readiness失败则回滚旧版本，**绝不把旧备份覆盖新的usage/sequence**。
手工使用已校验的本地脚本：
```
/opt/proxysetting/current/install.sh --upgrade --root /opt/proxysetting --version v0.1.1
/opt/proxysetting/current/install.sh --rollback --root /opt/proxysetting
```
初装必须显式指定固定 `vMAJOR.MINOR.PATCH`，不接受latest；Web命令由Worker锁定发行版本和安装器SHA256。安装器还核对agent编译版本与所指定release一致。旧config schema兼容性由后续release负责，当前不自动迁移任意格式。
改过systemd unit、有drop-ins、仓库不匹配或release目录已存在会拒绝。失败版本目录保留供检查，重试之前仅移除经确认失败的releases/VERSION。断电/SIGKILL不可完整事务恢复，可能服务保持停止，应人工用previous/config备份恢复并确认state不回退。

## 撤销、凭据轮换与重装
Web撤销使设备下次请求401并停服务；离线VPS需人工停服务。agent rotate CLI轮换设备凭据，旧凭据立刻无效，注意网络丢响应/本地写失败会锁出，要重新注册恢复。重新签发enroll命令撤销旧凭据，不擅自覆盖非空root；先停旧服务并备份配置/状态，人工确认清理/迁移后再安装。新空root从Worker继承已上报本月用量，不抵消旧用量；尚未上报的窗口仅在本地state，**不能丢弃**。注册响应丢失不要重放token，重新签发。

## 上线前环境验证
需在一次性Debian/Ubuntu×amd64/arm64环境分别验证真安装、再次执行拒绝、端口占用、错误令牌、hash失败、升级/回滚、Watchdog崩溃联动和Xray意外重启。当前本地模拟测试不等于这些环境已验收。Verge Rev人工导入也是单独验收项目。
