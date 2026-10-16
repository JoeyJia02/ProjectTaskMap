# Project Task Map

**Human-facing task state layer for ChatGPT projects.** 为当前 ChatGPT Project 保存一份可解释、可恢复的任务地图：目标、当前焦点、真正的任务树、关键决策和 Parking Lot。

这不是全局 Dashboard。底层是带父子层级和跨分支依赖的图，UI 以树呈现；每轮只接收有证据的增量，刷新执行 reconcile，保留已有任务和人工决定。

当前使用状态：用户已确认客户端验收完成，并在多个实际项目中使用。使用反馈与历史验收范围见 [客户端验收记录](docs/client-acceptance.md)。

## 本地运行

需要 Node.js 24.x 与 npm。不需要 OpenAI API key，不会产生模型 API 调用费用。

```sh
npm ci
node scripts/setup.mjs
npm run build
npm start
```

本地调试 UI：`http://127.0.0.1:3000`。登录凭据在自动生成的 `.env` 中；仅在自己的部署输入。输入项目名和固定 binding key 即可建立/恢复项目。服务不会自动灌入演示数据；`/?demo=1` 是明确标记、禁止写入的视觉样例。正式体验是在 ChatGPT 的 MCP Apps iframe 内，独立页面只用于开发验证。

开发：`npm run dev` 启动后端；另开终端 `npm run dev:ui` 启动 Vite。持久化文件为 `data/task-map.sqlite`，停止/重启不丢状态。不要提交 `.env`、SQLite 或用户证据。

## 接入 ChatGPT

这台电脑的本地接入状态与必要操作见 [用户短清单](docs/桌面客户端接入操作指南.md)，验证依据见 [本地接入验收](docs/local-connection-verification.md)。本地 Codex 连接与普通 ChatGPT 插件是两条接入流程。

按 [ChatGPT Pro 接入指南](docs/chatgpt-connection.md) 配置 HTTPS/隧道及 OAuth，连接 `/mcp`，调用 `bind_project`。把非敏感 `bindingKey` 与外部 `projectId` 保存到该 Project instructions；项目名不是身份。加载 [Task Manager Skill](skills/task-manager/SKILL.md) 的管理策略（普通 Chat 可将策略加入 Project instructions）。

当前实现使用 MCP Apps 标准 UI bridge，兼容 feature-detected `window.openai`。更新工具通过 MCP 持久化；`stage_project_delta` 可将变化交给活动 UI 通过 HTTPS 写入自己的后端。项目能力令牌仅经 `_meta` 交给 UI，不出现在模型文本或 artifact。SQLite 是状态事实来源。

**平台限制影响产品承诺：** 未获得公开稳定宿主 Project ID、普通 Chat 的保证每轮回调、第三方宿主文件页签注册或完整项目聊天枚举。Level A 是模型策略驱动；Level B 依赖重新打开/刷新时提交可访问上下文的 overview。不能保证任何未观察对话会自动保存。详见 [CURRENT_LIMITATIONS](CURRENT_LIMITATIONS.md)。本仓库的本地测试不等于你的真实 Pro 账号已经连接成功。

## 数据可靠性

- 乐观版本检查 + 原子批次；相同幂等键的重复提交不会再次写入。
- 无变化不修改状态、时间、版本或历史。低置信度、过期版本、人工锁及终态冲突进入待审。
- 任务父图和依赖图分别验证无环；依赖未完成不能开始/完成下游工作。
- 人工编辑受到保护，AI 无法通过伪造 `source=manual` 绕过。终态提及不会重建或重新激活任务。
- Full reconcile 合并明确观察到的变化；遗漏不是删除。历史回退形成新版本，保留原始审计。
- 独立项目 UUID、绑定、授权、数据与证据；短期 UI token 只能访问一个项目。

## 验证

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

Windows 可使用已安装的 Chrome：`$env:PLAYWRIGHT_CHANNEL='chrome'; npm run test:e2e`。单元/集成测试覆盖用户提供的 20 轮仅 4 次变化、暂缓新想法、终态重复提及、人工放弃保护、App 离线后的补偿和 full reconcile；还包含持久化重启、幂等、DAG、隔离、真实 MCP SDK 握手、OAuth PKCE、UI 操作和安全 artifact 输出。浏览器测试使用临时 SQLite，验证真实绑定、编辑、保存、导出、重连和窄屏布局。CI 在每次 push/PR 运行这些检查。

## 文档和代码

先设计后编码的基线：[requirements.md](requirements.md)、[architecture.md](architecture.md)、[data-model.md](data-model.md)。目录结构见 architecture.md。

其他交付：[安装与运维](docs/setup.md)、[界面原型](docs/ui-prototype.md)、[架构决策](DECISIONS.md)、[独立代码审查](docs/code-review.md)、[产品验收](docs/product-review.md)。

核心目录：`src/domain` 纯状态规则；`src/store` SQLite；`src/server` HTTP/OAuth/MCP；`src/ui` React；`src/artifacts` Markdown/HTML 投影；`skills/task-manager` 行为策略。`task-map.md` 是仓库交付概况，实时用户 artifact 通过导出端点或 `export_task_map` 生成。

### 快速记录 Parking Lot

地图顶部的“＋ 记想法”可以直接人工保存一条暂存想法，不调用模型或全量核对。只填一句话即可；可选说明、多个关联任务、优先级和置顶。任务详情的“为此任务记想法”会预选该任务；详情中也能查看关联想法。关联是参考关系，不是父子层级或执行依赖。

Parking Lot 支持编辑和两种排序：默认按最新记录优先保持顺序稳定，也可选按置顶、优先级、关联当前焦点、记录时间自动排序。排序只影响展示，不产生项目版本。保存沿用人工增量接口、版本校验和人工保护，失败保留当前表单供重试。

### 日常操作

- 顶部“随手记想法”回车保存，不调用模型、不刷新整张地图；失败保留输入。在 Parking Lot 中补充关联任务、优先级和置顶。
- 任务地图默认显示未完成任务，可搜索名称/说明，筛选进行中、受阻、关联想法或全部；匹配子任务时保留父分支。
- 多个任务可以同时进行，`START_NODE` 只改变状态；`SET_ACTIVE_NODE` 选择一个当前焦点，切换或清空焦点不会暂停其他任务。旧数据无需迁移。
- 审批显示当前值和提议值，原始提案及证据可展开；无可执行更改的旧提案只能保留当前。
- 自动读取失败保留快照，网络恢复或切回页面会重试读取。业务操作错误单独显示，自动读取成功不会抹掉审批错误。
