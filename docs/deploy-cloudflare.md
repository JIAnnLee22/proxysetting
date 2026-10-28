# 部署 Cloudflare 免费版
## 准备发布
公开GitHub仓库，代码推送后按 `.github/workflows/release.yml` 发布固定tag（当前部署固定 `v0.1.6`）；Release需有 install.sh、两架构agent `tar.gz`、两架构Xray `tar.gz` 和SHA256SUMS。VPS不使用ZIP安装包，无需unzip。首次执行脚本不能仅依赖同一下载源的校验文件：管理员审核源码/CI，取固定install.sh的SHA256，填Worker `INSTALL_SHA256`。Xray官方版本/ZIP哈希固定在CI，校验后转为 `tar.gz` 发布，不用latest下载。格式变更需发布新固定tag，不覆盖旧Release；同步Worker的 `RELEASE_VERSION` 和新安装器的 `INSTALL_SHA256`。

## D1、Worker与Secrets
当前 `wrangler.jsonc` 的默认 Worker 名为 `proxysetting-next`，D1 名称仍为 `proxysetting`，二者无需同名。**替换已有 Worker 时直接复用原 D1，不要重新创建数据库或重新生成 UUID_KEY**，见下文“替换 Worker”。以下创建数据库步骤仅用于全新安装：
```
npm ci
npx wrangler login
npx wrangler d1 create proxysetting
```
首次安装把返回ID写入 `wrangler.jsonc` 的 database_id；替换部署保持原ID不变。按需修改Worker名称；配置 `RELEASE_REPO=owner/repo`、`RELEASE_VERSION=v0.1.6`。
```
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put UUID_KEY
npx wrangler secret put INSTALL_SHA256
npm run db:remote
npm run deploy
```
ADMIN_PASSWORD：用 `openssl rand -base64 24` 生成随机密码，保存到密码管理器，再交互输入上述 secret 命令；要求16–256字符且不含控制字符，缺失/不符合要求时管理端返回503，不会公开放行。用户名固定为 `admin`。密码不要写进 `wrangler.jsonc`、Git或URL。

UUID_KEY：生成32随机字节Base64（如 `openssl rand -base64 32`），保存到密码管理器/离线备份。**丢失会导致既有UUID无法解密；不能直接替换此secret，密钥轮换需专用重加密迁移（首版不提供）**。INSTALL_SHA256是64小写hex，用于首次安装脚本固定。`.dev.vars`可用于本地测试但不能提交；本地管理端需用 `npm run dev -- --local-protocol https`，HTTP请求会被拒绝且不弹密码框。`npm run verify`不要求云账号，验证本地D1和构建。

## 同步安装版本与校验值
安装命令使用 Worker 的 `RELEASE_VERSION`，不会自动跟随 GitHub latest 或前端版本。当前固定 `v0.1.6`，其 `install.sh` SHA256 已核对 Release 文件、`SHA256SUMS` 和对应 tag 源码。已有部署从 `v0.1.1` 切换时，必须同步更新 `INSTALL_SHA256`，否则脚本校验失败：
```bash
printf '%s\n' '18e528bcd4961fff93176411fdf47d60d4eb057daa26e0a7376ac2bba7c7f305' | npx wrangler secret put INSTALL_SHA256
npm run deploy
```
`v0.1.6` 的安装器在 root 且可写 `/etc/sysctl.d` 时写入 `99-proxysetting-network.conf`，启用 BBR/fq 并保留原有 fastopen、缓冲区与 MTU 探测配置；内核不支持 BBR 时自动省略该行。这里的 SHA256 是公开校验值，不是管理员密码。未来切换其他固定 tag 时，重新核对并更新对应安装器校验值；部署后关闭旧命令弹窗，重新获取安装命令，不要手动替换旧命令中的版本号。

