# 在 ChatGPT 中连接 Project Task Map

本仓库提供真实的持久化后端、MCP 工具与嵌入式 UI。**仓库代码和本地测试不等于已经连接到你的 ChatGPT 账号。** 完成下述部署和真实账号验收后才能确认端到端接入；目前不声称已完成真实 ChatGPT 连接。

## 1. 部署前配置

使用 Node.js 24，按根目录 README 安装依赖、验证并构建。复制 `.env.example` 为本机 `.env`，或通过部署平台注入环境变量。`.env` 与数据库不能提交到 GitHub。

| 配置 | 用途 |
|---|---|
| `TASK_MAP_OWNER_SECRET` | 单所有者登录密码，至少 32 字符；仅在自己托管的授权页或本地管理登录中输入 |
| `TASK_MAP_SIGNING_SECRET` | 签名密钥，至少 32 字符，与 owner secret 不同；只保留在服务端 |
| `TASK_MAP_PUBLIC_URL` | 对外 origin，例如 `https://tasks.example.com`，不含 `/mcp`、子路径、查询参数或凭据 |
| `TASK_MAP_WIDGET_ORIGIN` | MCP Apps 组件 origin；开发默认 `https://web-sandbox.oaiusercontent.com`，公开提交需使用插件独有的 HTTPS origin |
| `TASK_MAP_ALLOWED_ORIGINS` | 逗号分隔的精确允许 origin；组件 origin 会自动加入，生产环境移除多余的 localhost/开发 origin |
| `TASK_MAP_DB` | 持久化 SQLite 路径，例如挂载卷内 `/data/task-map.sqlite` |
| `TASK_MAP_HOST` / `PORT` | 服务监听地址和端口；本地默认 `127.0.0.1:3000` |

生成两个独立的强随机值，不使用示例字符串。生产环境挂载持久化卷，保留相同数据库与签名密钥；只复制容器而丢失数据库会丢失绑定和历史。签名密钥轮换会使旧会话失效。

反向代理应转发 `/mcp`、`/api`、OAuth discovery、`/register`、`/authorize` 和 `/token` 等服务路由，保留 Authorization 请求头并允许 MCP Streamable HTTP 传输。公网 origin 必须是 HTTPS；HTTP 仅允许 localhost 开发。短期隧道可验证开发流程，正式使用与公开提交需要稳定 HTTPS 服务和域名控制。不要把本地 `127.0.0.1` URL 填入远端 ChatGPT。

## 2. 创建 MCP 应用连接

官方开发模式文档目前列出网页版 Pro、Plus、Business、Enterprise、Education 的 MCP 读写支持，实际开关和策略仍以账号/工作区为准。[官方 Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)

1. 本次账号截图已确认桌面客户端入口为 **插件 → 添加 → 创建 MCP 应用**。已能打开这个表单时，直接继续，无需再寻找 Developer mode 开关。其他版本的入口以实际界面及官方文档为准。
2. 名称填写 `Project Task Map`；连接选择 **服务器 URL**，填写已部署且验证可达的 `https://你的域名/mcp`。图标和描述可省略，不要使用示例域名或本机地址。
3. 身份验证保持 **OAuth**，高级设置保持默认。勾选已了解连接风险后点击创建。本实现支持动态客户端注册（DCR）、authorization code + PKCE S256；个人版本使用完整的 `projects:read projects:write` 授权，单独请求只读权限会被拒绝，不会静默升级权限。
4. 按宿主授权流程打开你部署的 `/authorize` 页面。在确认域名正确后输入 owner secret。不要把密码贴进聊天、工具参数、Project instructions、GitHub 或截图。
5. 连接成功后，在要使用任务地图的对话中选择该插件。工具或 schema 更新后在连接详情刷新工具列表。

此个人部署仅有一个所有者，没有团队账号系统。OAuth 访问 token 有效期最长 1 小时，支持轮换 refresh token，单次授权最长 30 天。支持刷新的客户端可自动续期；期满、撤销或部署密钥/issuer 改变后需重新授权。客户端与刷新授权持久化到 SQLite，正常重启不要求重新连接；正在进行的登录需重试。刷新令牌重放会撤销同一授权及其派生项目令牌。

