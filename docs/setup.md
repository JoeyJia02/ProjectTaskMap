# 安装与运维

## 运行方式

Node.js 24.x。SQLite 使用 Node 内建 `node:sqlite`，无需 Python 编译链或单独数据库服务；此 API 在所用 Node 版本可能发出实验性提示，升级 Node 时需重跑测试。

首次运行 `npm ci`、`node scripts/setup.mjs`、`npm run build`、`npm start`。setup 不覆盖已有 `.env`。修改环境后重启进程。开发用 `npm run dev` 和 `npm run dev:ui`。

## 配置

| 变量 | 用途 |
|---|---|
| TASK_MAP_OWNER_SECRET | 32+ 字符随机部署者密钥，用于初始化和 OAuth 授权页；不要给模型。 |
| TASK_MAP_SIGNING_SECRET | 独立随机签名密钥；改变后所有能力令牌失效。 |
| TASK_MAP_PUBLIC_URL | 外部可访问的 origin，无路径、query、用户名密码；非本机必须 HTTPS。 |
| TASK_MAP_WIDGET_ORIGIN | 组件声明的明确 HTTPS origin，默认官方开发 sandbox；正式提交需专属 origin。默认值及其已验证的实际 sandbox 来源自动加入精确 CORS 允许列表；自定义域的实际框架来源需在 TASK_MAP_ALLOWED_ORIGINS 中明确列出。 |
| TASK_MAP_ALLOWED_ORIGINS | 逗号分隔的 UI origin，无通配符；不需要允许任意互联网域。 |
| TASK_MAP_DB | 持久 SQLite 路径，默认 data/task-map.sqlite。 |
| TASK_MAP_DIAGNOSTICS | 默认关闭；设为 `1` 后在标准输出记录脱敏的连接请求诊断，排查后关闭。 |
| TASK_MAP_HOST / PORT | 默认 127.0.0.1:3000；容器内可监听 0.0.0.0。 |

每个部署仅支持一个个人 owner，可保存多个隔离的项目。不要把此配置当多人账号系统。启动需要两个不同的强密钥；无默认生产密码。不要把密钥放 URL/Project instructions/GitHub/截图。

## HTTPS 部署

可使用自有服务器/容器 + TLS 反向代理；本仓库提供 Dockerfile。为 `/app/data` 挂持久卷，通过环境传入密钥和公网 HTTPS origin；确保代理转发 Authorization 和 MCP 请求头，允许 POST `/mcp` 与 OAuth discovery。MCP 使用无会话 Streamable HTTP，不需额外后台队列。不要用临时容器文件系统存数据库。

Dockerfile 已提供，未在当前 Windows 环境执行 Docker 构建。真实部署、域名、TLS、ChatGPT 账号授权不由本地测试代替。开发可按官方指南使用 Secure MCP Tunnel 或临时 HTTPS 隧道；不要将临时隧道 URL 当长期绑定身份。

OAuth 使用动态客户端注册、code+PKCE S256、双权限个人授权、一次性 code。访问 token 与 UI 项目 token 最长一小时；OAuth 支持轮换刷新令牌，授权最长 30 天，支持的客户端可自动续期。客户端注册和刷新授权与项目共用持久 SQLite；刷新令牌只保存哈希，检测旧令牌重放会撤销同一授权及派生的 UI 访问权限。owner/signing 密钥或 issuer 变化会使旧授权失效。授权页意图与一次性 code 仍只保存在内存，重启时正在进行的登录需要重试。服务不记录输入密钥或 token。

Windows 本地接入完成后可双击根目录 `启动任务地图.cmd`，或执行 `node scripts/start-local.mjs`。它检测现有服务并在需要时隐藏启动本项目后端，不创建开机计划任务；运行日志写入被 Git 忽略的 `.tmp/`。初次构建和 `.env` 仍需完成。真实协议检查使用 `node scripts/verify-local-mcp.mjs --refresh-check`，只操作单独的“接入验证”项目。重启后使用 `--read-only --refresh-check` 核对原状态。

需要关闭 ChatGPT/Codex 后继续运行时，可使用独立的 [PC 后台维护](pc-background-runtime.md) 安装脚本。它注册当前用户登录后运行的计划任务并恢复停止的后端；固定远程入口与隧道客户端仍需单独配置。

## 备份与恢复

```sh
node scripts/backup.mjs data/backup-2026-09-26.sqlite
```

该命令使用 SQLite online backup，不会覆盖已有目标。备份包含项目状态、绑定、历史和证据，须与数据库同级保护。不要在 WAL 活动时只复制主文件而遗漏 WAL。

恢复时先停止服务，将备份恢复到一个**新文件路径**并修改 `TASK_MAP_DB`，保留旧文件以便回退，再启动核对绑定、节点数、版本与历史。不会自动迁移或删除旧数据库。项目内容层面的回退可在 UI 历史中预览并确认；它写入新版本，不抹掉历史。

## 诊断

遇到客户端仅显示“无法创建 MCP 应用”时，可临时启用 `TASK_MAP_DIAGNOSTICS=1` 并重启后端，再复现一次。日志仅保留时间、白名单方法/路由标签、状态码、耗时和来源分类；未知路径统一记为 `other`，不记录原始 URL、查询参数、请求或响应内容及凭据。运行日志存放在被忽略的 `.tmp/`，不提交到仓库。

- `/health` 返回版本但不披露项目数据。
- 401：缺少/过期凭据，重新授权；不要把 owner secret 当 MCP access token。
- 403：项目 token 跨项目或 iframe origin 不在允许列表；核对 `TASK_MAP_WIDGET_ORIGIN`。
- 组件 `Failed to fetch` 且 API OPTIONS 返回 403：核对实际浏览器来源。默认声明 `https://web-sandbox.oaiusercontent.com` 在已验证宿主中实际使用 `https://web-sandbox-oaiusercontent-com.web-sandbox.oaiusercontent.com`，服务已兼容这两个精确来源；不接受任意 sandbox 子域或 `null`。
- 400：schema/JSON/项目 ID 不合法；不要在客户端吞错。
- pending：查看待审理由，保留原状态；补正证据或明确人工批准。
- UI Refresh 显示等待：只是请求了模型输出概况，必须得到 reconcile 结果才算同步完成。

本地自动测试和浏览器截图在 [产品验收](product-review.md) 记录。上线前仍需使用真实账号验收来源元数据、OAuth回调和组件 CSP。
