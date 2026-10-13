/**
 * 会话交班（"会话重生"）：上下文到阈值时，把旧会话整理成交接束 + 记忆碎片，
 * 归档旧会话、建新会话、把交接文本注入进去。
 *
 * ## 为什么要有这个东西
 *
 * 一个 QQ 会话 = 一个常驻对话会话。聊得久了上下文会撑满，宿主的 compaction 会把
 * 早期历史**静默**换成一段摘要 —— 用户看不出"它什么时候开始不记得了"。
 * 交班是**可见的**、**无损的**替代：先把该记住的抽成碎片落盘，再换一个干净的会话继续，
 * 并在 QQ 上说一句"我整理了一下"。
 *
 * ## 契约要点（逐条都有源码依据，改动前务必先读）
 *
 * | 约束 | 依据 |
 * |---|---|
 * | 阈值判据用 `ctx.tokenMeter.measure(session).totalTokens`，**不传第二参数** | 与压缩同一个数（`dsh-compaction-basic/lib/index.js:919` vs `:941`）；传第二参数会替换 envelope 导致两边不一致（`dsh-token-meter/lib/index.js:638`、`:643`） |
 * | 只能挂 `turn/end` | `contextPressure` 在一个回合内部不动（`dsh-token-meter/lib/index.js:487-495`），且 `measure()` 是 O(surface) + 深克隆，不能每条消息调 |
 * | **先归档、后建新会话** | `ArchivedSessionGate` 在 `agent/pre-step` 第一道闸门直接 reject（`dsh-api-session-controller/lib/types/archived-session-gate.js:17-25`），归档后任何唤醒都以 `blocked` 静默结束 |
 * | 归档后**绝不再投递** | 同上；由 `DeliveryGate` 单点强制，不靠"我们记得" |
 * | 交接文本走 `agent.inject()`，不走 `prompt()` | `prompt()` 造的是 `source.kind='user'` 的真用户消息（`dsh-api-session-controller/lib/index.js:858-881`），模型分不出来 |
 * | `ctx.llm.stream()`：**不传 `purpose`、不传 `tools`** | `purpose` 是封闭联合，只有 `'compaction'` / `'session-title'`（`dsh-llm/lib/types/types.d.ts:530`）；传 tools 会让模型去调工具而不是输出 JSON |
 * | 没有结构化输出 → 提示词内嵌 JSON 骨架 + 宽松解析 + 重试 1 次 + 降级 | 全树搜索 `response_format`/`json_schema` 只在前端高亮资源里命中 |
 * | `llm.stream()` 失败**不抛**，变成终止 `finish` chunk | `dsh-llm/lib/index.js:2369-2382`；必须像 `dsh-compaction-basic/lib/index.js:324-325` 那样检查 `finish`，否则失败会被当成"输出为空" |
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assessSessionWork } from './pending.js'
import { fragmentId } from './memory.js'

/** 交班失败时的降级理由（写进台账，便于排障） */
export const DEGRADE = {
  /** 压根没走到 LLM（读历史失败、无可用模型） */
  NO_INPUT: 'no-input',
  /** LLM 调用失败或输出无法解析 */
  LLM_FAILED: 'llm-failed',
  /** LLM 输出解析出来了但空 */
  EMPTY: 'empty',
}

/** 交接文本的身份声明。照抄宿主 `CHECKPOINT_PREAMBLE` 的手法（`dsh-compaction-basic/lib/index.js:280`） */
const HANDOFF_PREAMBLE =
  '这是**自动生成的会话交接记录**，不是用户的新指令。' +
  '它把上一段对话里必须带过来的事情浓缩在这里。' +
  '把它当作已经知道的背景，直接从接下来的消息继续，**不要回应这份记录本身**，' +
  '也不要说明你"看到了交接"。'

/**
 * 交班整理指令。
 *
 * ⚠️ 没有结构化输出支持，所以格式必须**写死在提示词里**，然后自己解析
 * （宿主 `COMPACTION_INSTRUCTION` 就是这么做的，`dsh-compaction-basic/lib/index.js:243-278`）。
 */
const EXTRACT_INSTRUCTION = `你是这次会话交班的整理者。下面是一个 QQ 对话的完整历史（可能已省略更早部分），以及这个会话已经记住的碎片清单。

你的任务是把"下一代会话要接住的东西"整理成 JSON。要求：
1. 只输出 JSON，不要 markdown 代码围栏，不要解释。
2. fragments 里每一条都要给 tag：
   +0 = 有信息但不动手就无所谓（寒暄、被推翻的中间结论、一次性试探）
   +1 = 影响下一句话怎么回答（称呼/语气偏好、当下在做的事、最近一次明确纠正）
   +2 = 不复述就会导致错误行为（长期目标、硬约束、明确的承诺与截止）
3. fragments 要短（每条 ≤ 60 字），要具体（保留路径、文件名、数字、日期、人名）。
   不要写"用户讨论了某个问题"这种没有信息量的话。
4. 如果某条碎片其实等价于清单里已有的某条，给 mergeWith: "<已有碎片 id>"，不要新增。
   **只在你有把握它们说的是同一件事时才给 mergeWith** —— 合并会丢掉差异，
   拿不准就新增一条。
5. handoff 里的每一项都用中文，inFlight/constraints/preferences/promises/openQuestions
   是字符串数组，没有就给空数组。persona 用第一人称写。

输出 JSON 形状（严格）：
{ "handoff": { "userGoal": "...", "inFlight": [], "constraints": [],
               "preferences": [], "promises": [], "openQuestions": [], "persona": "..." },
  "fragments": [ { "text": "...", "kind": "fact", "tag": 1, "confidence": 0.9,
                   "mergeWith": null } ],
  "drop": [] }`

// ── 宽松 JSON 解析 ────────────────────────────────────────────────────

/**
 * 从模型输出里抠出 JSON。
 *
 * **为什么必须宽松**：没有结构化输出，模型经常会套 ```json 围栏、或在 JSON 前后
 * 加一句"好的，这是整理结果："。严格 `JSON.parse` 会让这些全部走降级路径，
 * 而交班降级一次就少一份信息。
 *
 * 策略（从最保守到最宽松）：
 *   1. 直接 parse
 *   2. 剥掉 markdown 代码围栏后再 parse
 *   3. 取第一个 `{` 到最后一个 `}` 的子串再 parse
 *
 * @param {string} raw
 * @returns {{ok:true, value:any} | {ok:false, error:string}}
 */
export function parseLooseJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, error: '输出为空' }

  const attempts = [text]
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text)
  if (fenced?.[1]) attempts.push(fenced[1].trim())
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1))

  let lastError = '无法解析'
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt)
      if (value && typeof value === 'object') return { ok: true, value }
      lastError = '顶层不是对象'
    } catch (err) {
      lastError = String(err?.message ?? err)
    }
  }
  return { ok: false, error: lastError }
}

