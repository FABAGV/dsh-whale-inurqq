/**
 * 任务调度：把一条 QQ 任务变成「一个独立 session + 一次投递」，并管住并发与收尾。
 *
 * ## 为什么需要这一层
 *
 * v1 是"一条任务直接 prompt 进常驻 session"，于是任务天然串行（session 的
 * inbox 是队列）。v2 给每条任务开独立 session 之后，"开几个"就没人管了 ——
 * 用户连发 20 条消息就会同时起 20 个 session，把机器和模型额度一起打满。
 * 所以需要一层显式的准入控制：
 *
 *   受理 → [并发槽位有空?] --是--> 建 session + 投递 → 跑 → 归档 → 释放槽位
 *                            --否--> 排队，等前面某条结束
 *
 * ## 并发上限的粒度：**每个 QQ 会话**，不是全局
 *
 * `tasks.maxConcurrent` 的语义是"同一会话同时执行的任务数上限"（schema 里就是这么写的）。
 * 按会话限流而不是全局限流有两个理由：
 *   1. 全局上限会让一个话痨群把其他所有人的任务饿死 —— 一个群刷屏，别人全排队；
 *   2. 单个会话的并发才是"用户能理解的那个数"：群里的 20 条任务不该比私聊的 1 条
 *      获得更少的资源，但它们之间确实应该互相排队。
 * 代价是总 session 数没有硬上限（N 个会话 × maxConcurrent）。真正的兜底是
 * 任务跑完立刻归档，以及状态文件里的任务台账有上限（见 state.js）。
 *
 * ## 槽位是"同步占位"的
 *
 * 准入必须在**同一个 tick 内**完成判断与占位，否则两条几乎同时到达的消息会
 * 双双看到"还有空位"（都是先 await 再判断）。所以 `#pump` 是同步函数：
 * 它先把任务状态写成 running、把槽位占掉，再去 await 建 session 与投递。
 *
 * ## 收敛不是"看到 turn/end 就归档"
 *
 * `turn/end` 只说明模型此刻不欠回应，**不等于任务结束**（未决提问/审批、
 * 多回合任务都会让它说谎）。所以收敛路径是：
 *
 *   turn/end → 问宿主"还有待办吗"（pending.js 的五个判据）
 *       ├─ 有 → 状态置 waiting：不写终态、不归档、槽位继续占着，并在 QQ 上说清在等什么
 *       └─ 无 → 过一个 `tasks.settleGraceMs` 的确认窗（治"回合刚结束、新回合立刻开始"的竞态）
 *                → 再问一次 → 仍然空闲才写终态并归档
 *
 * 宽限期**只是最后一道**：它治不了"用户五分钟后才回答问题"这类等待，
 * 那种情况靠判据（未决审批/提问）长期拦住，而不是靠等时间。
 * 反过来，判据也可能因为宿主服务缺失而全问不到，那时按"忙"处理，
 * 由 waiting 看门狗（WAITING_MAX_MS）兜底，避免队列被永久堵死。
 *
 * ## 归档：默认**不强制**
 *
 * 正常收敛用 `archiveSession(id)`（不带 `stopActivity`）—— 宿主自己会先问一遍
 * "还有活动吗"，有就拒绝。这道宿主自带的闸门是判据之外的第二重保险：
 * 判据漏了宿主会拒，拒了我们就退回去继续等，而不是把活任务停掉。
 * 只有**用户显式取消**（与看门狗超时）才用 `{stopActivity:true}` 强制归档 ——
 * 那是用户的明确意图，不该被"它还在忙"挡回来。
 */
import { TASK_STATUS, isTerminal, occupiesSlot } from './state.js'
import { assessSessionWork, BUSY, describeBusy } from './pending.js'

/** 单条任务的执行看门狗：卡死时不能让它永远占着并发槽位 */
const TASK_WATCHDOG_MS = 30 * 60 * 1000

/**
 * waiting 状态下的看门狗：等用户回答问题可能很久（隔夜也正常），
 * 所以给一个远长的上限 —— 它不是"任务超时"，只是"别让队列被永远堵死"。
 */
const WAITING_MAX_MS = 24 * 60 * 60 * 1000

