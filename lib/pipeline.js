/**
 * 事件流水线：OneBot 事件 → 归一化 → 去重 → 范围判定 → 路由决策。
 *
 * 这一层刻意只做决策、不做副作用，返回一个「意图」对象，
 * 由 index.js 决定怎么执行（Milestone 1 只打日志；Milestone 2 接 DSH）。
 *
 * v2 起，TASK 与 CHAT 在这里分流（规则见 classify.js）：任务去独立任务 session，
 * 闲聊去常驻 root session。分类结果连同 reason 一起返回，便于排障时回答
 * "这条消息为什么被当成闲聊了"。
 */
import { classifyEvent, normalizeMessageEvent, plainText, idempotencyKey } from './onebot/normalize.js'
import { Dedupe } from './dedupe.js'
import { inScope } from './config.js'
import { classifyMessage, shouldRespond, taskHint, CLASSIFY } from './classify.js'
import { META_SUB_TYPE, NOTICE_TYPE } from './onebot/constants.js'

/** 路由意图 */
export const INTENT = {
  /** 任务：需要 DSH 干活（独立任务 session） */
  TASK: 'task',
  /** 闲聊：进常驻 root session，不落任务 */
  CHAT: 'chat',
  /** 投喂：进语料库，不响应 */
  INGEST: 'ingest',
  /** 忽略 */
  IGNORE: 'ignore',
}

export class Pipeline {
  /**
   * @param {object} opts
   * @param {ReturnType<import('./config.js').resolveConfig>} opts.config
   * @param {ReturnType<import('./log.js').createLogger>} opts.log
   */
  constructor({ config, log }) {
    this.config = config
    this.log = log
    this.dedupe = new Dedupe({
      windowMs: config.dedupeWindowMs,
      maxEntries: config.dedupeMaxEntries,
    })
    this.stats = {
      events: 0,
      messages: 0,
      duplicates: 0,
      outOfScope: 0,
      ignored: 0,
      tasks: 0,
      chats: 0,
      ingests: 0,
      notices: 0,
      metas: 0,
      unknown: 0,
      lastHeartbeatAt: 0,
      lastLifecycleAt: 0,
      loginInfo: null,
    }
    /** @type {Array<{ts:number, kind:string, chatType?:string, chatId?:string, senderName?:string, preview?:string}>} */
    this.recent = []
  }

  /**
   * 处理一条原始事件，返回意图描述。
   * @param {any} payload
   * @param {import('./onebot/connection.js').OneBotConnection} conn
   */
  handle(payload, conn) {
    this.stats.events += 1
    const kind = classifyEvent(payload)

    if (kind === 'meta') return this.#handleMeta(payload)
    if (kind === 'notice') return this.#handleNotice(payload)
    if (kind === 'request') {
      this.stats.unknown += 1
      return { intent: INTENT.IGNORE, reason: 'request 事件暂不处理', payload }
    }
    if (kind !== 'message') {
      this.stats.unknown += 1
      return { intent: INTENT.IGNORE, reason: `未知 post_type=${payload?.post_type}`, payload }
    }

    return this.#handleMessage(payload, conn)
  }

