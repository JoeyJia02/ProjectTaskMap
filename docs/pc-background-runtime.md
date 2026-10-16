# PC 后台运行

任务地图的 Node 后端独立运行，关闭 ChatGPT 或 Codex 窗口不会主动停止它。其他机器使用时，需要这台 PC 开机联网、Windows 用户已登录，且 PC 不进入睡眠或休眠。锁屏可以；本方案不承诺在注销用户后继续运行。

## 后台维护

`scripts/install-runtime-task.ps1` 注册仅属于当前仓库的 Windows 计划任务，使用当前用户的普通权限，不存储密码。用户登录时启动，并每分钟触发检查；已有维护进程运行时忽略重复启动。任务在隐藏窗口里运行，不依赖开发终端。

维护程序恢复停止的本地 3000 后端。未配置固定入口时，它同时维护 `.tmp/chatgpt-preview.json` 记录的临时接入 3001 后端；存在通过校验的 `data/public-runtime.json` 时，则维护固定入口的 3002 后端并检查固定公网地址。它使用已有配置和数据库，不更改项目状态。只在接口明确拒绝连接时启动后端，遇到其他端口占用、服务身份不符或超时时保留现状并报告，不杀死未知进程，也不会自动重建隧道或改变域名。

```powershell
powershell.exe -NoProfile -File scripts/install-runtime-task.ps1 -Plan
powershell.exe -NoProfile -File scripts/install-runtime-task.ps1
```

安装后需要确认计划任务确实处于运行状态，并检查 `.tmp/runtime-maintenance.json`。仅有脚本文件不代表已经安装。状态和启动日志保存在被 Git 忽略的 `.tmp/`，不含密钥或令牌。

如需停止自动维护：

```powershell
powershell.exe -NoProfile -File scripts/install-runtime-task.ps1 -Remove
```

此命令只移除本仓库的维护任务，不删数据，也不主动停止已经独立启动的后端。

更新维护脚本或切换入口配置后，使用 `powershell.exe -NoProfile -File scripts/install-runtime-task.ps1 -Restart`。它先核对计划任务身份，再停止与本仓库完整启动命令匹配的旧检查器并重新启动；避免 Windows 结束计划任务后留下 Node 子进程。它保留任务地图后端和数据库。

## 固定远程入口仍需配置

自动维护不会重新创建 Quick Tunnel，也不会替换 ChatGPT 的连接地址。这避免悄悄更改 OAuth issuer，使已有插件连接失效。当前临时隧道进程退出后，自动恢复后端仍不足以恢复远程接入；固定隧道的配置、后台运行和真实账号授权必须另行完成。

有域名时，可使用自己控制的域名和 Cloudflare 固定隧道。它允许 PC 在没有公网 IP 的情况下接受插件访问，但要求域名和 Cloudflare 账号的授权。固定隧道客户端需要独立配置为系统服务；本计划任务并未完成这项工作。

没有域名时，可以评估 Tailscale Funnel 提供的 `设备名.网络名.ts.net` HTTPS 地址，不需要购买自己的域名。它允许没有安装 Tailscale 的外部客户端访问；开启后台模式后可在设备重启时恢复共享。需要在 PC 安装客户端、登录自己的账号并授权 HTTPS/Funnel，服务端仍保持应用的 OAuth 边界。地址依赖设备和网络名称，应保持这些名称及账号配置稳定。Funnel 目前为 beta，存在带宽限制；实际环境可达性、授权和界面加载验收完成前，不能宣称已替换临时隧道。

OpenAI Secure MCP Tunnel 是另一种私有 MCP 接入方式，需要 Platform 隧道权限与运行密钥；现有应用的浏览器 OAuth 授权服务不能假定会随 MCP 一起被转发，需验证授权页可达性后才能替换现有连接。

