/**
 * 持久化状态：QQ 会话 ↔ DSH 工作区/会话 的绑定关系，以及**任务台账**。
 *
 * 用普通 JSON 文件而不是 storageDomain：可读、可手工修、便于排障，
 * 且这份映射本身就是用户会想去检查的东西。
 *
 * ## v2 的结构变化（为什么）
 *
 * v1 是「一个 QQ 会话 = 一个 session」，所以 chats 里只有一个 sessionId。
 * 现在一个 QQ 会话下会有：
 *   - 0 或 1 个**常驻 root session**（闲聊用，惰性创建）
 *   - N 个**任务 session**（每条任务一个，跑完归档）
 * 因此拆成两张表：
 *   chats[chatKey] = { workspace*, rootSessionId, taskIds[] }   —— 会话级绑定
 *   tasks[taskId]  = { sessionId, status, text, ... }           —— 任务台账
 *
 * 分开存而不是把任务塞进 chat 记录里，是因为**任务才是会被频繁改写的热数据**
 * （状态流转 queued → running → done/canceled），而会话绑定基本不变。
 * 混在一起会让每次状态流转都重写整份会话绑定。
 *
 * 台账是「这个 QQ 会话派过哪些任务、各自什么状态」的唯一事实来源：
 * 并发槽位的占用数、`qq_tasks` 工具的答案、进度回传的 session 反查，全部读它。
 * 也正因为它是唯一事实来源，**进程重启后必须先把遗留的 queued/running 收敛掉**
 * （见 TaskScheduler.recover），否则那些永远不会结束的"在跑"任务会把
 * 并发槽位永久占死。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const STATE_VERSION = 3

/**
 * 每个会话最多保留多少条任务记录。超出的**已终态**记录会被丢弃，
 * 未终态的一条都不丢（丢了下不来台：用户还在等它，或者还要取消它）。
 */
const MAX_TASK_RECORDS_PER_CHAT = 50

/** 任务状态取值 */
export const TASK_STATUS = {
  /** 已受理，等并发槽位 */
  QUEUED: 'queued',
  /** 已建 session 并投递 */
  RUNNING: 'running',
  /**
   * 回合结束了，但会话**还有待办**（未决提问/审批、活动、inbox）——
   * 不是"跑完了"，也**不是终态**：它仍然占着并发槽位，等后续回合或用户回答。
   * 独立成一个状态的原因：用户在 QQ 侧必须分得清"它跑完了"和"它在等你"。
   */
  WAITING: 'waiting',
  /** 正常结束 */
  DONE: 'done',
  /** 出错/被阻塞/超时 */
  FAILED: 'failed',
  /** 用户取消 */
  CANCELED: 'canceled',
  /** 插件重启时遗留的未完成任务（收敛为终态） */
  INTERRUPTED: 'interrupted',
}

/** 终态集合：不再占用并发槽位 */
export const TERMINAL_TASK_STATUS = new Set([
  TASK_STATUS.DONE,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELED,
  TASK_STATUS.INTERRUPTED,
])

export function isTerminal(status) {
  return TERMINAL_TASK_STATUS.has(status)
}

/**
 * 是否占着并发槽位：从"被准入"到"收敛"为止都占着 —— **包括 waiting**。
 * waiting 不放槽位是刻意的：那条任务的会话还活着、随时可能继续跑，
 * 放掉槽位会让同一会话的并发数悄悄超过上限。
 */
export function occupiesSlot(status) {
  return status === TASK_STATUS.RUNNING || status === TASK_STATUS.WAITING
}

export class StateStore {
  /**
   * @param {object} opts
   * @param {string} [opts.dir] 状态目录，默认 $DSH_HOME/dsh-whale-inurqq
   * @param {ReturnType<import('../log.js').createLogger>} opts.log
   */
  constructor({ dir, log }) {
    this.log = log
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    this.dir = dir || path.join(home, 'dsh-whale-inurqq')
    this.file = path.join(this.dir, 'state.json')
    /** @type {{version:number, chats:Record<string, any>, tasks:Record<string, any>, taskSeq:number, updatedAt:number}} */
    this.data = { version: STATE_VERSION, chats: {}, tasks: {}, taskSeq: 0, updatedAt: 0 }
    this.#load()
  }

