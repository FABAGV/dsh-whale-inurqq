/**
 * 存活检测：**极简，但绝不瞎报活着**。
 *
 * ## 为什么"瞎报活着"比"不报"更糟
 *
 * 用户问"你还活着吗/好了吗"时，如果插件回一句"在的"，而他看到的其实是
 * 一个已经断了 NapCat、或者卡死的进程，那他接下来会把时间花在**等**上 ——
 * 比一开始就知道"它掉线了"贵得多。所以本模块的第一原则是：
 *
 *   **任何一条必需证据缺失，都判 false，并把缺失的那条写进 reasons。**
 *
 * 不猜、不因为"上一次是活的"就顺着说，也不因为"没有反证"就默认 true。
 *
 * ## 判据（每一条都是可以直接查的事实，不含推断）
 *
 * | 信号 | 事实来源 | 缺了会怎样 |
 * |---|---|---|
 * | `channel.open` | `server.connections` 里有连接、`conn.closed === false`、且 `ws.readyState === OPEN` | 判定 false：`no-connection` / `socket-not-open` |
 * | `channel.fresh` | `conn.lastEventAt`（每条事件帧都会刷新，`connection.js:84`；NapCat 的 heartbeat 是周期性事件） | 判定 false：`event-stream-stale` |
 * | `loop.healthy` | 插件自己的 tick 计时器最近一次真的跑了 | 判定 false：`event-loop-stalled` |
 * | `tasks.dead` | 台账里 running/waiting 的任务，其 session 在 `agents.get()` 里还查得到 | 只影响 `tasks.verdict`，**不影响 `alive`**（见下） |
 *
 * ## 为什么 task 侧不算进 `alive`
 *
 * `alive` 回答的是"**现在跟它说话有用吗**"。任务侧的失败模式（任务会话没了、
 * 台账状态陈旧）不影响"它还收不收消息、会不会答" —— 把它们混进 `alive` 会让
 * `alive=false` 变得无法解释，用户也就没法据它行动。
 * 所以 task 侧单独给一个 `tasks.verdict`，并且明确标注它不参与 `alive`。
 *
 * ## `loop.healthy` 究竟证明了什么（别把它当"进程活着"的证明）
 *
 * 它证明的是"最近 `LOOP_STALL_MS` 毫秒内，本插件的定时器真的被调度过"。
 * 它的价值在于：事件循环有没有被长同步任务堵住。**它不是进程存活的证明**
 * —— 一个已经退出的进程根本不会执行到这里（状态端点会连不上，而不是返回 false）。
 * 这一点必须对外说清楚，否则这条判据会被当成比它实际更强的东西。
 */
import { TASK_STATUS } from './dsh/state.js'

/** tick 间隔：事件循环是否还在跑的观测粒度 */
export const LOOP_TICK_MS = 500

/**
 * 事件循环卡死判定阈值。
 *
 * 取 10 秒（= 20 个 tick）。一个正常的 turn 里可能有几十毫秒的同步块，
 * 也可能有 `await` 造成的调度空隙，但**连续 10 秒一次 tick 都跑不到**
 * 只可能是长同步操作（大文件读写、同步子进程、死循环）。
 */
export const LOOP_STALL_MS = 10_000

/**
 * 事件流静默上限。
 *
 * 依据：NapCat 反向 WS 会在 `heartInterval` 周期发 `meta_event.heartbeat`
 * （README 的推荐配置是 30000ms），所以"健康的连接"最长静默时间 ≈ 心跳间隔。
 * 90 秒 = 3 个心跳周期，留足抖动与 GC 停顿的余量，同时远小于用户能忍受的
 * "等一个不存在的答复"的时间。
 *
 * ⚠️ 这条判据治的是**半开连接**：TCP 层没报错（`readyState` 仍是 OPEN）、
 * 但对端已经没了。没有它，断开后能不能报离线就取决于 OS 什么时候发 RST ——
 * 网络中断（拔网线、休眠）时那天可能永远不来。
 */
export const EVENT_SILENCE_MS = 90_000

