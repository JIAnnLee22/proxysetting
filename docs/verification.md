# 实施与部署验证记录
## 本地及CI通过
- Node 24：`npm run verify`，TypeScript、24个Vitest测试、本地D1 migration、Worker assets/API dry-run通过；此前`npm audit`零已知漏洞。
- Go 1.26+：单测、`go vet ./...`、`go test -race ./...`；amd64/arm64无CGO构建。一次本机未提供GCC的默认CGO测试失败，改用`CGO_ENABLED=0 go test ./...`通过；GitHub Ubuntu CI的race/vet通过。
- `python3 scripts/test-install.py`：29模拟测试，覆盖Debian/Ubuntu/Arch、双架构、固定新版本初装、二进制版本不符拒绝、端口/权限、注册/hash/归属失败、升级回滚和计量状态不可回退。ShellCheck和Bash语法通过。
- 官方Xray v26.3.27哈希校验后真实Reality集成：双向计量、超额移除用户、新连接失败、旧连接继续计量、北京时间受控跨月恢复、离线限额及Xray停止检测。复现：`XRAY_BIN=/path/to/verified/xray CGO_ENABLED=0 go test ./internal/daemon -run TestRealXrayRuntime -v -count=1`。
- 官方Mihomo v1.19.31哈希校验和`mihomo -t`通过；Verge脚本VM覆盖幂等/同名冲突/嵌套select等。未替代桌面人工导入。

## 公开Release
- 首个v0.1.0 tag保留，旧版CI ShellCheck报告SC2015，未发布资产；修复后不改写旧tag。
- [v0.1.1](https://github.com/JIAnnLee22/proxysetting/releases/tag/v0.1.1)，提交`a980ff4d05888256cf19e2eebf9a7199fe91bd5e`；[CI 36671481874](https://github.com/JIAnnLee22/proxysetting/actions/runs/36671481874)的verify、双架构build、release均success。
- 下载公开资产后校验SHA256、归档恰好含agent和两unit、ELF64架构62/183；amd64实际执行`--version`为v0.1.1；install.sh与审核源码逐字节一致。没有密钥、运行配置或状态。

| 资产 | SHA256 |
|---|---|
| install.sh | `c97287cc5c99f0305c8a78179fb370decc20d962281fdfdf063f167f326b089b` |
| proxysetting-agent-linux-amd64.tar.gz | `071b0c0c6d71369cf3cea7a29aba260c22acc05967b5c17483c58f08c884a573` |
| proxysetting-agent-linux-arm64.tar.gz | `400366b0cd7b3e0f81d34820771ccb2a6f136fd58ec80ad8f6b106ff16059c45` |

## Cloudflare真实部署
- 用户Wrangler OAuth账号邮箱jiannlee22@gmail.com；创建独立proxysetting D1并应用0001 migration，旧sing-box-subscription数据库未改动。
- Worker地址：`https://proxysetting.jiannlee22.workers.dev`；固定repo JIAnnLee22/proxysetting、v0.1.1及上述安装器hash。UUID_KEY以0600私有文件另存仓库外，未提交或上传GitHub。
- **Access参数已部署**：用户提供团队`square-field-415b.cloudflareaccess.com`及主应用AUD，已填wrangler.jsonc并部署（Worker版本6093700f-0d42-42d8-a1c0-bc939a38a326），npm verify的24测试通过。主站、app.js和管理API匿名请求302到该团队登录页，跳转AUD匹配，JWKS200/2公钥；未代替用户完成邮箱验证码登录。
- **设备Bypass仍待修复**：/api/agent/config匿名请求及真实credential+agent UA请求均302到登录页；默认Python UA曾403。边缘Access截获设备请求，当前云端同步受阻。SSH确认agent/Xray active、check ready，本地缓存计量仍健康。不能把全站设为Bypass；需更具体设备路径例外，并检查是否启用了覆盖整个Worker的Access策略。
- 初始测试VPS/1GiB身份通过已认证的Cloudflare D1操作创建；VPS真实Worker单次令牌注册后使用独立credential完成配置拉取和统计上报，并非mock。配置轮询60秒、用量上报300秒，last_sync不代表用量秒级刷新。

## 用户授权Arch VPS永久安装（144.202.123.93）
- sing-box停止/disable/mask，备份`/root/proxysetting-singbox-backup.2heDmH`。公开Release安装器先验证固定hash，再安装并注册；agent和Xray active，agent enabled，`check`返回ready。
- Xray占用TCP443，gRPC仅127.0.0.1:10085；config/agent.json、config/xray.json、state/usage.json均0600。UFW/云安全组未修改。
- www.microsoft.com通过TLS1.3探测，但本机和公网Reality客户端均握手失败；隔离比较www.cloudflare.com成功。旧配置恢复关闭debug后保存至root私有备份，显式重装更换SNI，保留同一云端身份及累计用量。
- Chrome指纹的真实公网VLESS/Reality+vision客户端经TCP443请求ipify，返回144.202.123.93。
- 通过真实D1将测试身份额度降至64byte：云快照uplink1918/downlink4631/disabled=true，新连接失败；恢复1GiB后公网连接成功，云快照revision4/disabled=false。最终额度1GiB，不遗留64byte测试限额。
- 临时客户端、目标比较进程/目录已清理；仅正式服务和私有备份保留。

## 早期隔离测试与已知局限
- Arch支持/永久迁移之前，隔离目录、未启用临时systemd服务和本机HTTPS mock验证READY、SIGKILL/BindsTo、Xray故障恢复、65秒控制面离线、45秒watchdog、最终采样及无死锁停止；当时保持sing-box/防火墙不变。另在该VPS通过受控跨月真实Reality集成。不能据此声称当时已有真实云部署。
- 手动`systemctl restart proxysetting-agent`出现关停Xray任务抢占启动，首轮30秒本地API超时，5秒自动重试后恢复；保持fail-closed但有可用性间隙。手动维护使用`systemctl stop proxysetting-agent proxysetting-xray && systemctl start proxysetting-agent`，升级器使用有序stop/start。
- TLS1.3探测和READY只证明必要条件/本地计量健康，不等于公网Reality验证；目标须逐台实测。
- 独立安全审查子任务没有交付可用结论，不作为审计通过。

## 仍需外部验收
- Zero Trust Access主站实际邮箱登录/允许策略验收、设备路径Bypass修复后凭据请求与同步恢复、管理员网页及导出验收；team/AUD已部署。
- Debian/Ubuntu×amd64/arm64四种真实镜像安装；Arch真机不替代该矩阵。公开Release真实升级/失败回滚仍需下一可用版本。
- Verge Rev桌面人工导入；自然月边界长时运行。受控跨月测试未更改VPS系统时钟。
