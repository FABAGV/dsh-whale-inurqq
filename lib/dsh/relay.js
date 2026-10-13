/**
 * 进度回传：DSH 会话事件 → QQ 消息。
 *
 * 设计要点：
 *  - 只回传「映射到 QQ 会话」的那些 session，其余一概不看（`StateStore.findBySession` 反查）。
 *  - 节流合并：高频事件不逐条刷屏
 *  - 保证终态必达：turn/end 一定 flush
 *  - **先回传，再收敛**：turn/end 的 flush `await` 完成后才回调 onSettled，
 *    调度器在那之后才会归档 session（见 tasks.js）。顺序反了就会出现
 *    "结果还没发出去，会话已经被归档"的丢消息。
 *  - 任务 session 的正文带 `【#编号】` 前缀（v2 路径：同一会话里可能有好几条任务在并行跑，
 *    不带编号的话用户根本分不清哪条消息属于哪个任务）。
 *
 * ## 规则 2：回传的判据是「这个回合是谁发起的」
 *
 * 一个 QQ 会话现在只有一个**常驻对接会话**，聊天和干活都在它里面。而它同时也会被
 * 用户在 DSH GUI 里直接打开、直接说话 —— 那种回合一回都不许推给 QQ。
 *
 * 判据**不是**"用户在不在电脑前"（那是猜），而是宿主自己记下的事实：
 * 插件投递的 prompt 带 `requestId`（`lib/dsh/bridge.js` 的 `promptSession`），
 * 宿主把它写进 `user/message` 的 `source.rpcId`
 * （`dsh-api-session-controller/lib/index.js:856-859`、
 *  `dsh-agent-loop/lib/index.js:1061`）。于是：
 *
 * | 这个回合的开头那条 `user/message` | 结论 |
 * |---|---|
 * | `source.rpcId` ∈ 插件发出的 id 集合 | **插件发起的** → 照常回传 QQ |
 * | 不命中（例如 GUI 里用户自己发的） | **GUI 发起的** → 这个回合一个字都不回传 |
 *
 * 一个回合的正文只按**开头那条**用户消息定型（`turn/start` 之后 `pre-step` 里
 * 落盘的那条），所以用"回合开头的来源"而不是"最近一条消息的来源"。
 *
 * ## 「它动了什么」的两个信号源
 *
 * | 信号 | 来源 | 它证明什么 |
 * |---|---|---|
 * | `deliverables/presented` | `dsh-tool-present` 在 `tools/result` 之后 `session.append`（`lib/index.js:112-120`；事件形状 `lib/types/types.d.ts:13-18`） | **agent 自己声明**"这是我要交付的东西"，最可信 |
 * | 写类工具的 `tool/call` + 配对的 `tool/result` | `tool/call` 的 `arguments` 里带 `file_path` / `path` | 某次写操作**成功结束了**（`isError !== true`） |
 *
 * 第二路为什么要等 `tool/result`：只看 `tool/call` 会把**失败**的写也算进去
 * （编辑没匹配上、路径越权被拒都会走到 tool/call）。配对之后才敢说"它动过"。
 *
 * ⚠️ 覆盖面必须说清楚：`pwsh`/`bash` 里 `Set-Content` 之类的写**认不出来**
 * （参数里没有明确路径，命令文本不该被正则解析）。所以回传里给的是
 * "**工具确认改过的文件**"，不是"文件系统真实 diff"。措辞上不许夸大。
 *
 * ## 不回传"还在跑"
 *
 * 这里**没有**周期性「🔧 执行中…」这一句了（也没有任何等价形式）。
 * 一个回合里的中间态**一律安静**：有正文就发正文，动过文件就列文件，
 * 两样都没有就什么都不发。进度靠问（常驻会话用 `qq_alive` + `qq_tasks` 查真实状态，
 * 见 lib/dsh/frontdesk.js 的约定）。
 */

const FLUSH_INTERVAL_MS = 2000
const MAX_CHUNK = 1200

