# VPS 安装、升级与恢复
支持Debian/Ubuntu/Arch Linux、amd64/arm64，支持普通账户和root。默认 `--service-mode auto`：**root且系统systemd管理器可用时使用systemd，其余情况使用内置独立进程监管**，不要求systemd、sudo或systemd用户会话。可在初装指定 `--service-mode standalone` 强制独立模式；`--service-mode systemd` 必须满足root和systemd条件。Xray固定官方 `v26.3.27`，由CI校验官方ZIP SHA256后转为项目Release的 `tar.gz`；VPS只用 `tar` 解压，不需要 `unzip`。本安装器须使用包含下述四个 `tar.gz` 资产的新固定Release，不能混用缺少Xray包的旧tag；无root/独立模式还要求新agent声明 `--capabilities` 包含standalone，旧发行版在消费令牌前拒绝，不能仅替换脚本而仍使用旧二进制。VPS无需自有域名。**不要在已有代理机器上直接覆盖**：安装器拒绝非空root、所选端口和API10085占用；systemd模式还拒绝同名服务。

## 安装
1. 必须已有 `bash curl tar gzip flock` 和GNU coreutils、awk/sed等工具；`ss` 可选，缺少时由agent实际bind检查端口。无root时请使用系统已有工具或请管理员预装，安装器不调用sudo。管理员人工安装工具：Debian/Ubuntu上 `apt-get update && apt-get install -y curl tar gzip iproute2 util-linux coreutils`。Arch Linux使用 `pacman -Syu --needed curl tar gzip iproute2 util-linux coreutils ca-certificates`。安装器不自动改包管理器/防火墙。
2. Web添加名称、公网IPv4/IPv6（首版仅字面IP，不接受DNS或私网地址）、端口和Reality候选目标。候选如www.cloudflare.com/www.microsoft.com/www.apple.com；安装时TLS1.3不通则失败，不部署。TLS1.3仅是必要条件，不保证Reality握手兼容：本次Arch VPS上www.microsoft.com通过TLS探测但Reality失败，www.cloudflare.com通过实际公网客户端验证。目标须逐台实测，不要求属于自己。
3. 443冲突或目标TLS测试失败时，在Web“修改未部署参数”选择其他端口/目标；这会使旧令牌失效，需重新生成命令。已注册设备不能在线改地址/端口/目标，须显式重装。Web生成一次性命令，确认GitHub仓库/tag/脚本SHA256。使用选定安装账户在**对应VPS**执行，15分钟有效一次消费；普通账户请先选择可绑定的端口，建议 `8443` 等≥1024端口（不是自动把443改为8443，Web登记端口必须一致）。未授权的低端口在消费令牌前经实际bind检查拒绝；命令先下载校验脚本再运行，不直接curl|bash。token会出现在一次性命令里，关闭shell历史，勿贴入日志/聊天。
4. 安装器完成权限/系统/架构/端口检查，下载校验双组件，agent生成本地Reality私钥、公钥/shortId、Xray配置，测试后注册，原子切换current并启动受监管的agent/Xray进程。仅公有Reality参数上传Worker。
5. 手动检查主机防火墙和云安全组，放行Reality所选TCP端口（默认443），**不要开放10085**。安装器不关闭防火墙，也不能代替云控制台放行。root安装时会自动写入 `/etc/sysctl.d/99-proxysetting-network.conf` 优化跨境高延迟网络协议栈（禁用空闲慢启动、开启服务端TFO、释放32MB套接字缓冲区、开启MTU探测）。
6. 创建身份，每VPS填写正GiB月额度后才开通，等待ready/最新revision，再导出JS。额度耗尽不删除导出节点。

## 发布包格式
项目Release发布 `proxysetting-agent-linux-{amd64,arm64}.tar.gz` 和 `proxysetting-xray-linux-{amd64,arm64}.tar.gz`，由同一固定版本的 `SHA256SUMS` 校验。安装器先校验，再用 `tar` 流式读取指定成员，不直接展开归档路径。
人工查看/解压已校验的包（以amd64为例）：
```bash
tar -tzf proxysetting-agent-linux-amd64.tar.gz
tar -xzf proxysetting-agent-linux-amd64.tar.gz
tar -xzf proxysetting-xray-linux-amd64.tar.gz
```
GitHub自动生成的 `Source code (zip)` 和Actions下载时的ZIP外层不是VPS安装包；部署应使用Release中的上述 `tar.gz` 资产。

## 文件与健康
root默认 `/opt/proxysetting`；普通账户默认 `$HOME/.local/share/proxysetting`，也可用 `--root /绝对路径` 选择当前账户拥有的安全目录（不得含空格、符号链接或dot段）。升级、回滚、检查和卸载须使用同一账户和root。文件布局：`releases/VERSION`固定产物，`current`/`previous`链接，`config/agent.json`/`xray.json`/`release.env`，`state/usage.json`。私钥和凭据/状态0600，安装root及config/state目录0700；备份必须保密。
```
systemctl status proxysetting-agent.service proxysetting-xray.service
/opt/proxysetting/current/bin/proxysetting-agent check --root /opt/proxysetting
journalctl -u proxysetting-agent.service -u proxysetting-xray.service
```
以上systemctl/journalctl命令仅用于systemd模式。systemd下Xray BindsTo/PartOf agent，仅由agent的Wants关系启动；agent需恢复允许用户并持久化才发READY，每成功采样发watchdog。Xray clients静态为空，启动不绕过本月停用状态。正常停止顺序agent先，最终采样后Xray停。配置轮询每60秒、云端用量上报每300秒，页面快照并非秒级实时。手动重启采用 `systemctl stop proxysetting-agent proxysetting-xray && systemctl start proxysetting-agent`；直接restart agent存在关停任务与启动任务抢占，可能先超时再自动恢复。

