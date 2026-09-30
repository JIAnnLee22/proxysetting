# 部署 Cloudflare 免费版
## 准备发布
公开GitHub仓库，代码推送后按 `.github/workflows/release.yml` 发布固定tag（可用首发 `v0.1.1`）；Release需有 install.sh、两架构agent包和SHA256SUMS。首次执行脚本不能仅依赖同一下载源的校验文件：管理员审核源码/CI，取固定install.sh的SHA256，填Worker `INSTALL_SHA256`。Xray官方版本/哈希内置安装器，不用latest下载。

## D1、Worker与Secrets
```
npm ci
npx wrangler login
npx wrangler d1 create proxysetting
```
把返回ID写入 `wrangler.jsonc` 的 database_id。按需修改Worker名称；配置 `RELEASE_REPO=owner/repo`、`RELEASE_VERSION=v0.1.1`。
```
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put UUID_KEY
npx wrangler secret put INSTALL_SHA256
npm run db:remote
npm run deploy
```
ADMIN_PASSWORD：用 `openssl rand -base64 24` 生成随机密码，保存到密码管理器，再交互输入上述 secret 命令；要求16–256字符且不含控制字符，缺失/不符合要求时管理端返回503，不会公开放行。用户名固定为 `admin`。密码不要写进 `wrangler.jsonc`、Git或URL。

UUID_KEY：生成32随机字节Base64（如 `openssl rand -base64 32`），保存到密码管理器/离线备份。**丢失会导致既有UUID无法解密；不能直接替换此secret，密钥轮换需专用重加密迁移（首版不提供）**。INSTALL_SHA256是64小写hex，用于首次安装脚本固定。`.dev.vars`可用于本地测试但不能提交；本地管理端需用 `npm run dev -- --local-protocol https`，HTTP请求会被拒绝且不弹密码框。`npm run verify`不要求云账号，验证本地D1和构建。

## 管理员密码（不使用Cloudflare Access）
打开Worker HTTPS地址，浏览器弹出原生登录框；用户名 `admin`，密码为 `ADMIN_PASSWORD`。Worker保护根页面、静态资源和 `/api/admin/*`；`/api/agent/*` 保留独立设备bearer凭据，不要求管理员密码，也无需路径Bypass。安装文件来自固定GitHub Release。

**已有Access部署的迁移顺序**：先设置ADMIN_PASSWORD并部署新版Worker，再到 **Workers & Pages → proxysetting → Access**，关闭对应规则（make public；若被账户级规则覆盖，仅对本Worker绕过）。不要禁用workers.dev域名本身。如Zero Trust中另有覆盖该域名的self-hosted application，也需移除该应用（只处理本项目域名，不影响其他应用）。否则边缘仍返回登录重定向，Worker内改代码无法解除拦截。常规Wrangler OAuth通常没有Zero Trust应用管理权限，且Wrangler 4.144.0的可选OAuth scope不包含Access，不能靠删配置或追加 `access:write` 替代控制台操作。自动处理需另外使用仅限对应账户的 `Access: Apps and Policies Write` API Token；Token只保存在仓库外私有文件，不发到聊天或提交Git。

Basic凭据只通过HTTPS传输；浏览器会缓存登录，没有内置退出按钮，共享设备建议用隐私窗口，使用后关闭整个隐私会话。修改ADMIN_PASSWORD并重新部署可轮换密码，现有设备凭据不受影响。密码不要放在URL/命令历史/公开日志；脚本访问可用 `curl -u admin https://<worker>/api/admin/state` 交互输入密码。

部署后检查：匿名访问根/app.js/admin/state返回401及 `WWW-Authenticate: Basic`，正确密码返回200；设备无凭据返回JSON 401且不带Basic挑战/Access重定向，有效设备凭据应正常同步。管理员管理写请求仍必须同源JSON。首次未配置Secret/Release时清晰503，不能绕过。

## 数据、备份与预算
```
npx wrangler d1 export proxysetting --remote --output backup.sql
```
备份包含加密UUID、设备hash与用量，应仍按敏感数据保管。同时备份UUID_KEY/版本锁定；不要公开备份。日/月usage_periods保存累计JSON，10台约17,280请求/日，约28,800写行/日，额外管理和注册。监控免费额度、D1 rows_read/rows_written/storage、Worker错误率和最后同步。定期清理旧daily记录与rate_limits过期window（注册900秒、device60秒窗口，不同类型按前缀计算），避免累计无上限。免费额度不是服务SLA。

## 云端验收（需真实账号）
1. 创建VPS，root运行15分钟单次命令，等待注册和ready。
2. 创建两个身份，在每台VPS填写正GiB额度；不填不得开通/导出。
3. 导出其中一个身份JS，全VPS各一个节点；Verge Rev导入测试，第二次运行不重复。
4. 双向传输并观察月累计和last_sync；超额新连接失败（旧会话可继续）。
5. 跨北京时间月初恢复；断Cloudflare网络仍本地限额；崩溃agent/watchdog时Xray停止；Xray意外重启不放行已耗尽用户。
6. 撤销/轮换credential、过期及重复注册token拒绝；升级失败恢复旧版本。
本地测试不能替代这些真实部署和网络环境验收。