/**
 * 一次回传里最多列几个文件。
 *
 * 为什么要有上限：一条任务可能写了上百个小文件，全列出来会把回传变成刷屏，
 * 用户反而看不到结论。超出时明说"还有 N 个没列"—— 不静默截断。
 */
const MAX_FILES_LISTED = 12

/**
 * 写类工具的允许清单：工具名 → 从 `arguments` 里取路径的字段。
 *
 * ⚠️ **允许清单而不是启发式**：只认这些"名字就说明它在写文件"的工具。
 * 宁可漏（pwsh 里写的文件认不出来，措辞上也不夸大），也不要认错
 * —— 把 `read` 的 `file_path` 当成"改了它"是最伤信任的一类假情报。
 *
 * 依据（真实工具 schema）：
 *   - `write` / `edit`：`{file_path, ...}`（`dsh-tool-fs/lib/types/write.d.ts:16-22`、`edit.d.ts:23-28`）
 *   - 别的名字按同样的 `file_path` 约定收进来，取不到就自动跳过
 */
const WRITE_TOOLS = new Map([
  ['write', 'file_path'],
  ['edit', 'file_path'],
  ['create_file', 'file_path'],
  ['write_file', 'file_path'],
  ['str_replace_editor', 'path'],
])

/** `str_replace_editor` 只有这几个 command 是写操作（view 是只读） */
const MUTATING_COMMANDS = new Set(['create', 'str_replace', 'insert', 'undo_edit'])

/** 安全解析 `tool/call.arguments`（模型给的**原始 JSON 字符串**，可能是任意垃圾） */
function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw
  const text = String(raw ?? '').trim()
  if (!text) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    // 模型偶尔给出截断的 JSON —— 这不是异常路径，安静地不提取即可
    return null
  }
}

/**
 * `tool/result` 里"这次调用是谁"的取值。
 *
 * ⚠️ 真名是 `message.toolCallId`。宿主 `dsh-llm` 的 `createToolResultMessage`
 * 造出来的是 `{ role:'tool', source:{ kind:'tool', callId }, toolCallId, content, isError }`
 * —— 消息对象上**没有**顶层 `callId`。早先读 `message.callId` 恒为空串，于是
 * `pendingWrites` 里的键（`tool/call` 侧用真实 callId 登记）永远匹配不上，
 * 「它动过哪些文件」整条清单恒为空。
 *
 * 两个来源都兜：`toolCallId` 是当前形状，`source.callId` 是它的另一处落点。
 *
 * ⚠️ 别再把顶层 `callId` 加回来当兜底。测试里的假宿主一度把
 *    `createToolResultMessage` 的**入参**（`{callId, content, isError}`）当成消息本身，
 *    于是 message 上有个真实世界不存在的 `callId` —— 插件读它、fake 发它，
 *    两边"自洽"，断言全绿，而真机上恒为空。那是**测试把 bug 冻住**，
 *    不是"防御性兼容"。fake 已按真实产出一并修正（`tools/test-entry.mjs` 的
 *    `emitToolResult`），两边现在都对着 `dsh-llm/lib/index.js:101-112`。
 */
export function toolResultCallId(message) {
  return String(message?.toolCallId ?? message?.source?.callId ?? '')
}

/** 从一次工具调用里取"它要写的文件路径"；不是写类工具或取不到就返回 '' */
export function filePathFromToolCall(name, rawArguments) {
  const field = WRITE_TOOLS.get(String(name ?? ''))
  if (!field) return ''
  const args = parseArguments(rawArguments)
  if (!args) return ''
  if (field === 'path') {
    const command = String(args.command ?? '')
    if (command && !MUTATING_COMMANDS.has(command)) return ''
  }
  const value = args[field]
  return typeof value === 'string' ? value.trim() : ''
}