### 无root / 无systemd服务管理
不依赖第三方supervisor、nohup或systemctl；安装器启动agent自带的独立监管进程，脱离SSH会话，管理Xray和采样agent两个子进程。启动恢复额度并就绪后才成功；正常停止先agent最终采样和fsync，再停Xray。45秒未收到成功采样watchdog、任一子进程退出，均停止整组；监管进程被SIGKILL时Linux父进程死亡信号会杀掉子进程，避免无人计量的Xray继续运行。**异常后保持停止，不自动无限重试**；排查后手动start。
```bash
ROOT="$HOME/.local/share/proxysetting" # root账户无systemd时默认 /opt/proxysetting
"$ROOT/current/bin/proxysetting-agent" status --root "$ROOT"
"$ROOT/current/bin/proxysetting-agent" stop --root "$ROOT"
"$ROOT/current/bin/proxysetting-agent" start --root "$ROOT"
"$ROOT/current/bin/proxysetting-agent" restart --root "$ROOT"
"$ROOT/current/bin/proxysetting-agent" check --root "$ROOT"
bash scripts/check.sh --root "$ROOT" # 仓库本地检查入口
```
独立模式不提供systemd隔离规则；不记录Xray配置/私钥日志，健康通过status/check检查。普通用户的TCP10085仍须独占；同一主机的不同账户不能同时各部署一套默认API。**不自动注册开机启动**；若VPS提供用户crontab，可人工添加（替换为实际绝对路径，cron中不要使用变量）：
```cron
@reboot /home/USER/.local/share/proxysetting/current/bin/proxysetting-agent start --root /home/USER/.local/share/proxysetting
```
部分受限VPS会清理退出登录后的所有用户进程；脱离终端不能绕过宿主策略，需使用供应商允许的持久运行/开机启动机制。

## 升级和回滚
Web“升级版本”输入固定 `vMAJOR.MINOR.PATCH`，Worker只读取已配置GitHub仓库该tag的SHA256SUMS，下发经hash验证的安装脚本；systemd模式由agent独立systemd-run执行，独立模式启动脱离会话且不随agent停止的安装器进程（输出仅写当前root下0600的 `state/upgrade.log`），升级器读取本地root/config/release.env仓库，不接受任意URL。不得使用latest。服务模式记录在本地 `config/release.env`，升级/回滚不会自动切换模式，即使之后取得root或安装了systemd也保持原方式。升级前agent最终采样，保存并备份状态/配置；原子切换、Xray配置检查及agent readiness失败则回滚旧版本，**绝不把旧备份覆盖新的usage/sequence**。
手工使用已校验的本地脚本：
```
/opt/proxysetting/current/install.sh --upgrade --root /opt/proxysetting --version v0.1.1
/opt/proxysetting/current/install.sh --rollback --root /opt/proxysetting
```
初装必须显式指定固定 `vMAJOR.MINOR.PATCH`，不接受latest；Web命令由Worker锁定发行版本和安装器SHA256。安装器还核对agent编译版本与所指定release一致。旧config schema兼容性由后续release负责，当前不自动迁移任意格式。
systemd模式下改过unit、有drop-ins会拒绝；所有模式下仓库不匹配、文件不属于安装账户或release目录已存在都会拒绝。失败版本目录保留供检查，重试之前仅移除经确认失败的releases/VERSION。断电/SIGKILL不可完整事务恢复，可能服务保持停止，应人工用previous/config备份恢复并确认state不回退。

## 撤销、凭据轮换与重装
Web撤销使设备下次请求401并停服务；离线VPS需人工停服务。agent rotate CLI轮换设备凭据，旧凭据立刻无效，注意网络丢响应/本地写失败会锁出，要重新注册恢复。重新签发enroll命令撤销旧凭据，不擅自覆盖非空root；先停旧服务并备份配置/状态，人工确认清理/迁移后再安装。新空root从Worker继承已上报本月用量，不抵消旧用量；尚未上报的窗口仅在本地state，**不能丢弃**。注册响应丢失不要重放token，重新签发。
Release包含 `uninstall.sh`，可用于彻底卸载或在重装前清理环境：
```bash
# 普通账户安装：不要加 sudo
bash uninstall.sh --root "$HOME/.local/share/proxysetting" [--keep-data]
# root安装：使用root，默认 /opt/proxysetting
sudo bash uninstall.sh [--root /opt/proxysetting] [--keep-data]
```
默认按已安装模式停止受监管进程并删除root目录；仅systemd模式移除unit和重载systemd，独立模式不触碰系统服务。若人工配置了crontab开机启动，卸载时须人工删除对应条目。添加 `--keep-data` 可保留 `config/` 与 `state/`。


## 上线前环境验证
需在一次性Debian/Ubuntu×amd64/arm64环境分别验证root+systemd、普通账户（有/无systemd）及root无systemd的真安装、再次执行拒绝、端口占用、错误令牌、hash失败、升级/回滚、Watchdog崩溃联动和Xray意外重启。当前本地模拟测试不等于这些环境已验收。Verge Rev人工导入也是单独验收项目。