/** 判定用的人话标签 */
export const ALIVE_REASON = {
  /** 连接层还没建起来（服务端未起） */
  NO_SERVER: 'no-server',
  /** 一条协议端连接都没有 */
  NO_CONNECTION: 'no-connection',
  /** 有连接对象，但 socket 不是 OPEN（正在关闭/半关） */
  SOCKET_NOT_OPEN: 'socket-not-open',
  /** 连接在，但太久没有任何事件帧 */
  STALE_EVENTS: 'event-stream-stale',
  /** 插件的 tick 计时器太久没跑 = 事件循环被堵住 */
  LOOP_STALLED: 'event-loop-stalled',
}

/** 理由 → 给人看的一句话（状态端点与工具都用它） */
export function describeAliveReason(reason) {
  switch (reason) {
    case ALIVE_REASON.NO_SERVER:
      return '连接层还没建起来（webServer 服务未就绪或插件刚启动）'
    case ALIVE_REASON.NO_CONNECTION:
      return '没有任何 QQ 协议端（NapCat）连接 —— 断开或从未接入'
    case ALIVE_REASON.SOCKET_NOT_OPEN:
      return '协议端连接存在，但 WebSocket 已不在 OPEN 状态'
    case ALIVE_REASON.STALE_EVENTS:
      return '连接还在，但超过静默上限没有收到任何事件帧（半开连接/对端已死）'
    case ALIVE_REASON.LOOP_STALLED:
      return '插件的事件循环超过阈值没有被调度（被长同步任务堵住）'
    default:
      return ''
  }
}

/**
 * 纯判定函数：**只看传进来的事实**，不读时钟、不碰服务。
 *
 * @param {object} input
 * @param {boolean} input.serverReady 连接层是否已初始化
 * @param {Array<{closed?:boolean, socketOpen?:boolean, lastEventAt?:number, connectedAt?:number, selfId?:string}>} input.connections
 * @param {number} input.now
 * @param {number} input.lastTickAt 插件 tick 计时器最近一次真的跑的时间
 * @param {number} [input.eventSilenceMs] 静默上限（默认 EVENT_SILENCE_MS）
 * @param {number} [input.loopStallMs] 卡死阈值（默认 LOOP_STALL_MS）
 * @returns {{alive:boolean, because:string[], reasons:string[], evidence:object}}
 */
export function judgeAlive({
  serverReady,
  connections,
  now,
  lastTickAt,
  eventSilenceMs = EVENT_SILENCE_MS,
  loopStallMs = LOOP_STALL_MS,
} = {}) {
  const at = Number(now) || 0
  const conns = Array.isArray(connections) ? connections : []
  const reasons = []

  // ── ① QQ 通道 ────────────────────────────────────────────────────
  let open = null
  if (!serverReady) {
    reasons.push(ALIVE_REASON.NO_SERVER)
  } else {
    // 只认"既没被标记关闭、socket 又是 OPEN"的连接
    open = conns.find((c) => c && !c.closed && c.socketOpen !== false) ?? null
    if (!open) reasons.push(conns.length === 0 ? ALIVE_REASON.NO_CONNECTION : ALIVE_REASON.SOCKET_NOT_OPEN)
  }

  const lastEventAt = Number(open?.lastEventAt ?? 0) || 0
  // 静默判据的锚点：还没收到过任何事件时，从连接建立那一刻起算
  const anchor = lastEventAt > 0 ? lastEventAt : Number(open?.connectedAt ?? 0) || 0
  const silentForMs = open && anchor > 0 ? Math.max(0, at - anchor) : 0
  if (open && (!anchor || silentForMs > eventSilenceMs)) reasons.push(ALIVE_REASON.STALE_EVENTS)

  // ── ② 插件自身：事件循环还在被调度吗 ───────────────────────────────
  const sinceTickMs = Number(lastTickAt) > 0 ? Math.max(0, at - Number(lastTickAt)) : Number.POSITIVE_INFINITY
  if (!(sinceTickMs <= loopStallMs)) reasons.push(ALIVE_REASON.LOOP_STALLED)

  // ── 汇总：必需项全过才算活着 ──────────────────────────────────────
  const alive = reasons.length === 0
  const because = alive
    ? [
        `QQ 通道：${conns.length} 条连接、WebSocket 处于 OPEN，最近 ${Math.round(silentForMs / 1000)} 秒内收到过事件帧` +
          (open?.selfId ? `（selfId=${open.selfId}）` : ''),
        `插件自身：事件循环 ${Math.round(sinceTickMs)} 毫秒前刚跑过一次（阈值 ${loopStallMs} 毫秒）`,
      ]
    : reasons.map((r) => {
        const base = describeAliveReason(r)
        if (r === ALIVE_REASON.STALE_EVENTS) {
          return `${base}（静默 ${Math.round(silentForMs / 1000)} 秒 > 上限 ${Math.round(eventSilenceMs / 1000)} 秒）`
        }
        if (r === ALIVE_REASON.LOOP_STALLED) {
          return `${base}（${Number.isFinite(sinceTickMs) ? `${Math.round(sinceTickMs)} 毫秒` : '从未'} > 阈值 ${loopStallMs} 毫秒）`
        }
        return base
      })

  return {
    alive,
    because,
    reasons,
    evidence: {
      connections: conns.length,
      openConnections: conns.filter((c) => c && !c.closed && c.socketOpen !== false).length,
      selfId: open?.selfId ?? '',
      lastEventAt,
      silentForMs,
      eventSilenceMs,
      sinceTickMs: Number.isFinite(sinceTickMs) ? sinceTickMs : null,
      loopStallMs,
      lastTickAt: Number(lastTickAt) || 0,
      /** 判据的边界，别让读的人以为 `alive` 比它实际更强 */
      note: 'alive 只回答"现在跟它说话有没有用"；loop.healthy 不是"进程存活"的证明（进程不在时这个端点根本不会响应）',
    },
  }
}

