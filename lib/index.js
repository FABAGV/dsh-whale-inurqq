/**
 * dsh-whale-inurqq — 把 QQ 接入 DeepSeek Harness。
 *
 * 里程碑：
 *   M1 连接层 + 归一化 + 路由决策        ✅
 *   M2 workspace/session 派活 + 进度回传  ✅
 *   M3 任务/闲聊分流（v2）+ 语料库 / 洞察 / 设置页
 *   v3 常驻对接会话 + 阈值交班 + 碎片记忆  ✅
 *
 * ## 当前（v3）的路由：一个 QQ 会话 = 一台常驻对接会话
 *
 *   QQ 消息 → 该 QQ 会话的常驻对接会话（惰性创建），**聊天和干活都在它里面**。
 *             上下文到阈值 → 交班换一台新会话（碎片记忆继续用）。
 *
 * 早先的 v2 路由是"闲聊进常驻会话、每条任务另起一台任务会话"。那条路现在只在
 * `conversation.enabled=false`（回滚开关）时启用：它保留是为了随时能回到旧行为对照，
 * 默认路径不再新建任务会话 —— 用户的原话是
 * 「每次发一个新的消息我就看见工作区看见一个新的会话在那边猜用户要干什么」。
 *
 * 回传侧的判据见 `lib/dsh/relay.js` 顶部：**据 turn 的来源**（插件发的 prompt 带
 * `requestId`），不是"用户在不在电脑前" —— GUI 里用户自己发起的回合一个字都不推 QQ。
 *
 * 设计依据：本仓库 README 的「它做什么 / 交班换新会话」两节
 *           （架构取舍与判据契约写在 README 里，代码注释只补实现细节）
 *
 * 反向 WS 的挂载方式有两种，默认 'own'：
 *   own — 插件自建 HTTP 服务端监听 reversePort（默认 6700），与 NapCat 现有配置对齐
 *   dsh — 挂在 DSH 的 webServer 上（此时 NapCat 需指向 DSH 的端口）
 */
import http from 'node:http'
import { createLogger, defaultLogFile } from './log.js'
import { resolveConfig, inScope } from './config.js'
import { Pipeline, INTENT } from './pipeline.js'
import { OneBotReverseServer } from './onebot/server.js'
import { StateStore } from './dsh/state.js'
import { DshBridge } from './dsh/bridge.js'
import { ProgressRelay } from './dsh/relay.js'
import { TaskScheduler } from './dsh/tasks.js'
import { assessSessionWork } from './dsh/pending.js'
import { registerQqTools } from './dsh/tools.js'
import { MemoryStore } from './dsh/memory.js'
import { registerResidentMemory, ScopeResolver, CONTEXT_NAME, CONTEXT_ORDER } from './dsh/context.js'
import { registerFrontDesk, FRONTDESK_SECTION, FRONTDESK_ORDER } from './dsh/frontdesk.js'
import { LivenessMonitor, describeAliveReason } from './alive.js'
import { ConversationHandoff, DeliveryGate } from './dsh/handoff.js'
import { Corpus } from './corpus.js'
import { expandForward, formatForward } from './onebot/forward.js'
import { plainText } from './onebot/normalize.js'
import { Config } from './schema.js'

export { Config }

export const name = 'dsh-whale-inurqq'

const PLUGIN_VERSION = '0.1.0'
const STATUS_PATH = '/dsh-whale-inurqq/status'

