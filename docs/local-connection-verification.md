# 本地接入验收记录

日期：2026-09-27。此记录只包含非敏感状态，不保存令牌、密钥或授权 URL。

| 项目 | 结果 |
|---|---|
| 生产构建 | 通过 |
| 单元/集成测试 | 78 / 78 通过（含 OAuth 续期、授权页面来源/CSP、MCP 认证顺序、实际组件来源回归及 3 项诊断日志脱敏测试） |
| 浏览器测试 | 3 / 3 通过，Chrome，独立数据库；新增真实原生表单授权、跨源回跳、PKCE 交换和刷新 |
| 标准 OAuth DCR + PKCE + cookie 绑定授权 | 通过 |
| 刷新令牌轮换 | 通过；30 天绝对有效期、重放撤销及派生 UI 撤销均有回归测试 |
| MCP 工具发现 | 7 个工具 |
| 创建、完成、重读、导出 | 通过，仅操作独立接入验证项目 |
| 服务重启后验证项目 | 同一 projectId，版本仍为 2，无重复写入 |
| Codex CLI OAuth 登录 | 成功 |
| 重启后 Codex 实际 app-server 连接状态 | oAuth，已发现7个工具；仅查询元数据，没有启动模型回合 |
| 模型实际读图 | 用户明确允许后，当前 Codex 任务直接调用 get_project_map 成功：Project Task Map，版本 0，0 个任务；无须另开任务 |
| 普通 ChatGPT 插件及客户端内嵌界面 | 用户确认“已连接”；实际账号 OAuth 令牌交换与 MCP HTTP 成功响应已有日志证据，地图读取结果及内嵌界面仍待验收 |
| 创建失败诊断 | 2026-09-27 重试日志显示 POST /mcp 返回 415，后续两项 discovery 为 200，另有尚未识别路径的 404，无注册或授权请求；URL 确实可达。MCP 认证检查已前移到媒体类型校验与 JSON 解析之前，未认证探测返回 401 和 WWW-Authenticate。仍需实际账号重试确认创建结果 |
| 桌面客户端入口 | 用户截图确认：插件 → 添加 → 创建 MCP 应用，表单支持服务器 URL 和 OAuth |
| 临时 HTTPS 准备 | 用户明确授权后已启动 Cloudflare Quick Tunnel；官方 cloudflared 2026.9.3 匹配官方 SHA-256；HTTP/2 转发到独立 127.0.0.1:3001，保留原本地 3000 配置 |
| 公网协议验收 | HTTPS health、OAuth discovery、无凭据 MCP 401、DCR、PKCE、刷新轮换及 7 个工具均通过；部署者密钥仅在回环接口完成测试授权 |
| 授权页报错修复 | 浏览器复现 no-referrer 导致原生表单 Origin:null/403；仅授权 GET 页改为 same-origin。CSP 仅加入经过严格校验的当前回调 origin，修复 Chrome 对跨源 303 的阻断；回跳仍无 Referer、无密钥请求体，null/恶意来源继续被拒绝 |
| 公网地图与界面资源 | 只读原接入测试项目，版本仍为 2；UI HTML、公开 API 地址与 CSP 已验证。未在普通 ChatGPT 客户端完成实际渲染验收 |

服务地址为本机 http://127.0.0.1:3000，MCP 路径 /mcp。Codex 用户配置新增 project_task_map，保留原有连接；通过 CLI 正常保存 OAuth 凭据。

真实项目 bindingKey 为 project-task-map-development，初始为空地图；接入测试使用 taskmap-local-verification，不混入真实项目。

运行时证据保存在被 Git 忽略的 .tmp/local-mcp-verification.json、.tmp/codex-mcp-status.json 和 .tmp/current-task-map-read.json。当前任务直接读图的工具调用也记录在本对话中；未执行此前被拦截的独立 Codex 验收进程。本机已有数据库在变更前通过 SQLite online backup 备份；数据、备份、密钥和凭据均未提交。

临时接入状态记录在 .tmp/chatgpt-preview.json；公网检查报告在 .tmp/chatgpt-preview-verification.json（ok=true）。只读测试使用原验证项目，未修改真实项目。代理程序和日志也位于被忽略的 .tmp 目录。

上述授权修复已在 2026-09-26 应用到 3001 临时接入后端，保留原公网地址。重启后重新验证公开授权页 Referrer-Policy 与精确 CSP、OAuth 和 MCP 均通过；用户需要从 ChatGPT 重新发起一次授权，旧的未完成授权页不能继续提交。

2026-09-27 07:33（北京时间）启用诊断后，再次完成公开 HTTPS、OAuth、7 个 MCP 工具和 UI 资源只读验证，原接入验证项目仍为版本 2。普通客户端创建是否成功须由实际重试结果确认，协议验收不能代替账号联调。