/** 把解析出来的对象收敛成内部形状；缺字段一律补空，不抛 */
export function normalizeBundle(value) {
  const h = value?.handoff && typeof value.handoff === 'object' ? value.handoff : {}
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [])
  const str = (v) => (typeof v === 'string' ? v.trim() : '')

  const fragments = []
  for (const raw of Array.isArray(value?.fragments) ? value.fragments : []) {
    if (!raw || typeof raw !== 'object') continue
    const text = str(raw.text)
    if (!text) continue
    fragments.push({
      text,
      kind: str(raw.kind) || 'fact',
      // tag 原样带过去：合法性由 MemoryStore 判（非法整条丢弃并记 badFragments）
      tag: raw.tag,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
      mergeWith: str(raw.mergeWith) || null,
    })
  }

  return {
    handoff: {
      userGoal: str(h.userGoal),
      inFlight: arr(h.inFlight),
      constraints: arr(h.constraints),
      preferences: arr(h.preferences),
      promises: arr(h.promises),
      openQuestions: arr(h.openQuestions),
      persona: str(h.persona),
    },
    fragments,
    drop: Array.isArray(value?.drop) ? value.drop.filter((x) => typeof x === 'string') : [],
    degraded: false,
  }
}

/** 降级交接束：规则骨架，不阻塞交班（设计文档 §2.2 阶段 2 的兜底） */
export function degradedBundle({ eventCount = 0, reason = '', measurement = null } = {}) {
  return {
    handoff: {
      userGoal: '',
      inFlight: [],
      constraints: [],
      preferences: [],
      promises: [],
      openQuestions: [],
      persona: '',
    },
    fragments: [],
    drop: [],
    degraded: true,
    degradeReason: reason,
    note:
      `（本次交班没能整理上一段对话：${reason || '未知原因'}。` +
      `上一段共有 ${eventCount} 条会话事件、约 ${measurement?.totalTokens ?? 0} token，` +
      `原始记录仍保留在该会话的历史里。）`,
  }
}

/** 渲染交接文本（进 `agent.inject()` 的那段） */
export function renderHandoff(bundle, { generation, chatLabel, fragments, memoryRevision, newSessionId }) {
  const h = bundle?.handoff ?? {}
  const lines = []
  lines.push(`【会话交接 · 第 ${generation} 代 · ${chatLabel}】`)
  lines.push('')
  lines.push(HANDOFF_PREAMBLE)
  lines.push('')

  if (bundle?.note) lines.push(bundle.note, '')
  if (h.userGoal) lines.push(`· 他要什么：${h.userGoal}`)
  const section = (title, list) => {
    if (!Array.isArray(list) || list.length === 0) return
    lines.push(`· ${title}：`)
    for (const item of list) lines.push(`    - ${item}`)
  }
  section('正在做但没做完的', h.inFlight)
  section('他明确说过的不许/必须', h.constraints)
  section('称呼与语气偏好', h.preferences)
  section('我答应过的事', h.promises)
  section('还没问清或他还没答的', h.openQuestions)
  if (h.persona) {
    lines.push(`· 我以什么身份在跟他说话：${h.persona}`)
  }

  const list = Array.isArray(fragments) ? fragments : []
  if (list.length > 0) {
    lines.push('')
    lines.push(`（跨会话累积记住的 ${list.length} 条重要的事，已经挂在常驻记忆里，这里不重复。）`)
  }
  lines.push('')
  lines.push('—— 交接记录结束。下面是用户刚说的话。')
  return lines.join('\n')
}

// ── 单点投递守卫 ──────────────────────────────────────────────────────

/**
 * **所有**向会话投递/注入的代码路径都必须经过这里。
 *
 * ## 为什么需要它（这是本轮最重要的一道防线）
 *
 * 归档一个会话**不 dispose agent**，也不抛错 —— `ArchivedSessionGate` 会在
 * `agent/pre-step` 第一道闸门直接 `{kind:'reject'}`，于是被唤醒的回合以
 * `turnEnds = {kind:'blocked'}` 结束（`dsh-agent-loop/lib/index.js:958-961`）。
 * **不报错、不通知、不阻断 `prompt` —— 静默不动。**
 *
 * 也就是说："往已归档的会话投递"是一次**静默的数据丢失**：
 * 调用方以为发出去了，其实那条消息连同被唤醒的用户输入一起被吞掉。
 *
 * 这类静默失败唯一能活下来的原因，就是判断散落在多处。所以这里做成一扇门：
 * 调用方各自判断"要不要投"，但"这台会话还能不能收"**只有这一处**说了算。
 *
 * 实测（tools/test-entry.mjs 的 fake 复刻了 ArchivedSessionGate 的形态）：
 * 对已归档会话 `inject` → `next-step` 里那条被 `pre-step` reject 一起吞掉，
 * 且**没有任何返回值能告诉调用方**。
 */
export class DeliveryGate {
  /**
   * @param {object} opts
   * @param {ReturnType<import('../log.js').createLogger>} opts.log
   */
  constructor({ log }) {
    this.log = log
    /**
     * 已退役的 sessionId → { at, why, by }
     * @type {Map<string, {at:number, why:string, by:string}>}
     */
    this.retired = new Map()
    this.stats = { delivered: 0, refused: 0, lastRefusal: null }
  }

  /**
   * 标记一个会话已退役（归档之后立刻调用）。
   * 幂等：重复标记只更新最近一次的理由。
   */
  retire(sessionId, { why = 'handoff', by = 'unknown' } = {}) {
    const id = String(sessionId ?? '')
    if (!id) return false
    const first = !this.retired.has(id)
    this.retired.set(id, { at: Date.now(), why, by })
    if (first) this.log.info(`[gate] 会话已退役（不再接受任何投递）：${id}（${why} / ${by}）`)
    return first
  }

  isRetired(sessionId) {
    return this.retired.has(String(sessionId ?? ''))
  }

  /** 会话被重新启用（目前只有测试与"重建绑定"用得到） */
  revive(sessionId) {
    return this.retired.delete(String(sessionId ?? ''))
  }

  /**
   * **唯一的投递入口**（同步版）。
   *
   * @param {object} input
   * @param {string} input.sessionId
   * @param {'inject'|'prompt'} input.kind 投递方式（用于日志与断言）
   * @param {string} input.by 调用点标识（"谁在投"），排障时必看
   * @param {() => any} input.deliver 真正执行投递的闭包（守卫放行后才会被调用）
   * @returns {{ok:boolean, refused?:boolean, reason?:string, value?:any}}
   */
  deliver({ sessionId, kind, by, deliver }) {
    const gate = this.#check(sessionId, kind, by)
    if (gate) return gate
    try {
      const value = deliver()
      this.stats.delivered += 1
      return { ok: true, value }
    } catch (err) {
      return { ok: false, refused: false, reason: String(err?.message ?? err), error: err }
    }
  }

  /**
   * 异步版。**语义与 `deliver` 完全相同**，只是把返回值解开。
   *
   * 之所以要有两个：`agent.inject()` 是同步的，`sessions.prompt()` 是异步的。
   * 让调用方各自 `await` 自己那一份会把守卫判断重复两遍 —— 而"判断散落在多处"
   * 正是这套守卫要消灭的东西。所以判断只在 `#check` 里，两个入口共享它。
   *
   * @param {object} input 同上，但 `deliver` 返回 Promise
   * @returns {Promise<{ok:boolean, refused?:boolean, reason?:string, value?:any, error?:any}>}
   */
  async deliverAsync({ sessionId, kind, by, deliver }) {
    const gate = this.#check(sessionId, kind, by)
    if (gate) return gate
    try {
      const value = await deliver()
      this.stats.delivered += 1
      return { ok: true, value }
    } catch (err) {
      return { ok: false, refused: false, reason: String(err?.message ?? err), error: err }
    }
  }

  /** 守卫判断本身（两个入口共享，**只有这一份**） */
  #check(sessionId, kind, by) {
    const id = String(sessionId ?? '')
    if (!id) return { ok: false, refused: true, reason: 'empty-session-id' }