  #handleMeta(payload) {
    const sub = payload?.meta_event_type
    if (sub === META_SUB_TYPE.HEARTBEAT) {
      this.stats.lastHeartbeatAt = Date.now()
      return { intent: INTENT.IGNORE, reason: 'heartbeat' }
    }
    if (sub === META_SUB_TYPE.LIFECYCLE) {
      this.stats.lastLifecycleAt = Date.now()
      const detail = payload?.sub_type ?? ''
      this.log.info(`[pipeline] 生命周期事件: ${detail}`)
      return { intent: INTENT.IGNORE, reason: `lifecycle:${detail}` }
    }
    this.stats.unknown += 1
    return { intent: INTENT.IGNORE, reason: `meta:${sub}` }
  }

  #handleNotice(payload) {
    this.stats.notices += 1
    const t = payload?.notice_type
    const chatType = payload?.group_id ? 'group' : 'private'
    const chatId = String(payload?.group_id ?? payload?.user_id ?? '')
    const summary = {
      ts: Date.now(),
      kind: `notice:${t}`,
      chatType,
      chatId,
      senderName: String(payload?.user_id ?? ''),
      preview: t === NOTICE_TYPE.GROUP_RECALL || t === NOTICE_TYPE.FRIEND_RECALL ? '撤回了一条消息' : '',
    }
    this.#pushRecent(summary)
    return { intent: INTENT.IGNORE, reason: `notice:${t}`, payload }
  }

  #handleMessage(payload, conn) {
    const msg = normalizeMessageEvent(payload, { selfId: conn?.selfId })
    if (!msg) {
      this.stats.unknown += 1
      return { intent: INTENT.IGNORE, reason: '无法归一化的消息事件', payload }
    }
    this.stats.messages += 1

    // ① 去重
    const key = idempotencyKey(msg)
    if (this.dedupe.isDuplicate(key)) {
      this.stats.duplicates += 1
      this.log.debug(`[pipeline] 重复消息已丢弃 key=${key}`)
      return { intent: INTENT.IGNORE, reason: 'duplicate', message: msg }
    }

    // ② 范围
    if (!inScope(this.config, msg.chatType, msg.chatId)) {
      this.stats.outOfScope += 1
      this.log.debug(`[pipeline] 会话不在范围内: ${msg.chatType}/${msg.chatId}`)
      return { intent: INTENT.IGNORE, reason: 'out-of-scope', message: msg }
    }

    const text = plainText(msg)
    this.#pushRecent({
      ts: Date.now(),
      kind: 'message',
      chatType: msg.chatType,
      chatId: msg.chatId,
      senderName: msg.senderName,
      preview: text.slice(0, 80),
    })

    // ③ 参与模式：先决定 bot 该不该回应
    const respond = this.#shouldRespond(msg)
    const hasForward = msg.segments.some((s) => s.kind === 'forward')

    // ④ 合并转发永远入库；该不该同时当任务，取决于参与模式
    if (hasForward && !respond) {
      this.stats.ingests += 1
      return { intent: INTENT.INGEST, reason: 'forward-record', message: msg, expandForward: true }
    }

    if (!respond) {
      this.stats.ingests += 1
      return {
        intent: INTENT.INGEST,
        reason: msg.chatType === 'group' ? 'group-not-mentioned' : 'private-disabled',
        message: msg,
      }
    }

    // ⑤ 任务还是闲聊？规则见 classify.js（刻意不引入 LLM：入口路径上不能加一次模型往返）
    const stripped = this.#stripMention(text)

    // ⚠️ 这里**不再解析控制指令**。
    //    曾经有一支 `parseControl()` 会把 `/cancel [N|all]` 吃成带外取消命令；
    //    删掉它的理由见 classify.js 顶部：关键词会误判（"把这个任务停一下看看日志"
    //    会被当成停止命令）。控制意图改由常驻会话理解后调 `qq_tasks(cancel_task_id)`，
    //    于是 `/cancel 3` 现在和别的正文一样往下走分类。
    const verdict = classifyMessage({
      text: stripped,
      chatPrefix: this.config.tasks.chatPrefix,
      taskPrefix: this.config.tasks.prefix,
      hasForward,
    })

    if (verdict.kind === CLASSIFY.IGNORE) {
      this.stats.ignored += 1
      return { intent: INTENT.IGNORE, reason: 'empty-text', message: msg }
    }

    if (verdict.kind === CLASSIFY.CHAT) {
      this.stats.chats += 1
      return {
        intent: INTENT.CHAT,
        reason: verdict.reason,
        message: msg,
        text: verdict.text,
        /** 闲聊也带转发段时应展开（展开后仍然是闲聊语境） */
        expandForward: hasForward,
      }
    }

    this.stats.tasks += 1
    const forcedTask = verdict.reason === 'task-prefix'

    // ── v3：常驻对话会话开启时，任务**不再**直接派活 ────────────────────
    //
    // 分类结果从"执行指令"降级为"给对话会话的提示"：正文照进常驻会话，
    // 要不要真的派活由会话自己决定（它调 qq_dispatch）。
    //
    // ⚠️ **这一段必须放在 `this.stats.tasks += 1` 之后、返回之前**，
    //    且 `conversation.enabled === false` 时**一个字段都不碰** ——
    //    121 条既有断言的全绿保命线靠的就是这个早返回。
    if (this.config.conversation?.enabled === true) {
      const hint = this.config.conversation.dispatchHint === false ? '' : taskHint(verdict.kind, verdict.reason, verdict.text)
      // 统计口径跟着走：分诊权移交之后，它确实是一次"进对话会话"
      this.stats.tasks -= 1
      this.stats.chats += 1
      return {
        intent: INTENT.CHAT,
        reason: verdict.reason,
        message: msg,
        text: `${verdict.text}${hint}`,
        /** 排障用：这条 CHAT 是被分诊规则从 TASK 重路由过来的 */
        routedBy: 'conversation',
        /** 排障用：这条被规则认为"缺关键信息"，提示里已经让会话先追问 */
        ambiguous: verdict.kind === CLASSIFY.TASK && hint.includes('待澄清'),
        forcedTask,
        expandForward: hasForward,
      }
    }

    return {
      intent: INTENT.TASK,
      reason: verdict.reason,
      forcedTask,
      message: msg,
      text: verdict.text,
      // 带转发段的任务：展开后作为语境一并投递
      expandForward: hasForward,
    }
  }

  /** bot 是否应当在这个会话里回应（寻址门，规则见 classify.js 的 `shouldRespond`） */
  #shouldRespond(msg) {
    return shouldRespond({
      chatType: msg.chatType,
      atBot: msg.atBot,
      groupMode: this.config.participation.groupMode,
      privateMode: this.config.participation.privateMode,
    }).respond
  }

  /** 去掉开头的 @bot 文本残留 */
  #stripMention(text) {
    return text.replace(/^@\S+\s*/, '').trim() || text.trim()
  }

  #pushRecent(entry) {
    this.recent.unshift(entry)
    if (this.recent.length > 50) this.recent.length = 50
  }

  snapshot() {
    return { stats: { ...this.stats }, recent: this.recent.slice(0, 20), dedupeSize: this.dedupe.size }
  }
}