/** 从 `deliverables/presented` 的 data 里取文件（形状见 dsh-tool-present/lib/types/types.d.ts） */
export function filesFromPresented(data) {
  const out = []
  for (const f of Array.isArray(data?.files) ? data.files : []) {
    const p = typeof f?.path === 'string' ? f.path.trim() : ''
    if (p) out.push({ path: p, description: typeof f?.description === 'string' ? f.description.trim() : '' })
  }
  return out
}

/** 短路径：只留最后两段，避免长路径把回传刷满 */
function shortPath(p) {
  const parts = String(p ?? '').split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return String(p ?? '')
  return `…/${parts.slice(-2).join('/')}`
}

/** 把收集到的文件渲染成回传里的一段 */
function renderFiles(files, { delivered }) {
  const list = [...files]
  if (list.length === 0) return ''
  // 交付物优先展示（那是 agent 自己声明的重点），其余按路径稳定排序
  list.sort((a, b) => {
    if (a.delivered !== b.delivered) return a.delivered ? -1 : 1
    return a.path.localeCompare(b.path)
  })
  const shown = list.slice(0, MAX_FILES_LISTED)
  const lines = shown.map((f) => `· ${shortPath(f.path)}${f.delivered ? '（交付物）' : ''}`)
  if (list.length > shown.length) lines.push(`· …还有 ${list.length - shown.length} 个没列`)
  const head = delivered ? '📦 它动过这些文件：' : '📝 它动过这些文件：'
  return `${head}\n${lines.join('\n')}`
}

/** 从 assistant 消息里抽出纯文本 */
function extractText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** TurnEndReason → 人话 */
function describeEnd(reason) {
  switch (reason?.kind) {
    case 'completed':
      return null // 正常的完成不需要额外说明
    case 'aborted':
      return `已中止（${reason.reason?.kind ?? 'unknown'}）`
    case 'blocked':
      return '已阻塞'
    case 'error':
      return `出错：${reason.error?.message ?? '未知错误'}`
    case 'max-tokens':
      return '达到输出上限'
    case 'interrupted':
      return '被新消息打断'
    case 'forked':
      return '已分叉'
    default:
      return reason?.kind ? `结束：${reason.kind}` : '结束'
  }
}

function splitChunks(text) {
  if (text.length <= MAX_CHUNK) return [text]
  const out = []
  for (let i = 0; i < text.length; i += MAX_CHUNK) out.push(text.slice(i, i + MAX_CHUNK))
  return out
}

/** agent/error 的 error 是 unknown，可能是 Error、字符串或任意值 */
function truncateErr(error) {
  const text =
    error instanceof Error
      ? (error.message || error.name || '未知错误')
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error) ?? String(error)
            } catch {
              return String(error)
            }
          })()
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