export default {
  name,

  // 关键：cordis 的 loader 读的是 `runtime.Config`，而 runtime 就是**这个默认导出对象**
  // （见 cordis `this.runtime?.Config?.["simplify"]` 与 `resolveConfig(runtime, config)`）。
  // 只做命名导出 `export { Config }` 是不够的 —— 那样 loader 采集不到，
  // 设置页就不会按 Schema 生成（表现为 Config provider 里 status = "absent"）。
  Config,

  /**
   * @param {import('@deepseek-ai/cordis').Context} root
   * @param {object} rawConfig
   */
  apply(root, rawConfig = {}) {
    const config = resolveConfig(rawConfig)
    // 桌面端插件的 stdout 归 Electron 管，出问题时看不到 —— 所以日志同时镜像到文件
    const log = createLogger('dsh-whale-inurqq', config.logLevel, defaultLogFile())
    log.info(`──────── apply() 开始  pid=${process.pid}  node=${process.version} ────────`)

    for (const w of config.warnings) log.warn(w)
    log.info(
      `启动中：mode=${config.connection.mode} mount=${config.connection.mount} ` +
        `path=${config.connection.reversePath} groupMode=${config.participation.groupMode} ` +
        `workspaceRoot=${config.tasks.workspaceRoot || '(未配置)'}`,
    )

    const pipeline = new Pipeline({ config, log })

    /** @type {NodeJS.Timeout | null} */
    let pruneTimer = null

    // 语料库不依赖 DSH 服务：即使工作区/会话服务不可用，投喂也应当能沉淀
    const corpusStore = new Corpus({ config, log })

    // 保留期清理：启动时跑一次，之后每 6 小时一次
    try {
      corpusStore.prune()
      // 定时那次自己也要兜住：prune 里读配置/算日期都可能抛，抛出来就是未捕获异常
      pruneTimer = setInterval(() => {
        try {
          corpusStore.prune()
        } catch (err) {
          log.warn(`[corpus] 定时清理异常: ${err?.message ?? err}`)
        }
      }, 6 * 60 * 60 * 1000)
      if (typeof pruneTimer.unref === 'function') pruneTimer.unref()
    } catch (err) {
      log.warn(`[corpus] 启动清理失败: ${err?.message ?? err}`)
    }

    /** access token 运行时持有者：先用配置兜底，随后由 credentials 刷新覆盖 */
    const auth = {
      token: config.connection.token ?? '',
      source: config.connection.token ? 'config' : 'none',
      /**
       * 鉴权信息是否已解析完成。凭据解析是异步的，在此之前一律拒绝连接
       * （fail-closed），否则凭据-only 部署的首个连接会被放行。
       * 若配置里已有 token，则视为立即就绪。
       */
      ready: Boolean(config.connection.token),
      /** @type {null | (() => Promise<void>)} 由凭证注入后就绪 */
      refresh: null,
    }

    /** @type {OneBotReverseServer | null} */
    let server = null
    /** @type {http.Server | null} */
    let ownServer = null
    /**
     * 存活观测器（v3.1）。
     *
     * 它只回答一个问题："**现在跟它说话有用吗**"。判据与"为什么不瞎报活着"
     * 见 lib/alive.js 顶部 —— 那里是这件事的单一真源，改判据改那边。
     * 这里只负责把三样活值喂给它：连接层是否就绪、当前连接、以及 tick 计时器。
     */
    const liveness = new LivenessMonitor({
      serverReady: () => server !== null,
      connections: () => (server ? [...server.connections] : []),
      log,
    })
    /** 暴露给状态端点与 `qq_alive` / `qq_tasks` 用：拿不到 agents 服务时如实说"问不到" */
    const liveProbe = () => {
      let agents = null
      try {
        agents = typeof root.get === 'function' ? root.get('agents') : null
      } catch {
        agents = null
      }
      return liveness.probeAll({
        getAgent: agents && typeof agents.get === 'function' ? (id) => agents.get(id) : undefined,
        tasks: dsh ? dsh.state.allTasks(50) : [],
      })
    }
    /**
     * @type {{bridge: DshBridge, relay: ProgressRelay, state: StateStore, scheduler: TaskScheduler | null,
     *         memory: MemoryStore | null, handoff: ConversationHandoff | null, gate: DeliveryGate,
     *         resolver: ScopeResolver}} | null}
     */
    let dsh = null
    /** @type {Array<() => void>} */
    const readyWaiters = []

    const disposers = []

    // ── 常驻对接会话：`conversation.enabled` 是**回滚开关** ──────────────
    //
    // == true（默认）：走 README 说的那条新逻辑链条 —— 消息进常驻对接会话，
    //   干活也在它里面做（`frozenQueue` 是唯一例外窗口）。
    // == false：路由与装配回到 v2 —— 任务派成独立任务会话（TaskScheduler 装配起来），
    //   不注册 `qq_dispatch`、不建常驻记忆、不挂交班监视器。
    //   这一态是 159 条 v2 断言的全绿保命线，改动前务必先跑一遍基线。
    //
    // ⚠️ 有一件事**不分模式**：回传的来源门控（规则 2，见 lib/dsh/relay.js）。
    //    它判的是“这个回合是不是插件发起的”，与走哪条路由无关。
    const conversationOn = config.conversation.enabled === true

    /**
     * 交班冻结闸门。**即使 conversation 关闭也建一个空对象**，
     * 因为 `consume` 与 `bridge` 都会问它"这个会话现在能不能收"。
     * @type {DeliveryGate}
     */
    const gate = conversationOn ? new DeliveryGate({ log }) : null

    /** @type {MemoryStore | null} */
    let memoryStore = null
    /** @type {ConversationHandoff | null} */
    let handoff = null
    /** @type {ScopeResolver | null} */
    let scopeResolver = null

    // ── 语料沉淀 ──────────────────────────────────────────────────────
    const archive = (message, extra = {}) => {
      corpusStore.append({
        chatType: message.chatType,
        chatId: message.chatId,
        chatName: extra.chatName,
        kind: extra.kind ?? 'message',
        ts: message.ts || Date.now(),
        payload: {
          messageId: message.messageId,
          senderId: message.senderId,
          senderName: message.senderName,
          text: extra.text ?? '',
          segments: message.segments.map((s) => s.kind),
          ...extra.payload,
        },
      })
    }

    /** 展开合并转发；失败不抛，返回 null */
    const expandSafely = async (message) => {
      const conn = server?.pick()
      if (!conn) {
        log.warn('[forward] 没有可用连接，无法展开合并转发')
        return null
      }
      const seg = message.segments.find((s) => s.kind === 'forward')
      if (!seg?.id) return null
      try {
        const rec = await expandForward(conn, seg.id)
        log.info(`[forward] 展开 ${seg.id}：${rec.nodes.length} 个节点`)
        return rec
      } catch (err) {
        log.warn(`[forward] 展开失败 ${seg.id}: ${err?.message ?? err}`)
        return null
      }
    }

    // ── 出站：把文本发到 QQ ────────────────────────────────────────────
    const send = async (chatType, chatId, text) => {
      const conn = server?.pick()
      if (!conn) throw new Error('当前没有可用的 OneBot 连接')
      const action = chatType === 'group' ? 'send_group_msg' : 'send_private_msg'
      const idKey = chatType === 'group' ? 'group_id' : 'user_id'
      await conn.call(action, {
        [idKey]: Number(chatId),
        message: [{ type: 'text', data: { text } }],
      })
    }

    /** 等待 DSH 侧服务就绪（用于极早期到达的消息） */
    const awaitDsh = (timeoutMs = 10000) =>
      new Promise((resolve) => {
        if (dsh) return resolve(dsh)
        const timer = setTimeout(() => resolve(null), timeoutMs)
        readyWaiters.push(() => {
          clearTimeout(timer)
          resolve(dsh)
        })
      })

    // ── 意图消费 ──────────────────────────────────────────────────────
    /**
     * 把一条消息整理成要投递的正文，并顺手沉淀语料。
     * 合并转发要展开成结构化节点当语境；展开失败时明确告知，而不是装作读到了。
     */
    const prepareText = async (decision, message, chatName) => {
      if (decision.expandForward) {
        const rec = await expandSafely(message)
        if (rec && rec.nodes.length > 0) {
          archive(message, {
            chatName,
            kind: 'forward',
            payload: { forwardId: rec.id, nodes: rec.nodes.map((n) => ({ s: n.senderName, t: n.ts, x: n.text })) },
          })
          return `${formatForward(rec)}\n\n【我的问题】\n${decision.text}`
        }
        return (
          `${decision.text}\n\n` +
          '（注：你转发的那段聊天记录我打不开，如果问题依赖它的内容，请直接把关键几条贴给我）'
        )
      }
      archive(message, { chatName, text: decision.text })
      return decision.text
    }

    /**
     * 「交班冻结期」收到的话：**按到达顺序排队**，交班一结束立刻按同一顺序补投。
     *
     * 为什么必须有这个队列：交班那几百毫秒到几秒里，常驻会话正在被归档、映射还没切
     * （见 handoff.js 的阶段 4→6）。这期间往旧会话投递 = 静默丢消息（DeliveryGate 拦下），
     * 往新会话投递 = 它还没建出来。
     *
     * ⚠️ v2 曾经在这里把消息兜底成"派一条独立任务会话"。新逻辑链条下**不能**再这么干：
     *    那等于绕开常驻对接会话、又冒出一个任务会话（正是本轮要废除的行为）。
     *    代价是这几条消息要多等一个交班的时间 —— 但它们不会丢，也不会另起会话。
     * @type {Array<{chatType:'private'|'group', chatId:string, chatName?:string, text:string, senderName?:string}>}
     */
    const frozenQueue = []

    /**
     * 队列长度告警阈值。
     *
     * ⚠️ 只告警、**不丢消息**：丢用户消息比占一点内存严重得多。正常情况下队列最多
     *    攒一个人打字的速度那几条；到这个量级说明某个会话长期卡在交班态，
     *    那才是要查的东西（下面是阈值告警，状态端点的 handoff 段是现场）。
     */
    const FROZEN_QUEUE_WARN = 200

    /** 按顺序补投冻结期攒下的消息（交班解冻后调用；失败只记账，不丢队列里的其他条） */
    const drainFrozenQueue = () => {
      if (frozenQueue.length === 0 || !dsh) return
      const pending = frozenQueue.splice(0, frozenQueue.length)
      /** 交班还没结束的会话：退回队列，等它自己的解冻回调来取 */
      const requeue = []
      let sent = 0
      for (const input of pending) {
        // ⚠️ 解冻回调是按 scope 触发的，但队列是**全局**的：另一个会话可能还在交班。
        //    那种消息必须重新排队 —— 否则它会投进已被 retire 的旧会话，被
        //    DeliveryGate 拒掉，再走 bridge 的兜底（清绑定 + 另建一台常驻会话），
        //    于是这条用户消息落进一台孤儿会话：它被处理了，回复却永远回不到 QQ。
        if (dsh.handoff?.isFrozen?.(input.chatType, input.chatId)) {
          requeue.push(input)
          continue
        }
        sent += 1
        void dsh.bridge
          .deliverChat({ ...input, by: 'bridge:frozen-drain' })
          .catch((err) => log.error(`[chat] 冻结期补投失败: ${err?.stack ?? err}`))
      }
      if (requeue.length > 0) {
        frozenQueue.push(...requeue)
        log.info(`[chat] 有 ${requeue.length} 条属于仍在交班的会话，留在队列里等它解冻`)
      }
      log.info(`[chat] 交班已结束，补投冻结期攒下的 ${sent} 条消息`)
    }

    const consume = async (decision) => {
      const { intent, message } = decision
      const chatName = message.chatType === 'group' ? undefined : message.senderName

      if (intent === INTENT.INGEST) {
        // 投喂：进语料库。合并转发额外展开成结构化节点
        const segs = message.segments.map((s) => s.kind).join('+')
        if (decision.expandForward) {
          const rec = await expandSafely(message)
          if (rec) {
            archive(message, {
              chatName,
              kind: 'forward',
              payload: { forwardId: rec.id, nodes: rec.nodes.map((n) => ({ s: n.senderName, t: n.ts, x: n.text })) },
            })
            log.info(`[ingest] forward-record ${message.chatType}/${message.chatId} → 已展开 ${rec.nodes.length} 节点入库`)
          } else {
            log.warn(`[ingest] forward-record ${message.chatType}/${message.chatId} → 展开失败，未入库`)
          }
          return
        }
        archive(message, { chatName, text: plainText(message) })
        log.info(`[ingest] ${decision.reason} ${message.chatType}/${message.chatId} segments=${segs}`)
        return
      }

      if (intent === INTENT.IGNORE) return

      const isChat = intent === INTENT.CHAT
      if (!isChat && intent !== INTENT.TASK) return

      // 任务与闲聊都要先把这段话沉淀下来（用户问的就是它）
      const text = await prepareText(decision, message, chatName)

      const ready = await awaitDsh()
      if (!ready) {
        log.warn(`[${isChat ? 'chat' : 'task'}] DSH 服务未就绪，丢弃 from ${message.chatType}/${message.chatId}`)
        await send(message.chatType, message.chatId, '⚠️ DSH 侧的服务还没就绪，请稍后再试').catch(() => {})
        return
      }

      // ── 规则 1：默认路径只投常驻对接会话，**不再新建任务会话** ─────────
      //
      // 一个 QQ 会话恒定只有一台会话，聊天和干活都在它里面。
      //
      // 唯一的例外窗口是"交班冻结期"：那期间会话正在换代，投进去等于静默丢，
      // 所以排队等交班结束再按原顺序补投 —— 仍然不新建会话。
      const frozen = Boolean(dsh?.handoff && dsh.handoff.isFrozen(message.chatType, message.chatId))
      if (conversationOn && frozen) {
        frozenQueue.push({
          chatType: message.chatType,
          chatId: message.chatId,
          chatName,
          text,
          senderName: message.senderName,
        })
        log.info(`[chat] ${decision.reason} 落在交班冻结期 → 排队（第 ${frozenQueue.length} 条），交班结束后补投`)
        if (frozenQueue.length === FROZEN_QUEUE_WARN) {
          log.warn(
            `[chat] 冻结期队列已达 ${FROZEN_QUEUE_WARN} 条 —— 可能有会话长期卡在交班态，` +
              `请查状态端点的 handoff 段（frozenScopes）`,
          )
        }
        return
      }

      // ⚠️ 兜底补投：队列只在 `onUnfreeze` 回调里被抽干，而那个回调可能失败
      //    （`handoff.#unfreeze` 失败时只 warn 一句），失败之后队列就**没有人再来取**了 ——
      //    那批消息会一直躺到进程重启。所以每条「不在冻结期」的消息进来时顺手 drain 一次：
      //    只要还有流量，积压就一定投得出去；drain 排在本条投递之前，先来的仍然先处理。
      if (conversationOn && frozenQueue.length > 0) drainFrozenQueue()

      // ── v2 路径（只在 `conversation.enabled=false` 时走到，是回滚开关）──
      //
      // 关掉常驻对话会话时行为与 v2 逐字一致：任务直接派成独立任务会话（受并发上限）。
      if (!conversationOn && intent === INTENT.TASK) {
        try {
          const result = await ready.scheduler.submit({
            chatType: message.chatType,
            chatId: message.chatId,
            chatName,
            text,
            senderName: message.senderName,
            messageId: message.messageId,
          })
          const no = result.task?.no
          log.info(
            `[task] ${decision.reason} 已派活 #${no} → ` +
              `${result.admitted ? '开始执行' : `排队（前面 ${result.ahead} 条）`}` +
              ` ${result.task?.workspacePath ?? ''}`,
          )
          await ready.relay.notify(
            message.chatType,
            message.chatId,
            result.admitted
              ? `✅ 任务 #${no} 已受理，开始处理…`
              : `⏳ 任务 #${no} 已排队（前面还有 ${result.ahead} 条），轮到时会告诉你`,
          )
        } catch (err) {
          log.error(`[task] 派活失败: ${err?.stack ?? err}`)
          await send(message.chatType, message.chatId, describeFailure(err)).catch(() => {})
        }
        return
      }

      // ── 闲聊：进常驻 root session（惰性创建），不占任务并发 ─────────
      try {
        const result = await ready.bridge.chat({
          chatType: message.chatType,
          chatId: message.chatId,
          chatName,
          text,
          senderName: message.senderName,
        })
        log.info(
          `[chat] ${decision.reason}${decision.routedBy ? `(分诊→${decision.routedBy})` : ''} → ` +
            `session=${result.sessionId}${result.rebuilt ? '（重建了常驻会话）' : ''}`,
        )
      } catch (err) {
        log.error(`[chat] 投递失败: ${err?.stack ?? err}`)
        await send(message.chatType, message.chatId, describeFailure(err)).catch(() => {})
      }
    }

    const onEvent = (payload, conn) => {
      let decision
      try {
        decision = pipeline.handle(payload, conn)
      } catch (err) {
        log.error(`[pipeline] 处理事件失败: ${err?.stack ?? err}`)
        return
      }
      if (!decision || decision.intent === INTENT.IGNORE) return
      void Promise.resolve(consume(decision)).catch((err) => {
        log.error(`[consume] 失败: ${err?.stack ?? err}`)
      })
    }

    // ── 状态快照 ──────────────────────────────────────────────────────
    /** 一眼看懂的体检结论：出问题时不用逐字段推 */
    const computeHealth = () => {
      const issues = []
      const ok = []

      if (!server) issues.push('连接层未初始化（webServer 服务未就绪）')
      else if (!server.getToken()) issues.push('未配置 access token —— 任何进程都能连入，不建议')
      else ok.push(`access token 已配置（来源：${auth.source}）`)

      // ── 存活判定：先说清"它现在是不是还活着、凭什么叫它活着" ──────────
      //
      // 这条必须在最前面：一个已断开的插件，后面所有"任务在跑""交班正常"
      // 的数字都是**没有意义**的（它们描述的是过去）。
      const live = liveProbe()
      if (!live.alive) {
        issues.push(`插件当前**不活着**：${live.because.join('；')}`)
      } else {
        ok.push(`插件活着：${live.because.join('；')}`)
      }
      if (live.tasks && live.tasks.verdict === 'dead') issues.push(live.tasks.because)
      else if (live.tasks && live.tasks.verdict === 'unknown') ok.push(live.tasks.because)

      if (!server || server.connections.size === 0) issues.push('当前没有协议端连接（NapCat 未接入或已断开）')
      else ok.push(`协议端已接入（${[...server.connections].map((c) => c.selfId || '未知').join(',')}）`)

      if (!config.tasks.workspaceRoot) issues.push('tasks.workspaceRoot 未配置 —— 任务无法落盘')
      else ok.push('工作区父目录已配置')

      if (!dsh) issues.push('DSH 桥接未就绪（workspace/session 服务未注入）')
      else {
        ok.push('DSH 桥接就绪')
        if (dsh.bridge.stats.failed > 0) {
          issues.push(`有 ${dsh.bridge.stats.failed} 次派活失败，最近一次：${dsh.bridge.stats.lastError ?? '未知'}`)
        }
        const created = dsh.bridge.stats.sessionsCreated
        if (created === 0 && dsh.bridge.stats.workspacesCreated > 0) {
          issues.push('建过工作区但从未建成会话 —— 派活链路可能有问题')
        }
        // 任务调度只在 v2 回滚路径上存在（新逻辑链条没有任务会话可调度）
        const sched = dsh.scheduler?.snapshot() ?? null
        if (!sched) {
          ok.push('常驻对接会话模式：不建任务会话、没有任务队列（进度靠 qq_alive / qq_tasks 查）')
        } else {
          const queuedTotal = Object.values(sched.queues ?? {}).reduce((a, b) => a + b, 0)
          if (queuedTotal > 0) {
            ok.push(`有 ${queuedTotal} 条任务在排队（每会话上限 ${sched.maxConcurrent}）`)
          }
          if (sched.waiting > 0) {
            ok.push(`有 ${sched.waiting} 条任务在等用户回答/等后续回合（未归档）`)
          }
          if (sched.archiveRefused > 0) {
            issues.push(
              `有 ${sched.archiveRefused} 次归档被宿主以"会话仍有活动"拒绝 —— 说明待办判据漏判过，任务已退回等待`,
            )
          }
          if (sched.failed > 0) {
            issues.push(`有 ${sched.failed} 条任务失败，最近一次：${sched.lastError ?? '未知'}`)
          }
          if (sched.archiveFailed > 0) {
            issues.push(`有 ${sched.archiveFailed} 条任务会话归档失败（任务本身不受影响，但会话会堆在侧边栏）`)
          }
        }
      }

      if (corpusStore.disabled) issues.push('语料库不可用（目录不可写或已关闭采集）')
      else ok.push('语料库可用')

      // v3：交班与记忆的体检
      if (conversationOn && dsh) {
        const h = dsh.handoff?.snapshot()
        if (!h) {
          issues.push('常驻对话会话已开启，但交班监视器未就绪')
        } else {
          if (h.contextWindow > 0) {
            ok.push(
              `交班阈值 ${h.handoffAtRatio} × ${h.contextWindow} = ${Math.floor(h.contextWindow * h.handoffAtRatio)} token` +
                `（宿主压缩要到 ${h.compactionThresholdTokens} token 才动手，交班在先手）`,
            )
          } else {
            issues.push('还没有测量到 contextWindow —— 交班阈值算不出来，功能不会触发（等到第一个回合结束就会测）')
          }
          if (h.handoffAtRatio >= h.compactionThresholdRatio) {
            issues.push(
              `conversation.handoffAtRatio=${h.handoffAtRatio} 不低于宿主压缩阈值 ${h.compactionThresholdRatio}` +
                ' —— 压缩会先手把历史摘要掉',
            )
          }
          if (h.stats.failed > 0) issues.push(`有 ${h.stats.failed} 次交班流程异常，最近一次：${h.stats.lastError ?? '未知'}`)
          if (h.stats.archiveFailed > 0) {
            issues.push(`有 ${h.stats.archiveFailed} 次旧会话归档失败（交班仍完成，但旧会话会留在侧边栏）`)
          }
          if (h.stats.degraded > 0) {
            ok.push(`有 ${h.stats.degraded} 次交班走了降级路径（交接内容不完整，但记忆本身没丢）`)
          }
          if (h.stats.completed > 0) ok.push(`已完成 ${h.stats.completed} 次交班`)
          const frozen = h.frozenScopes ?? []
          if (frozen.length > 0) ok.push(`正在交班中：${frozen.join('、')}（这期间该会话的消息走 v2 兜底）`)
        }
        const mem = dsh.memory?.snapshot()
        if (mem) {
          ok.push(`常驻记忆 ${mem.count} 条碎片（文件 ${mem.file}，可查可删：qq_memory 工具）`)
          if (mem.stats.failures > 0) issues.push(`记忆落盘失败 ${mem.stats.failures} 次 —— 碎片可能没存住`)
        }
        const refused = dsh.gate?.snapshot?.().refused ?? 0
        if (refused > 0) {
          // 这是**好事**：说明守卫拦住了本该静默丢消息的投递
          ok.push(`投递守卫拦下 ${refused} 次"向已退役会话投递"（否则会静默丢消息）`)
        }
      } else if (!conversationOn) {
        ok.push('常驻对话会话未开启（conversation.enabled=false），行为与 v2 一致')
      }

      return { verdict: issues.length === 0 ? 'ok' : 'attention', issues, ok }
    }

    const statusBody = () =>
      JSON.stringify(
        {
          plugin: 'dsh-whale-inurqq',
          version: PLUGIN_VERSION,
          /**
           * 存活判定（v3.1）。
           *
           * 形状：`{alive, because[], reasons[], evidence{}, tasks{}}`
           *   - `alive`：必需判据**全过**才 true；任一条缺失即 false（绝不瞎报活着）
           *   - `because`：**凭什么**这么判 —— 活着时列出通过的判据与具体数值，
           *     不活着时逐条说明缺的是哪一条。一眼可核对，不用逐字段推
           *   - `evidence`：裸数值（静默多少毫秒、tick 多久前跑过、阈值是多少）
           *   - `tasks`：任务侧的独立结论；它**不参与** `alive`（理由见 lib/alive.js）
           */
          alive: liveProbe(),
          config: {
            mode: config.connection.mode,
            mount: config.connection.mount,
            path: config.connection.reversePath,
            port: config.connection.mount === 'own' ? config.connection.reversePort : null,
            authRequired: Boolean(auth.token),
            groupMode: config.participation.groupMode,
            workspaceRoot: config.tasks.workspaceRoot,
            maxConcurrent: config.tasks.maxConcurrent,
            settleGraceMs: config.tasks.settleGraceMs,
            taskPrefix: config.tasks.prefix,
            chatPrefix: config.tasks.chatPrefix,
            /**
             * v3.1：**取消不再由关键词驱动**，所以这里没有 cancelPrefix。
             * 控制意图由常驻会话理解后调 `qq_tasks(cancel_task_id)`；
             * 也就是说"停一下"这类话说得再随意也能停，而
             * "把这个任务停一下看看日志"不会被吃成停止命令。
             */
            /** v3：常驻对话会话是否开启（关闭时行为与 v2 逐字一致） */
            conversationEnabled: config.conversation.enabled,
            handoffAtRatio: config.conversation.handoffAtRatio,
            memoryBudgetTokens: config.conversation.memoryBudgetTokens,
          },
          warnings: config.warnings,
          connection: server?.snapshot() ?? null,
          pipeline: pipeline.snapshot(),
          bridge: dsh?.bridge.snapshot() ?? null,
          tasks: dsh?.scheduler?.snapshot() ?? null,
          relay: dsh?.relay.snapshot() ?? null,
          state: dsh?.state.snapshot() ?? null,
          corpus: corpusStore.snapshot(),
          /**
           * v3：**离交班还差多少**。
           *
           * 这是硬要求：没有它，用户永远不知道这个功能在工作 ——
           * 而 0.25 的阈值在 1M 窗口下也要 25 万 token 才触发。
           * 每个会话给出 `totalTokens / handoffThresholdTokens / ratio /
           * tokensToHandoff / progressPercent`，一眼可答"为什么还没触发"。
           */
          conversation: conversationOn
            ? {
                ...(dsh?.handoff?.snapshot() ?? { enabled: true, note: 'handoff-not-ready' }),
                memory: memoryStore?.snapshot() ?? null,
                gate: gate?.snapshot() ?? null,
                context: { name: CONTEXT_NAME, order: CONTEXT_ORDER, injectMode: config.conversation.injectMode },
              }
            : {
                enabled: false,
                note: 'conversation.enabled=false：行为与 v2 一致（规则分类器直接决定派活或闲聊）',
                handoffAtRatio: config.conversation.handoffAtRatio,
              },
          health: computeHealth(),
          now: Date.now(),
        },
        null,
        2,
      )

    const writeStatus = (res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(statusBody())
    }

    const buildServer = () => {
      server = new OneBotReverseServer({
        path: config.connection.reversePath,
        getToken: () => auth.token,
        isAuthReady: () => auth.ready,
        // 此前没传，于是 connection.callTimeoutMs 是个空转的设置项（连接层恒 15000）
        callTimeoutMs: config.connection.callTimeoutMs,
        log,
        onEvent,
      })
      return server
    }

    // ── 连接层：自建服务端（默认）─────────────────────────────────────
    const startOwnServer = () => {
      buildServer()
      ownServer = http.createServer((req, res) => {
        if (req.url === STATUS_PATH || req.url === '/status') {
          writeStatus(res)
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('dsh-whale-inurqq: not found')
      })
      ownServer.on('upgrade', (req, socket, head) => {
        // 每次接入都顺手刷新一次凭据：让设置里改过的 token 尽快生效（不影响本次校验）
        if (auth.refresh) void auth.refresh()
        if (server.matches(req)) {
          server.handleUpgrade(req, socket, head)
          return
        }
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
      })

      // 端口被占用（常见于残留进程）时自动重试，而不是永久失败。
      // 注意：error 监听器只挂一次 —— 每次重试都加一个会导致监听器泄漏。
      let attempt = 0
      let retryTimer = null
      const maxAttempts = 20
      const retryDelayMs = 2000

      const bind = () => {
        ownServer.listen(config.connection.reversePort, config.connection.host, () => {
          log.info(
            `[server] 反向 WS 就绪：ws://${config.connection.host}:${config.connection.reversePort}${config.connection.reversePath}`,
          )
          log.info(
            `[server] 状态查询：http://${config.connection.host}:${config.connection.reversePort}${STATUS_PATH}`,
          )
        })
      }

      ownServer.on('error', (err) => {
        if (err?.code === 'EADDRINUSE' && attempt < maxAttempts) {
          attempt += 1
          log.warn(
            `[server] 端口 ${config.connection.reversePort} 被占用（第 ${attempt}/${maxAttempts} 次），` +
              `${retryDelayMs / 1000} 秒后重试…`,
          )
          retryTimer = setTimeout(bind, retryDelayMs)
          if (typeof retryTimer.unref === 'function') retryTimer.unref()
          return
        }
        if (err?.code === 'EADDRINUSE') {
          log.error(
            `[server] 端口 ${config.connection.reversePort} 持续被占用，已放弃（尝试 ${attempt} 次）。` +
              `NapCat 将连不上 —— 请释放该端口或改 connection.reversePort。`,
          )
          return
        }
        log.error(`[server] HTTP 服务端错误: ${err?.code ?? ''} ${err?.message ?? err}`)
      })

      bind()

      disposers.push(() => {
        if (retryTimer) clearTimeout(retryTimer)
        try {
          ownServer?.close()
        } catch {
          /* 已关闭 */
        }
      })
    }

    // ── 连接层：挂在 DSH webServer 上 ─────────────────────────────────
    const startOnDshWebServer = (ctx) => {
      buildServer()
      disposers.push(
        ctx.webServer.registerUpgrade({
          path: config.connection.reversePath,
          handler: (req, socket, head) => {
            if (server && server.matches(req)) server.handleUpgrade(req, socket, head)
            else socket.destroy()
          },
        }),
      )
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: STATUS_PATH,
          handler: (_req, res) => writeStatus(res),
        }),
      )
      log.info(`[server] 已挂在 DSH webServer 的 ${config.connection.reversePath} 上`)
      log.info(`[server] 注意：NapCat 需指向 DSH 的端口，而不是 ${config.connection.reversePort}`)
    }

    // ① 连接层：只需要 webServer（用来挂状态路由 / dsh 模式）
    root.inject(['webServer'], (ctx) => {
      if (config.connection.mode === 'forward') {
        log.warn('[server] forward 模式尚未实现（当前只支持 reverse），连接不会建立')
      } else if (config.connection.mount === 'own') {
        startOwnServer()
      } else {
        startOnDshWebServer(ctx)
      }

      // access token 的解析。
      //
      // 两个必须遵守的点（来自 credentials 服务契约）：
      //  1. resolve() 返回的是 `{ value, source }` **对象**，不是字符串 ——
      //     早期版本写成 String(resolve(...))，会把 token 变成 "[object Object]"，
      //     导致 NapCat 鉴权 401（真机上因为走的是 config 兜底才没暴露）。
      //  2. 契约明确要求「每次操作重新解析，不要跨操作缓存」，
      //     否则用户在设置里改了 token 必须重启才生效。
      //     upgrade 回调是同步的，所以这里用「每次接入时刷新 + 定时刷新」来逼近该语义。
      const refreshToken = async () => {
        try {
          const creds = typeof ctx.get === 'function' ? ctx.get('credentials') : null
          if (!creds || typeof creds.resolve !== 'function') {
            if (!auth.token) log.warn('[auth] credentials 不可用且未配置 token —— 将不校验来源')
            return
          }
          const resolved = await creds.resolve(config.connection.tokenRef)
          const value = resolved?.value
          if (value) {
            const changed = auth.token !== String(value)
            auth.token = String(value)
            auth.source = resolved.source ?? 'credentials'
            if (changed) {
              log.info(
                `[auth] access token 已更新（来源 ${auth.source}，凭据键 ${config.connection.tokenRef}）`,
              )
            }
          } else if (!config.connection.token) {
            if (auth.token) log.warn('[auth] 凭据已清空，且未配置兜底 token —— 改为不校验来源')
            auth.token = ''
            auth.source = 'none'
          }
        } catch (err) {
          log.warn(`[auth] 读取凭据失败，沿用现有值: ${err?.message ?? err}`)
        } finally {
          // 无论成功失败都标记就绪：失败时沿用配置值（可能为空=不校验），
          // 但不能让连接永久被 503 挡住。
          auth.ready = true
        }
      }

      auth.refresh = refreshToken
      void refreshToken()
      // 定时刷新：让用户在设置里改 token 后无需重启
      const tokenTimer = setInterval(() => void refreshToken(), 60_000)
      if (typeof tokenTimer.unref === 'function') tokenTimer.unref()
      disposers.push(() => clearInterval(tokenTimer))
    })

    // ② DSH 桥接：需要 workspace + session 服务
    root.inject(['workspaceRegistry', 'sessionController'], (ctx) => {
      const state = new StateStore({ log, dir: config.stateDir || undefined })

      // ── v3：碎片记忆 + 交班 + 单点投递守卫 ──────────────────────────
      if (conversationOn) {
        memoryStore = new MemoryStore({
          log,
          dir: config.stateDir || undefined,
          thresholds: {
            mergeJaccard: config.conversation.fragmentMergeJaccard,
            askJaccard: config.conversation.fragmentAskJaccard,
          },
        })
        scopeResolver = new ScopeResolver({ state })
      }

      const bridge = new DshBridge({
        ctx,
        config,
        log,
        state,
        gate: gate ?? undefined,
        // 用户消息投递成功 → 告诉交班"交接文本已经和这句话同批交付了"（见 handoff.js）。
        // 用闭包读 `handoff`：它在本函数稍后才被构造。
        onUserPrompt: (sessionId) => handoff?.noteUserDelivery(sessionId),
      })
      /**
       * 任务调度器（并发槽位 / 排队 / 收敛 / 归档）。
       *
       * ⚠️ **只在 v2 回滚路径上装配**（`conversation.enabled=false`）。
       *    新逻辑链条下默认路径不再新建任务会话，所以它整条退出默认路径：
       *    `qq_dispatch` 不注册、`qq_tasks` 的台账恒为空、状态端点里 `tasks` 为 null。
       *    代码留着是刻意的 —— 它是那个回滚开关的实现，也是 159 条 v2 断言的对象。
       * @type {TaskScheduler | null}
       */
      const scheduler = conversationOn
        ? null
        : new TaskScheduler({
            config,
            log,
            state,
            bridge,
            // 待办判据：决定一条任务能不能收敛（真实契约见 pending.js 顶部）
            assess: (sessionId, hints) => assessSessionWork({ ctx, log }, sessionId, hints),
          })
      const relay = new ProgressRelay({
        bridge,
        log,
        send,
        flushIntervalMs: config.relayFlushMs,
        // 顺序很重要：relay 先把这一轮的正文回传完，才回调调度器收敛/归档
        onSettled: scheduler ? (sessionId, reason) => scheduler.settleSession(sessionId, reason) : null,
        // 新回合 = 会话又被续上了：撤销已经排队的收敛确认，别在两个回合的缝里归档
        onTurnStart: scheduler ? (sessionId, turn) => scheduler.noteTurnStart(sessionId, turn) : null,
      })
      if (scheduler) {
        scheduler.setRelay(relay)
        // 上次进程留下的 queued/running 永远不会再有终态事件，必须先收敛，
        // 否则它们会永久占住并发槽位（新任务只能排队）
        scheduler.recover()
      }

      // ── v3：交班监视器（挂在 relay 已经在订阅的同一个事件流上）──────
      if (conversationOn && memoryStore && scopeResolver) {
        handoff = new ConversationHandoff({
          ctx,
          config,
          log,
          bridge,
          state,
          memory: memoryStore,
          relay,
          gate,
          resolver: scopeResolver,
          // 交班走完（解冻）后，把冻结期攒下的消息按原顺序补投进新会话
          onUnfreeze: () => {
            try {
              drainFrozenQueue()
            } catch (err) {
              log.error(`[chat] 冻结期队列补投失败: ${err?.stack ?? err}`)
            }
          },
          notify: (chatType, chatId, text) => relay.notify(chatType, chatId, text),
        })
        // 只关心常驻会话的 turn/end —— 任务会话由 scheduler 管，交班不碰它们
        disposers.push(
          ctx.on('session/event', (session, event) => {
            if (event?.type !== 'turn/end') return
            try {
              handoff.onTurnEnd(String(session?.id ?? ''), event?.data?.reason)
            } catch (err) {
              log.error(`[handoff] onTurnEnd 失败: ${err?.stack ?? err}`)
            }
          }),
        )
        log.info('[handoff] 已订阅 session/event（只处理常驻会话的 turn/end）')

        // 启动时清一次过期交接束（之后每 6 小时一次）
        try {
          handoff.pruneLedgers()
        } catch (err) {
          log.warn(`[handoff] 启动清理交接束失败: ${err?.message ?? err}`)
        }
        const ledgerTimer = setInterval(() => {
          try {
            handoff?.pruneLedgers()
          } catch {
            /* 忽略 */
          }
        }, 6 * 60 * 60 * 1000)
        if (typeof ledgerTimer.unref === 'function') ledgerTimer.unref()
        disposers.push(() => clearInterval(ledgerTimer))

        // 崩溃恢复：上次交班"切换了映射但归档失败"的旧会话，补一次（幂等）
        for (const repair of state.pendingArchiveRepairs()) {
          void bridge
            .archiveSession(repair.sessionId)
            .then(() => {
              gate.retire(repair.sessionId, { why: 'handoff-repair', by: 'startup' })
              log.info(`[handoff] 已补归档上次未归档的旧会话 ${repair.sessionId}（${repair.key}）`)
            })
            .catch((err) => log.warn(`[handoff] 补归档 ${repair.sessionId} 失败: ${err?.message ?? err}`))
        }

        // 崩溃恢复：上次交班卡在"旧会话已归档、映射还没切"这一小段窗口里。
        //
        // 这是交班唯一会造成**静默丢消息**的残留：映射还指着已经归档的会话，
        // 而归档不报错、不通知（宿主在 pre-step 静默 reject）。所以这里必须
        // 主动把它判成"坏了"：退役那台会话 + 清掉绑定，让下一条消息惰性重建。
        for (const stale of state.pendingHandoffRecoveries()) {
          gate.retire(stale.sessionId, { why: 'handoff-interrupted', by: 'startup' })
          state.setRootSession(stale.chatType, stale.chatId, '')
          state.clearHandoffPending(stale.chatType, stale.chatId)
          log.warn(
            `[handoff] 上次交班没走完（${stale.key}：第 ${stale.gen} 代，旧会话 ${stale.sessionId} 已归档但映射没切）` +
              '—— 已清掉绑定，下一条消息会重建常驻会话',
          )
        }
      }

      // 让 DSH 的设置页按 Config Schema 自动生成本插件的表单
      const settings = typeof ctx.get === 'function' ? ctx.get('settings') : null
      if (settings && typeof settings.configure === 'function') {
        try {
          disposers.push(settings.configure({ auto: true }))
          log.info('[settings] 已注册自动设置页（依据 Config Schema 生成）')
        } catch (err) {
          log.warn(`[settings] 注册自动设置页失败: ${err?.message ?? err}`)
        }
      } else {
        log.info('[settings] settings 服务不可用，跳过自动设置页')
      }

      dsh = { bridge, relay, state, scheduler, memory: memoryStore, handoff, gate, resolver: scopeResolver }

      // 测试钩子：把投递守卫暴露给集成测试。
      //
      // 为什么必须这么做：真实语义下"往已退役会话投递**被拒绝**"与"**被静默吞掉**"
      // 在外部观察者看来完全一样（都不抛错、都没有返回值）—— 只靠端到端断言
      // 根本区分不出守卫到底有没有生效。所以测试必须能直接调它。
      // 只在有全局钩子时挂（测试进程），生产环境里 `globalThis.__dshqq_onGate` 不存在。
      if (conversationOn && typeof globalThis.__dshqq_onGate === 'function') {
        try {
          globalThis.__dshqq_onGate(gate)
        } catch {
          /* 钩子失败不影响插件 */
        }
      }

      // 测试钩子：把"投一条用户消息到常驻会话"的**真实入口**暴露出去。
      //
      // 为什么需要：受控假宿主会对同一发送者限频（retcode 1200），
      // 而交班断言需要在很短的墙钟时间里对同一个 QQ 号连发多条。
      // 直接调这条入口既能走完整真实代码路径（含 DeliveryGate），又不吃限流。
      if (conversationOn && typeof globalThis.__dshqq_onChat === 'function') {
        try {
          globalThis.__dshqq_onChat((input) => bridge.deliverChat({ ...input, by: 'test:direct-chat' }))
        } catch {
          /* 钩子失败不影响插件 */
        }
      }

      disposers.push(relay.attach(ctx))
      disposers.push(() => relay.dispose())
      if (scheduler) disposers.push(() => scheduler.dispose())

      // 给 agent 的 QQ 工具（tools 是可选服务：没有也不影响派活与回传）
      try {
        disposers.push(
          ...registerQqTools({
            ctx,
            config,
            log,
            send,
            corpus: corpusStore,
            /**
             * 只列出 scope 允许的会话。
             *
             * ⚠️ 早先这里返回**全部**已接入会话（含工作区路径），而 agent 是被不可信
             *    QQ 文本驱动的 —— 它只要问一句就能枚举出别人所有会话的 chatId，
             *    再用那些 chatId 去调 qq_history / qq_memory。scope 配置了却挡不住
             *    枚举，等于没配。`scope.groups/friends` 为空数组（默认）时
             *    `inScope` 恒真 = 行为与从前完全一致。
             */
            listChats: () =>
              state
                .entries()
                .map(([key, v]) => ({
                  chatType: v.chatType ?? key.split(':')[0],
                  chatId: v.chatId ?? key.split(':').slice(1).join(':'),
                  chatName: v.chatName ?? '',
                  workspacePath: v.workspacePath ?? '',
                }))
                .filter((c) => inScope(config, c.chatType, c.chatId)),
            // 任务台账：常驻会话靠它回答"我给这个 QQ 会话派过哪些任务、跑完没"
            listTasks: ({ chatType, chatId, limit } = {}) => {
              if (chatType && chatId) return state.listTasks(chatType, chatId, limit ?? 20)
              const all = state.allTasks(limit ?? 20)
              if (!chatType) return all
              return all.filter((t) => t.chatType === chatType)
            },
            cancelTask: scheduler
              ? ({ chatType, chatId, target }) => scheduler.cancel({ chatType, chatId, target, by: 'tool' })
              : undefined,
            // ── 只在 v2 回滚路径上提供 `qq_dispatch`（派活给独立任务会话）──
            //
            // ⚠️ **新逻辑链条下这个工具不存在**：干活就在常驻对接会话里做，
            //    没有"独立任务会话"可派 —— 保留它等于把刚废除的行为从工具口放回来。
            //    关掉常驻对话会话（`conversation.enabled=false`）时它照旧可用，
            //    那时 `TaskScheduler` 也照旧装配，v2 的并发/排队/取消断言继续有效。
            //
            // ⚠️ **不要在这里调 `bridge.buildPromptText()`**：
            //    `scheduler.submit()` → `#pump()` → `#start()` 内部会自己包一次来源标注
            //    （见 `lib/dsh/tasks.js` 的 `#start` 里那次 `buildPromptText` 调用）。
            //    包两次的结果是正文里出现两行
            //    「[来自 QQ 私聊，发言人 …]」，任务会话看到的就是一段自相矛盾的来源说明。
            dispatchTask: scheduler
              ? async ({ chatType, chatId, text: rawText }) =>
                  scheduler.submit({
                    chatType,
                    chatId,
                    chatName: state.get(chatType, chatId)?.chatName,
                    text: String(rawText ?? ''),
                    // 让任务会话知道"这句话是常驻对话会话替你派的"，而不是用户亲口说的
                    senderName: '对话会话（qq_dispatch 派发）',
                    messageId: '',
                  })
              : undefined,
            memory: conversationOn ? memoryStore : undefined,
            // ── v3.1：存活检测与真实状态 ────────────────────────────────
            //
            // 为什么把 `liveProbe` 交给工具而不是让工具自己去取服务：
            // 它要综合**连接层 + 事件循环 + 任务侧**三样东西，而这三样分别属于
            // 本函数的闭包与 DSH 服务。收在一处（lib/alive.js 的判据）才能保证
            // 状态端点与工具说的是同一句话 —— 两边口径不一致比不报更糟。
            liveProbe,
            // 写碎片时要知道"现在是第几代"（老化判据用 lastSeenGen）。
            // 拿不到就给 0 = 享受最大宽限期，绝不误伤用户手动记住的东西。
            memoryGeneration: ({ chatType, chatId } = {}) => ({
              value: Number(state.get(chatType, chatId)?.rootGeneration ?? 0) || 0,
            }),
          }),
        )
      } catch (err) {
        log.warn(`[tools] 注册失败（不影响派活）: ${err?.message ?? err}`)
      }

      for (const w of readyWaiters.splice(0)) {
        try {
          w()
        } catch {
          /* 忽略 */
        }
      }
      log.info(
        scheduler
          ? `[bridge] DSH 桥接就绪（workspace + 常驻会话 + 任务调度，maxConcurrent=${scheduler.maxConcurrent}）`
          : '[bridge] DSH 桥接就绪（workspace + 常驻对接会话；任务会话已退出默认路径）',
      )
    })

    // ③ v3：常驻记忆注入（全局注册 + 按 ctx.agent.id 分流）
    //
    // 单独一个 inject 块：它需要 systemPrompt，但**不**需要 workspace/session
    // —— 拆开之后即使桥接还没就绪，注入注册也已经完成（注册本身不依赖会话存在）。
    if (conversationOn) {
      root.inject(['systemPrompt'], (ctx) => {
        if (!memoryStore || !scopeResolver) {
          log.warn('[context] 记忆仓库未就绪，跳过常驻记忆注入')
          return
        }
        const disposeMemory = registerResidentMemory({
          ctx,
          memory: memoryStore,
          log,
          scopeForSession: (sessionId) => scopeResolver.resolve(sessionId),
          policy: () => ({
            budgetTokens: config.conversation.memoryBudgetTokens,
            injectMode: config.conversation.injectMode,
          }),
        })
        disposers.push(disposeMemory)

        // ── 前台行为约定（先追问再派活 / 查真实状态 / 说停就停）──────────
        //
        // 注册成 `systemPrompt.section`：固定行为约定，不是每步重算的上下文快照。
        // 只对常驻会话生效（任务会话由 scopeForSession 返回空串筛掉）。
        const disposeFrontDesk = registerFrontDesk({
          ctx,
          log,
          scopeForSession: (sessionId) => scopeResolver.resolve(sessionId),
        })
        disposers.push(disposeFrontDesk)
      })
    }

    root.effect(() => () => {
      if (pruneTimer) clearInterval(pruneTimer)
      for (const d of disposers) {
        try {
          d()
        } catch (err) {
          log.warn(`[dispose] ${err?.message ?? err}`)
        }
      }
      disposers.length = 0
      // 存活观测器的计时器必须显式清掉：它虽然 unref 过，但留着会持续读到空连接
      try {
        liveness.dispose()
      } catch {
        /* 忽略 */
      }
      if (server) void server.closeAll().catch(() => {})
      dsh = null
      log.info('已卸载')
    })
  },
}

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ')
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 把派活失败翻译成用户能据以行动的一句话。
 *
 * 起因：真机上一次失败只回了「任务受理失败：…」加一句框架内部措辞（英文），
 * 定位它花掉了大量考古工作。失败必须自解释 —— 用户和下一个维护者都该一眼看懂。
 * @param {any} err
 */