    const retired = this.retired.get(id)
    if (!retired) return null

    this.stats.refused += 1
    this.stats.lastRefusal = { sessionId: id, kind, by, at: Date.now(), why: retired.why }
    // 拒绝必须**有声**：这是对抗静默失败的唯一手段
    this.log.warn(
      `[gate] 拒绝向已退役会话投递：${kind} → ${id}（调用点 ${by}；` +
        `退役原因 ${retired.why}，${Math.round((Date.now() - retired.at) / 1000)} 秒前）`,
    )
    return { ok: false, refused: true, reason: `session-retired:${retired.why}` }
  }

  snapshot() {
    return {
      retiredCount: this.retired.size,
      ...this.stats,
      retired: [...this.retired.entries()].slice(-20).map(([sessionId, meta]) => ({ sessionId, ...meta })),
    }
  }
}

// ── 交班监视器 ────────────────────────────────────────────────────────

/**
 * 挂在 `session/event` 上，只在常驻会话的 `turn/end` 测一次压力并决定要不要交班。
 *
 * 不轮询、不做每条消息检查 —— 理由见文件头表格第二行。
 */
export class ConversationHandoff {
  /**
   * @param {object} opts
   * @param {any} opts.ctx cordis 上下文
   * @param {ReturnType<import('../config.js').resolveConfig>} opts.config
   * @param {ReturnType<import('../log.js').createLogger>} opts.log
   * @param {import('./bridge.js').DshBridge} opts.bridge
   * @param {import('./state.js').StateStore} opts.state
   * @param {import('./memory.js').MemoryStore} opts.memory
   * @param {import('./relay.js').ProgressRelay} opts.relay
   * @param {DeliveryGate} opts.gate
   * @param {import('./context.js').ScopeResolver} opts.resolver
   * @param {(chatType:string, chatId:string, text:string) => Promise<void>} opts.notify
   * @param {() => void} [opts.onUnfreeze]
   *   解冻回调：交班走完（或失败收尾）后调一次。入口路径用它把**冻结期攒下的
   *   消息按原顺序补投进新会话** —— 那些消息在冻结期投不进去（旧会话已归档、
   *   新会话还没建），但也不许另起会话（见 index.js 的 frozenQueue）。
   */
  constructor({ ctx, config, log, bridge, state, memory, relay, gate, resolver, notify, onUnfreeze }) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.bridge = bridge
    this.state = state
    this.memory = memory
    this.relay = relay
    this.gate = gate
    this.resolver = resolver
    this.notify = notify
    this.onUnfreeze = typeof onUnfreeze === 'function' ? onUnfreeze : null

    /**
     * 冻结闸门：`chatType:chatId` → 冻结信息。
     * 冻结期间新来的消息由入口路径**排队**（不投递、也不另起会话），
     * 解冻后经 `onUnfreeze` 按原顺序补投 —— 交班不会丢消息。
     */
    /** @type {Map<string, {at:number, gen:number}>} */
    this.frozen = new Map()

    /** 最近一次实测到的上下文窗口（从 session.requestHeader() 解析，拿不到时为 0） */
    this.contextWindow = 0
    /** 最近一次压缩阈值推算（宿主 compaction 的 thresholdRatio 默认 0.8） */
    this.compactionThresholdRatio = 0.8
    /** 每个 scope 最近一次测量结果，供状态端点回答"离交班还差多少" */
    /** @type {Map<string, {at:number, totalTokens:number, contextWindow:number, ratio:number, threshold:number}>} */
    this.measurements = new Map()
    /**
     * 交接文本的**待交付**台账：`scope` → `{sessionId, text, gen, delivered}`。
     *
     * ## 为什么需要它
     *
     * 交接文本走 `agent.inject()`，进的是 `next-step`；而宿主的 `claim()` 在**任何**
     * 回合的第一步都会无条件吃掉整个 `next-step`（`dsh-agent-loop/lib/index.js:103-111`）——
     * 包括**不是用户消息触发**的回合（定时项、后台作业、宿主的维护回合）。
     * 那种回合会把交接文本单独吃掉：等用户真正开口时，它已经不在上下文里了，
     * 而 §1.6 的位置契约（`[交接][用户的话][运行时上下文]`）也就无从谈起。
     *
     * 所以这里记一笔"这份交接文本还没和用户的话一起送达"，并在该会话每次
     * `turn/end` 时补投一次（`inject` 不唤醒，补投不会多烧一个回合）。
     * 用户的消息一旦真的投进去（`noteUserDelivery`），补投就停 —— 那时交接文本
     * 已经和它同批被 claim 了。
     */
    /** @type {Map<string, {sessionId:string, text:string, gen:number, delivered:boolean, at:number, rearms:number}>} */
    this.pendingDelivery = new Map()

