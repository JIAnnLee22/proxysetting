# 部署 Cloudflare 免费版
## 准备发布
公开GitHub仓库，代码推送后按 `.github/workflows/release.yml` 发布固定tag（首版 `v0.1.0`）；Release需有 install.sh、两架构agent包和SHA256SUMS。首次执行脚本不能仅依赖同一下载源的校验文件：管理员审核源码/CI，取固定install.sh的SHA256，填Worker `INSTALL_SHA256`。Xray官方版本/哈希内置安装器，不用latest下载。

## D1、Worker与Secrets
```
npm ci
npx wrangler login
npx wrangler d1 create proxysetting
```
把返回ID写入 `wrangler.jsonc` 的 database_id。按需修改Worker名称；配置 `RELEASE_REPO=owner/repo`、`RELEASE_VERSION=v0.1.0`。
```
npx wrangler secret put UUID_KEY
npx wrangler secret put INSTALL_SHA256
npm run db:remote
npm run deploy
```
UUID_KEY：生成32随机字节Base64（如 `openssl rand -base64 32`），保存到密码管理器/离线备份。**丢失会导致既有UUID无法解密；不能直接替换此secret，密钥轮换需专用重加密迁移（首版不提供）**。INSTALL_SHA256是64小写hex，用于首次安装脚本固定。`.dev.vars`可用于本地测试但不能提交。`npm run verify`不要求云账号，验证本地D1和构建。

## Access（保护workers.dev，不需要VPS域名）
Cloudflare Zero Trust创建self-hosted Access application，绑定Worker的workers.dev地址。Access允许策略为明确管理员邮箱，不使用Everyone。配置ACCESS_TEAM_DOMAIN=`your-team.cloudflareaccess.com`（无scheme）、ACCESS_AUD=应用aud、ADMIN_EMAILS=逗号分隔准确邮箱。Worker验证签名、iss/aud/exp/iat/email，而不是信任邮箱请求头。
- Access保护 `/`、静态资源和 `/api/admin/*`。
- 为 `/api/agent/*` 设置路径级独立应用/策略 **Bypass**（更具体路径优先）；设备需要直接HTTPS访问。不要把admin或全站都Bypass。
- 安装文件来自固定GitHub Release，不需要Worker公开安装目录。
- **仅在有Access覆盖且验证正常时上线**。绕过Access的管理请求仍被Worker拒绝401，agent使用独立高熵token。
部署后检查：无Access直接访问根/app.js/admin/state应401或Access登录页；设备无凭据应401（不能是Access HTML登录页）；管理员管理写请求必须同源JSON。首次未配置Secret/Release时清晰503，不能绕过。

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
