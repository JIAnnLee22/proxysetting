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

## Cloudflare真实部署（此前Access版本记录）
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

## Access移除与密码登录
- 当前代码已移除Access JWT/JWKS及team/AUD/邮箱配置，管理端改为HTTP Basic（用户名admin、ADMIN_PASSWORD secret）；静态资源/管理API仍受保护，设备仍使用原有bearer凭据。
- `npm run verify`通过：30个Vitest测试、TypeScript、本地D1 migration检查及Worker dry-run（30.45KiB / gzip 8.97KiB）；`git diff --check`通过。覆盖错误/缺失密码、HTTP拒绝、Basic挑战、旧Access头无效、同源JSON写入和设备认证隔离。
- 已生成32字符随机ADMIN_PASSWORD并上传Worker secret，密码另存仓库外0600私有文件；未改UUID_KEY/D1数据/设备凭据。新版发布到 `https://proxysetting.jiannlee22.workers.dev`，版本 `089270ed-cdb0-4822-a691-cc1e33e5bd52`，旧Access变量已移除。
- 迁移排查期间，Wrangler OAuth具备Worker/D1写权限但未授权Access；发布后匿名根路径、带正确管理员密码的 `/api/admin/state` 和匿名 `/api/agent/config` 曾实测302到旧Access登录页。Access组织接口返回403，应用列表返回200/0条，不能只凭空应用列表判定保护已解除；当时带随机查询参数的请求仍被拦截。
- Wrangler 4.144.0的 `login --scopes-list` 未提供Access scope；补充 `access:read/access:write` 的设备登录被CLI拒绝（退出1），未更换原OAuth凭据。不要继续尝试靠Wrangler OAuth追加Access权限。
- 用户选择控制台关闭方式后，该Worker已实测不再被Access拦截，workers.dev域名保留；本机未取得额外Access权限，未操作其他Worker或Access应用。
- 线上密码验收：根页面/app.js匿名401并带Basic挑战、正确密码200；管理state正确密码200、错误密码401。匿名设备config返回JSON 401且无登录挑战/Access重定向；跨域JSON写入非存在管理路径返回403（无数据修改）。
- SSH只读确认Arch VPS的agent/Xray均active，正式二进制 `check --root /opt/proxysetting` 返回ready；本地已应用revision6、3个授权用户，pending快照为0。随后云端收到sequence12/revision6/ready快照，last_sync为 `2026-09-30T07:56:29.987Z`，无error，证明有效设备凭据的配置拉取和统计上报已恢复。未重启服务、轮换设备凭据或删除计量状态。

## 仍需外部验收
- 实际浏览器内管理操作/敏感导出仍需人工验收；线上HTTP密码鉴权和有效设备凭据同步已验收通过，不再需要邮箱登录/设备路径Bypass配置。
- Debian/Ubuntu×amd64/arm64四种真实镜像安装；Arch真机不替代该矩阵。公开Release真实升级/失败回滚仍需下一可用版本。
- Verge Rev桌面人工导入；自然月边界长时运行。受控跨月测试未更改VPS系统时钟。
