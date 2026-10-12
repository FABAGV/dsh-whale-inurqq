/**
 * 「这个会话还有没有待办？」—— 决定一条任务能不能收敛（写终态 + 归档）。
 *
 * ## 为什么不能只看 turn/end
 *
 * `turn/end` 只说明"模型此刻不欠回应了"，**不等于任务结束**。至少两种情况
 * 会让一个活任务在回合结束后被误判成"跑完了"：
 *
 *   1. **回合结束时还挂着一个未决的用户提问 / 审批**。DSH 的 timed
 *      `ask_user_question` 允许工具先返回"待回答"载荷、由**下一个回合**带回答案
 *      （投影里记作 `state: 'continued'`）；用户可能几分钟后才回答。
 *   2. **多回合任务**：`interrupted` 之后宿主或用户续跑，第一个 turn/end 只是
 *      两个回合之间的缝。
 * 一旦在此时归档（尤其是带 `stopActivity` 的强制归档），宿主会把仍在等答案的
 * 回合停掉 —— 用户在 QQ 侧只看到"它突然不说话了"，这是最难排查的一类故障。
 *
 * ## 判据（严格按"先问宿主，不猜"的顺序）
 *
 * | # | 判据 | 宿主契约 |
 * |---|---|---|
 * | 1 | 未决**审批**（会话日志 `approval/asked` 无对应 `approval/decided`） | `dsh-user-approval`：`approval/asked`/`approval/decided` 是 log-only 审计事件，成对写入（`lib/types/types.d.ts` 27-52 行） |
 * | 2 | 未决**用户提问**（会话投影 `userQuestions.active`） | `dsh-user-questions`：投影视图 `{active:[{callId,questions,state:'open'\|'continued'}],settled}`（`lib/types/types.d.ts` 62-93 行、`lib/types/projection.js` 197-245 行）；读取方式照抄宿主用法 `ctx.sessionProjections.snapshot(session,['userQuestions']).values.userQuestions`（`dsh-session-projection/lib/types/index.d.ts` 24-26、92-97、185 行） |
 * | 3 | 宿主**活动询问**（`workspace/session-activity` waterfall） | `dsh-workspace/lib/types/index.d.ts` 85-95 行；Agent 注册表的提供方明确写着"**a turn waiting for an approval or an answer included**"（`dsh-agent/lib/types/archive-admission.d.ts` 12-23 行）—— 这正是宿主自己对"还有没有活"的权威回答 |
 * | 4 | `agent.status === 'running'` | `dsh-agent/lib/types/runtime-types.d.ts` 83-90、139-157 行（`Agent.status: 'idle'｜'running'`，`agent/status` 事件镜像它） |
 * | 5 | 未消费的 **inbox** | 同上 40-82 行：`Agent.inbox.nextTurn` / `.nextStep` 就是"排队中的输入"（注意用契约成员，不用 agent-loop 里 `ReactLoopInbox.hasPending` 这个实现细节） |
 *
 * 判据 1/2 是**精确**的（能指名"在等哪个问题"），3/4/5 是**保守**的
 * （只知道"还有东西"，不知道是什么）。它们互补：
 *   - **阻塞式** ask/审批：工具调用还没返回 → 回合仍然开着 → 判据 3 拦住；
 *   - **timed/continued** 提问：工具已经返回"待回答"、回合已结束 → 只有判据 2 知道。
 *
 * ## 都不确定时倾向于"不收敛"
 *
 * 五个判据一个都问不到（服务缺失、会话对象拿不到）时返回 `busy: true,
 * reason: 'unknown'` —— 宁可留一个空闲 session 被后续清理，也不要掐死一个活任务。
 * 调用方（TaskScheduler）另有限时兜底，避免"永远不确定"把队列堵死。
 */

/** 判据给出的"忙"原因 */
export const BUSY = {
  /** 有未决的用户提问（timed/continued） */
  QUESTION: 'question',
  /** 有未决的审批 */
  APPROVAL: 'approval',
  /** 宿主说这个会话还有活动（运行中的回合、子代理、任务、定时） */
  ACTIVITY: 'activity',
  /** agent.status 仍是 running */
  STATUS: 'status',
  /** inbox 里还有没被消费的输入 */
  INBOX: 'inbox',
  /** 一个判据都问不到：不确定，按"忙"处理 */
  UNKNOWN: 'unknown',
}