详细入口会随产品更新变化，以官方接入与快速开始说明为准。[官方 quickstart](https://developers.openai.com/plugins/build/app-quickstart)、[官方 OAuth 契约](https://developers.openai.com/plugins/build/auth)

## 3. 绑定当前 Project

给每个 ChatGPT Project 选择一个长期保存的随机 bindingKey，例如自己生成的 UUID。把以下非敏感定位信息保存在该 Project 的 instructions：

```text
此 Project 使用 Project Task Map 管理任务。
Task Map bindingKey: <该项目唯一且长期保存的随机标识>
绑定时始终重用该键；更新前读取当前状态。
只同步有明确依据的增量，保留人工修改、已完成与已放弃任务。
```

请 ChatGPT 调用 `bind_project`，传入该键和项目名称。相同所有者与键返回相同 `projectId`；改名与重启不应创建新地图。不同 Project 使用不同键。**bindingKey 是定位符，不是授权凭据**，无需保密到密码级别；复制到另一个 Project 会指向同一份地图。不要把 OAuth token 或 projectToken 放到 instructions。

仓库里的 [task-manager Skill](../skills/task-manager/SKILL.md) 定义增量判断、人工保护与恢复策略；文件存在不等于已自动安装到 ChatGPT。可在支持 Skill 的插件/Work 环境按该产品流程导入，普通 Chat 可将适用的工作流程写入 Project instructions。只有当前宿主实际加载的指令才会生效。

## 4. UI、刷新与状态更新

`bind_project` / `get_project_map` 返回 MCP Apps UI 所需资源和项目快照。服务器在工具结果的 UI 专用 `_meta` 中传入 `apiBaseUrl` 与短期 `projectToken`；组件自动连接 HTTPS API，并在请求 Authorization 头使用 token。凭据不进入模型可见的 `structuredContent`、聊天正文、URL 参数或导出文件。CSP 的 `connectDomains` 允许后端 origin，CORS 允许真实组件 origin；这是两个不同方向的约束。服务器同时在资源 `_meta.ui.domain` 声明 `TASK_MAP_WIDGET_ORIGIN`，并将它加入精确 CORS 白名单，避免 ChatGPT iframe 请求被拒绝。[组件 origin 说明](https://developers.openai.com/plugins/reference#component-resource-_meta-fields)

UI token 只允许访问所绑定项目；过期后重新调用 `get_project_map` 获取新的会话信息。使用开发浏览器直接打开 UI 时，可用自己的 owner secret 进行本地/管理员连接；这不是普通用户需要填密钥的生产流程。

语义判断由 ChatGPT 完成，后端校验结构化增量并提交事务。写操作能否直接执行或需要确认由宿主决定；应用不能承诺每轮自动调用，也不能绕过写确认。处于活动状态的 UI 可刷新服务端已提交状态，但没有权限读取整段聊天。

点击“刷新项目地图”，或向 ChatGPT 发送：

```text
输出我们任务概况目前进度，并更新 TaskBoardApp。
先读取地图，再用当前可见的项目概况与证据执行 reconcile，说明实际覆盖范围。
```

Level B 核对只合并实际提供的证据。其他会话不可见时，补充相关概况或文件；遗漏节点不会被删除。`pending` 代表未应用，需查看冲突原因并在 UI 决定是否接受。静态 Markdown/HTML 导出来自已提交版本，不会自行刷新，也不会注册为宿主原生 workspace tabs。

## 5. 真实账号验收记录

按顺序执行，并保存实际结果；未执行项标为“未验证”，不可用本地协议测试替代：

- HTTPS `/health` 和 `/mcp` 可被宿主访问，OAuth discovery 与 PKCE 登录成功。
- 同一个 bindingKey 绑定两次，重启/重连后仍为同一 projectId；改项目名不复制地图。
- UI 展示真实快照，并能在授权后修改状态；工具返回的新版本、UI 与重新读取结果一致。
- 主动过期会话后出现可恢复错误；重新读取工具可恢复 UI 连接。
- 两个项目的 token 不能互相读写；导出不含 token/密钥。
- 20 轮中人为安排 4 次真实变化，检查只有 4 次状态版本增加；单独记录模型是否实际调用工具及宿主是否要求确认。
- “之后再看”进入 Parking Lot，重复提及已完成任务不复制，人工放弃不被旧上下文恢复。
- 提供遗漏进度概况后 reconcile 能恢复有证据的变化，且说明未覆盖的历史。

如果工具调用失败，保留最后一次成功状态，检查服务日志中的相关 ID 和 HTTP 状态。不要为调试记录 Authorization 头、owner secret、完整聊天或工具 `_meta` 凭据。

## 避免重复地图页签

`bind_project` 只绑定项目，`get_project_state` 只读取数据；常规刷新和更新后不再调用界面工具。只有用户明确要求打开地图时才调用 `get_project_map`。已打开的地图在可见时每 15 秒读取保存状态。刷新按钮发送核对请求，保存结果在对话中说明。

每次显式打开仍可能生成一个宿主页签，插件没有接管宿主页签的关闭或复用。已有重复页签可关闭，只保留一个，不会删除项目数据。服务升级后若宿主仍缓存旧工具列表，需要在已有插件的设置中刷新工具；不需要新建项目绑定。

### 界面升级与缓存

UI 入口固定使用 `ui://project-task-map/map-v3.html`，保留已发布 URI 的别名。不要随界面修改更换入口：已有会话可能保留旧工具描述，导致宿主报 Unknown resource，即使服务器有旧地址别名也不够。重新构建部署后，重新加载组件以获取最新 HTML；工具定义变更时刷新已有应用的工具目录。仅刷新项目数据不会替换运行中的界面，不要通过新建绑定解决缓存。