/**
 * 任务侧存活：台账说"在跑"的那些任务，它们的 session 真的还在吗。
 *
 * ⚠️ **它不参与 `alive` 判定**（理由见文件头）。它治的是另一种失败：
 * 台账里挂着 running/waiting 但对应的 agent 已经不存在 —— 那种情况下
 * 用户问"跑到哪了"会被答"在跑"，而实际上永远不会再有进展。
 *
 * 读不到 `agents` 服务时给 `available: false` 而不是 `false`：
 * **问不到 ≠ 它死了**，这一点必须和"查到了、确实没有"区分开。
 *
 * @param {object} opts
 * @param {(id:string) => any} opts.getAgent `ctx.agents.get`
 * @param {Array<{no:number, status:string, sessionId?:string, chatType?:string, chatId?:string, text?:string}>} opts.tasks
 * @returns {{available:boolean, verdict:string, running:number, waiting:number, dead:Array<object>, because:string}}
 */
export function probeTasks({ getAgent, tasks } = {}) {
  const rows = Array.isArray(tasks) ? tasks : []
  const live = rows.filter((t) => t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.WAITING)
  const running = rows.filter((t) => t.status === TASK_STATUS.RUNNING).length
  const waiting = rows.filter((t) => t.status === TASK_STATUS.WAITING).length

  if (typeof getAgent !== 'function') {
    return { available: false, verdict: 'unknown', running, waiting, dead: [], because: 'agents 服务不可用，无法核对任务会话是否还在' }
  }

  const dead = []
  for (const t of live) {
    const id = String(t.sessionId ?? '')
    if (!id) {
      dead.push({ no: t.no, reason: 'no-session', detail: '台账里没有 sessionId' })
      continue
    }
    let agent
    try {
      agent = getAgent(id)
    } catch (err) {
      return {
        available: false,
        verdict: 'unknown',
        running,
        waiting,
        dead: [],
        because: `读取 agents 失败：${err?.message ?? err}`,
      }
    }
    if (!agent) dead.push({ no: t.no, reason: 'session-gone', detail: `会话 ${id} 已不在 agents 注册表里` })
  }

  if (dead.length > 0) {
    return {
      available: true,
      verdict: 'dead',
      running,
      waiting,
      dead,
      because: `台账里有 ${dead.length} 条任务自称在跑，但它们的会话已经查不到了：${dead.map((d) => `#${d.no}`).join('、')}`,
    }
  }
  if (live.length === 0) {
    return { available: true, verdict: 'idle', running, waiting, dead: [], because: '没有在跑或等待中的任务' }
  }
  return {
    available: true,
    verdict: 'ok',
    running,
    waiting,
    dead: [],
    because: `${live.length} 条任务（执行中 ${running}、等待中 ${waiting}）的会话都还在 agents 注册表里`,
  }
}