2026-09-27 09:09（北京时间）部署 MCP 认证顺序修复，保留原临时地址。公开空 POST、非 JSON 和畸形 JSON 的未认证探测均返回 401 及正确发现提示；有效凭据仍经过格式校验，Origin 拒绝保持不变。OAuth、刷新、7 个工具、UI 资源和只读测试项目再次通过，项目版本仍为 2。参考 [OpenAI 官方认证文档](https://developers.openai.com/plugins/build/auth) 的未认证请求挑战要求。

后续实际客户端重试仍失败：日志为 MCP 401、受保护资源元数据 200、OAuth 元数据 200、OpenID 配置 404，未发起注册或授权。正式 MCP SDK 对真实公网配置的只读发现通过，无需 OpenID 回退（证据 `.tmp/public-discovery-verification.json`）。没有据此盲加 OpenID 端点或放宽认证。用户随后确认“个人”列表已经存在 Project Task Map，接下来复用该条目核验 URL 和授权状态，不再重复创建；条目存在不代表授权及工具调用已经成功。

2026-09-27 09:18（北京时间）现有条目的实际授权请求返回 303、令牌交换返回 200，随后多条 MCP POST 返回 200/202。用户确认客户端显示“已连接”。日志仅记录 HTTP 状态，不能据此断言业务工具结果或界面渲染成功；下一步是在客户端选择已有应用，以真实 bindingKey 发起只读打开地图。创建窗口的通用报错原因仍未完全确认，连接成功不等同于该创建路径已经修复。

09:30 用户在当前对话选择远程插件后，bind_project 与 get_project_map 成功读取真实项目，版本 0、任务数 0。用户截图确认组件已渲染，但浏览器 API 预检被 403 拒绝。临时观察仅记录公开 sandbox Origin，确认实际值是 `https://web-sandbox-oaiusercontent-com.web-sandbox.oaiusercontent.com`；与声明域名不同。09:35 部署精确来源兼容修复并移除临时观察模块的启动参数，保留授权与数据。其它 sandbox 子域、恶意域与 null 仍被拒绝，允许来源下无凭据仍返回 401。地图空白来自尚未录入任务，与 CORS 故障分开处理。

09:35:50 与 09:36:06 连续两轮实际组件轮询已恢复：预检为 204，后续三项 GET 均为 200；期间未运行模拟 API 读取。证据来自现有客户端自行重试，非仅本地测试。实际画面错误提示是否消失仍以用户端显示为准。

新增双击启动入口，未创建开机计划任务。普通 ChatGPT 入口与公网协议已验证；账号创建和授权、内嵌 UI 仍待实际联调。临时隧道仅用于开发验证；全天在线需要稳定的部署。

## 2026-09-27 快速 Parking Lot

新增一句话人工记录、任务多选关联、详情反向关联、想法编辑、置顶/优先级与自动展示排序。`npm run check`：83 项测试通过，类型检查与构建通过。独立 Chrome 端到端测试验证录入、关联、编辑、页面重载持久化及 430px 布局；截图保存在 `.tmp/parking-desktop.png` 和 `.tmp/parking-narrow.png`。测试只使用独立验证数据库，不写入业务项目。现有已加载的宿主页面需要重新打开才能加载新版前端；真实宿主新界面验收待用户确认。

## 2026-09-27 滚动白屏防护

用户报告向下滚动后白屏且向上无法恢复，真实客户端根因尚未复现。关闭 SDK 修改 documentElement 高度的自动测量，改为测量 root 内容、过滤隐藏零尺寸、合并通知并在卸载时清理观察器。增加 React 渲染错误边界及恢复按钮。85 项单元/集成测试通过；独立 Chrome 的模拟 MCP 宿主验证滚动、缩放、长短页切换、隐藏恢复，不代替真实客户端验收。UI 缓存地址升级为 map-v3.html，保留旧地址兼容。

## 2026-09-27 Unknown resource 时序定位

用户确认旧卡片重试后可显示5–10秒，随后宿主显示 Unknown resource；这不是可由滚动测试证明的故障。公开客户端代码显示：先使用共享HTML缓存，再按工具调用 originCallId 和资源身份后台读取；最终资源query错误可撤掉已显示界面。失败重试间隔1+2+4秒，与现象吻合。旧卡片03:19:39Z的后端日志只有API读取200，无resources/read。

本轮工具清单首次出现更新后的get_project_state与get_project_map描述；用新定义创建卡片后，03:24:42.469Z实际客户端resources/read map-v3返回200，03:25:01继续轮询成功。强烈指向旧调用卡片保留过期资源上下文；不宣称已从平台侧日志完全确认。新卡片持续显示待用户确认。

另消除已有window.openai有效桥接时重复发起标准ui/initialize的6秒超时路径。85项检查通过；Chrome分别验证标准桥接滚动与注入桥接超过11秒无第二次握手，均通过。该加固不作为Unknown resource根因证据。保留map-v3及所有旧别名，不再为本次诊断新增资源版本。