- [Cloudflare 固定隧道与 Windows 服务](https://developers.cloudflare.com/tunnel/get-started/)
- [Quick Tunnel 限制](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [OpenAI Secure MCP Tunnel 与 OAuth 边界](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Tailscale Funnel 地址及限制](https://tailscale.com/docs/features/tailscale-funnel)
- [Tailscale Funnel 后台及重启恢复](https://tailscale.com/docs/reference/tailscale-cli/funnel)

## 本机已验证（2026-09-30）

已安装本仓库的 `ProjectTaskMap-Runtime-42EAEC680BA6` 当前用户计划任务，核对维护进程独立运行。短暂停止经过端口及启动路径核对的本地 3000 后端后，后台维护自动恢复了它；3001 公网后端没有停止。证据见 `.tmp/runtime-recovery-verification.json`，本地、公网后端及当前临时入口健康状态见 `.tmp/runtime-maintenance.json`。本次验证未改业务任务数据。

`npm run check` 通过（102 项测试及构建）。未实际注销 Windows、重启 PC 或关闭整个桌面应用作验收。固定入口后端停止恢复检查也已通过，记录在 `.tmp/fixed-recovery-verification.json`。

## D 盘固定入口准备（2026-09-30）

官方签名的 Tailscale 1.102.4 已安装到 `D:\Tailscale`，Windows 后台服务的实际程序路径为 `D:\Tailscale\tailscaled.exe`，并已运行。Windows IP Helper 原先被禁用，安装时恢复为手动启动；原始状态记录在 `.tmp/tailscale-service-prerequisite.json`。系统服务注册、驱动及 Windows Installer 缓存仍由 Windows 管理，不能把“程序安装在 D 盘”理解为 C 盘完全没有相关文件。

账号登录和设备连接已完成，客户端报告设备在线且无健康告警。实际固定 origin 为 `https://project-task-map.taile1a438.ts.net`。`scripts/configure-fixed-entry.mjs` 从已运行的官方客户端读取设备域名，仅在被 Git 忽略的 `data/public-runtime.json` 保存提供商、公网 origin 和 3002 端口；客户端身份和密钥不进入日志。若设备域名与已有配置不同，脚本拒绝自动替换。

`scripts/start-public.mjs` 已启动并核对 3002 后端，复用现有数据库和应用密钥；不停止当前 3000/3001 服务。本仓库维护任务已重新启动，加载固定入口配置，并核对只剩一个检查进程。设备所有者已完成 HTTPS/Funnel 的首次授权，官方客户端的实际配置确认只通过 443 HTTPS 转发 `http://127.0.0.1:3002`，Funnel 已开启。公网 `/health` 及 OAuth discovery 返回 200，且 issuer 与固定域名一致。

公网 OAuth 授权码/PKCE、刷新轮换、未授权 MCP 拒绝、工具发现、验证项目的宿主桥接读取和新版 UI 资源读取均已检查通过，不改业务任务数据。旧版资源兼容检查首轮出现网络超时，增加大资源检查的等待上限后复测通过：v3 当前入口及 v1/v2 别名均可读取，验证项目的状态及版本完整保留。完整复测报告见 `.tmp/fixed-entry-verification.json`；这证明当前入口的协议可用，不保证网络永远无超时。真实 ChatGPT 连接切换及界面操作尚待验收；旧临时地址上的授权不能直接用于新 issuer，应为固定地址完成一次新的 OAuth 授权，继续使用原有项目 bindingKey。

## 所有者剩余操作

1. 在现有 MCP 应用管理中将服务器 URL 更新为 `https://project-task-map.taile1a438.ts.net/mcp`；若产品界面不提供 URL 编辑，则为这个地址创建 MCP 应用连接。验证方式选 OAuth，不需要上传 MCP 压缩包。
2. 在这个固定域名的授权页完成一次应用 OAuth 授权，保留原有各项目 bindingKey。
3. 在目标会话打开任务地图，核对任务数量及当前焦点，并从另一台机器读取同一绑定。

无需再次点击已经生效的 Enable Funnel。PC 必须开机联网、不睡眠，当前方案还要求 Windows 用户保持登录；可锁屏及关闭 ChatGPT/Codex 窗口。

应用计划任务仍使用当前 Windows 登录用户。Tailscale 已确认无人值守模式开启，不接管 DNS，也不接受其他设备发布的路由；它的系统服务独立于 ChatGPT 窗口。注销后的应用后端运行未验证，不能视为完成。设备授权也可能到期，固定地址不等于永远无需授权。
