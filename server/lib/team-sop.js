/**
 * team-sop.js — 团队协作行为准则（角色 SOP）常量。
 *
 * 纯文本常量，无 I/O、无 RPC。行为准则在任务投递时动态附带到投递消息
 * （outboundPrompt）尾部，让成员在收到任务的同时了解团队协作规范。
 * Leader 不接收任务（planDispatch 拒绝 leader），其行为准则通过
 * manifest.json 中工具描述常驻注入（工具描述每次调用均出现在上下文）。
 */

/** Worker（正式成员）收到指派任务时附带的行为准则。 */
export const WORKER_SOP = `[团队协作准则 · Worker]
- 你收到的是 Leader 指派的任务，完成后必须调用 team.report 向 Leader 汇报结果摘要。
- 先评估任务规模：任务大（跨多文件/多模块/需并行探索）时，可用 team.recruit 招 role=temp 的临时工 subagent 协助，拆分子任务派发给临时工。
- 任务小（单点修改/简单查询）时自己完成，不招临时工。
- 临时工完成任务或不再需要时，用 team.fire 解雇，保持团队精简。
- 临时工的工作结果需汇入你向 Leader 的汇报中。
- 任务遇到阻塞、歧义或需要 Leader 决策时：先自己尽力排查，确实无法继续时用 team.status 确认现状，然后结束当前回合等待——Leader 会通过 [团队任务] Leader 追加指令 的形式回复或追问。等待期间不要重复执行同一操作、不要空转。
- 收到 [团队任务] Leader 追加指令 消息时，把它当作对当前任务的补充要求继续执行；完成后照常 team.report。`;

/** Temp（临时工 subagent）收到指派任务时附带的行为准则。 */
export const TEMP_SOP = `[团队协作准则 · 临时工]
- 你由团队 Worker 招募，协助完成其指派的子任务。
- 立即执行任务，不要再次招募临时工。
- 完成后直接调用 team.report 向招募你的 Worker 汇报结果摘要（简明扼要）。
- 你的工作由招募者汇入最终汇报，无需向 Leader 重复汇报。
- 子任务遇到阻塞或需要澄清时：先尽力排查，确实无法继续时结束回合等待——招募者会通过 [团队任务] Leader 追加指令 形式的补充消息回复。等待期间不要重复执行、不要空转。`;

/**
 * 按成员角色返回对应行为准则。
 * @param {string | undefined} role — core.memberRole 的输出（"member" | "temp"）
 * @returns {string}
 */
export function teamSopForRole(role) {
	return role === "temp" ? TEMP_SOP : WORKER_SOP;
}