/**
 * 取消后的兜底收敛时限：正常情况下 cancel 会立刻换来一个 aborted 的 turn/end，
 * 但万一那个回合其实已经结束（没有终态事件会再来），这里的定时器负责
 * 释放槽位并归档，避免队列被一条"取消不掉的"任务堵住。
 */
const CANCEL_SETTLE_GRACE_MS = 3000

/**
 * 宿主是否以"这个会话还有活动"为由拒绝了归档。
 *
 * 真实形状：`dsh-workspace` 抛 `WorkspaceActiveSessionError(sessionId, activity)`
 * （`lib/index.js` 524-540 行的 archiveSession 在 `options.stopActivity !== true`
 * 时先问 `workspace/session-activity`，非空就抛）。这里同时认类名与消息里的
 * `session-active`，避免跨版本改名后判定失效。
 */
function isActiveRefusal(err) {
  const name = String(err?.name ?? '')
  const message = String(err?.message ?? err ?? '')
  return name === 'WorkspaceActiveSessionError' || message.includes('session-active') || message.includes('activeSession')
}

/** TurnEndReason.kind → 任务状态 */
function statusForEndReason(reason) {  switch (reason?.kind) {
    case 'completed':
      return TASK_STATUS.DONE
    case 'aborted':
    case 'interrupted':
      return TASK_STATUS.CANCELED
    case 'blocked':
    case 'error':
    case 'max-tokens':
    case 'forked':
      return TASK_STATUS.FAILED
    default:
      // 未知的结束原因：任务确实结束了，不该按失败计（也不该占着槽位）
      return TASK_STATUS.DONE
  }
}

export class TaskScheduler {
  /**
   * @param {object} opts
   * @param {ReturnType<import('../config.js').resolveConfig>} opts.config
   * @param {ReturnType<import('../log.js').createLogger>} opts.log
   * @param {import('./state.js').StateStore} opts.state
   * @param {import('./bridge.js').DshBridge} opts.bridge
   * @param {(sessionId:string, hints:object) => Promise<{busy:boolean, reason:string, detail:string, signals:object}>} [opts.assess]
   *   待办评估（默认由 index.js 注入 pending.js 的实现）；做成注入点便于单测替换
   */
  constructor({ config, log, state, bridge, assess }) {
    this.config = config
    this.log = log
    this.state = state
    this.bridge = bridge
    /** @type {(sessionId:string, hints:object) => Promise<any>} */
    this.assess =
      typeof assess === 'function'
        ? assess
        : async () => ({ busy: true, reason: BUSY.UNKNOWN, detail: '', signals: {} })
    /** @type {import('./relay.js').ProgressRelay | null} 建好后由 index.js 注入 */
    this.relay = null
    /** @type {Map<string, string[]>} chatKey → 排队中的 taskId（FIFO） */
    this.queues = new Map()
    /** @type {Set<string>} 已收敛的任务：保证归档/释放槽位只做一次 */
    this.settled = new Set()
    /** @type {Map<string, string>} taskId → 完整正文。台账里只存 200 字预览 */
    this.bodies = new Map()
    /** @type {Map<string, NodeJS.Timeout>} taskId → 执行看门狗 */
    this.watchdogs = new Map()
    /** @type {Map<string, NodeJS.Timeout>} taskId → 收敛确认窗（宽限期）定时器 */
    this.settleTimers = new Map()
    this.stats = {
      submitted: 0,
      started: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      queued: 0,
      waiting: 0,
      resumed: 0,
      archived: 0,
      archiveFailed: 0,
      /** 宿主以"还有活动"为由拒绝归档的次数（判据漏判的自证） */
      archiveRefused: 0,
      cancelRequested: 0,
      lastError: null,
    }
  }

  setRelay(relay) {
    this.relay = relay
  }

  /** 每个会话的并发上限；配置非法时退回 1（宁可慢，不可打满） */
  get maxConcurrent() {
    const n = Number(this.config.tasks?.maxConcurrent)
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
  }

  /** 收敛确认窗（毫秒）；0 表示不等待（仅排障用，见文件头） */
  get settleGraceMs() {
    const n = Number(this.config.tasks?.settleGraceMs)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3000
  }