## 管理员密码（不使用Cloudflare Access）
当前版本提供访客只读总览：根页面、静态资源、`/api/admin/state` 和 `/api/admin/analytics` 可匿名访问；state 返回 `isAdmin: false`。管理员用户名为 `admin`，密码为 `ADMIN_PASSWORD`，通过 HTTPS Basic 验证；登录及其他管理接口需要管理员凭据，管理写操作还须同源。`/api/agent/*` 保留独立设备bearer凭据，不要求管理员密码，也无需路径Bypass；订阅使用独立订阅标识。安装文件来自固定GitHub Release。

**已有Access部署的迁移顺序**：先设置ADMIN_PASSWORD并部署新版Worker，再到 **Workers & Pages → 目标 Worker → Access**，关闭对应规则（make public；若被账户级规则覆盖，仅对本Worker绕过）。不要禁用workers.dev域名本身。如Zero Trust中另有覆盖该域名的self-hosted application，也需移除该应用（只处理本项目域名，不影响其他应用）。否则边缘仍返回登录重定向，Worker内改代码无法解除拦截。常规Wrangler OAuth通常没有Zero Trust应用管理权限，且Wrangler 4.144.0的可选OAuth scope不包含Access，不能靠删配置或追加 `access:write` 替代控制台操作。自动处理需另外使用仅限对应账户的 `Access: Apps and Policies Write` API Token；Token只保存在仓库外私有文件，不发到聊天或提交Git。

Basic凭据只通过HTTPS传输；浏览器会缓存登录，没有内置退出按钮，共享设备建议用隐私窗口，使用后关闭整个隐私会话。修改ADMIN_PASSWORD并重新部署可轮换密码，现有设备凭据不受影响。密码不要放在URL/命令历史/公开日志；脚本访问可用 `curl -u admin https://<worker>/api/admin/state` 交互输入密码。

部署后检查：首页与构建后的JS/CSS返回200；匿名state返回200及 `isAdmin: false`，正确管理员密码返回200及 `isAdmin: true`，错误密码返回401。设备无凭据返回JSON 401且不带Basic挑战/Access重定向，有效设备凭据应正常同步。管理员管理写请求仍必须同源JSON。需要Secret/Release的功能在缺少配置时清晰503，不能绕过。

## 数据、备份与预算
```
npx wrangler d1 export proxysetting --remote --output backup.sql
```
备份包含加密UUID、设备hash与用量，应仍按敏感数据保管。同时备份UUID_KEY/版本锁定；不要公开备份。日/月usage_periods保存累计JSON，10台约17,280请求/日，约28,800写行/日，额外管理和注册。监控免费额度、D1 rows_read/rows_written/storage、Worker错误率和最后同步。定期清理旧daily记录与rate_limits过期window（注册900秒、device60秒窗口，不同类型按前缀计算），避免累计无上限。免费额度不是服务SLA。

## 固定控制域名
正式入口为 `https://jiannlee22panel.ccwu.cc`，通过 Workers Custom Domain 绑定到 `proxysetting-next`。`wrangler.jsonc` 使用 `routes: [{ pattern: "jiannlee22panel.ccwu.cc", custom_domain: true }]` 保存绑定，`workers_dev: true` 保留 `https://proxysetting-next.jiannlee22.workers.dev` 作为备用入口。Cloudflare 自动管理该自定义域名的 DNS 记录和证书，不要手工添加指向 Worker 的 CNAME。

域名区域必须处于 Active，且域名HTTPS证书、页面及接口均验证通过后，才能切换VPS。节点最终统一使用 `controlUrl: "https://jiannlee22panel.ccwu.cc"`；安装命令及订阅地址应从正式入口生成。不要关闭TLS证书校验；若本机解析到 `198.18.0.0/15` 等Fake-IP或代理合成IPv6，而公共DNS返回Cloudflare公网地址，应区分本机代理/DNS路径故障与域名证书故障，并在实际VPS上验证可达性。

