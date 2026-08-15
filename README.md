# Narrator Team

面向 [NarraFork](https://github.com/NarraFork) 的团队协作插件：组织一个 **Leader 叙述者** 与多个 **Worker 叙述者** 组成的团队，在会话内直接派发任务、跟踪任务队列、查看成员忙闲状态与最近回复，并支持招募 **subagent 临时工** 拆分并行工作。

> **测试性声明**：这是一个**测试性**的 NarraFork 插件，用于验证宿主插件系统与团队协作工作流；在未来可能会**并入 NarraFork 本体**。

- 当前版本：`0.1.43`
- 运行方式：local-process 插件（宿主 NarraFork 0.5.23+，公共 API 含 narrator 通道）

## 功能特性

- **团队配置** — 设置团队名称、Leader 与成员（会话内 `team.setup`，或 UI 面板操作）
- **任务派发与队列** — `team.dispatch` 向成员投递任务并写入共享任务队列；队列自动维护（终态保留窗口 + 孤儿任务回收）
- **成员状态总览** — `team.status` 查看每个成员的忙闲状态、当前执行任务（activeTask）与最近一次回复摘要（recentReply）
- **临时工（temp）** — 任意成员可招募 `role=temp` 的 subagent 临时工协助大任务拆分，完成后可随时 `team.fire` 解雇，保持团队精简
- **成员资料管理** — `team.update_member` 修改成员名称（title）、模型（model）、思考强度（reasoningEffort）与 Dynamic Spec 文件
- **UI 面板** — 插件面板支持团队切换、成员编辑（标题/模型/思考强度）、成员添加、任务队列查看与删除（行内 ✕ 或右键）

## 安装

插件通过宿主插件系统安装（管理员操作）：

1. 将打包好的 `narrator-team-0.1.43.zip` 放入宿主插件导入目录（`~/.narrafork/plugin-imports/`）；
2. 在管理员的 Agent 会话中加载工具并用 `PluginInstall` 安装并启用：

```
/load plugin_install
→ PluginInstall: install_and_enable, path="narrator-team-0.1.43.zip"
```

安装后插件贡献以下入口：

| 贡献 | 类型 | 说明 |
|------|------|------|
| `team.dispatch` / `team.status` / `team.report` / `team.setup` / `team.recruit` / `team.fire` / `team.update_member` | 工具 | 团队协作工具集 |
| `team.configure` | 命令 | 配置团队（Leader、成员、名称） |
| `team-panel` | 视图（focus / workspace） | 团队配置、成员与任务队列面板 |

## 快速开始

```text
1. 团队配置     team.setup  name="我的团队" leaderId=<Leader ID> members=[<成员1>, <成员2>]
2. 查看状态     team.status          # 成员忙闲、队列、recentReply
3. 派发任务     team.dispatch  memberId=<成员ID> task="任务描述" [priority=high|normal]
4. 汇报结果     成员完成后调用 team.report 标记任务完成
5. 临时工       team.recruit  role=temp  → team.dispatch → 完成后 team.fire
6. 成员管理     team.update_member  memberId=<成员ID> [title=新名称] [model=新模型]
```

### 任务闭环机制

- `dispatch` 将任务镜像为成员 `spec://tasks.json` 中的 protected 任务（`[团队任务 task-N]`），由宿主任务机制驱动执行；
- 成员完成任务后标记 spec 任务为 `done`，插件在状态查询时同步任务状态（`done` / `failed`）；
- **临时工（subagent）** 没有独立消息通道：任务经宿主 `send_subagent_message` 通道投递（运行中→缓冲，空闲→原地恢复），临时工执行后同样将 spec 任务标记 `done` 完成闭环；
- 结果内容由临时工通过 `Send` 向父叙述者汇报，任务状态由 spec 同步收敛。

## 权限

插件声明的最小宿主能力（见 `manifest.json`）：

- 读取：`query.read.narrators` / `query.read.projects` / `query.read.chapters`
- 叙述者命令：`narrator.send_message` / `send_subagent_message` / `interrupt` / `create` / `delete` / `spec_tasks_get` / `spec_task_add` / `update_profile` / `spec_write`
- 其他：`event.subscribe`、`storage.read_self` / `write_self`、`ui.panel`、`provider.use`

网络与文件系统默认收紧：`network.mode = none`，仅包内只读 + 插件数据可写。

## 开发

```bash
# 打包（输出到宿主导入目录 ~/.narrafork/plugin-imports/）
bun scripts/package.mjs

# 运行测试
bun test
```

- 版本号：同步更新 `manifest.json` 与 `scripts/package.mjs` 中的 `VERSION`
- 打包内容：`server/`、`ui/`、`manifest.json` 等，自动排除 `tests/` 与 `scripts/`

## License

MIT License — 详见 [LICENSE](./LICENSE)。