  /**
   * 启动收敛：上一次进程留下的 queued/running 任务**永远不会再有终态事件**，
   * 如果放着不管，它们会永久占住并发槽位（新任务全排队）。
   * 所以启动时一律标成 interrupted。
   */
  recover() {
    let n = 0
    for (const task of this.state.allTasks(1000)) {
      if (isTerminal(task.status)) continue
      this.state.updateTask(task.taskId, {
        status: TASK_STATUS.INTERRUPTED,
        finishedAt: Date.now(),
        error: '插件重启，任务未能继续',
      })
      n += 1
    }
    if (n > 0) this.log.warn(`[tasks] 已把 ${n} 条上次遗留的未完成任务收敛为 interrupted`)
    return n
  }

  #key(chatType, chatId) {
    return `${chatType}:${chatId}`
  }

  #queueFor(key) {
    let q = this.queues.get(key)
    if (!q) {
      q = []
      this.queues.set(key, q)
    }
    return q
  }

  /**
   * 该会话当前占用槽位的任务数（唯一的判定依据就是台账，重启后依然正确）。
   * **waiting 也算占位**：它的会话还活着，只是暂时没有回合在跑。
   */
  runningCount(chatType, chatId) {
    return this.state.activeTasks(chatType, chatId).filter((t) => occupiesSlot(t.status)).length
  }

  /**
   * 受理一条任务。**立刻返回**，不等执行 —— QQ 消息循环不能被任务拖住。
   * @param {object} input
   * @param {'private'|'group'} input.chatType
   * @param {string} input.chatId
   * @param {string} [input.chatName]
   * @param {string} input.text 任务正文（完整）
   * @returns {Promise<{task:any, ahead:number, admitted:boolean, position:number}>}
   */
  async submit({ chatType, chatId, chatName, text, senderName, messageId }) {
    const chat = await this.bridge.ensureProject({ chatType, chatId, chatName })
    const task = this.state.createTask({
      chatType,
      chatId,
      text,
      senderName,
      messageId,
      workspaceId: chat.workspaceId,
      workspacePath: chat.workspacePath,
    })
    // 完整正文只放内存：台账里那 200 字是给人看的预览，
    // 转发记录展开后可能有几万字，不该写进状态文件。
    this.bodies.set(task.taskId, text)
    this.stats.submitted += 1

    const ahead = Math.max(0, this.state.activeTasks(chatType, chatId).length - 1)
    this.#queueFor(this.#key(chatType, chatId)).push(task.taskId)
    this.#pump(chatType, chatId)

    const fresh = this.state.getTask(task.taskId)
    const admitted = fresh?.status === TASK_STATUS.RUNNING
    if (!admitted) {
      this.stats.queued += 1
      // 记一笔"这条是对用户说过'排队中'的"，等它真起来时补一条通知。
      // 用户在外面等着，最难受的就是"排上了但没人告诉我"。
      this.state.updateTask(task.taskId, { awaitingNotice: true })
    }
    return { task: fresh ?? task, ahead, admitted, position: ahead }
  }

  /**
   * 准入循环（**同步**，见文件头"同步占位"）：把队列头部能起的任务都起起来。
   * @param {'private'|'group'} chatType
   * @param {string} chatId
   */
  #pump(chatType, chatId) {
    const key = this.#key(chatType, chatId)
    const queue = this.#queueFor(key)
    while (queue.length > 0) {
      if (this.runningCount(chatType, chatId) >= this.maxConcurrent) return
      const taskId = queue.shift()
      const task = this.state.getTask(taskId)
      if (!task || isTerminal(task.status)) continue
      // 同步占位：先落 running，再去做异步的建会话/投递
      this.state.updateTask(taskId, { status: TASK_STATUS.RUNNING, startedAt: Date.now() })
      this.#armWatchdog(taskId, TASK_WATCHDOG_MS)
      // ⚠️ 必须带 .catch：`#start` 的第一件事是 `ensureProject`，而它在 `#start`
      //    自己的 try 之外 —— workspaceRoot 未配置、DSH 服务未就绪、mkdir 失败都会抛。
      //    未捕获的 rejection 在 Node 默认策略下会结束整个进程（用户正在用的会话一起没）。
      void this.#start(taskId).catch((err) =>
        this.#fail(taskId, err, '启动任务失败').catch((nested) =>
          this.log.error(`[tasks] 启动失败且收敛也失败（任务 #${task?.no ?? taskId}）: ${nested?.stack ?? nested}`),
        ),
      )
    }
  }

  /** 建 session 并投递（异步部分） */
  async #start(taskId) {
    const task = this.state.getTask(taskId)
    if (!task) return
    const chat = await this.bridge.ensureProject({
      chatType: task.chatType,
      chatId: task.chatId,
    })
    const body = this.bodies.get(taskId) ?? task.text

    let sessionId = ''
    try {
      const label = task.text.slice(0, 24) || '任务'
      sessionId = await this.bridge.newSession(chat, `QQ 任务 #${task.no} · ${label}`)
    } catch (err) {
      await this.#fail(taskId, err, '建立任务会话失败')
      return
    }

    this.state.updateTask(taskId, {
      sessionId,
      workspaceId: chat.workspaceId,
      workspacePath: chat.workspacePath,
    })

    try {
      await this.bridge.promptSession(
        sessionId,
        this.bridge.buildPromptText({
          chatType: task.chatType,
          chatName: chat.chatName,
          chatId: task.chatId,
          senderName: task.senderName,
          text: body,
        }),
        `tasks:start:#${task.no}`,
      )
    } catch (err) {
      await this.#fail(taskId, err, '投递任务失败', sessionId)
      return
    }

    this.stats.started += 1
    this.log.info(`[tasks] 任务 #${task.no} 已投递 → session=${sessionId}（${task.text.slice(0, 40)}…）`)

    // 之前告诉过用户"排队中"，现在真的轮到了，补一条通知
    if (task.awaitingNotice) {
      this.state.updateTask(taskId, { awaitingNotice: false })
      await this.#notify(task, `▶️ 任务 #${task.no} 已开始执行`)
    }
  }

  /** 建会话/投递阶段就失败：任务没跑起来，直接收敛成 failed 并释放槽位 */
  async #fail(taskId, err, prefix, sessionId = '') {
    const task = this.state.getTask(taskId)
    // 计数统一在 #settle 里做，这里只记最后一个错误，避免同一次失败被数两遍
    this.stats.lastError = `${err?.message ?? err}`
    this.log.error(`[tasks] ${prefix}（任务 #${task?.no}）: ${err?.stack ?? err}`)
    if (sessionId && task) this.state.updateTask(taskId, { sessionId })
    await this.#settle(taskId, TASK_STATUS.FAILED, { error: `${prefix}：${err?.message ?? err}` })
    await this.#notify(task, `❌ 任务 #${task?.no} ${prefix}：${err?.message ?? err}`)
  }

  /** 看门狗：任务迟迟不结束，取消它并收敛，避免槽位被永久占住（实现在文件末尾，waiting 用更长的时限） */

  /**
   * Relay 回调：某个 session 的一个回合结束了。
   * 只有任务 session 需要收敛；root session（闲聊）既不归档也不释放槽位。
   *
   * ⚠️ 这里**不能**直接收敛：turn/end 只说明模型此刻不欠回应。先问宿主
   * "还有待办吗"（见文件头与 pending.js）。
   * @param {string} sessionId
   * @param {any} reason TurnEndReason
   */
  async settleSession(sessionId, reason) {
    const found = this.state.findBySession(sessionId)
    if (!found || found.kind !== 'task' || !found.taskId) return
    // ⚠️ `interrupted` 不是"这条任务结束了"：它表示**这个回合被新的唤醒输入打断了**
    //    （`TurnEndReason` 的 interrupted/aborted），而多回合任务正是这个形态 ——
    //    紧接着就会开新回合（`noteTurnStart` 的"取消本次收敛确认"那条路就是为它写的）。
    //
    //    拿它去走收敛会有两个真实后果：
    //      1. `statusForEndReason` 把它映射成 CANCELED，于是 `#gate` 走"用户显式取消"
    //         那条分支**强制归档**（带 stopActivity），把仍在跑的任务掐掉；
    //      2. 归档一旦被宿主以 session-active 拒绝，任务已经被写成 CANCELED 且进了
    //         `settled` 集合 —— 后面的 turn/end 再也收敛不了，会话永远留在侧边栏。
    //    所以这里直接不管：真正的终态会由**随后那个回合**的 turn/end 带来。
    //    （实测依据：tools/test-entry.mjs 的 G1「回合结束后紧接着又开新回合」。）
    if (reason?.kind === 'interrupted') return
    await this.#gate(found.taskId, { status: statusForEndReason(reason), reason })
  }

  /**
   * Relay 回调：某个 session 开了一个新回合。
   * 用途有二：① waiting 的任务被"续上"了，状态回到 running；
   * ② **取消已经排队的收敛确认** —— 新回合已经开始，绝不能在这个缝里归档。
   */
  noteTurnStart(sessionId, turn) {
    const found = this.state.findBySession(sessionId)
    if (!found || found.kind !== 'task' || !found.taskId) return
    const task = this.state.getTask(found.taskId)
    if (!task || isTerminal(task.status) || this.settled.has(task.taskId)) return

    const hadSettleTimer = this.#clearSettleTimer(found.taskId)
    if (hadSettleTimer) {
      this.log.info(`[tasks] 任务 #${task.no} 又开了新回合，取消本次收敛确认（不归档）`)
    }
    if (task.status === TASK_STATUS.WAITING) {
      this.stats.resumed += 1
      this.log.info(`[tasks] 任务 #${task.no} 从 waiting 继续执行（第 ${Number(turn) || 1} 回合）`)
    }
    this.state.updateTask(found.taskId, {
      status: TASK_STATUS.RUNNING,
      waitingReason: '',
      waitingDetail: '',
      waitingSince: 0,
      // 清掉"已通知过"的记账：下次再等时应该重新告诉用户
      waitingNotified: '',
    })
    this.#armWatchdog(found.taskId, TASK_WATCHDOG_MS)
  }

  /**
   * 收敛闸门：先问宿主"还有待办吗"，空闲再等一个确认窗。
   * @param {string} taskId
   * @param {{status:string, reason:any}} intent
   */
  async #gate(taskId, intent) {
    const task = this.state.getTask(taskId)
    if (!task || this.settled.has(taskId)) return

    // 用户显式取消过：这是明确意图，不必看待办（也不该被"它还在忙"挡回来）。
    // ⚠️ 这一条必须在下面的终态判断**之前**：canceled 本身是终态，
    // 但"状态已是终态"不等于"会话已经归档" —— 取消只改了状态，
    // 收敛（强制归档）还没做，必须在这里补上。
    if (task.status === TASK_STATUS.CANCELED) {
      await this.#settle(taskId, TASK_STATUS.CANCELED, { endReason: String(intent.reason?.kind ?? '') })
      return
    }

    if (isTerminal(task.status)) return

    const view = await this.#assess(task)
    if (view.busy) {
      this.#markWaiting(task, view)
      return
    }

    // 判据说空闲 —— 但 turn/end 与新回合之间可能只差几毫秒，先过确认窗再落终态
    const grace = this.settleGraceMs
    if (grace <= 0) {
      await this.#confirm(taskId, intent)
      return
    }
    this.#armSettleTimer(taskId, grace, () => this.#confirm(taskId, intent), '确认收敛')
    this.log.debug(`[tasks] 任务 #${task.no} 回合结束且无待办，${grace}ms 后确认收敛`)
  }

  /** 确认窗到点：再问一次宿主，仍然空闲才真的收敛 */
  async #confirm(taskId, intent) {
    const task = this.state.getTask(taskId)
    if (!task || isTerminal(task.status) || this.settled.has(taskId)) return
    const view = await this.#assess(task)
    if (view.busy) {
      // 确认窗里发生了什么（新回合 / 来了提问 / 还有活动）→ 回到 waiting，不归档
      this.#markWaiting(task, view)
      return
    }
    await this.#settle(taskId, intent.status, { endReason: String(intent.reason?.kind ?? '') })
  }

  /** 问宿主待办（带上一轮折叠出来的未决审批提示） */
  async #assess(task) {
    const hints = { approvals: this.relay?.approvalsFor?.(task.sessionId) }
    try {
      return await this.assess(task.sessionId, hints)
    } catch (err) {
      // 判据本身炸了 → 按"不确定"处理（不收敛），绝不当成空闲
      this.log.warn(`[tasks] 任务 #${task.no} 的待办评估失败（按未确认处理）: ${err?.message ?? err}`)
      return { busy: true, reason: BUSY.UNKNOWN, detail: '', signals: {} }
    }
  }

  /**
   * 置为 waiting：**不**写终态、**不**归档，槽位继续占着，并在 QQ 上说清在等什么。
   * 同一个原因只通知一次，避免多回合之间反复刷屏。
   */
  #markWaiting(task, view) {
    const detail = view.detail ?? ''
    const stamp = `${view.reason}|${detail}`
    const first = task.status !== TASK_STATUS.WAITING
    if (first) this.stats.waiting += 1
    this.state.updateTask(task.taskId, {
      status: TASK_STATUS.WAITING,
      waitingReason: view.reason,
      waitingDetail: detail,
      waitingSince: task.waitingSince || Date.now(),
    })
    // 等用户回答可能很久：把执行看门狗换成 waiting 的长上限
    this.#armWatchdog(task.taskId, WAITING_MAX_MS)
    if (task.waitingNotified === stamp) return
    this.state.updateTask(task.taskId, { waitingNotified: stamp })
    this.log.info(
      `[tasks] 任务 #${task.no} 回合结束但仍有待办（${view.reason}${detail ? ` ${detail}` : ''}），先不归档：${JSON.stringify(view.signals ?? {})}`,
    )
    void this.#notify(task, `⏸️ 任务 #${task.no} ${describeBusy(view)}`)
  }

  /**
   * 收敛一条任务：写终态 → 释放槽位并立刻调度下一条 → 归档 session。
   * 幂等：归档与释放只做一次。
   */
  async #settle(taskId, status, patch = {}) {
    if (this.settled.has(taskId)) return
    const task = this.state.getTask(taskId)
    if (!task) return
    this.settled.add(taskId)
    // ⚠️ `settled` 是幂等集合，只增不减会随进程寿命无界增长（每跑一条任务留一个 id，
    //    而正常收敛从不删除它）。超过阈值时顺手把"台账里已经不存在的 id"清掉：
    //    那些 id 再也查不到任务（`getTask` 返回 undefined，`#settle` 会提前 return），
    //    留着只是内存。任务记录本身由 `#pruneTasks` 按每会话上限裁剪。
    if (this.settled.size > 500) {
      for (const id of this.settled) if (!this.state.getTask(id)) this.settled.delete(id)
    }
    this.#clearTimers(taskId)
    this.bodies.delete(taskId)

    // 用户显式取消过就保持 canceled：即使那一回合最后是"正常结束"，
    // 用户看到的也应该是"已取消"，否则会以为取消没生效。
    const effective = task.status === TASK_STATUS.CANCELED ? TASK_STATUS.CANCELED : status
    this.state.updateTask(taskId, {
      status: effective,
      finishedAt: Date.now(),
      waitingReason: '',
      waitingDetail: '',
      waitingSince: 0,
      ...patch,
    })

    if (effective === TASK_STATUS.DONE) this.stats.completed += 1
    else if (effective === TASK_STATUS.CANCELED) this.stats.canceled += 1
    else if (effective === TASK_STATUS.FAILED) this.stats.failed += 1

    // 先放槽位再归档：归档要走宿主服务，不该让排队的任务干等它
    const key = this.#key(task.chatType, task.chatId)
    const q = this.queues.get(key)
    if (q) {
      const i = q.indexOf(taskId)
      if (i >= 0) q.splice(i, 1)
    }
    this.#pump(task.chatType, task.chatId)

    if (task.sessionId) await this.#archive(task)
    this.#scheduleCleanup(key)
  }

  /**
   * 归档任务 session。
   *
   * 默认**不强制**（不带 stopActivity）：宿主自己会先问一遍"这个会话还有活动吗"，
   * 有就拒绝 —— 这是判据之外的第二重保险，拒绝说明我们判错了，于是退回 waiting
   * 继续等，而不是把活任务停掉。只有用户显式取消（与看门狗超时）才强制。
   *
   * 归档失败只记日志 —— 归档是清理动作，不能反过来影响任务本身。
   */
  async #archive(task) {
    const force = task.status === TASK_STATUS.CANCELED || task.status === TASK_STATUS.FAILED
    try {
      await this.bridge.archiveSession(task.sessionId, { force })
      this.state.updateTask(task.taskId, { archivedAt: Date.now() })
      this.stats.archived += 1
      this.log.info(`[tasks] 任务 #${task.no} 已结束（${task.status}），会话 ${task.sessionId} 已归档`)
    } catch (err) {
      // 宿主以"还有活动"为由拒绝 = 我们漏判了。退回去等待，而不是改强制归档重试。
      if (!force && isActiveRefusal(err)) {
        this.stats.archiveRefused += 1
        this.settled.delete(task.taskId)
        this.log.warn(
          `[tasks] 任务 #${task.no} 被宿主拒绝归档（会话仍有活动），退回 waiting 继续观察: ${err?.message ?? err}`,
        )
        this.#markWaiting(task, {
          reason: BUSY.ACTIVITY,
          detail: '（宿主报告仍有活动）',
          signals: { refused: true },
        })
        return
      }
      this.stats.archiveFailed += 1
      this.log.warn(`[tasks] 任务 #${task.no} 的会话归档失败（不影响任务本身）: ${err?.message ?? err}`)
    } finally {
      // 只有真的不再跟踪这个会话时才忘掉回传缓冲；被拒绝时还得继续回传
      if (this.settled.has(task.taskId)) {
        try {
          this.relay?.forget?.(task.sessionId)
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  /**
   * 取消任务。
   * @param {object} input
   * @param {'private'|'group'} input.chatType
   * @param {string} input.chatId
   * @param {'latest'|'all'|number} input.target
   * @param {string} [input.by] 取消来源，仅用于日志与台账
   * @returns {Promise<{changed:boolean, reason?:string, tasks:any[]}>}
   */
  async cancel({ chatType, chatId, target = 'latest', by = 'user' }) {
    const active = this.state.activeTasks(chatType, chatId) // 新的在前
    if (active.length === 0) return { changed: false, reason: '没有正在跑或排队中的任务', tasks: [] }

    let targets
    if (target === 'all') {
      targets = active
    } else if (typeof target === 'number') {
      const found =
        active.find((t) => t.no === target) ??
        this.state.listTasks(chatType, chatId, 50).find((t) => t.no === target)
      if (!found) return { changed: false, reason: `没找到任务 #${target}`, tasks: [] }
      if (isTerminal(found.status)) {
        return { changed: false, reason: `任务 #${target} 已经结束（${found.status}）`, tasks: [] }
      }
      targets = [found]
    } else {
      targets = [active[0]]
    }

    const done = []
    for (const task of targets) {
      if (await this.#cancelOne(task, by)) done.push(this.state.getTask(task.taskId))
    }
    return { changed: done.length > 0, tasks: done }
  }

  async #cancelOne(task, by) {
    if (isTerminal(task.status)) return false
    const wasQueued = task.status === TASK_STATUS.QUEUED

    // ① 先落状态、再出队：杜绝 #pump 在下一次循环里又把它起起来
    this.state.updateTask(task.taskId, {
      status: TASK_STATUS.CANCELED,
      canceledAt: Date.now(),
      canceledBy: by,
    })
    const q = this.queues.get(this.#key(task.chatType, task.chatId))
    if (q) {
      const i = q.indexOf(task.taskId)
      if (i >= 0) q.splice(i, 1)
    }

    // ② 真正在跑的：请求**单个会话**取消（v1 只能取消整个会话）
    if (!wasQueued && task.sessionId) {
      try {
        await this.bridge.cancelSession(task.sessionId)
        this.stats.cancelRequested += 1
      } catch (err) {
        // 会话可能刚好已经结束，不影响取消本身
        this.log.debug(`[tasks] cancel 会话失败（可能已结束）: ${err?.message ?? err}`)
      }
    }

    // ③ 收敛：排队中的任务没有 session 也没有回合，直接收敛；在跑的等 turn/end，
    //    但放一个兜底定时器，保证槽位一定会被释放。取消是用户显式意图，
    //    不走"待办闸门"，到期直接强制收敛。
    if (wasQueued) {
      await this.#settle(task.taskId, TASK_STATUS.CANCELED)
    } else {
      this.#armSettleTimer(
        task.taskId,
        CANCEL_SETTLE_GRACE_MS,
        () => this.#settle(task.taskId, TASK_STATUS.CANCELED),
        '取消兜底',
      )
    }
    return true
  }

  /**
   * 执行看门狗。running 时是"卡死保护"；waiting 时是"别让队列被永远堵死"，
   * 两者时限不同（见 TASK_WATCHDOG_MS / WAITING_MAX_MS）。
   */
  async #onWatchdog(taskId) {
    const task = this.state.getTask(taskId)
    if (!task || isTerminal(task.status) || this.settled.has(taskId)) return
    const waiting = task.status === TASK_STATUS.WAITING
    const minutes = Math.round((waiting ? WAITING_MAX_MS : TASK_WATCHDOG_MS) / 60000)
    const why = waiting ? `等待用户回答已超过 ${minutes} 分钟` : `超过 ${minutes} 分钟未结束`
    this.log.warn(`[tasks] 任务 #${task.no} ${why}，强制收敛（避免占着并发槽位）`)
    if (task.sessionId) {
      try {
        await this.bridge.cancelSession(task.sessionId)
      } catch (err) {
        this.log.debug(`[tasks] 看门狗取消会话失败（可能已结束）: ${err?.message ?? err}`)
      }
    }
    await this.#settle(taskId, TASK_STATUS.FAILED, { error: waiting ? '等待用户回答超时（看门狗）' : '执行超时（看门狗）' })
    await this.#notify(task, waiting ? `⏱️ 任务 #${task.no} 等你回答等太久了，先收起来（要接着做请重发一条）` : `⏱️ 任务 #${task.no} 执行超时，已中止`)
  }

  // ── 定时器：两类各自一格，互不覆盖 ─────────────────────────────────

  /** 执行看门狗（running / waiting 两种时限） */
  #armWatchdog(taskId, ms) {
    const prev = this.watchdogs.get(taskId)
    if (prev) clearTimeout(prev)
    const timer = setTimeout(() => {
      this.watchdogs.delete(taskId)
      void this.#onWatchdog(taskId).catch((err) => this.log.warn(`[tasks] 看门狗失败: ${err?.message ?? err}`))
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    this.watchdogs.set(taskId, timer)
  }

  /** 收敛定时器：可能是"确认窗到点再核对"，也可能是"取消后的兜底收敛" */
  #armSettleTimer(taskId, ms, fn, label) {
    this.#clearSettleTimer(taskId)
    const timer = setTimeout(() => {
      this.settleTimers.delete(taskId)
      void Promise.resolve()
        .then(fn)
        .catch((err) => this.log.warn(`[tasks] ${label}失败: ${err?.message ?? err}`))
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    this.settleTimers.set(taskId, timer)
  }

  /** @returns {boolean} 是否有正在等待的收敛定时器 */
  #clearSettleTimer(taskId) {
    const t = this.settleTimers.get(taskId)
    if (!t) return false
    clearTimeout(t)
    this.settleTimers.delete(taskId)
    return true
  }

  #clearTimers(taskId) {
    const w = this.watchdogs.get(taskId)
    if (w) {
      clearTimeout(w)
      this.watchdogs.delete(taskId)
    }
    this.#clearSettleTimer(taskId)
  }

  /** 队列空了就把该会话的数组删掉，别让 Map 随着会话数无限长 */
  #scheduleCleanup(key) {
    const q = this.queues.get(key)
    if (q && q.length === 0) this.queues.delete(key)
  }

  async #notify(task, text) {
    if (!task || !this.relay?.notify) return
    try {
      await this.relay.notify(task.chatType, task.chatId, text)
    } catch {
      /* 回传失败不影响任务收敛 */
    }
  }

  dispose() {
    for (const t of this.watchdogs.values()) clearTimeout(t)
    for (const t of this.settleTimers.values()) clearTimeout(t)
    this.watchdogs.clear()
    this.settleTimers.clear()
    this.queues.clear()
    this.bodies.clear()
  }

  snapshot() {
    /** @type {Record<string, number>} */
    const queues = {}
    for (const [key, q] of this.queues) if (q.length > 0) queues[key] = q.length
    return {
      ...this.stats,
      maxConcurrent: this.maxConcurrent,
      settleGraceMs: this.settleGraceMs,
      queues,
      settled: this.settled.size,
      /** 正在等收敛确认的任务数（排障用） */
      pendingSettle: this.settleTimers.size,
    }
  }
}
