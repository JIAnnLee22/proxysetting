# Cloudflare 免费版 VPS Reality 管理与分用户流量额度

## 目标与已确认决策
- 当前 `/home/jiannlee22/Project/proxy/proxysetting` 为空目录、非 Git 仓库；从零实现，不迁移已有配置。Web 部署在 Cloudflare 免费版（Worker 静态资源 + API、D1、Access），可使用 `workers.dev`，VPS 无自有域名。规模按 1–10 台 VPS、1–50 个用户/设备设计。
- **最终选择 Xray-core，不安装 sing-box**；首版只提供 VLESS/Reality。原先讨论的 sing-box、Shadowsocks 2022、Hysteria2 均被后续决策替代或推迟。每台 VPS 只导出一个节点；优先 443，冲突时报错并由 Web 指定其他端口。Reality 伪装目标从预置候选中测试选择，允许逐台覆盖，测试失败不部署。
- VPS：Debian/Ubuntu、systemd、amd64/arm64、root 或可提权安装；在 Web 添加 VPS 后获得有时效的一次性安装命令，在 VPS 上执行。**项目首版不实现内置 SSH 客户端**；SSH 仅供人工应急。公开 GitHub 仓库 + Releases 提供版本锁定的安装脚本和代理程序；Web 手动触发经校验的升级，支持失败回滚。
- Web 管理员通过 Cloudflare Access 指定邮箱登录。每个用户/设备是独立身份、独立 VLESS UUID；在**每台 VPS** 上必须先填写 GiB 月额度才能开通。用量=上行+下行，北京时间自然月重置，各 VPS 的额度彼此独立。
- VPS 本地每约 10 秒采样 Xray 的用户统计、计算用量并实施额度停用；采集结果约每 5 分钟批量上报 Cloudflare，网页标记最后同步时间。到额度使用 Xray HandlerService 动态移除该用户，**只阻止新连接**：用户确认已建立的连接可继续传输，不承诺严格零超额。月初重新添加。采集/限额进程故障时 Xray 停止（fail-closed）；Cloudflare 不可达时按已缓存的本地额度继续工作。
- 导出时选择**一个身份**，下载/复制可直接粘贴到 Clash Verge Rev 的 JS 扩展脚本；注入所有已就绪 VPS 的节点，新建 `select` 分组 `自建节点`，将此分组放入配置中其他**每一个** `select` 分组，跳过自身并防重复。没有就绪节点或列表中有尚未部署/缺失必要数据的 VPS 时明确报错，不静默漏项。导出脚本含该身份的节点密钥，不能公开分享；额度耗尽的节点仍保留，月初恢复后原脚本可继续使用。