以后替换Worker时，先保留原D1和Secrets并验证新Worker，再将同一自定义域名的绑定移到新Worker；同步更新新Worker的 `routes` 并从旧Worker配置中移除该域名，避免后续部署重新绑定。只要固定域名、数据及设备凭据保持兼容，节点无需再因Worker名称变化而修改 `controlUrl`。

## 替换 Worker（同账户复用原 D1）
当前正式入口为 `https://jiannlee22panel.ccwu.cc`，备用入口为 `https://proxysetting-next.jiannlee22.workers.dev`，旧 Worker `proxysetting` 保留。新旧 Worker 绑定同一个 D1，节点、身份、授权、设备凭据哈希、月/日用量及订阅模板均直接沿用，不是独立数据库副本；任一入口的写操作都会修改同一份数据。

1. 先备份原 D1 和本机私有密钥文件。SQL备份含敏感信息，应放在Git忽略的受保护目录，文件权限0600。导出期间D1可能短暂不可用，选择合适的维护窗口。
2. 新 Worker 必须单独配置原 `UUID_KEY`、管理员密码和与固定Release匹配的 `INSTALL_SHA256`。Wrangler只能列出远端Secret名称，不能读取其原值；从密码管理器或本机私有备份取得，**不要生成新UUID_KEY冒充迁移，也不要把秘密写入命令参数、历史或Git**。若使用 `--secrets-file`，在仓库外准备包含这三个字段的JSON文件并设为0600。
3. 修改 `wrangler.jsonc` 的 Worker 名称，但保留原D1的 `database_id`。构建后部署；普通后续部署会保留该 Worker 已配置的Secrets：
   ```bash
   npm run build:web
   npx wrangler deploy --secrets-file "$HOME/.config/proxysetting/replacement-worker-secrets.json"
   ```
4. 验证新入口的页面/静态资源、管理员身份、节点/身份/授权数据、订阅生成及设备鉴权，再切换节点。显示旧快照不代表节点已连接新入口；未经验证不要删除旧 Worker。
5. VPS不会自动发现域名变更，当前也没有内置切换URL命令。使用原安装账户，先正常停止服务并备份 `config/` 与 `state/`，仅把 `<ROOT>/config/agent.json` 的 `controlUrl` 改为 `https://jiannlee22panel.ccwu.cc`，保持0600权限，不修改凭据、UUID、revision或用量。systemd模式使用 `systemctl stop proxysetting-agent proxysetting-xray`，修改后 `systemctl start proxysetting-agent`；独立模式使用原二进制的 `stop --root <ROOT>` / `start --root <ROOT>`。默认root目录为 `/opt/proxysetting`，普通账户为 `~/.local/share/proxysetting`；自定义安装目录须沿用原值。**不要重装或清空state**，完整服务命令见[安装/恢复文档](install-vps.md)。
6. 配置拉取周期60秒、快照上传周期300秒；逐台确认新入口的 `last_sync` 更新、revision一致且状态ready。订阅消费者只更换订阅URL的域名，保留路径和订阅标识；已导出的纯节点配置因VPS地址/密钥不变通常无需修改。

换Worker名称不能保证解决整个 `workers.dev` 域名的网络不可达；新入口仍不可达时须另查DNS、TLS、Access/WAF或配置自定义域名。旧入口保留只是入口级退路，不是数据备份，也不会自动转发至新入口。

## 云端验收（需真实账号）
1. 创建VPS，root运行15分钟单次命令，等待注册和ready。
2. 创建两个身份，在每台VPS填写正GiB额度；不填不得开通/导出。
3. 导出其中一个身份JS，全VPS各一个节点；Verge Rev导入测试，第二次运行不重复。
4. 双向传输并观察月累计和last_sync；超额新连接失败（旧会话可继续）。
5. 跨北京时间月初恢复；断Cloudflare网络仍本地限额；崩溃agent/watchdog时Xray停止；Xray意外重启不放行已耗尽用户。
6. 撤销/轮换credential、过期及重复注册token拒绝；升级失败恢复旧版本。
本地测试不能替代这些真实部署和网络环境验收。