export class ProgressRelay {
  /**
   * @param {object} opts
   * @param {import('./bridge.js').DshBridge} opts.bridge
   * @param {ReturnType<import('../log.js').createLogger>} opts.log
   * @param {(chatType:'private'|'group', chatId:string, text:string) => Promise<void>} opts.send
   * @param {number} [opts.flushIntervalMs]
   * @param {(sessionId:string, reason:any) => Promise<void>|void} [opts.onSettled]
   *   某个 session 的一个回合已经**回传完毕**之后的回调（任务调度器用它收敛/归档）
   * @param {(sessionId:string, turn:number) => void} [opts.onTurnStart]
   *   某个 session 开了新回合。调度器用它让 waiting 的任务回到 running，
   *   并**取消已排队的收敛确认** —— 关键：绝不能在两个回合之间的缝里归档。
   */
  constructor({ bridge, log, send, flushIntervalMs = FLUSH_INTERVAL_MS, onSettled = null, onTurnStart = null }) {
    this.bridge = bridge
    this.log = log
    this.send = send
    this.flushIntervalMs = flushIntervalMs
    this.onSettled = onSettled
    this.onTurnStart = onTurnStart
    /**
     * @type {Map<string, {chat:any, sessionId:string, pending:string[], timer:NodeJS.Timeout|null,
     *   turn:number, files:Map<string,{path:string,delivered:boolean}>,
     *   pendingWrites:Map<string,string>, pendingDeliveries:Map<string,Array<any>>}>}
     */
    this.buffers = new Map()
    /**
     * 每个 session 当前回合的**来源**（规则 2 的判据落点）。
     *
     *   'plugin'  — 这个回合由本插件发起（QQ 来的话）→ 照常回传
     *   'foreign' — 不是本插件发起的（用户在 DSH GUI 里自己说话）→ 一个字都不回传
     *   'unknown' — 还没在会话日志里看到定型的 `user/message`（例如只被
     *               `agent.inject()` 唤醒、或事件顺序上先到 turn/start）
     *
     * ⚠️ 回合的状态机是**先 turn/start、后 user/message**：真实 agent loop 在
     *    `turn()` 里先 `append('turn/start')`（`dsh-agent-loop/lib/index.js:943`），
     *    再到 `pre-step` 的 `step()` 里 `append('user/message')`（`:1061`）。
     *    所以 turn/start 时来源通常是 unknown，定型发生在紧随其后的 user/message。
     *    两者都在任何正文之前，正文不会因此漏判。
     * @type {Map<string, 'plugin'|'foreign'|'unknown'>}
     */
    this.turnProvenance = new Map()
    /**
     * 未决审批：sessionId → Map<approvalRequestId, toolName>。
     * 数据来自会话日志里成对写入的审计事件（`approval/asked` / `approval/decided`，
     * 见 `dsh-user-approval/lib/types/types.d.ts` 27-52 行）——
     * 这是"有没有未决审批"的**持久**判据，不依赖内存里的请求对象。
     */
    this.pendingApprovals = new Map()
    this.stats = {
      events: 0,
      relayed: 0,
      dropped: 0,
      settled: 0,
      approvalsAsked: 0,
      approvalsDecided: 0,
      /** v3.1：见过多少个"工具确认动过"的文件（同一路径只计一次） */
      filesSeen: 0,
      /** v3.1：收到过多少个 `deliverables/presented` 声明的文件 */
      deliverablesSeen: 0,
      /**
       * 规则 2：因为"这个回合不是插件发起的"而整个跳过的会话事件数
       *
       * ⚠️ 口径说明：`turn/start` **不**计进这一栏 —— 它排在来源守卫之前处理（见
       * `#onEvent`），因为"新回合开始了"这件事与回合来源无关（谁发起的都要重置文件
       * 清单、都要通知调度器）。于是 GUI 回合的 `turn/start` 现在计进 `events`。
       * 别把它读成"这一栏漏报了一个事件"：它统计的是**被守卫挡掉**的那些。
       */
      skippedForeign: 0,
      /** 规则 2：判定过多少次回合来源 */
      provenanceDecided: 0,
      /** 规则 2：有多少次来源判成了 unknown（只应出现在 inject 唤醒这类场景） */
      provenanceUnknown: 0,
    }
  }