## 关键调研及依据
- 现有项目无文件、无既有符号可引用。预期路径见下方；实际版本和接口以实现时锁定的上游发行版为准。
- Xray 官方文档：[API（StatsService、HandlerService、动态用户）](https://xtls.github.io/en/config/api.html)、[用户流量计数](https://xtls.github.io/en/config/stats.html)、[统计查询示例](https://xtls.github.io/en/document/level-2/traffic_stats.html)、[REALITY](https://xtls.github.io/en/config/transports/reality.html)。用户统计须配置 `stats`、policy 的上/下行开关与稳定唯一的 `email`，gRPC API 只监听 `127.0.0.1`。`RemoveUser` 移除认证条目，不会可靠结束已经建立的会话：[VLESS 实现](https://github.com/XTLS/Xray-core/blob/main/proxy/vless/inbound/inbound.go)。
- [Clash Verge Rev 扩展脚本](https://www.clashverge.dev/guide/script.html)使用 `function main(config)` 返回配置，运行时不能网络请求；[Mihomo VLESS 字段](https://wiki.metacubex.one/en/config/proxies/vless/)需要与 Reality 服务端参数一致。[MDN 混合内容](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)说明 HTTPS 页面不能直接 `fetch('http://IP/api')`；且 Xray 统计 API 是本地 gRPC，不是公开 REST 接口。
- [Workers 免费额度](https://developers.cloudflare.com/workers/platform/pricing/)约 100,000 请求/日，[D1 免费额度](https://developers.cloudflare.com/d1/platform/pricing/)约 100,000 行写入/日、5 GB；[Access 可保护 workers.dev Worker](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)。VPS 本地采样不消耗 Worker 请求；10 台每分钟拉取变更 + 每 5 分钟上报约 17,280 次/日（另有管理请求），批量快照每台一次写入，避免 10×50 用户逐条上报突破免费额度。额度、条款可能改变，应实测监控。

## 实施步骤（按依赖顺序）
1. **建立数据契约与 Cloudflare 骨架**：创建 `README.md`、`docs/architecture.md`、`wrangler.jsonc`、`package.json`、`migrations/0001_init.sql`、`src/worker/index.ts`。定义 VPS、身份、VPS×身份 UUID/额度、期望配置版本、设备凭据哈希、一次性安装令牌哈希、当前快照与按日/月汇总。D1 按 VPS 保存批量用户统计快照（而非每 10 秒写每用户一行）；建立索引、输入校验和幂等操作。验证：本地 D1 migration、契约/增量版本单测、免费额度预算。
2. **管理页面、安全与注册**：`src/web/*`、`src/worker/routes/admin.ts`、`src/worker/routes/agent.ts`、`src/worker/auth.ts`。Worker 同源提供列表、身份/逐台额度编辑、注册命令、就绪/最后同步/错误状态、月用量及版本升级按钮；Access 限制页面与管理 API，仅预留设备注册/同步/公开安装文件路径，后者必须使用单次短期注册令牌或逐设备独立的高熵凭据，限流、轮换与撤销。敏感 UUID 在 D1 以 Worker Secret 加密；设备凭据仅存哈希；管理 API 做 Access 身份校验与权限检查；禁止缓存或日志泄露密钥。验证：未登录拒绝、凭据过期/重放/串台拒绝、配额必填、错误处理、D1 本地集成测试。
3. **可校验的一行安装与 Xray 配置**：`scripts/install.sh`、`packaging/*`、`.github/workflows/release.yml`。CI 针对 amd64/arm64 构建管理程序并发布 SHA-256；安装器固定官方 Xray 发行版本与校验值，校验 OS、架构、权限、目标端口、外网地址与伪装目标可达性；生成 Reality 私钥（仅 VPS 本地保留）、公钥/shortId、独立 systemd 服务与本机回环 gRPC API；备份旧文件并原子切换，`xray run -test` 成功后才启用。已有服务/端口冲突不擅自覆盖；检查本机防火墙并提示云安全组放行，不静默关闭防火墙。向 Worker 完成一次性注册，回传导出所需**公有** Reality 参数。提供健康检查、人工回滚和固定版本手动升级。验证：ShellCheck、镜像/VM 中 Debian/Ubuntu × amd64/arm64 的安装、二次执行、端口冲突、错误令牌、校验失败和回滚。
4. **VPS 本地限额与同步程序**：`agent/cmd/proxysetting-agent/main.go`、`agent/internal/{xray,usage,state,sync}/*`、`agent/go.mod`。用锁定版本的 Xray gRPC protobuf 客户端读 StatsService 并调用 HandlerService AddUser/RemoveUser；按稳定 `email` 匹配身份；每 10 秒读取**不清零**计数，持久化原始计数基线、单月上下行、已停用状态（原子写入+fsync），识别计数器回退/重启。触及额度先保存状态再移除用户，并持续记录仍存活的旧会话；月初由本地时钟恢复。约每分钟拉取修订号/用户额度，约每 5 分钟批量推送快照，离线重试/去重，校验凭据；重启后从本地状态恢复，安装/升级前先采样。systemd 设置健康检查与进程故障联动：采集程序持续失效则停 Xray，避免无计量运行。验证：跨月边界、并发用户、计数器归零/进程重启、断网重试、超额动态移除/恢复、故障 fail-closed 的单元与端到端测试。
5. **Verge Rev 脚本导出**：`src/worker/export-verge.ts`、`src/worker/routes/admin.ts` 与 `src/web/*`。仅在 Access 授权下针对所选身份构建 Mihomo VLESS/Reality 对象，节点名按 VPS ID 保持唯一且稳定，序列化为 JS 字面量避免注入。`main(config)` 幂等注入节点与 `自建节点` 组；跳过自身，其他 `select` 组各添加一次，保留原顺序/其他字段；现有同名但非本脚本创建的节点/分组冲突时报清晰错误，避免覆盖用户配置；空配置或无其他 select 组也要有效。下载与复制均不缓存。验证：用包含嵌套组、无组、重复执行、同名冲突、恶意名称的 fixture 检查脚本；有条件时用 Mihomo 校验最终配置，人工在 Verge Rev 导入。
6. **上线说明与验收**：`docs/deploy-cloudflare.md`、`docs/install-vps.md`、`docs/security.md`、`README.md`。说明 GitHub Release 版本与校验、Wrangler D1/Worker 部署、Access 按路径保护（不要挡住设备接口，也不能裸露管理接口）、Worker Secret 配置及备份、设备吊销/重装、无域名 `workers.dev`、端口与云防火墙、升级回滚、导出脚本更新、免费额度与状态监控。验收路径：创建 VPS→获取一次性命令→VPS 自动注册→创建身份并填写每台额度→导出一个用户所有节点→消费流量并观察上下行/月度汇总→超额后新连接失败→北京时间次月恢复；同时测试 Cloudflare 离线、本地程序崩溃和 Xray 意外重启。

## 风险与边界
- **非硬实时断流**：每 10 秒采样可超额；选定的动态移除不会终止既有长连接。已向用户确认接受这一行为；若以后要求严格硬限额，需要单用户连接强制中断/独立实例等新方案。
- **重启丢计量窗口**：Xray 内存计数器在意外停止时可能丢失自上次采样以来的字节；本地持久化只能缩小窗口，不能保证计费级零误差。常规升级前采样并备份。
- **服务可用性与成本**：本地采集程序故障会停止 Xray；Cloudflare/`workers.dev` 在个别 VPS 网络环境可能无法访问，届时本地已下发额度可继续生效，但管理更改/网页数据延迟。Cloudflare 免费额度并非无限，超过限额会影响同步；需展示最后成功同步时间并监控使用量。
- **安全与发布**：导出 JS/注册命令含敏感信息，不要在日志、公开仓库或不受信下载缓存中保存；Worker API 必须区分 Access 管理路径与设备鉴权路径。无 VPS 域名不影响 Reality，但伪装目标可达性和云安全组须逐台验证。公开 GitHub Releases 需固定版本、校验产物，不能直接执行不受校验的远端脚本。
- 不采用浏览器直连 `http://IP/api`（混合内容 + 无公开 REST + 不安全）；不加 SSH 批量 CLI、Hysteria2、SS2022 或自编译 sing-box（与最终决定不符）。实施时需提供实际 Cloudflare 账号、Access 邮箱、GitHub 仓库地址及各 VPS 地址/额度，它们是部署数据，不是未决架构选择。

## 执行记录与实际差异（2026-09-30）
- 六个实施步骤的代码、文档与可运行本地验证已实现。源码从空目录建立 Git 初始契约提交，用独立 worktree 实施并审查合并；未提交用户的新实现，也未发布GitHub Release或部署真实Cloudflare。完整结果见 `docs/verification.md`。
- 固定 Xray 官方 `v26.3.27`；Go官方模块对应 `v1.260327.0`，Go 1.26+；官方amd64/arm64 ZIP SHA256写入安装器。Node 24，npm lockfile锁定工具链。首次实现曾将初装锁为v0.1.0；公开CI修订后改为显式固定语义版本（拒绝latest）加agent编译版本匹配，Web仍锁定具体Release及安装器SHA256。
- 数据契约补充当前月云端usage seed：重装空root按每方向max(local,reported)恢复已经上报的用量，不把已用额度清零。尚未上报的窗口仍需本地state备份。首版只接收公网字面IPv4/IPv6；GiB支持小数，向上舍入至整数byte。未部署VPS可从Web编辑地址/端口/目标（443冲突时改其他端口），同时使旧注册令牌失效；已注册设备禁止在线修改这些固定参数，需显式重装。
- 日汇总具体采用“月累计用量的日末观测快照”，不是精确日账单，页面和文档明确标注；月计量仍为上下行累计。跨月aggregate计数无法精确切分，首个跨月采样窗口最多约10秒不计入新月，是额外非计费级计量边界。
- 网络同步/发布下载使用独立异步任务，只有本地采样主循环修改持久化状态，Cloudflare慢请求不阻塞10秒限额。systemd停止Xray使用no-block避免关闭排序死锁；WatchdogSignal=SIGKILL防SIGSTOP卡死等待core dump，Xray BindsTo/PartOf agent，静态clients为空。
- 实际验证：Worker/D1/Access/导出24测试、migration/dry-run通过；Go单测/vet/race、两架构cross-build通过；ShellCheck与26安装/回滚mock通过；校验官方Mihomo v1.19.31后配置检查通过；官方Xray真实Reality流量/动态限额/跨月/旧会话继续计量集成通过。
- 用户另授权 `root@144.202.123.93` 测试。实际机器为Arch Linux amd64，已有sing-box占用TCP/UDP443，UFW仅22/443，不属于批准的生产安装支持范围。没有覆盖旧服务、没有更改防火墙、没有正式安装；仅隔离目录/临时systemd units/本机HTTPS mock完成真实READY、崩溃BindsTo、Xray重启、65秒控制面离线、45秒watchdog、最终采样及停止无死锁测试，并在该VPS通过真实Reality流量集成。测试后全部临时文件/服务清理，原sing-box PID2848与防火墙不变。
- **未完成外部上线验收**：真实Cloudflare账号/Access路径政策/D1、公开GitHub Release一行首装及升级、Debian/Ubuntu×amd64/arm64四种真实安装环境、Verge Rev桌面人工导入/公网云安全组可达性。提供的Arch机测试不替代该矩阵；这些项需要部署数据/环境后继续。

## 用户追加：GitHub发布与Arch测试机部署
- 发布仓库明确为 `git@github.com:JIAnnLee22/proxysetting.git`，公开仓库；保留首个tag `v0.1.0`（CI旧ShellCheck兼容性失败，未发布资产），修复版本为 `v0.1.1`，不重写旧tag；GitHub Actions生成安装器/双架构包/SHA256SUMS，并允许固定tag的人工dispatch发布。不包含私钥、凭据、本地测试数据或构建缓存。
- 管理员邮箱明确为 `jiannlee22@gmail.com`。用户已完成Wrangler OAuth登录；新建独立proxysetting D1并应用migration，Worker真实部署至 `https://proxysetting.jiannlee22.workers.dev`。旧sing-box-subscription数据库未改动。UUID_KEY随机生成，另备份至仓库外的用户私有配置目录（0700目录/0600文件），未随Git或发布包上传。OAuth没有Access管理权限（403）；用户已提供真实team/AUD，已规范域名并部署Worker参数。主站/静态资源/管理API匿名请求302至该团队登录页，AUD匹配，JWKS200；实际邮箱登录仍待用户验证。设备路径也302（默认Python UA曾403，按agent UA探测为302），表明Bypass未生效；VPS当前active/ready、本地额度继续，云端同步受阻，需用户补路径例外，不放宽管理鉴权。
- 用户明确要求在已授权Arch测试机上停用sing-box并安装本项目，不要求生产式迁移。原Debian/Ubuntu限制扩展为Debian/Ubuntu/Arch Linux（amd64/arm64）；安装器与回归测试同步更新，已有的Xray版本锁定和服务归属/端口保护不变。
- sing-box已停止、取消开机启动并mask，备份保留。v0.1.1公开CI、双架构发布与SHA256验收通过；Arch上通过真实Worker单次令牌注册并安装，agent/Xray active，agent enabled，Xray仅开放TCP443和回环10085，秘密/计量文件0600，防火墙未改。
- 真实目标兼容性差异：该VPS的www.microsoft.com通过TLS1.3探测但Reality握手失败；隔离比较确认www.cloudflare.com成功。保留旧安装并显式重装更换目标，不在Web放宽已注册参数修改。公网Chrome/VLESS/Reality+vision请求ipify返回144.202.123.93。
- 通过真实D1改测试身份额度：64byte时上报uplink1918/downlink4631/disabled=true且新连接失败；恢复1GiB后新连接成功、云快照disabled=false。配置轮询60秒/上报300秒，测试不假设快照每分钟刷新。该轮真实设备注册/统计/配置链路已验证可用；随后用户启用Access，管理入口已转登录页，但设备路径也被保护，当前同步暂受阻，等待修复Bypass。
- 手动systemctl restart agent首次出现关停Xray任务抢占启动、30秒本地API超时后5秒自动恢复；已记录局限，操作文档改用stop两服务再start agent；升级器原本使用有序stop/start。独立安全审查无可用结论，不作为安全审计通过。详细结果见docs/verification.md。