/** 把任务侧结论压成一句话，给工具/状态端点用 */
export function describeTasks(probe) {
  if (!probe) return ''
  const head = `任务侧：${probe.verdict}`
  return probe.because ? `${head} —— ${probe.because}` : head
}

/**
 * 进程内的存活观测器。
 *
 * 只做一件事：用一条 `unref` 的计时器，记录"事件循环最近一次被调度"的时间。
 * 不写盘、不发网络、不做统计聚合（要极简，也要保证它自己不会成为卡顿源）。
 */
export class LivenessMonitor {
  /**
   * @param {object} opts
   * @param {() => Array<any>} opts.connections 返回当前连接快照
   * @param {() => boolean} opts.serverReady 连接层是否已初始化
   * @param {ReturnType<import('./log.js').createLogger>} [opts.log]
   * @param {number} [opts.tickMs]
   */
  constructor({ connections, serverReady, log = null, tickMs = LOOP_TICK_MS }) {
    this.connectionsOf = typeof connections === 'function' ? connections : () => []
    this.serverReadyOf = typeof serverReady === 'function' ? serverReady : () => false
    this.log = log
    this.tickMs = tickMs
    /** 构造即视为刚跑过一次：否则插件刚起来的前 tickMs 会被误判成"卡死" */
    this.lastTickAt = Date.now()
    this.ticks = 0
    this.maxGapMs = 0
    this.disposed = false
    /** @type {NodeJS.Timeout | null} */
    this.timer = null
    this.#arm()
  }

  #arm() {
    if (this.disposed) return
    this.timer = setInterval(() => {
      const now = Date.now()
      const gap = now - this.lastTickAt
      if (gap > this.maxGapMs) this.maxGapMs = gap
      this.lastTickAt = now
      this.ticks += 1
    }, this.tickMs)
    // 绝不能因为这个观测器把进程钉住不退出
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** 直接读连接快照（不缓存：状态端点要的是"此刻"） */
  #connections() {
    try {
      const list = this.connectionsOf()
      if (!Array.isArray(list)) return []
      return list.map((c) => ({
        closed: Boolean(c?.closed),
        // 真实连接对象上 socket 是 ws；OPEN 常量在实例上也有一份
        socketOpen: c?.socket ? c.socket.readyState === c.socket.OPEN : undefined,
        lastEventAt: Number(c?.lastEventAt ?? 0) || 0,
        connectedAt: Number(c?.connectedAt ?? 0) || 0,
        selfId: String(c?.selfId ?? ''),
      }))
    } catch (err) {
      this.log?.warn?.(`[alive] 读取连接状态失败: ${err?.message ?? err}`)
      return []
    }
  }

  /** 纯通道 + 自身判定（不含任务侧） */
  probe(now = Date.now()) {
    let serverReady = false
    try {
      serverReady = Boolean(this.serverReadyOf())
    } catch {
      serverReady = false
    }
    return judgeAlive({
      serverReady,
      connections: this.#connections(),
      now,
      lastTickAt: this.lastTickAt,
    })
  }

  /**
   * 完整判定 = 通道/自身 + 任务侧。
   * @param {{getAgent?:Function, tasks?:Array<any>}} [deps]
   */
  probeAll(deps = {}) {
    const alive = this.probe()
    const tasks = probeTasks({ getAgent: deps.getAgent, tasks: deps.tasks })
    return { ...alive, tasks }
  }

  snapshot(now = Date.now()) {
    return {
      alive: this.probe(now).alive,
      lastTickAt: this.lastTickAt,
      sinceTickMs: Math.max(0, now - this.lastTickAt),
      ticks: this.ticks,
      maxGapMs: Math.round(this.maxGapMs),
      tickMs: this.tickMs,
      loopStallMs: LOOP_STALL_MS,
      eventSilenceMs: EVENT_SILENCE_MS,
    }
  }

  dispose() {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
