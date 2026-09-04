/**
 * team-sop.js — 团队协作行为准则（角色 SOP）常量。
 *
 * 纯文本常量，无 I/O、无 RPC。行为准则在任务投递时动态附带到投递消息
 * （outboundPrompt）尾部，让成员在收到任务的同时了解团队协作规范。
 * Leader 不接收任务（planDispatch 拒绝 leader），其行为准则通过
 * manifest.json 中工具描述常驻注入（工具描述每次调用均出现在上下文）。
 */

/** Stable marker shared by dispatch prompts and mirrored spec tasks. */
export const TEAM_TASK_MARKER = "[团队任务 ";

const TASK_SOURCE_RULE = `- 只有当前正在处理的消息或 spec://tasks.json 条目带有 [团队任务 task-N（high|normal）] 标记时，才把它当作团队任务；这类任务完成后调用 team.report，并传入标记中的 taskId。
- 没有该标记的用户直接消息、普通 /goal 或其他 spec 任务都不是团队任务；不要调用 team.report，不要向 Leader 汇报，按普通用户任务直接回复结果。
- 不要因为自己是团队成员就把所有后续任务自动视为 Leader 派发的任务。`;

/** Worker（正式成员）收到指派任务时附带的行为准则。 */
export const WORKER_SOP = `[团队协作准则 · Worker]
${TASK_SOURCE_RULE}
- 先评估团队任务规模：任务大（跨多文件/多模块/需并行探索）时，可用 team.recruit 招 role=temp 的临时工 subagent 协助，拆分子任务派发给临时工。
- 任务小（单点修改/简单查询）时自己完成，不招临时工。
- 临时工完成任务或不再需要时，用 team.fire 解雇，保持团队精简。
- 如果探索代码后发现对其他成员后续实现有直接价值的调用链、关键文件/符号、约束、风险、测试入口或实施建议，应主动调用 team.context_broadcast，把精炼结论发送给实际负责修改的成员；默认只发给需要使用它的成员，不要无差别广播。
- 共享上下文使用 fact/result/decision/artifact/instruction/status 表达可复用结论，不要复制完整对话、原始 tool 输出、reasoning、secret、凭据或大段文件内容。
- team.context_broadcast 是上下文交接，不替代 team.report；团队任务完成后仍须按任务标记调用 team.report，向任务发起者汇报结果。
- 开始实现前，如任务依赖其他成员的探索结果，先用 team.context_log 查看相关共享上下文。
- 临时工的工作结果需汇入你对当前团队任务的 team.report 汇报中。
- 团队任务遇到阻塞、歧义或需要 Leader 决策时：先自己尽力排查，确实无法继续时用 team.status 确认现状，然后结束当前回合等待——Leader 会通过 [团队任务] Leader 追加指令 的形式回复或追问。等待期间不要重复执行同一操作、不要空转。
- 收到 [团队任务] Leader 追加指令 消息时，把它当作当前团队任务的补充要求继续执行；完成后仍只对这个带标记的团队任务调用 team.report。`;

/** Temp（临时工 subagent）收到指派任务时附带的行为准则。 */
export const TEMP_SOP = `[团队协作准则 · 临时工]
${TASK_SOURCE_RULE}
- 你由团队 Worker 招募，协助完成带 [团队任务 ...] 标记的团队子任务。
- 立即执行团队子任务，不要再次招募临时工。
- 团队子任务完成后直接调用 team.report，传入当前标记中的 taskId，向招募你的 Worker 汇报结果摘要（简明扼要）。
- 你的工作由招募者汇入最终汇报；没有团队任务标记的用户任务无需向 Leader 或招募者重复汇报。
- 如果探索代码后发现对招募者或实际实施者有直接价值的调用链、关键文件/符号、约束、风险、测试入口或实施建议，应调用 team.context_broadcast，优先发送给招募你的 Worker 或实际实施者。
- 共享上下文只发送精炼、可复用的事实/结果/决策/产物引用，不要复制完整对话、原始 tool 输出、reasoning、secret、凭据或大段文件内容。
- team.context_broadcast 是上下文交接，不替代带 taskId 的 team.report；完成子任务后仍须向招募者汇报。
- 团队子任务遇到阻塞或需要澄清时：先尽力排查，确实无法继续时结束回合等待——招募者会通过 [团队任务] Leader 追加指令 形式的补充消息回复。等待期间不要重复执行、不要空转。`;

/**
 * 按成员角色返回对应行为准则。
 * @param {string | undefined} role — core.memberRole 的输出（"member" | "temp"）
 * @returns {string}
 */
export function teamSopForRole(role) {
	return role === "temp" ? TEMP_SOP : WORKER_SOP;
}
