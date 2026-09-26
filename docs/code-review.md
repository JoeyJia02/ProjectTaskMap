# 独立代码审阅记录

日期：2026-09-26。审阅者为未实现 server/domain/store/UI 的独立子代理；其实现过导出、Skill 与接入文档，因此不把这些文件的自查称为独立审阅。

## 范围与方法

阅读 `src/server/{auth,app,mcp,config}.ts`、`src/domain/{schema,reducer,assessment,reconcile}.ts`、`src/store/index.ts` 和 UI host adapter，交叉检查需求、架构及官方 MCP Apps/OAuth 文档。重点是项目隔离、认证受众、来源强制、PKCE、CORS、工具契约、人工锁、终态、版本、幂等、原子批次和核对合并。

独立运行的 HTTP/MCP 测试使用真实 MCP SDK client 和本地 HTTP 端口，包括协议初始化、工具发现、持久化、重复调用、导出，以及 owner/project/oauth 凭据隔离。测试没有连接真实 ChatGPT 账号。

## 发现与处理

| 严重性 | 发现 | 处理与复查 |
|---|---|---|
| P1 | UI 未声明组件 domain，CORS 只允许后端 origin；官方默认 sandbox iframe 的直接 API 请求会被拒绝。 | 已增加 `TASK_MAP_WIDGET_ORIGIN`，在资源 `_meta.ui.domain` 声明并自动加入精确 CORS 白名单；HTTP 回归测试覆盖 sandbox origin。真实宿主仍待接入验收。 |
| P2 | 返回 `structuredContent` 的工具没有 `outputSchema`，缺少官方要求的输出契约。 | 已定义共享状态/绑定/变更结果 schema 并用于所有结构化工具；协议测试检查工具发现的 output schema。 |
| P2 | OAuth 接受只读 scope 请求，却总签发 read/write token。 | 个人版明确仅提供完整 read/write grant，拒绝部分 scope，避免静默提升权限；回归测试覆盖只读请求被拒绝。 |
| P2 | `window.openai.toolResponseMetadata` 兼容路径仅解析平面 metadata，未识别官方 canonical envelope 的嵌套 `_meta`。 | 已解析嵌套 metadata；UI 测试覆盖 `call_tool_result` / `mcp_tool_result`，并验证不能从模型可见字段提取凭据。 |
| P2 | 旧证据能覆盖较新 AI 目标，且提交的时间戳可能倒退，削弱后续 stale-evidence 保护。 | 已检查目标证据和提案新旧，保留节点/项目/同步时间单调；回归覆盖“T12 更新目标 → T10 补历史任务 → T11 旧目标”被拒绝，以及旧 reconcile 不回退同步时间。 |
| P2 | UI 使用缓存版本命名导出文件，而服务端导出的是读取时的最新快照，可能把 v13 文件误标为 v12。 | 已移除客户端猜测的版本号，文件命名为 `task-map.md/html`，成功提示引导查看内容中的服务端实际版本；代码复查确认。 |

## 已确认的边界

- API 在读取、历史、冲突与导出路径检查 project capability 的项目范围；OAuth token 与 API project token 使用不同 audience。
- MCP `apply_project_delta` 和 UI 自动增量路径强制 AI source，不能通过请求正文的 `source: manual` 获得人工覆盖权；人工 API 是第一方 UI 的明确人工操作入口，不暴露为模型工具。
- OAuth 校验精确 redirect URI、resource、PKCE S256、授权 cookie/intent、短期单次 code；签名验证限制 HS256、issuer、audience、owner、过期与 scope。
- 状态批次在 SQLite 事务内处理；失败的 reducer 不提交部分图。已应用幂等键重试不会再次变更，同键异内容进入冲突记录。
- 图结构在提交前验证父子环、依赖环、端点、唯一焦点与前置依赖；人工锁检查覆盖移动、依赖、焦点的隐式变更。
- reconcile 复用稳定 ID 并保留遗漏节点；冲突记录与项目 revision 分离，审批使用最新预期版本。

## 独立验证结果

2026-09-26 12:09（本地 Asia/Shanghai）独立运行：

```text
npm test -- tests/domain.test.ts tests/store.test.ts tests/http.test.ts tests/artifacts.test.ts tests/ui.test.tsx
5 test files passed; 55 tests passed
```

其中 domain/store/server/UI 是独立审阅验证；artifacts 为实现者回归验证。Skill 通过官方 `quick_validate.py`。真实浏览器 E2E 与视觉验收由主代理另行执行，不计入上述结果。

快速核对 README、安装文档、初始化/交付导出脚本和 Docker 忽略规则：初始化脚本创建两个独立随机密钥，不打印凭据，不覆盖已有 `.env`；交付地图使用内存数据库，不读取运行时用户数据库；Git/Docker 忽略配置排除 `.env`、数据库与本地产物。文档明确区分本地验证与真实账号连接。

## 剩余验证范围

当前审阅不包含独立渗透测试、生产容量或故障演练、托管部署、真实 OAuth 宿主互操作、完整模型语义评测。人工来源的可信边界是已认证的第一方 UI，浏览器持有的项目 token 应当按敏感短期凭据管理。普通 Chat 的 turn 调度、写入确认、历史可见性和原生页签能力是 [已声明平台边界](../CURRENT_LIMITATIONS.md)。

结论：此次审阅发现的六项问题已处理，所述范围内没有尚未解决的 P1/P2 发现。可以交付源码与本地验证结果；**真实 ChatGPT 账号 OAuth/iframe 接入、HTTPS 部署、Docker 构建和生产运行尚未由此次审阅验证**。不将“没有发现更多问题”等同于没有漏洞。