    this.stats = {
      checks: 0,
      belowThreshold: 0,
      deferredBusy: 0,
      deferredCooldown: 0,
      rearmed: 0,
      triggered: 0,
      completed: 0,
      degraded: 0,
      failed: 0,
      archiveFailed: 0,
      delivered: 0,
      refused: 0,
      lastError: null,
      lastAt: 0,
    }
  }

  // ── 阈值测量 ────────────────────────────────────────────────────────

  /**
   * 上下文窗口从哪来。
   *
   * ⚠️ 顺序很重要：真正的权威是**适配器声明的** `resolveModelInfo(provider, model).contextWindow`。
   * `session.requestHeader().config` 只有 provider/model，**没有** contextWindow。
   * 拿不到就退回配置里的推算值，并把"没拿到"记进 stats —— 宁可显示"未知"，
   * 也不要拿一个错的窗口算出错的百分比。
   */
  async resolveContextWindow(agent) {
    const llm = typeof this.ctx.get === 'function' ? this.ctx.get('llm') : undefined
    const header = agent?.session?.requestHeader?.()
    const provider = header?.config?.provider ?? agent?.options?.provider
    const model = header?.config?.model ?? agent?.options?.model
    if (llm && typeof llm.resolveModelInfo === 'function' && provider && model) {
      try {
        const info = await llm.resolveModelInfo(provider, model)
        const cw = Number(info?.contextWindow)
        if (Number.isFinite(cw) && cw > 0) return { contextWindow: cw, provider, model, source: 'llm.resolveModelInfo' }
      } catch (err) {
        this.log.debug(`[handoff] resolveModelInfo(${provider}/${model}) 失败: ${err?.message ?? err}`)
      }
    }
    return { contextWindow: 0, provider: provider ?? '', model: model ?? '', source: 'unavailable' }
  }

  /** 观测：把当前压力写进 measurements（状态端点靠它回答"离交班还差多少"） */
  observe(scope, totalTokens, contextWindow, ratio, threshold) {
    const rec = { at: Date.now(), totalTokens, contextWindow, ratio, threshold }
    this.measurements.set(scope, rec)
    return rec
  }

  /**
   * `turn/end` 的入口。**同步返回**，真正的交班异步跑（不阻塞事件流）。
   *
   * @param {string} sessionId
   * @param {any} reason
   */
  onTurnEnd(sessionId, reason) {
    const id = String(sessionId ?? '')
    if (!id) return
    // 只盯常驻会话：任务会话由 TaskScheduler 管，交班不碰它们
    const chat = this.bridge.chatForSession(id)
    if (!chat || chat.kind !== 'root') return
    const scope = `${chat.chatType}:${chat.chatId}`
    if (this.frozen.has(scope)) return // 已经在交班了（幂等闸门）
    this.log.debug(`[handoff] 收到常驻会话的 turn/end：${scope}（session=${id}），开始判阈值`)

    void this.#maybeHandoff(id, chat, scope, reason)
      .then((handedOff) => {
        // 这一回合**没有**交班：如果还有一份交接文本没和用户的话一起送达，补投一次
        if (!handedOff) this.#rearmPending(id, scope)
      })
      .catch((err) => {
        this.stats.failed += 1
        this.stats.lastError = String(err?.message ?? err)
        this.log.error(`[handoff] 交班流程异常: ${err?.stack ?? err}`)
      })
  }

  /**
   * 用户的一条消息已经投进这台会话了。
   *
   * 由 `Bridge.promptSession()` 在投递成功后回调（**唯一**的 prompt 投递入口）。
   * 拿到它之后我们就知道：交接文本已经和用户的话同批进了下一步的 claim ——
   * 补投到此为止。
   */
  noteUserDelivery(sessionId) {
    const id = String(sessionId ?? '')
    if (!id) return false
    let marked = false
    for (const [scope, pending] of this.pendingDelivery) {
      if (pending.sessionId !== id) continue
      pending.delivered = true
      marked = true
      this.log.debug(`[handoff] ${scope} 的交接文本已随用户消息交付（第 ${pending.gen} 代），停止补投`)
    }
    return marked
  }

  /**
   * 补投一份还没交付的交接文本（见 `pendingDelivery` 的注释）。
   *
   * 只在"这一回合没交班"时调用（交班会换掉整份台账），所以不会和交班流程抢会话。
   *
   * 为什么必须补投：宿主的 `claim()` 在**任何**回合的第一步都无条件吃掉整个
   * `next-step`（`dsh-agent-loop/lib/index.js:103-111`），包括不是用户消息触发的
   * 回合（定时项、后台作业、宿主的维护回合）。那种回合会把交接文本单独吃掉：
   * 用户真正开口时它已经不在上下文里，§1.6 的位置契约（`[交接][用户的话]`）
   * 也就无从谈起。补投是 `inject`（不唤醒），不会多烧一个回合。
   */
  #rearmPending(sessionId, scope) {
    const pending = this.pendingDelivery.get(scope)
    if (!pending || pending.sessionId !== sessionId || pending.delivered) return false
    const agents = typeof this.ctx.get === 'function' ? this.ctx.get('agents') : undefined
    const agent = agents?.get?.(sessionId)
    if (!agent || typeof agent.inject !== 'function') return false
    const result = this.gate.deliver({
      sessionId,
      kind: 'inject',
      by: 'handoff:rearm',
      deliver: () => agent.inject(createHandoffMessage(pending.text, pending.gen)),
    })
    if (!result.ok) return false
    pending.rearms += 1
    this.stats.rearmed += 1
    this.log.info(
      `[handoff] ${scope} 的交接文本还没和用户消息一起送达，已补投第 ${pending.rearms} 次` +
        `（第 ${pending.gen} 代；补投不唤醒，等用户下一句话同批 claim）`,
    )
    return true
  }

  /**
   * @returns {Promise<boolean>} 是否真的交班了（调用方据此决定要不要补投）
   */
  async #maybeHandoff(sessionId, chat, scope, reason) {
    const cfg = this.config.conversation
    const agents = typeof this.ctx.get === 'function' ? this.ctx.get('agents') : undefined
    const agent = agents?.get?.(sessionId)
    if (!agent) return false // agent 没了：归档或进程重启，没什么可交班的

    const meter = typeof this.ctx.get === 'function' ? this.ctx.get('tokenMeter') : undefined
    if (!meter || typeof meter.measure !== 'function') {
      this.log.warn('[handoff] tokenMeter 服务不可用 —— 无法测量上下文压力，交班功能停用')
      return false
    }

    this.stats.checks += 1
    const chatRecord = this.state.get(chat.chatType, chat.chatId) ?? {}
    const gen = Number(chatRecord.rootGeneration ?? 1)

    // ① 唯一判据：与压缩同源的 numerator。
    //    ⚠️ **不传第二参数** —— 传了会替换最新 envelope，导致与压缩读到不同的数。
    let measurement
    try {
      measurement = meter.measure(agent.session)
    } catch (err) {
      this.log.warn(`[handoff] tokenMeter.measure 失败: ${err?.message ?? err}`)
      return false
    }
    const totalTokens = Number(measurement?.totalTokens ?? 0)

    const cw = await this.resolveContextWindow(agent)
    if (cw.contextWindow > 0) this.contextWindow = cw.contextWindow
    const contextWindow = cw.contextWindow > 0 ? cw.contextWindow : this.contextWindow
    if (!contextWindow) {
      // 拿不到窗口就只能记原始 token 数，不能算出比例 —— 也绝不"猜一个窗口"
      this.observe(scope, totalTokens, 0, 0, 0)
      this.log.debug(`[handoff] ${scope} 拿不到 contextWindow（provider=${cw.provider} model=${cw.model}），本次不判阈值`)
      return false
    }

    const threshold = Math.max(1, Math.floor(contextWindow * cfg.handoffAtRatio))
    const ratio = totalTokens / contextWindow
    this.observe(scope, totalTokens, contextWindow, ratio, threshold)

    if (totalTokens < threshold) {
      this.stats.belowThreshold += 1
      this.log.debug(
        `[handoff] ${scope} 第 ${gen} 代 ${totalTokens}/${threshold} token（${(ratio * 100).toFixed(1)}% / ` +
          `阈值 ${(cfg.handoffAtRatio * 100).toFixed(0)}%），未到交班线`,
      )
      return false
    }

    // ② 冷却：**在"这一代"内部**至少要涨够 minTokensBetweenHandoffs。
    //
    //    ⚠️ 基线必须是**这一代自己的起点**（上一次交班建出新会话那一刻的 token 数），
    //    不能拿上一代的收尾 token 来比 —— 新会话是从零涨起来的，两个不同会话的
    //    token 数相减没有意义：那会让"上一代收尾 25k、这一代已经 40k"被判成
    //    "只涨了 15k"而拒绝交班，于是每一代都只交班一次就再也交不动。
    //    所以：只有"上次交班建的正是这台会话"时才比，且比的是它自己的增长量。
    //    绑定被手工重建（`last.to !== sessionId`）时无从比较，直接放行。
    const last = chatRecord.lastHandoff
    if (last && String(last.to ?? '') === sessionId) {
      const base = Number(last.baselineTokens ?? 0) || 0
      const grown = totalTokens - base
      if (grown < cfg.minTokensBetweenHandoffs) {
        this.stats.deferredCooldown += 1
        this.log.info(
          `[handoff] ${scope} 已超阈值但这一代只涨了 ${grown} token ` +
            `（< minTokensBetweenHandoffs=${cfg.minTokensBetweenHandoffs}），跳过本次`,
        )
        return false
      }
    }

    // ③ 活动判据：复用现成的 assessSessionWork（别重写一遍）
    const view = await assessSessionWork(
      { ctx: this.ctx, log: this.log },
      sessionId,
      { approvals: this.relay.approvalsFor(sessionId) },
    )
    if (view.busy) {
      this.stats.deferredBusy += 1
      this.log.info(`[handoff] ${scope} 已超阈值但会话还忙着（${view.reason}${view.detail ? ': ' + view.detail : ''}），等下个 turn/end`)
      return false
    }

    await this.#handoff({ sessionId, chat, scope, chatRecord, gen, measurement, ratio, reason })
    return true
  }

  // ── 冻结闸门 ────────────────────────────────────────────────────────

  /** 幂等冻结：同一 key 已有交班在跑就返回 false */
  #freeze(scope, gen) {
    if (this.frozen.has(scope)) return false
    this.frozen.set(scope, { at: Date.now(), gen })
    return true
  }

  #unfreeze(scope) {
    this.frozen.delete(scope)
    // 交班走完 → 通知入口路径把冻结期排队的那几条补投进新会话。
    // 回调失败不能影响交班本身的收尾（消息会留在队列里等下一次解冻）。
    try {
      this.onUnfreeze?.()
    } catch (err) {
      this.log.warn(`[handoff] onUnfreeze 回调失败: ${err?.message ?? err}`)
    }
  }

  /** 这个 QQ 会话是否正在交班（入口路径据此把消息排进 frozenQueue，而不是投递） */
  isFrozen(chatType, chatId) {
    return this.frozen.has(`${chatType}:${chatId}`)
  }

  // ── 主流程 ──────────────────────────────────────────────────────────

  /**
   * 交班主流程的**外层包装**：只负责一件事 —— 保证 `#freeze` 过的 scope
   * **无论如何都会被解冻**。
   *
   * ⚠️ 为什么必须是 finally：`frozen` 是入口路径的判据（`isFrozen`），冻结期间
   *    该会话的每条消息都进 `frozenQueue`，而队列**只在解冻回调里**被抽干
   *    （`index.js` 的 `drainFrozenQueue` ← `onUnfreeze`）。早先唯一解冻点在主流程的
   *    happy path 末尾，于是阶段 3-7 之间任何一步抛错（归档、切映射、写台账……）
   *    都会让这个 QQ 会话永久停在冻结态：消息照样进队列、永远没人投递，
   *    表现就是"这个群从此再也不回话"，只有重启进程才恢复。
   */
  async #handoff(args) {
    if (!this.#freeze(args.scope, args.gen)) return
    // 计数放在冻结成功之后：早已在交班的 scope 会在这里返回，
    // 那种"想交班但被幂等挡掉"的次数不该算进 triggered（否则账目虚高）
    this.stats.triggered += 1
    try {
      await this.#handoffInner(args)
    } finally {
      this.#unfreeze(args.scope)
    }
  }

  /** 交班主流程本体（阶段 1-7）。解冻由 `#handoff` 的 finally 统一兜底，这里不要自己解冻 */
  async #handoffInner({ sessionId, chat, scope, chatRecord, gen, measurement, ratio, reason }) {
    const t0 = Date.now()
    const label = chat.chatName?.trim() || (chat.chatType === 'group' ? `群 ${chat.chatId}` : `私聊 ${chat.chatId}`)
    const nextGen = gen + 1
    let bundle = null
    let events = []
    const stats = { fragmentsAdded: 0, fragmentsMerged: 0, archiveFailed: false, degradeReason: '' }

    try {
      // ── 阶段 1：读完整历史（含被压缩遮蔽的）────────────────────────
      events = await this.#readHistory(sessionId)

      // ── 阶段 2：一次 ctx.llm.stream() 得到交接束（失败重试 1 次）────
      bundle = await this.#extract(events, sessionId, measurement, gen, scope)
      if (bundle.degraded) stats.degradeReason = bundle.degradeReason ?? DEGRADE.LLM_FAILED
    } catch (err) {
      this.log.error(`[handoff] 抽取失败（走降级）: ${err?.stack ?? err}`)
      bundle = degradedBundle({ eventCount: events.length, reason: String(err?.message ?? err), measurement })
      stats.degradeReason = DEGRADE.NO_INPUT
      this.stats.degraded += 1
    }

    // ── 阶段 3：合并记忆碎片并落盘 ────────────────────────────────────
    //     ⚠️ **在归档之前**做：万一后面任何一步崩了，记忆已经安全落盘
    let absorbed = null
    try {
      absorbed = await this.memory.absorb({
        scope,
        gen: nextGen,
        fragments: bundle.fragments,
        drop: bundle.drop,
        agingEveryGens: this.config.conversation.agingEveryGens,
        maxFragments: this.config.conversation.maxFragmentsPerChat,
      })
      stats.fragmentsAdded = absorbed.added
      stats.fragmentsMerged = absorbed.merged
    } catch (err) {
      this.log.error(`[handoff] 记忆落盘失败: ${err?.stack ?? err}`)
      absorbed = { added: 0, merged: 0, dup: 0, asked: 0, bad: 0, revision: this.memory.revision }
    }

    // 交班束整份留档：交班是唯一会永久丢掉对话的操作，
    // 出事时用户唯一想问的是"我上次说的那句它到底带过去没有"
    const handoffFile = this.#writeLedger(scope, nextGen, { bundle, measurement, ratio, absorbed, events: events.length })

    // ── 阶段 4：归档旧会话（**必须在建新会话之前**）────────────────────
    let archived = false
    try {
      archived = await this.bridge.archiveSession(sessionId)
    } catch (err) {
      // 归档失败不是致命：继续交班，但旧会话会留在侧边栏
      stats.archiveFailed = true
      this.stats.archiveFailed += 1
      this.log.warn(`[handoff] 归档旧会话失败（不阻塞交班）: ${err?.message ?? err}`)
    }
    // ⚠️ 无论归档成功与否，**立刻**把会话标为退役：
    //    "归档失败"意味着它可能仍然是活的，但我们的映射马上要切走，
    //    再往里投递只会让旧会话和新会话各回一遍 —— 所以两种情况下都退役。
    this.gate.retire(sessionId, { why: archived ? 'handoff-archived' : 'handoff-archive-failed', by: 'handoff' })
    this.resolver.invalidate(sessionId)
    // 归档之后、建新会话之前把"我正在交班"落一次盘：这一小段窗口是交班唯一
    // 会造成**静默丢消息**的残留（映射还指着已经归档的会话）。见 state.js 的
    // markHandoffPending / pendingHandoffRecoveries。
    this.state.markHandoffPending(chat.chatType, chat.chatId, { from: sessionId, gen: nextGen, at: Date.now() })

    // ── 阶段 5：建新会话并注入交接文本 ────────────────────────────────
    let newSessionId = ''
    try {
      newSessionId = await this.bridge.newSession(
        chatRecord,
        `QQ · ${label} · 第 ${nextGen} 代`,
      )
      this.resolver.remember(newSessionId, scope)

      const text = renderHandoff(bundle, {
        generation: nextGen,
        chatLabel: label,
        fragments: absorbed?.ids ?? [],
        memoryRevision: this.memory.revision,
      })
      // 交接文本走 agent.inject()：进 next-step，**不唤醒**（`dsh-agent-loop/lib/index.js:812-814`），
      // 排在用户下一句话之前（`claim` 无条件先吃 next-step，`:103-111`）。
      // ⚠️ 走 DeliveryGate —— 单点判断"这台会话还能不能收"。
      const agents = typeof this.ctx.get === 'function' ? this.ctx.get('agents') : undefined
      const newAgent = agents?.get?.(newSessionId)
      if (newAgent && typeof newAgent.inject === 'function') {
        const userMessage = createHandoffMessage(text, nextGen)
        const result = this.gate.deliver({
          sessionId: newSessionId,
          kind: 'inject',
          by: 'handoff:create',
          deliver: () => newAgent.inject(userMessage),
        })
        if (result.ok) {
          this.stats.delivered += 1
          // 记一笔"待交付"：它还没和用户的消息一起被 claim。
          // 在那之前，这台会话每次 turn/end 都会补投一次（见 pendingDelivery 的注释）。
          this.pendingDelivery.set(scope, {
            sessionId: newSessionId,
            text,
            gen: nextGen,
            delivered: false,
            at: Date.now(),
            rearms: 0,
          })
        } else {
          this.stats.refused += 1
        }
      } else {
        this.log.warn(`[handoff] 新会话 ${newSessionId} 还没有 agent，交接文本未能注入（记忆已落盘，下次交班会带上）`)
      }
    } catch (err) {
      this.stats.failed += 1
      this.stats.lastError = String(err?.message ?? err)
      this.log.error(`[handoff] 建新会话失败: ${err?.stack ?? err}`)
    }

    // ── 阶段 6：切换映射（先清空绑定，让下次消息惰性重建）────────────
    if (newSessionId) {
      this.state.setRootSession(chat.chatType, chat.chatId, newSessionId)
      this.resolver.remember(newSessionId, scope)
    } else {
      // 建会话失败：清空绑定，让下一次消息惰性重建（bridge.ensureRootSession 已支持）
      this.state.setRootSession(chat.chatType, chat.chatId, '')
      this.log.warn(`[handoff] ${scope} 新一代会话没建起来，已清空绑定等下次消息重建`)
    }
    this.state.recordHandoff(chat.chatType, chat.chatId, {
      gen: nextGen,
      at: Date.now(),
      from: sessionId,
      to: newSessionId,
      ratio,
      tokens: Number(measurement?.totalTokens ?? 0),
      /**
       * **这一代（新会话）自己的 token 起点**，下次冷却判断用它当基线。
       *
       * 新会话是刚 create 出来的：它的 fold 从零开始，交接文本进的是 `next-step`
       * （要等第一次真请求才进 token 计数）—— 所以除了"这一代自己攒出来的内容"，
       * 没有别的东西可以算进基线，取 0 是诚实的。
       * ⚠️ 绝不能拿上一代的 `tokens` 当基线：那是**另一台会话**的收尾数字。
       */
      baselineTokens: 0,
      contextWindow: this.contextWindow,
      threshold: Math.floor(this.contextWindow * this.config.conversation.handoffAtRatio),
      degraded: Boolean(bundle?.degraded),
      degradeReason: stats.degradeReason,
      fragmentsAdded: stats.fragmentsAdded,
      fragmentsMerged: stats.fragmentsMerged,
      fragmentsDup: absorbed?.dup ?? 0,
      fragmentsBad: absorbed?.bad ?? 0,
      archiveFailed: stats.archiveFailed,
      ledger: handoffFile,
      ms: Date.now() - t0,
      reason: String(reason?.kind ?? 'unknown'),
    })

    // ── 阶段 7：告诉用户（解冻由 `#handoff` 的 finally 统一做）────────
    this.stats.completed += 1
    this.stats.lastAt = Date.now()
    if (bundle?.degraded) this.stats.degraded += 1

    const kept = this.memory.forScope(scope).length
    const text = bundle?.degraded
      ? `🔄 这次对话有点长了，我换了个清爽的脑袋继续（第 ${nextGen} 代）。` +
        `不过刚才那段我整理得不太顺（${stats.degradeReason || '未知原因'}），` +
        `只把原本记住的 ${kept} 条事带过来了。`
      : `🔄 我整理了一下之前的对话，换了个清爽的脑袋继续（第 ${nextGen} 代）。` +
        `记住了 ${kept} 条重要的事${stats.fragmentsAdded > 0 ? `（这次新添 ${stats.fragmentsAdded} 条）` : ''}，` +
        `之前的会话我收起来了。`
    try {
      await this.notify(chat.chatType, chat.chatId, text)
    } catch (err) {
      this.log.warn(`[handoff] 通知失败: ${err?.message ?? err}`)
    }
    this.log.info(
      `[handoff] ${scope} 第 ${gen} → ${nextGen} 代完成：${Math.round((Date.now() - t0))}ms ` +
        `token=${measurement?.totalTokens ?? 0} 新增碎片=${stats.fragmentsAdded} 合并=${stats.fragmentsMerged} ` +
        `降级=${Boolean(bundle?.degraded)} 归档=${archived ? 'ok' : 'failed'} 新会话=${newSessionId || '(无)'}`,
    )
  }

  /**
   * 阶段 1：读完整事件日志。
   *
   * 优先 `ctx.sessionQuery.readSession()`（返回**完整原始日志**，不做 surface 折叠，
   * `dsh-session-query/lib/index.js:1079-1087`）。
   * 兜底 `session.snapshotEvents()` —— 它已被宿主标记 deprecated（`:1358-1359`），
   * 所以用到了必须留一条 warn。
   */
  async #readHistory(sessionId) {
    const sq = typeof this.ctx.get === 'function' ? this.ctx.get('sessionQuery') : undefined
    if (sq && typeof sq.readSession === 'function') {
      try {
        const result = await sq.readSession(sessionId)
        const events = Array.isArray(result?.events) ? result.events : []
        this.log.debug(`[handoff] readSession 取到 ${events.length} 条事件`)
        return events
      } catch (err) {
        this.log.warn(`[handoff] sessionQuery.readSession 失败: ${err?.message ?? err}`)
      }
    } else {
      this.log.warn('[handoff] sessionQuery 服务不可用，回退到已废弃的 session.snapshotEvents()')
    }
    const agents = typeof this.ctx.get === 'function' ? this.ctx.get('agents') : undefined
    const session = agents?.get?.(sessionId)?.session
    if (session && typeof session.snapshotEvents === 'function') {
      this.log.warn('[handoff] 使用了 deprecated 的 session.snapshotEvents() —— 建议检查 sessionQuery 服务')
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : []
    }
    throw new Error('读不到会话历史（sessionQuery 与 snapshotEvents 都不可用）')
  }

  /**
   * 把事件日志折成 `[{role, text}]`，按 handoffInputChars 从**头部**截断。
   *
   * 只取用户/助手两种角色：工具调用与结果的原文很长、对"记住什么"没有价值
   * （而且它们的细节本来就落盘在工作区里）。
   */
  foldEvents(events, maxChars) {
    const lines = []
    let skipped = 0
    for (const event of events) {
      const type = event?.type
      if (type !== 'user/message' && type !== 'assistant/message') continue
      const role = type === 'user/message' ? '用户' : '我'
      const text = messageText(event?.data?.message ?? event?.data)
      if (!text) continue
      // 运行时上下文快照是宿主自己注入的，不该被当成对话内容再整理一遍
      const source = event?.data?.message?.source ?? event?.data?.source
      if (source?.kind === 'runtime-context') continue
      if (source?.kind === 'handoff') {
        lines.push({ role: '系统', text: `（上一代交接记录）${text}` })
        continue
      }
      lines.push({ role, text, seq: event?.seq })
    }

    let total = lines.reduce((n, l) => n + l.text.length + 8, 0)
    const limit = Math.max(1000, Number(maxChars) || 120000)
    while (lines.length > 1 && total > limit) {
      const dropped = lines.shift()
      total -= dropped.text.length + 8
      skipped += 1
    }
    return { lines, skipped }
  }

  /**
   * 阶段 2：一次 `ctx.llm.stream()` 拿到交接束。
   *
   * ## 逐条遵守的契约
   *
   * - **不传 `purpose`**：它是封闭联合，只有 `'compaction'` / `'session-title'`
   *   （`dsh-llm/lib/types/types.d.ts:530`）。传自造字符串的 adapter 行为未定义。
   * - **不传 `tools`**：宿主传 tools 是为了复用 KV cache 前缀；我们不需要，
   *   而且传了模型可能去调工具、破坏"只输出 JSON"。
   * - **失败不抛**：`async *` 迭代会把 adapter/dispatch 失败变成终止 `finish` chunk
   *   （`dsh-llm/lib/index.js:2364-2382`），所以**必须**检查 `finish`，
   *   否则失败会被当成"输出为空"（宿主的做法见 `dsh-compaction-basic/lib/index.js:324-325`）。
   * - 目标 provider/model 照抄宿主的三级回退（`dsh-compaction-basic/lib/index.js:293-302`）：
   *   会话已记录的 envelope → agent.options → agentDefaultModel。
   */
  async #extract(events, sessionId, measurement, gen, scope) {
    const folded = this.foldEvents(events, this.config.conversation.handoffInputChars)
    const existing = this.memory.forScope(scope).sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
    const target = await this.#resolveTarget(sessionId)

    if (!target.provider || !target.model) {
      this.log.warn('[handoff] 找不到可用的 provider/model，交班走降级路径')
      return degradedBundle({ eventCount: events.length, reason: 'no-model-target', measurement })
    }
    if (folded.lines.length === 0) {
      // 没有可整理的内容（例如整个会话只有工具调用）：不是错误，直接给空束
      return {
        handoff: { userGoal: '', inFlight: [], constraints: [], preferences: [], promises: [], openQuestions: [], persona: '' },
        fragments: [],
        drop: [],
        degraded: false,
        note: '（上一段没有可整理的对话内容。）',
      }
    }

    // 最多试 2 次（首次 + 重试 1 次）；两次都失败就降级
    let lastError = ''
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await this.#callLlm({ target, folded, existing, sessionId, attempt })
        const parsed = parseLooseJson(raw)
        if (!parsed.ok) {
          lastError = `JSON 解析失败: ${parsed.error}`
          this.log.warn(`[handoff] 第 ${attempt + 1} 次整理输出无法解析（${parsed.error}），${attempt === 0 ? '重试一次' : '走降级'}`)
          continue
        }
        const bundle = normalizeBundle(parsed.value)
        if (bundle.fragments.length === 0 && !bundle.handoff.userGoal && !bundle.handoff.persona) {
          lastError = '整理结果为空'
          this.log.warn(`[handoff] 第 ${attempt + 1} 次整理结果是空的，${attempt === 0 ? '重试一次' : '走降级'}`)
          continue
        }
        bundle.llm = { ...target, provider: target.provider, model: target.model }
        return bundle
      } catch (err) {
        lastError = String(err?.message ?? err)
        this.log.warn(`[handoff] 第 ${attempt + 1} 次整理调用失败: ${lastError}`)
      }
    }
    return degradedBundle({ eventCount: events.length, reason: `${DEGRADE.LLM_FAILED}: ${lastError}`, measurement })
  }

  /** provider/model 三级回退（照抄 dsh-compaction-basic/lib/index.js:293-302） */
  async #resolveTarget(sessionId) {
    const agents = typeof this.ctx.get === 'function' ? this.ctx.get('agents') : undefined
    const agent = agents?.get?.(sessionId)

    // ① 用户显式配置（本插件没有这个配置项，留位）
    // ② 会话已记录的 envelope：跑过至少一次请求之后一定命中
    const latest = agent?.session?.requestHeader?.()?.config
    if (latest?.provider && latest?.model) return { provider: latest.provider, model: latest.model, source: 'requestHeader' }

    // ③ agent.options
    const opt = agent?.options
    if (opt?.provider && opt?.model) return { provider: opt.provider, model: opt.model, source: 'agent.options' }

    // ④ agentDefaultModel（服务已核实存在：dsh-agent-default-model/lib/index.js:17-45）
    const def = typeof this.ctx.get === 'function' ? this.ctx.get('agentDefaultModel') : undefined
    try {
      const current = def?.current ?? (typeof def?.get === 'function' ? def.get() : undefined)
      if (current?.provider && current?.model) return { provider: current.provider, model: current.model, source: 'agentDefaultModel' }
    } catch {
      /* 忽略 */
    }
    return { provider: '', model: '', source: 'none' }
  }

  /** 一次 LLM 调用；返回拼接后的文本。失败抛错（由调用方重试/降级） */
  async #callLlm({ target, folded, existing, sessionId, attempt }) {
    const llm = typeof this.ctx.get === 'function' ? this.ctx.get('llm') : undefined
    if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用')

    const parts = []
    if (folded.skipped > 0) {
      parts.push(`[以下为更早内容的省略，共 ${folded.skipped} 条]`)
    }
    for (const line of folded.lines) parts.push(`${line.role}：${line.text}`)
    parts.push('')
    parts.push('=== 这个会话已经记住的碎片清单 ===')
    if (existing.length === 0) {
      parts.push('（还没有任何碎片）')
    } else {
      for (const f of existing) parts.push(`${f.id} | ${f.kind} | 重要度${f.importance} | ${f.refs} 次 | ${f.text}`)
    }
    parts.push('')
    parts.push(EXTRACT_INSTRUCTION)
    if (attempt > 0) {
      parts.push('')
      parts.push('上一次你的输出不是合法 JSON。这次请**只输出 JSON**，不要任何其他字符。')
    }

    const messages = [{ role: 'user', content: [{ type: 'text', text: parts.join('\n') }] }]
    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      // ⚠️ 不传 purpose（封闭联合，没有我们的合法值）
      // ⚠️ 不传 tools（会让模型去调工具，而不是输出 JSON）
      // maxTokens 要显式给（照 dsh-compaction-basic/lib/index.js:318）
      maxTokens: this.config.conversation.handoffMaxTokens,
      // sessionId 只用于路由/回放；传它是为了让它归到这个会话的账上，便于排障
      sessionId,
      // 单次整理调用的硬超时：LLM 服务自己会超时，这里是一道兜底（防止整条链挂死）
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(120000) : undefined,
    }

    let text = ''
    /** 已经在增量里累过的块下标 */
    const deltaBlocks = new Set()
    /** 只在 `block-end` 上给整块文本的块（有的适配器不发增量） */
    const wholeBlocks = []
    let finish = null
    for await (const chunk of llm.stream(options)) {
      const type = chunk?.type
      if (type === 'text-delta') {
        deltaBlocks.add(chunk.index)
        text += String(chunk.text ?? chunk.delta ?? '')
      } else if (type === 'block-end') {
        // 宿主的 BlockAssembler 为这种形状保留了 `partial.block` 分支：适配器可以
        // 不发增量、只在 block-end 上给整块文本。同一个块已经按增量累过就不重复计。
        if (!deltaBlocks.has(chunk.index) && chunk.block?.type === 'text') wholeBlocks.push(chunk.block)
      } else if (type === 'finish') {
        finish = chunk
      }
    }
    // ⚠️ 必须检查 finish：失败是**终止 chunk**，不是异常。
    //    真实形状是 `{ type:'finish', reason:{ kind, failure } }`
    //    （`dsh-llm` 的 `adapterFailureChunk`；宿主自己按 `finish.failure.message` /
    //    `finish.failure.code` 消费，见 `dsh-compaction-basic/lib/index.js:358-361`）。
    //    早先读的是 `reason.error.message` —— 恒 undefined，于是交班失败的日志
    //    永远是 "LLM 调用失败: unknown"，排障价值归零（功能本身仍会走降级）。
    const reason = finish?.reason ?? finish?.finish?.reason
    const kind = reason?.kind
    if (kind === 'error') {
      throw new Error(`LLM 调用失败: ${reason?.failure?.message ?? reason?.error?.message ?? 'unknown'}`)
    }
    if (kind === 'aborted') {
      throw new Error(`LLM 调用被中止: ${reason?.failure?.code ?? reason?.failure?.message ?? 'unknown'}`)
    }
    // 整块文本（没有对应增量的那些块）与增量文本之间补一个换行：
    // 直接裸拼会把 "...前一句""后一句" 粘成 "前一句后一句"
    if (wholeBlocks.length > 0) {
      const whole = blocksToText(wholeBlocks)
      if (whole) text = text ? `${text}\n${whole}` : whole
    }
    return text
  }

  /** 交班束落盘（`handoff/<chatType>-<chatId 安全化>-<gen>.json`），只增不删 */
  #writeLedger(scope, gen, payload) {
    try {
      const dir = path.join(this.state.dir, 'handoff')
      fs.mkdirSync(dir, { recursive: true })
      const safe = scope.replace(/[^a-zA-Z0-9:._-]/g, '_').replace(':', '-')
      const file = path.join(dir, `${safe}-${gen}.json`)
      const body = {
        version: 1,
        scope,
        generation: gen,
        at: Date.now(),
        tokens: Number(payload?.measurement?.totalTokens ?? 0),
        ratio: payload?.ratio ?? 0,
        events: payload?.events ?? 0,
        degraded: Boolean(payload?.bundle?.degraded),
        llm: payload?.bundle?.llm ?? null,
        absorbed: payload?.absorbed ?? null,
        // 完整交接束：出事时用户唯一想问的是"我上次说的那句它到底带过去没有"，
        // 而 memory.json 是合并后的结果，已经看不出"这次带了什么"
        bundle: payload?.bundle ?? null,
      }
      fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8')
      this.log.info(`[handoff] 交接束已留档: ${file}`)
      return file
    } catch (err) {
      this.log.warn(`[handoff] 交接束留档失败: ${err?.message ?? err}`)
      return ''
    }
  }

  /** 清理过期的交班束（handoffRetainDays，0 = 永久保留） */
  pruneLedgers() {
    const days = Number(this.config.conversation.handoffRetainDays)
    if (!Number.isFinite(days) || days <= 0) return 0
    const dir = path.join(this.state.dir, 'handoff')
    if (!fs.existsSync(dir)) return 0
    const cutoff = Date.now() - days * 86400_000
    let removed = 0
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        const file = path.join(dir, name)
        try {
          if (fs.statSync(file).mtimeMs < cutoff) {
            fs.unlinkSync(file)
            removed += 1
          }
        } catch {
          /* 单个文件失败不影响其余 */
        }
      }
    } catch (err) {
      this.log.warn(`[handoff] 清理交班束失败: ${err?.message ?? err}`)
    }
    if (removed > 0) this.log.info(`[handoff] 已清理 ${removed} 份过期交接束（保留 ${days} 天）`)
    return removed
  }

  /**
   * 状态端点的"离交班还差多少"。
   *
   * 这是硬要求：没有它，用户永远不知道这个功能在工作 —— 而它默认阈值下
   * 可能要聊很久才触发一次。
   */
  snapshot() {
    const cfg = this.config.conversation
    const rows = []
    for (const [key, value] of this.state.entries()) {
      const scope = key
      const rec = this.measurements.get(scope)
      const chatRecord = value ?? {}
      const contextWindow = rec?.contextWindow || this.contextWindow || 0
      const threshold = contextWindow > 0 ? Math.floor(contextWindow * cfg.handoffAtRatio) : 0
      const totalTokens = rec?.totalTokens ?? 0
      rows.push({
        scope,
        chatType: chatRecord.chatType ?? key.split(':')[0],
        chatId: chatRecord.chatId ?? key.split(':').slice(1).join(':'),
        chatName: chatRecord.chatName ?? '',
        generation: Number(chatRecord.rootGeneration ?? 1),
        rootSessionId: chatRecord.rootSessionId ?? '',
        /** 当前会话的实测 token（与宿主 compaction 读的是同一个数） */
        totalTokens,
        contextWindow,
        /** 触发交班所需的 token 数 */
        handoffThresholdTokens: threshold,
        /** 当前占窗口的比例（0—1） */
        ratio: rec?.ratio ?? 0,
        /** 离交班还差多少 token（已超阈值时为 0） */
        tokensToHandoff: threshold > 0 ? Math.max(0, threshold - totalTokens) : null,
        /** 已用掉阈值的百分比，给一眼看懂的进度条用 */
        progressPercent: threshold > 0 ? Math.min(100, Math.round((totalTokens / threshold) * 100)) : null,
        measuredAt: rec?.at ?? 0,
        frozen: this.frozen.has(scope),
        lastHandoff: chatRecord.lastHandoff ?? null,
        /** 本会话累积的碎片数 */
        fragments: this.memory.forScope(scope).length,
      })
    }
    return {
      enabled: cfg.enabled,
      handoffAtRatio: cfg.handoffAtRatio,
      minTokensBetweenHandoffs: cfg.minTokensBetweenHandoffs,
      memoryBudgetTokens: cfg.memoryBudgetTokens,
      injectMode: cfg.injectMode,
      contextWindow: this.contextWindow,
      /** 宿主 compaction 的阈值比例（默认 0.8）。交班比例必须低于它 */
      compactionThresholdRatio: this.compactionThresholdRatio,
      /** 压缩触发点 token 数 —— 回答"为什么还没触发"的关键数字 */
      compactionThresholdTokens:
        this.contextWindow > 0 ? Math.floor(this.contextWindow * this.compactionThresholdRatio) : 0,
      stats: { ...this.stats },
      frozenScopes: [...this.frozen.keys()],
      /** 交接文本的待交付台账（排障用：它还没和用户的话一起进下一步的 claim） */
      pendingDeliveries: [...this.pendingDelivery.entries()].map(([key, p]) => ({
        scope: key,
        sessionId: p.sessionId,
        generation: p.gen,
        delivered: p.delivered,
        rearms: p.rearms,
        ageMs: Date.now() - p.at,
      })),
      chats: rows,
    }
  }
}

/** 从消息对象里抽纯文本 */
function messageText(message) {
  const content = message?.content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }
  if (typeof message?.text === 'string') return message.text.trim()
  return ''
}

/** finish chunk 上的 blocks → 文本 */
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * 造一条带身份标注的用户消息（交接文本的载体）。
 *
 * `source.kind` 是自由字段 —— 对照宿主自造的 `schedule` / `runtime-context` /
 * `plan-mode` / `user-question-reply`，所以插件用自己的 `kind` 符合约定，
 * 而且让宿主侧任何消费者都能识别"这不是用户说的"。
 */
export function createHandoffMessage(text, generation) {
  return {
    id: `handoff-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: 'handoff', generation },
  }
}

/** 供测试与排障：生成一个碎片 id（不落盘） */
export { fragmentId }