/** 给用户看的一句话（QQ 回传用）。调用方会在前面加「任务 #N」，所以这里不自称任务 */
export function describeBusy(view) {
  const detail = view?.detail ? `：${view.detail}` : ''
  switch (view?.reason) {
    case BUSY.QUESTION:
      return `在等你回答问题${detail}`
    case BUSY.APPROVAL:
      return `在等你确认${detail}`
    case BUSY.ACTIVITY:
      return `这一回合结束了，但会话里还有没跑完的工作${detail}`
    case BUSY.STATUS:
      return '还在继续跑，先不归档'
    case BUSY.INBOX:
      return '还有排队中的输入等着它处理'
    default:
      return '暂时无法确认它是否空闲，先不归档'
  }
}

/** 摘要一段可能很长的文本 */
function brief(text, max = 80) {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 评估某个 session 是否"还有待办"。
 *
 * @param {object} deps
 * @param {any} deps.ctx cordis 上下文（用它取服务与派发 waterfall）
 * @param {ReturnType<import('../log.js').createLogger>} deps.log
 * @param {string} sessionId
 * @param {{approvals?: string[]}} [hints] 由 ProgressRelay 折叠出来的未决审批
 * @returns {Promise<{busy:boolean, reason:string, detail:string, signals:object}>}
 */
export async function assessSessionWork({ ctx, log }, sessionId, hints = {}) {
  /** @type {Record<string, any>} */
  const signals = {}
  let available = 0
  const busy = (reason, detail = '') => ({ busy: true, reason, detail, signals })
  const idle = () => ({ busy: false, reason: '', detail: '', signals })

  const svc = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  // ── ① 未决审批：来自会话日志的 approval/asked ↔ approval/decided 配对 ──
  if (Array.isArray(hints.approvals)) {
    available += 1
    signals.approvals = hints.approvals
    if (hints.approvals.length > 0) {
      return busy(BUSY.APPROVAL, `工具 ${brief(hints.approvals[0], 40)} 的审批还没有结论`)
    }
  }

  const agents = svc('agents')
  let agent
  try {
    if (agents && typeof agents.get === 'function') agent = agents.get(sessionId)
  } catch (err) {
    log?.debug?.(`[pending] 读取 agent 失败: ${err?.message ?? err}`)
  }

  // ── ② 未决用户提问：会话投影 userQuestions ──────────────────────────
  const projections = svc('sessionProjections')
  const session = agent?.session
  if (projections && typeof projections.snapshot === 'function' && session) {
    try {
      const snapshot = projections.snapshot(session, ['userQuestions'])
      const view = snapshot?.values?.userQuestions
      if (view && Array.isArray(view.active)) {
        available += 1
        signals.questions = view.active.length
        if (view.active.length > 0) {
          const first = view.active[0]
          const text = first?.questions?.[0]?.question
          return busy(BUSY.QUESTION, text ? brief(text) : `${view.active.length} 个问题待回答`)
        }
      }
    } catch (err) {
      // 投影不可用只意味着这个判据缺席，后面的判据照常问
      log?.debug?.(`[pending] 读取 userQuestions 投影失败: ${err?.message ?? err}`)
    }
  }

  // ── ③ 宿主活动询问：workspace/session-activity ──────────────────────
  if (typeof ctx?.waterfall === 'function') {
    try {
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
      const list = Array.isArray(activity) ? activity : []
      available += 1
      signals.activity = list.map((a) => a?.kind ?? 'unknown')
      if (list.length > 0) {
        return busy(BUSY.ACTIVITY, `（${signals.activity.join('/')}）`)
      }
    } catch (err) {
      // 问不到就当"不确定"，不能当成空闲
      log?.warn?.(`[pending] workspace/session-activity 询问失败: ${err?.message ?? err}`)
      return busy(BUSY.UNKNOWN, '（活动状态询问失败）')
    }
  }

  // ── ④⑤ 活着的 Agent：状态与 inbox ──────────────────────────────────
  if (agent) {
    available += 1
    signals.status = agent.status ?? 'unknown'
    if (agent.status === 'running') return busy(BUSY.STATUS)

    const nextTurn = agent.inbox?.nextTurn?.length ?? 0
    const nextStep = agent.inbox?.nextStep?.length ?? 0
    signals.inbox = { nextTurn, nextStep }
    if (nextTurn + nextStep > 0) {
      return busy(BUSY.INBOX, `（${nextTurn + nextStep} 条）`)
    }
  }

  if (available === 0) return busy(BUSY.UNKNOWN)

  signals.assessed = available
  return idle()
}