  /** 订阅会话事件流 */
  attach(ctx) {
    const off = ctx.on('session/event', (session, event) => {
      try {
        this.#onEvent(session, event)
      } catch (err) {
        this.log.error(`[relay] 事件处理失败: ${err?.stack ?? err}`)
      }
    })
    this.log.info('[relay] 已订阅 session/event')

    // `agent/error` 是 **cordis 事件**，不是 session 事件类型：
    //   'agent/error'(this: Scoped<Agent>, payload: { agent, turn, step, error })
    // 它的 payload 里没有 session/event 那套 `{type, seq, data}` 结构，
    // 所以必须单独订阅。宿主对它的说明是「即使这次失败在回合内没有可写持久记录的位置，
    // 也会在这里上报」—— 正是最需要回传的一类失败。
    const offAgentError = ctx.on('agent/error', (payload) => {
      try {
        const sessionId = String(payload?.agent?.session?.id ?? payload?.agent?.id ?? '')
        if (!sessionId) return
        const chat = this.bridge.chatForSession(sessionId)
        if (!chat) return
        // 规则 2：只有"本插件发起的"回合才回传。还没定型（unknown）时**不回传** ——
        // 一个来源不明的错误宁可漏报，也不能把 GUI 里用户自己那一摊推到 QQ 上。
        if (this.#provenanceOf(sessionId) !== 'plugin') {
          this.stats.skippedForeign += 1
          return
        }
        const buf = this.#bufferFor(sessionId, chat)
        buf.pending.push(`❌ 执行出错：${truncateErr(payload?.error)}`)
        this.stats.events += 1
        void this.#flush(sessionId, true)
      } catch (err) {
        this.log.error(`[relay] agent/error 处理失败: ${err?.stack ?? err}`)
      }
    })
    this.log.info('[relay] 已订阅 agent/error')

    return () => {
      try {
        off()
      } catch {
        /* 忽略 */
      }
      try {
        offAgentError()
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 规则 2 的判据：这个会话**当前回合**是谁发起的。
   *
   * `user/message` 一出现就定型（见 `#decideProvenance`），所以正文事件到达时
   * 这里已经有了答案。unknown 一律按"不回传"处理。
   */
  #provenanceOf(sessionId) {
    return this.turnProvenance.get(sessionId) ?? 'unknown'
  }

  /**
   * 用一条 `user/message` 给**当前回合**定型。
   *
   * 为什么只认"这个回合的第一条用户消息"：一个回合里可能有好几条 `user/message`
   * （`pre-step` 每次 claim 都落盘），后面那些属于同一个回合，不该改写它的来源。
   * 而"插件投递"与"GUI 投递"在宿主的 inbox 里是**各自一条消息**，回合开头那条
   * 就是发起这个回合的那句话。
   *
   * @param {string} sessionId
   * @param {any} message `event.data.message`
   * @returns {'plugin'|'foreign'|null} 定型结果；null = 这条不参与定型
   */
  #decideProvenance(sessionId, message) {
    const source = message?.source
    if (source?.kind !== 'user') return null
    const rpcId = typeof source.rpcId === 'string' ? source.rpcId : ''
    const decided = rpcId && this.bridge.isPluginRequest?.(sessionId, rpcId) === true ? 'plugin' : 'foreign'
    this.turnProvenance.set(sessionId, decided)
    this.stats.provenanceDecided += 1
    if (decided === 'foreign') {
      // 这个回合一个字都不回传：把之前可能攒下的东西一并丢掉
      const stale = this.buffers.get(sessionId)
      if (stale) {
        if (stale.timer) clearTimeout(stale.timer)
        stale.timer = null
        stale.pending.length = 0
        stale.files.clear()
        stale.pendingWrites.clear()
        stale.pendingDeliveries.clear()
      }
      this.log.debug(`[relay] ${sessionId} 这个回合不是插件发起的（rpcId=${rpcId || '(无)'}）→ 不回传 QQ`)
    }
    return decided
  }

  #onEvent(session, event) {
    const sessionId = String(session?.id ?? '')
    if (!sessionId) return

    // 只关心有 QQ 归属的会话
    const chat = this.bridge.chatForSession(sessionId)
    if (!chat) return

    const type = event?.type

    // ── 规则 2：来源定型（必须在任何正文之前处理）───────────────────────
    if (type === 'user/message') {
      this.stats.events += 1
      this.#decideProvenance(sessionId, event.data?.message)
      return
    }
    // 新回合开始：来源重新进入未定型状态，等这个回合的 user/message 来定。
    //
    // ⚠️ **必须在这里就处理掉并 return，不能只置个标记往下走**：这一条自己的作用
    //    就是把来源清成 `unknown`，而紧接着的来源守卫判的就是 `!== 'plugin'` ——
    //    于是守卫必然把它自己挡掉，下面 `switch` 里的 `case 'turn/start'` 变成
    //    永不执行的死代码，连带 `onTurnStart` → `scheduler.noteTurnStart` →
    //    `#clearSettleTimer` 一起失效（那是取消"收敛确认窗"的唯一入口）。
    //
    //    而且"新回合开始了"这件事本身与回合来源无关：**谁发起的都该重新收集文件
    //    清单，也都该让调度器知道这个会话又续上了**。所以它排在守卫之前。
    if (type === 'turn/start') {
      this.turnProvenance.set(sessionId, 'unknown')
      this.stats.events += 1
      const startBuf = this.#bufferFor(sessionId, chat)
      startBuf.turn = event.data?.turn ?? startBuf.turn + 1
      // 新回合 = 上一回合的文件清单已经回传过（或随终态发出），重新开始收集
      startBuf.files.clear()
      startBuf.pendingWrites.clear()
      startBuf.pendingDeliveries.clear()
      // 新回合 = 这个会话又被续上了。调度器据此①让 waiting 回到 running，
      // ②撤销已经排队但还没执行的"收敛确认"（见 tasks.js#noteTurnStart）
      try {
        this.onTurnStart?.(sessionId, startBuf.turn)
      } catch (err) {
        this.log.warn(`[relay] onTurnStart 处理失败: ${err?.message ?? err}`)
      }
      return
    }
    // 不是本插件发起的回合：一个事件都不回传（GUI 里用户自己那一摊与 QQ 无关）
    if (this.#provenanceOf(sessionId) !== 'plugin') {
      this.stats.skippedForeign += 1
      return
    }

    this.stats.events += 1
    const buf = this.#bufferFor(sessionId, chat)

    switch (type) {
      case 'tool/call': {
        // 只登记"可能要写文件"的调用，等 tool/result 说它成功了才计入清单。
        // ⚠️ 调用**次数**不回传给用户，也不再拿它补「执行中」—— 中间态一律安静。
        const path = filePathFromToolCall(event.data?.name, event.data?.arguments)
        const callId = String(event.data?.callId ?? '')
        if (path && callId) buf.pendingWrites.set(callId, path)
        break
      }
      case 'tool/result': {
        // 失败的结果不算"动过"：编辑没匹配上、路径越权被拒都会来这一支
        if (event.data?.message?.isError === true) {
          const failedId = toolResultCallId(event.data.message)
          if (failedId) {
            buf.pendingWrites.delete(failedId)
            buf.pendingDeliveries.delete(failedId)
          }
          break
        }
        const callId = toolResultCallId(event.data?.message)
        const delivered = buf.pendingDeliveries.get(callId)
        const written = buf.pendingWrites.get(callId)
        if (delivered) {
          // ⚠️ 交付物**先处理**：同一次调用既写了文件又被 present 时，
          //    "交付物"这个更强的标记不能被后面那次"普通写入"覆盖掉。
          //    顺序反了的话清单里会丢掉"这是交付物"，用户就看不出哪个是重点。
          buf.pendingDeliveries.delete(callId)
          for (const f of delivered) this.#noteFile(buf, f.path, true)
        }
        if (written) {
          buf.pendingWrites.delete(callId)
          this.#noteFile(buf, written, false)
        }
        break
      }
      case 'deliverables/presented': {
        // agent 自己声明的交付物。真实顺序是 tool/call → **present 的 tools/result**
        // → 这个事件（dsh-tool-present/lib/index.js:112-120），所以按 callId 暂存，
        // 等配对的 result 确认没失败再计入 —— 与写类调用同一套"先证明再计入"的规矩。
        const files = filesFromPresented(event.data)
        const callId = String(event.data?.callId ?? '')
        if (files.length === 0) break
        this.stats.deliverablesSeen += files.length
        if (!callId) {
          for (const f of files) this.#noteFile(buf, f.path, true)
          break
        }
        const prev = buf.pendingDeliveries.get(callId)
        buf.pendingDeliveries.set(callId, prev ? [...prev, ...files] : files)
        break
      }
      case 'assistant/message': {
        const text = extractText(event.data?.message)
        if (text) buf.pending.push(text)
        break
      }
      // 审批的审计事件：asked 记一笔、decided 销一笔，剩下的就是"未决"
      case 'approval/asked': {
        const id = String(event.data?.id ?? '')
        if (!id) break
        let map = this.pendingApprovals.get(sessionId)
        if (!map) {
          map = new Map()
          this.pendingApprovals.set(sessionId, map)
        }
        map.set(id, String(event.data?.toolName ?? '未知工具'))
        this.stats.approvalsAsked += 1
        break
      }
      case 'approval/decided': {
        const id = String(event.data?.id ?? '')
        const map = this.pendingApprovals.get(sessionId)
        if (id && map?.delete(id)) {
          this.stats.approvalsDecided += 1
          if (map.size === 0) this.pendingApprovals.delete(sessionId)
        }
        break
      }
      case 'turn/end': {
        const reason = event.data?.reason
        const note = describeEnd(reason)
        if (note) buf.pending.push(`⚠️ ${note}`)
        // 终态必达：先 flush，**flush 完成之后**才通知收敛（归档不能抢在回传前面）
        const settledChat = buf.chat
        void (async () => {
          await this.#flush(sessionId, true)
          await this.#settle(sessionId, reason, settledChat)
        })()
        break
      }
      default:
        break
    }

    // 非终态：安排一次节流 flush
    if (type !== 'turn/end') this.#schedule(sessionId)
  }