function describeFailure(err) {
  const msg = String(err?.message ?? err ?? '未知错误')
  const code = err?.code ?? err?.retcode
  const head = code ? `❌ 任务受理失败 [${code}]` : '❌ 任务受理失败'

  if (msg.includes('session.create accepts')) {
    return `${head}\n插件参数有误：建会话时不能同时指定 workspaceId 与 cwd。这是插件 bug，请反馈。`
  }
  if (msg.includes('workspace/not-found')) {
    return `${head}\n工作区没找到，可能已被删除。删掉 qq-projects 下的对应目录后会重建。`
  }
  if (msg.includes('session/not-found')) {
    return `${head}\n会话已失效。再发一次这条消息即可重建。`
  }
  if (msg.includes('not fully qualified')) {
    return (
      `${head}\n工作区父目录必须是完全限定路径（如 D:\\qq-projects），当前值不是。` +
      '请在 设置 → 插件 → dsh-whale-inurqq 里改成绝对路径。'
    )
  }
  if (msg.includes('workspaceRoot')) {
    return `${head}\n插件还没配置 tasks.workspaceRoot（工作区父目录），任务无处落盘。请在 DSH 设置里补上。`
  }
  if (msg.includes('gateway/bad-request')) {
    return `${head}\n参数被 DSH 拒绝：${truncate(msg, 200)}（可能是插件版本与 DSH 不匹配，请反馈）`
  }
  if (msg.includes('OneBot') || msg.includes('连接')) {
    return `${head}\nQQ 连接不可用：${truncate(msg, 150)}`
  }
  return `${head}\n${truncate(msg, 300)}`
}