  #load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch (err) {
      this.log.warn(`[state] 无法创建状态目录 ${this.dir}: ${err.message}`)
    }
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        if (parsed && typeof parsed === 'object' && parsed.chats) {
          this.data = {
            version: STATE_VERSION,
            chats: parsed.chats,
            tasks: parsed.tasks ?? {},
            taskSeq: Number(parsed.taskSeq ?? 0),
            updatedAt: parsed.updatedAt ?? 0,
          }
          this.#migrate()
          this.log.info(
            `[state] 已载入 ${Object.keys(this.data.chats).length} 条会话绑定、` +
              `${Object.keys(this.data.tasks).length} 条任务记录 (${this.file})`,
          )
        }
      }
    } catch (err) {
      this.log.warn(`[state] 载入失败（将重新开始）: ${err.message}`)
    }
  }

  /**
   * v1 → v2 → v3 的迁移。
   *
   * v1 的 chats[key].sessionId 就是唯一的常驻会话，直接认成 rootSessionId。
   * v3 新增 `rootGeneration`（第几代会话）与 `lastHandoff`（上次交班台账），
   * 老绑定补默认值即可，**不丢任何东西**。
   */
  #migrate() {
    let migrated = 0
    let upgraded = 0
    for (const [key, chat] of Object.entries(this.data.chats)) {
      if (!chat || typeof chat !== 'object') continue
      if (chat.rootSessionId === undefined && chat.sessionId) {
        chat.rootSessionId = chat.sessionId
        migrated += 1
      }
      if (!Array.isArray(chat.taskIds)) chat.taskIds = []
      delete chat.sessionId
      // v2 → v3：代数是 1 起步（第 1 代就是最初那个常驻会话）
      if (!Number.isInteger(chat.rootGeneration) || chat.rootGeneration < 1) {
        chat.rootGeneration = 1
        upgraded += 1
      }
      if (chat.lastHandoff === undefined) chat.lastHandoff = null
      if (chat.handoffPending === undefined) chat.handoffPending = null
    }
    // 任务号必须严格递增：v1 没有 taskSeq，从已有记录里推一个安全起点
    const maxNo = Object.values(this.data.tasks).reduce((m, t) => Math.max(m, Number(t?.no ?? 0)), 0)
    if (this.data.taskSeq < maxNo) this.data.taskSeq = maxNo
    if (migrated > 0) {
      this.log.info(`[state] 已把 ${migrated} 条 v1 会话绑定迁移为 rootSessionId`)
      this.save()
    }
    if (upgraded > 0) {
      this.log.info(`[state] 已给 ${upgraded} 条会话绑定补上 rootGeneration=1（v3）`)
      this.save()
    }
  }

  /** 落盘。失败不抛出 —— 状态丢失不应打断任务执行 */
  save() {
    try {
      this.data.updatedAt = Date.now()
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      this.log.warn(`[state] 落盘失败: ${err.message}`)
    }
  }

  /** @param {'private'|'group'} chatType @param {string} chatId */
  static key(chatType, chatId) {
    return `${chatType}:${chatId}`
  }

  // ── 会话绑定 ─────────────────────────────────────────────────────────

  get(chatType, chatId) {
    return this.data.chats[StateStore.key(chatType, chatId)]
  }

  set(chatType, chatId, value) {
    this.data.chats[StateStore.key(chatType, chatId)] = value
    this.save()
  }

  remove(chatType, chatId) {
    delete this.data.chats[StateStore.key(chatType, chatId)]
    this.save()
  }

  entries() {
    return Object.entries(this.data.chats)
  }

  /** 记录/更新常驻会话 id */
  setRootSession(chatType, chatId, sessionId) {
    const chat = this.get(chatType, chatId)
    if (!chat) return null
    chat.rootSessionId = sessionId
    this.save()
    return chat
  }

  // ── 交班台账 ─────────────────────────────────────────────────────────

  /**
   * 记一次交班。
   *
   * `from` 字段是特意留的：进程在"切换映射之后、归档之前"崩掉时，
   * 启动时可以靠它做一次幂等补归档（旧会话可能没归档成功，会留在侧边栏）。
   *
   * @param {'private'|'group'} chatType
   * @param {string} chatId
   * @param {object} entry
   */
  recordHandoff(chatType, chatId, entry) {
    const chat = this.get(chatType, chatId)
    if (!chat) return null
    chat.rootGeneration = Number(entry?.gen ?? (chat.rootGeneration ?? 1) + 1)
    chat.lastHandoff = { ...entry, at: Number(entry?.at ?? Date.now()) }
    // 交班走完了：把"进行中"的标记清掉（崩溃恢复只看它）
    chat.handoffPending = null
    // 只留最近 10 次，防止 chats 记录无限膨胀（完整交接束在 handoff/ 目录里）
    const history = Array.isArray(chat.handoffHistory) ? chat.handoffHistory : []
    history.unshift(chat.lastHandoff)
    chat.handoffHistory = history.slice(0, 10)
    this.save()
    return chat
  }

  /**
   * 标记"这个会话正在交班：旧会话 `from` 已归档，映射还没切"。
   *
   * ## 为什么必须落盘（这是交班唯一会造成**静默丢消息**的残留）
   *
   * 交班的顺序是"先归档旧会话 → 建新会话 → 切映射"。进程若在**归档之后、
   * 切映射之前**挂掉，`state.json` 里的 `rootSessionId` 仍然指着那台
   * **已经归档**的会话。归档不报错、不通知，`ArchivedSessionGate` 只会在下一步
   * 静默 reject —— 于是用户下一条消息投进去之后**什么都不发生**，
   * 而且看不出任何异常（`lib/dsh/handoff.js` 的 DeliveryGate 注释里说的同一类故障）。
   *
   * 所以归档之后立刻把"我在交班、from 是谁"写一次盘，收尾时（`recordHandoff`）清掉；
   * 启动时若发现残留且映射还指着 `from`，就按"上次没走完"处理（见 `pendingHandoffRecoveries`）。
   */
  markHandoffPending(chatType, chatId, info) {
    const chat = this.get(chatType, chatId)
    if (!chat) return null
    chat.handoffPending = {
      from: String(info?.from ?? ''),
      gen: Number(info?.gen ?? 0),
      at: Number(info?.at ?? Date.now()),
    }
    this.save()
    return chat.handoffPending
  }

  /**
   * 上次没走完的交班（崩溃残留）：映射还指着已经归档的旧会话。
   *
   * 只报"可以确定已经坏了"的那些：`rootSessionId === handoffPending.from`。
   * 映射已经切到新会话、只是没来得及清标记的，不算（那种情况一切正常）。
   *
   * @returns {Array<{key:string, chatType:string, chatId:string, sessionId:string, gen:number, at:number}>}
   */
  pendingHandoffRecoveries() {
    const out = []
    for (const [key, chat] of Object.entries(this.data.chats)) {
      const pending = chat?.handoffPending
      if (!pending?.from) continue
      if (chat.rootSessionId !== pending.from) continue
      const [chatType, ...rest] = key.split(':')
      out.push({
        key,
        chatType,
        chatId: rest.join(':'),
        sessionId: String(pending.from),
        gen: Number(pending.gen ?? 0),
        at: Number(pending.at ?? 0),
      })
    }
    return out
  }

  /** 清掉交班进行中的标记（恢复动作做完之后调用） */
  clearHandoffPending(chatType, chatId) {
    const chat = this.get(chatType, chatId)
    if (!chat) return null
    chat.handoffPending = null
    this.save()
    return chat
  }

  /** 上次交班记下的、需要补归档的旧会话 id（没有则空数组） */
  pendingArchiveRepairs() {
    const out = []
    for (const [key, chat] of Object.entries(this.data.chats)) {
      if (!chat?.lastHandoff) continue
      const { from, archiveFailed } = chat.lastHandoff
      if (archiveFailed && from && from !== chat.rootSessionId) {
        out.push({ key, chatType: chat.chatType, chatId: chat.chatId, sessionId: from })
      }
    }
    return out
  }

  // ── 任务台账 ─────────────────────────────────────────────────────────

  /**
   * 建一条任务记录（状态 queued）。
   * @param {object} input
   * @param {'private'|'group'} input.chatType
   * @param {string} input.chatId
   * @param {string} [input.text] 正文预览（会截断）
   * @param {string} [input.workspaceId]
   * @param {string} [input.workspacePath]
   * @returns {any} 任务记录
   */
  createTask({ chatType, chatId, text, workspaceId, workspacePath, senderName, messageId }) {
    const no = (this.data.taskSeq ?? 0) + 1
    this.data.taskSeq = no
    const taskId = `t${no}`
    const task = {
      taskId,
      no,
      chatType,
      chatId,
      workspaceId: workspaceId ?? '',
      workspacePath: workspacePath ?? '',
      sessionId: '',
      status: TASK_STATUS.QUEUED,
      text: String(text ?? '').replace(/\s+/g, ' ').slice(0, 200),
      senderName: senderName ?? '',
      messageId: messageId ?? '',
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      archivedAt: 0,
      error: '',
      /** 进入 waiting 的判据（见 pending.js 的 BUSY）；非 waiting 时为空 */
      waitingReason: '',
      /** 判据的细节（问题原文、活动类型等），用于 QQ 提示 */
      waitingDetail: '',
      waitingSince: 0,
      /** 上一次已经通知过用户的 (reason|detail)，避免同一个原因反复刷屏 */
      waitingNotified: '',
      /** 收敛时的回合结束原因（排障用） */
      endReason: '',
    }
    this.data.tasks[taskId] = task

    const chat = this.get(chatType, chatId)
    if (chat) {
      if (!Array.isArray(chat.taskIds)) chat.taskIds = []
      chat.taskIds.unshift(taskId)
      chat.tasks = (chat.tasks ?? 0) + 1
      chat.lastTaskAt = task.createdAt
      chat.lastMessageId = messageId ?? chat.lastMessageId
      this.#pruneTasks(chat)
    }
    this.save()
    return task
  }

  /** 只裁掉**已终态**的旧记录；未终态的一条都不动 */
  #pruneTasks(chat) {
    const ids = chat.taskIds ?? []
    if (ids.length <= MAX_TASK_RECORDS_PER_CHAT) return
    const terminal = ids.filter((id) => isTerminal(this.data.tasks[id]?.status))
    const overflow = ids.length - MAX_TASK_RECORDS_PER_CHAT
    if (overflow <= 0 || terminal.length === 0) return
    // ids 是「新在前」，所以从尾部开始删
    const drop = new Set(terminal.slice(-overflow))
    chat.taskIds = ids.filter((id) => !drop.has(id))
    for (const id of drop) delete this.data.tasks[id]
  }

  getTask(taskId) {
    return this.data.tasks[taskId]
  }

  /** 就地更新任务记录；返回更新后的记录（不存在则 null） */
  updateTask(taskId, patch) {
    const task = this.data.tasks[taskId]
    if (!task) return null
    Object.assign(task, patch)
    this.save()
    return task
  }

  /** 某个 QQ 会话的任务台账（新的在前） */
  listTasks(chatType, chatId, limit = 20) {
    const chat = this.get(chatType, chatId)
    const ids = chat?.taskIds ?? []
    const out = []
    for (const id of ids) {
      const t = this.data.tasks[id]
      if (t) out.push(t)
      if (out.length >= limit) break
    }
    return out
  }

  /** 全部任务台账（新的在前），用于状态端点与 qq_tasks 不带参数时 */
  allTasks(limit = 50) {
    return Object.values(this.data.tasks)
      .sort((a, b) => b.no - a.no)
      .slice(0, limit)
  }

  /** 该会话里未终态的任务（排队中 + 执行中） */
  activeTasks(chatType, chatId) {
    return this.listTasks(chatType, chatId, MAX_TASK_RECORDS_PER_CHAT).filter((t) => !isTerminal(t.status))
  }

  /** 反向查找：某个 session 属于哪个 QQ 会话（进度回传要用） */
  findBySession(sessionId) {
    for (const [key, value] of Object.entries(this.data.chats)) {
      if (!value) continue
      if (value.rootSessionId === sessionId) {
        const [chatType, ...rest] = key.split(':')
        return { chatType, chatId: rest.join(':'), kind: 'root', sessionId, ...value }
      }
    }
    for (const task of Object.values(this.data.tasks)) {
      if (task?.sessionId === sessionId) {
        const chat = this.get(task.chatType, task.chatId) ?? {}
        return {
          chatType: task.chatType,
          chatId: task.chatId,
          chatName: chat.chatName ?? '',
          workspacePath: chat.workspacePath ?? task.workspacePath,
          kind: 'task',
          taskId: task.taskId,
          taskNo: task.no,
          sessionId,
        }
      }
    }
    return null
  }

  snapshot() {
    return {
      file: this.file,
      dir: this.dir,
      count: Object.keys(this.data.chats).length,
      updatedAt: this.data.updatedAt,
      taskSeq: this.data.taskSeq,
      // 状态端点要能回答"这个会话派过哪些任务"：给最近 50 条，
      // 一条任务记录只有百来字节，50 条也不到 10KB
      tasks: this.allTasks(50),
      chats: this.data.chats,
    }
  }
}