  #bufferFor(sessionId, chat) {
    let buf = this.buffers.get(sessionId)
    if (!buf) {
      buf = {
        chat,
        sessionId,
        pending: [],
        timer: null,
        turn: 0,
        /** 本回合"工具确认动过"的文件：路径 → {path, delivered} */
        files: new Map(),
        /** callId → 待确认的写路径（等 tool/result 说成功） */
        pendingWrites: new Map(),
        /** callId → 待确认的交付物（等配对的 tool/result 说成功） */
        pendingDeliveries: new Map(),
      }
      this.buffers.set(sessionId, buf)
    }
    buf.chat = chat
    return buf
  }

  /** 记一个"动过"的文件；同一路径只留一条，交付物标记优先 */
  #noteFile(buf, path, delivered) {
    const key = String(path ?? '').trim()
    if (!key) return
    const prev = buf.files.get(key)
    if (prev) {
      if (delivered) prev.delivered = true
      return
    }
    buf.files.set(key, { path: key, delivered: Boolean(delivered) })
    this.stats.filesSeen += 1
  }

  #schedule(sessionId) {
    const buf = this.buffers.get(sessionId)
    if (!buf || buf.timer) return
    buf.timer = setTimeout(() => {
      buf.timer = null
      void this.#flush(sessionId, false)
    }, this.flushIntervalMs)
    if (typeof buf.timer.unref === 'function') buf.timer.unref()
  }

  /**
   * 把缓冲区的内容发出去。
   *
   * ⚠️ **非终态一律安静**：没有正文、没有文件改动时什么都不发（"还在跑"这件事
   *    不通过消息告诉用户，见文件头）。只有终态才会补一句"这一轮结束了"，
   *    免得用户以为它死了。
   *
   * @param {string} sessionId
   * @param {boolean} force 终态：允许补那句"这一轮结束了"
   */
  async #flush(sessionId, force) {
    const buf = this.buffers.get(sessionId)
    if (!buf) return
    if (buf.timer) {
      clearTimeout(buf.timer)
      buf.timer = null
    }

    const pieces = [...buf.pending]
    buf.pending.length = 0

    // ── 「它动了什么」 ────────────────────────────────────────────────
    //
    // 只在"这一轮确实动过文件"时出现，且**不报工具调用次数**（那是噪音）。
    // 放在正文之前：用户第一眼看到的是"它在动什么"，再读结论。
    const files = [...buf.files.values()]
    const hasFiles = files.length > 0
    const hasDelivered = files.some((f) => f.delivered)
    const fileBlock = hasFiles ? renderFiles(files, { delivered: hasDelivered }) : ''
    buf.files.clear()
    buf.pendingWrites.clear()
    buf.pendingDeliveries.clear()

    if (fileBlock) pieces.unshift(fileBlock)
    // 什么都没动、也没有正文：**只在终态补一句**，免得用户以为它死了。
    else if (pieces.length === 0 && force) pieces.push('✅ 这一轮结束了：没有新的正文，也没有文件改动。')

    const text = pieces.join('\n\n').trim()
    if (!text) {
      if (force) this.stats.dropped += 1
      return
    }

    const { chatType, chatId } = buf.chat
    // 任务 session 的正文带编号（**v2 路径**：同一会话里可能并行跑着好几条任务）。
    // 新逻辑链条下每个 QQ 会话只有一台常驻对接会话，没有任务号，也就不加前缀。
    const label = buf.chat?.kind === 'task' && buf.chat.taskNo ? `【#${buf.chat.taskNo}】` : ''
    try {
      const chunks = splitChunks(text)
      for (let i = 0; i < chunks.length; i += 1) {
        await this.send(chatType, chatId, i === 0 ? `${label}${chunks[i]}` : chunks[i])
      }
      this.stats.relayed += 1
    } catch (err) {
      this.log.warn(`[relay] 回传失败 ${chatType}/${chatId}: ${err?.message ?? err}`)
      this.stats.dropped += 1
    }
  }

  /** 回合已回传完毕 → 交给上层收敛（任务调度器据此归档） */
  async #settle(sessionId, reason, chat) {
    if (typeof this.onSettled !== 'function') return
    try {
      await this.onSettled(sessionId, reason, chat)
      this.stats.settled += 1
    } catch (err) {
      // 收敛失败不能影响回传链路本身；调度器自己会记账
      this.log.error(`[relay] onSettled 处理失败 ${sessionId}: ${err?.stack ?? err}`)
    }
  }

  /**
   * 忘掉某个 session 的缓冲（任务 session 归档后调用，v2 路径）。
   * v2 每条任务一个 session，不主动清理的话 buffers 会随任务数一直涨。
   */
  forget(sessionId) {
    const buf = this.buffers.get(sessionId)
    if (buf?.timer) clearTimeout(buf.timer)
    this.buffers.delete(sessionId)
    this.turnProvenance.delete(sessionId)
    this.pendingApprovals.delete(sessionId)
  }

  /**
   * 未决审批的工具名列表（没有则为空数组）。
   * 供应 `pending.js` 当作"还有待办"的判据之一。
   * @param {string} sessionId
   * @returns {string[]}
   */
  approvalsFor(sessionId) {
    const map = this.pendingApprovals.get(String(sessionId ?? ''))
    return map ? [...map.values()] : []
  }

  /** 直接推一条（不经过缓冲），用于任务受理等即时反馈 */
  async notify(chatType, chatId, text) {
    try {
      await this.send(chatType, chatId, text)
      this.stats.relayed += 1
    } catch (err) {
      this.log.warn(`[relay] notify 失败: ${err?.message ?? err}`)
    }
  }

  dispose() {
    for (const [, buf] of this.buffers) {
      if (buf.timer) clearTimeout(buf.timer)
      buf.files?.clear()
      buf.pendingWrites?.clear()
      buf.pendingDeliveries?.clear()
    }
    this.buffers.clear()
    this.turnProvenance.clear()
    // 早先漏了这一张：卸载后它还会带着审批记录留在实例上
    this.pendingApprovals.clear()
  }

  snapshot() {
    return { ...this.stats, activeBuffers: this.buffers.size, trackedTurns: this.turnProvenance.size }
  }
}
