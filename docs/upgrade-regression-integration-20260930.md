# 升级兼容与失败回退回归：原项目集成验收

完成时间（UTC）：2026-09-30T22:47:27.522549+00:00

## 实际完成的里程碑

原项目 `D:\TaskKanban`（Project Task Map，main@fe168d0）已新增 11 个测试相关文件：3 个回归测试、1 个测试子进程 helper、5 个固定历史源码夹具、manifest 与夹具专用 .gitattributes。这些文件与此前隔离验证的交接源码逐字节一致。未合入任何 App.tsx 修复或其他应用实现补丁。

写入前逐文件重验 94 个旧文件的 SHA256，所有新增路径均使用独占创建；集成后及独立复核再次确认旧文件未变。已有 25 个 tracked 未提交更改、44 个 untracked 文件保留。没有 reset、提交、推送、部署、服务重启、凭据或 Tailscale 修改。

## 原项目真实验证

| 检查 | 结果 |
|---|---|
| npm run typecheck | 通过，退出码 0 |
| npm test | 16 个文件、129 项测试全部通过，退出码 0 |
| Vite production build | 通过，退出码 0 |
| tsc -p tsconfig.server.json | 通过，退出码 0 |

129 项包括此前已有 121 项与新增 8 项，不是把隔离结果当作原仓库执行结果。新增 8 项覆盖：旧 OAuth schema 增列/回填与 prune、refresh 重开轮换（3）；旧源码 fixture 完整性（1）；fe168d0 → 当前 → fe168d0 的 store 兼容（1）；多 active 状态降级拒写与保存保护（1）；缺 UI 资源时 health 200 但资源读取失败、恢复 UI 文件后保留新数据（1）；在线 WAL 一致性备份、新路径恢复与保留失败库（1）。

测试仅用合成凭据、临时 SQLite、随机 loopback 子进程，不执行真实业务数据写入。依赖注释的既有 Rollup 提示未导致构建失败。项目没有独立 lint 脚本。

为避免覆盖现有服务正在读取的 dist，本轮使用与 package.json build 相同的 Vite 和 server tsc 命令，只将 outDir 重定向到独立工作区：

```text
npm run typecheck
npm test
node_modules/.bin/vite build --outDir C:/Users/admin/Documents/Codex/2026-09-30/task-2/integrated-build/ui
node_modules/.bin/tsc -p tsconfig.server.json --outDir C:/Users/admin/Documents/Codex/2026-09-30/task-2/integrated-build/server
```

## 范围与未完成项

上述结果只完成测试集成里程碑。没有新增真实宿主 iframe 写入/旧卡片重开、跨会话超过一小时恢复、跨机器或整套发布回退的现场证据。现有后台 maintenance 的 ready 只证明 health/issuer 可用。

旧版可读取当前多 active 状态，但其普通 mutation 会 pending invalid_focus；不能宣称无条件降级兼容。fe168d0 的完整后端 OAuth refresh 兼容也未证明。备份恢复回到备份时点，之后的写入和授权变化必须单独处置。当前仍无专用 release 切换/回退脚本。

按父会话最新指令，本轮不通过真实服务写入正式台账。只读观察到开发项目仍为 v2、delivery-client-acceptance 为 active，stability-upgrade-matrix 与 stability-release-rollback 仍为 todo；本地文档只记录本里程碑完成，不标记整个项目完成。

## 可恢复证据

检查点：`C:/Users/admin/Documents/Codex/2026-09-30/task-2/integration-checkpoint-20260930/`。包含写入前状态及 94 文件哈希 manifest、无凭据/数据库的原源码 ZIP、仅新增测试的 patch 与逐文件写入 journal。验证日志在同一工作区 integrated-typecheck.log、integrated-tests.log、integrated-build.log、integrated-server-build.log。

如需撤销新增文件，必须先核对其仍匹配 journal 的 SHA256，仅处理本次新增路径；不得重置或覆盖原有未提交变更。正式宿主验收与可回退发布流程继续按未完成项推进。
