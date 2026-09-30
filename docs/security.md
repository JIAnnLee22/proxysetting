# 安全与已知边界
## 威胁模型
保护管理端、用户UUID、Reality私钥、安装与设备凭据；不防被root控制的VPS故意伪造统计或泄露配置。第三方GitHub/Cloudflare账户安全是信任根。首次安装SHA256应来自管理员审核的固定发布。以后升级仅取配置固定仓库/tag和SHA256SUMS，依赖HTTPS及该仓库发布权限，不是独立签名/离线供应链验证。

## 身份与秘密
- Access JWT经JWKS验签、iss/aud/过期和邮箱allowlist；不能只信任Cf-Access-Authenticated-User-Email。
- 管理写同源Origin+application/json，静态/管理API均经Worker鉴权；所有响应no-store/CSP，不开CORS。
- UUID AES-256-GCM+VPS/身份AAD，Worker secret保管，D1仅密文。Reality私钥不上传。
- 注册令牌随机256bit、15分钟、哈希存储、一次性CAS绑定目标地址/端口/SNI；设备token随机256bit独立、仅hash，支持rotate/revoke。
- 设备文件0600，目录限制访问，systemd只使用配置路径；禁止把token打印在日志。一次性安装命令含token，浏览器剪贴板/终端历史也属于泄密面，执行前关闭历史（`set +o history`）并清除剪贴板。若注册已消费但响应丢失，请管理员重新签发，不放宽重放保护。
- 首版轮换设备凭据若服务器已成功但客户端本地保存失败，会锁出；用重新注册恢复。云端撤销只能在设备下次请求时生效，离线设备仍按缓存额度运行，需要强制停止时人工关机/停服务。

## 服务与计量
每10秒采样，不保证硬实时、零超额。RemoveUser只拒绝新连接，旧连接继续计量且可超过额度。Xray内存counter异常停止后可能损失最后采样窗口；counter回退按新起点累计，不能还原未采集字节。跨月aggregate计数无法精确切分：首个跨月采样窗口最多约10秒不计入新月，也有计量误差。常规升级先停agent触发采样、保存状态，勿删除state目录。

Xray静态clients为空，启动必须等agent用持久化额度恢复用户；无月额度不创建认证。采集进程失败/watchdog和本地API持续失效停Xray；Cloudflare网络/5xx使用缓存，401/403退出。云端用量seed防重装清空已上报额度，但还未上报的最多5分钟仅在本地state，重装丢state仍可损失该窗口。备份本地state与config，不把其当作精确账单。

## 网络与运维
不暴露10085 gRPC API、不允许浏览器直连HTTP VPS。公网仅VLESS端口；防火墙和云安全组需要管理员放行，不关闭全局防火墙。需启用可信时间同步/NTP（证书和北京时间月额度依赖正确时钟）；Reality目标需TLS1.3可达，所选网站/本地法规与服务条款由部署者自行确认。目标测试失败不部署；无域名可用VPS公网IP。

注册限流每IP10次/15分钟，设备30次/分钟，body64KiB。应用级D1限流不是DDoS防护，攻击流量本身消耗Worker和D1额度；对公网agent路径配置可用的Cloudflare防护/速率规则、监控并清理旧IP限流行。没有内置SSH或开放控制面到VPS。

## 外部验收前不承诺
本地mock shell测试和Go/Xray集成测试不等于Debian/Ubuntu×amd64/arm64四种真实systemd启动/崩溃验收；Cross-build只证明编译。Cloudflare真实Access路径政策与Verge UI导入也必须上线前测试。
