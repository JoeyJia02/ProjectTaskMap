# 当前能力与限制

核实日期：2026-09-26。下列边界区分“产品已经实现的可测试契约”和“宿主或运维仍需验证的能力”；本地实现与测试不构成真实 ChatGPT 安装、上线或账号验收证明。

## ChatGPT 宿主边界

| 能力 | 当前处理 |
|---|---|
| 稳定 ChatGPT Project ID | 已查阅的公开接口没有建立可依赖的 Project ID 契约。由外部服务生成 projectId，以 owner + bindingKey 持久绑定；同名不能证明同一项目。 |
| 每轮结束自动回调 | 普通 Chat 无法保证 Skill 或 MCP 工具每轮都被调用。Level A 为模型遵循指令时的增量更新；没有收到调用的回合无法自动观察。 |
| Work/Codex hooks | 官方支持运行时生命周期 hooks，但需要对应环境与信任配置；不等于普通 Chat 的通用 callback。本版本没有接入 hooks。 |
| 宿主 workspace 页签 | 未建立第三方注册原生 workspace tabs 的公开能力。应用自身有 UI 内页签，并提供静态 Markdown/HTML 导出。 |
| 完整项目聊天历史 | 应用不能遍历 ChatGPT Project 的其他对话、读取隐藏上下文或证明概况完整；reconcile 只使用实际提供的 evidence 和 coverage。 |
| 无确认写入 | Developer mode 支持写工具；是否需要用户确认由宿主权限与配置决定，应用不能保证静默写入。 |
| UI 打开与后台同步 | MCP Apps UI 是隔离 iframe。活动 UI 可刷新持久化状态；关闭 UI 后没有对话监听器、后台 LLM 或常驻任务。 |

官方 reference 提供 `openai/session`、`openai/subject` 和可选 `openai/organization` 等匿名相关标识；它们不是 Project ID，也不替代 OAuth 授权。`widgetSessionId` 仅关联当前挂载的组件实例。[官方 Reference](https://developers.openai.com/plugins/reference)

界面支持 inline/fullscreen 等展示与 bridge 调用，但业务数据和跨会话状态必须保存在应用服务端。[官方 UI 文档](https://developers.openai.com/plugins/build/chatgpt-ui)。普通 Chat 不应依赖 hooks；Work/Codex 的 hooks 是单独运行时能力。[官方兼容指南](https://developers.openai.com/plugins/guides/submit-claude-plugin)、[Hooks](https://learn.chatgpt.com/docs/hooks)

## 当前实现范围

- 单所有者、多个相互隔离的项目；没有组织成员、角色分配、多人协同或团队 OAuth 用户目录。
- SQLite 持久化需要稳定磁盘和备份。单实例写入为设计目标；多副本、高可用、跨区域和 PostgreSQL 迁移尚未实现。
- 后端不调用付费模型 API，也不做通用自然语言理解。判断由 ChatGPT 提交为结构化 assessment/overview；确定性测试验证数据与规则，不证明任意模型一定正确解读对话。
- 人工修改以节点级保护，goal/focus 有独立锁。没有细粒度字段合并界面；冲突通过明确审批处理。
- reconciliation 不会因遗漏删除旧节点。无法唯一匹配、旧证据或保护冲突需审阅，不能保证在缺少资料时自动恢复全部历史。
- exports 是版本快照，保留任务、状态、决策与依据；它们不是运行中的应用，不会自动刷新，修改导出文件不会回写数据库。
- 不提供全局项目导航、日程、工时、通知、团队协作或 Jira/Slack/邮件集成；这些不在本版产品范围。

## 鉴权与接入运维

个人 OAuth 使用 authorization code + PKCE S256 和 DCR，由 owner secret 保护授权流程。本版只有完整 read/write grant，单独请求只读 scope 会被拒绝；不提供独立只读 OAuth 身份。访问 token 有效期为 1 小时，没有 refresh token。临时 OAuth 注册/授权信息保存在内存中，进程重启可能需要重新连接；数据库中的绑定、任务、版本和审阅记录继续保留。请勿将此单用户实现当成已经审计的多租户身份平台。

两份独立强密钥、真实公网 HTTPS origin、持久化数据库卷和精确 origin 配置由部署方提供。开发隧道用于联调；正式公开提交需要稳定域名与官方审核。当前没有声称完成生产部署、安全认证、性能容量认证或真实 ChatGPT 账号联调。[官方 MCP 部署要求](https://developers.openai.com/plugins/build/mcp-server)、[OAuth 要求](https://developers.openai.com/plugins/build/auth)

`projectToken` 只通过 authenticated 工具结果的 UI 专用 `_meta` 进入 iframe，不应进入模型正文、导出、日志或 Project instructions。`_meta` 是模型可见性边界，不是浏览器端的秘密保险箱；组件和部署环境仍须可信，token 必须短期且限定项目。

`TASK_MAP_WIDGET_ORIGIN` 默认使用官方开发 sandbox origin，并自动加入精确 CORS 白名单；正式公开提交 UI 插件必须配置插件独有的 HTTPS origin。后端 CSP connectDomains 与组件 CORS origin 均需真实环境验证，不能由本地同源浏览器测试推定。[官方组件元数据](https://developers.openai.com/plugins/reference#component-resource-_meta-fields)

Plus/Pro 网页开发模式支持 MCP 读写，但账号/工作区可能有策略限制；写工具默认确认，真实 UI 入口和可用性以账号为准。[官方 Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)

## 验证声明

以仓库实际测试结果、审阅记录和 [真实接入步骤](docs/chatgpt-connection.md) 的执行记录判断交付程度。尚未完成的真实账号连接不能标记为已通过。未来官方开放稳定 Project ID、普通 Chat 生命周期 callback 或宿主页签 API 时，可增加宿主适配器；现阶段不以这些假定能力支撑核心流程。
