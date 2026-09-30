# 架构
浏览器只访问同源 HTTPS Worker。Worker 验证 Cloudflare Access JWT 的 issuer、audience、签名、有效期及明确邮箱名单；设备路径不使用 Access，独立 bearer 凭据。静态资源也先经过 Worker 验证；同源 JSON 管理写操作拒绝跨域 Origin。Worker 返回 `no-store` 和 CSP，不记录请求体/凭据。

D1：VPS 期望 revision，身份，VPS×身份独立加密 UUID/必填正 GiB 额度；注册令牌和设备凭据仅 SHA256 哈希。注册15分钟单次CAS消费；设备可轮换/撤销。所有注册信息只包含公有Reality参数。私钥留在VPS的0600配置中。绑定UUID密文的AES-GCM AAD为VPS×身份，UUID_KEY必须32字节保密。

未部署VPS允许Web编辑IP/端口/SNI，修改即撤销旧安装令牌；注册后的固定参数不得在线变更。VPS本地Xray API仅127.0.0.1:10085，VLESS inbound tag `vless-reality`。独立Go代理每10秒不清零采样、原子持久化+fsync，达额度先持久化再RemoveUser；旧会话仍被计量。自然月按Asia/Shanghai复位再恢复AddUser。Xray重启不从静态配置重新放行用户：静态clients为空，代理依据持久化用量恢复。进程失败/watchdog使Xray停止。Cloudflare失败不影响缓存配额，401/403退出并fail-closed。

设备每分钟拉取期望配置，每5分钟上传单VPS JSON快照；带单调sequence，Worker幂等防回退，保存最新快照及VPS×月/日快照汇总。日记录是月累计快照的最后观测值，不是逐日精确账单；两日差值可观察日增量，第一条/跨月或离线缺日需注明估算。网页显示各方向和最后同步时间，不能误认为实时流量。

## 免费版预算（10台/50身份）
- 每日请求：10×(1440次配置+288次快照)=17,280，另加管理/注册。
- 每日写行约28,800：每请求1限流记录写 + 每快照4行（snapshot/月/日/VPS）。每日读行配置约≤720,000（50 grants×14,400 +认证等）；仍需监控D1 rows_read，免费常见上限5,000,000/日。
- 相比每10秒每用户逐行写，批量JSON快照不消耗每用户每次D1写行；日行需按保留策略定期清理，50用户约6KiB×365×10≈22MiB/年。
- 免费额度与API支持可能变动，以部署时控制台为准。限流键设备最多10行，注册按来源IP可增长；定期删除过期窗口，面对公网上游攻击需Cloudflare规则/WAF或独立防护。

升级仅管理端触发固定GitHub仓库tag，SHA256验证下载产物；发布流程生成SHA256SUMS，初次安装脚本hash人工固定到Worker。未内置SSH、不安装sing-box/SS2022/Hysteria2。
