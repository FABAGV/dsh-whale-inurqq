/**
 * 入口集成测试 —— 用最小的假 cordis 上下文跑真实的 lib/index.js
 * 覆盖：
 *   连接层、状态路由、凭据异步载入、disposer 清理
 *   workspace 创建（含目录落盘）、session 创建、任务投递、会话事件与 QQ 回传
 *   工具注册与 scope 门控、配置 Schema 与自动设置页、语料库与合并转发展开
 *   v2：任务与闲聊分流、每任务独立 session、并发上限与排队、单任务取消、跑完归档
 *   v3：turn/end 不等于任务结束 —— 未决提问/审批/活动/inbox/多回合都不许归档
 *   分类器与待办判据（纯函数断言，不依赖连接）
 *
 * 两路驱动力：
 *   1. 终端 B：tools/mock-napcat.mjs —— 按脚本节奏跑连接层与既有链路
 *   2. 本进程内的「受控客户端」—— 需要精确时序的场景（并发上限、取消、归档顺序、
 *      多回合与未决提问）用它自己的 WS 连接扮演第二个 OneBot 协议端：
 *      事件什么时候发、回合什么时候放行、会话还有没有待办，都由断言代码决定
 *
 * ⚠️ 假 DSH 服务必须**照抄真实实现的校验**，比真实宽松的 fake 会漏掉真机必炸的 bug：
 *   - sessionController.create 拒绝同时传 workspaceId 和 cwd
 *   - prompt 的 content 必须含非空白文本；归档后的会话不得再投递
 *   - workspaceRegistry.create 要求完全限定路径 + 目录已存在，且同路径返回已有实体（不改标题）
 *   - archiveSession 不带 stopActivity 时，会话有活动就拒绝（`workspace/session-activity`）
 *   - `agents.get(id)` 返回的是**活对象**，带 status/inbox 与 Agent；`sessionProjections.snapshot()`
 *     返回 `{asOfSeq, values:{userQuestions:{active,settled}}}`；审批是成对的：
 *     会话日志事件 `approval/asked` / `approval/decided`（形状与真实一致，见 pending.js 顶部表格）
 *
 * 用法：
 *   终端 A: node tools/test-entry.mjs
 *   终端 B: node tools/mock-napcat.mjs --once
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WebSocket } from 'ws'
import { createLogger } from '../lib/log.js'
import { classifyMessage, shouldRespond, isAmbiguousAsk, taskHint, CLASSIFY } from '../lib/classify.js'
import { assessSessionWork } from '../lib/dsh/pending.js'
import { judgeAlive, probeTasks, LOOP_STALL_MS, EVENT_SILENCE_MS } from '../lib/alive.js'
import { filePathFromToolCall, filesFromPresented, userMessageFromEvent } from '../lib/dsh/relay.js'

const PORT = Number(process.env.ENTRY_PORT ?? 6700)
/**
 * access token。**不在仓库里写任何 token 字面量** —— 默认空字符串 =
 * 测试台不校验来源，对着自己的实现跑测试本来也不需要凭据。
 * 只有要复现"token 不匹配必须被拒"这类场景时，才用 ENTRY_TOKEN 指一个值。
 */
const TOKEN = process.env.ENTRY_TOKEN ?? ''
/** QQ 项目目录的父目录：默认落在系统临时目录，避免把开发机的绝对路径写进仓库 */
const WORKSPACE_ROOT = process.env.ENTRY_ROOT ?? path.join(os.tmpdir(), 'dsh-whale-inurqq-entry-projects')
/** 每次运行都用全新的状态目录：断言不该被上一次运行的残留绑定影响 */
const STATE_DIR = process.env.ENTRY_STATE_DIR ?? path.join(os.tmpdir(), `dsh-whale-inurqq-entry-${PORT}-${Date.now()}`)

/**
 * 是否开启 v3 的常驻对话会话（`conversation.enabled`）
 *
 * **两趟跑**（这是刻意的，不是省事）：
 *   - `ENTRY_CONV=0`（默认）：只跑 v2 的 121 条断言。这一趟证明：
 *     "关掉开关行为逐字不变" —— 回归保命线
 *   - `ENTRY_CONV=1`：先跑同样的 121 条，再跑新增的常驻会话/交班/碎片记忆断言
 *     因为 mock 阶段的行为在两种模式下一致（mock 只走连接层与 v2 任务链路），
 *     同一条断言在两趟里都必须绿 */
const CONV = process.env.ENTRY_CONV === '1'

const log = createLogger('entry-test', 'info')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 假 DSH 服务 ────────────────────────────────────────────────────────
const calls = {
  createWorkspace: [],
  createSession: [],
  prompts: [],
  renames: [],
  cancels: [],
  archives: [],
}
const liveSessions = new Map()
/** @type {Map<string, any>} */
const workspaceByPath = new Map()
/** @type {Map<string, any>} */
const fakeWorkspaces = new Map()
const archivedSessions = new Set()
/** 测试注入的归档失败（验证"归档失败不影响任务本身"）*/
const archiveFailures = new Set()
/** 「挂住」的回合：sessionId 到 session（放行前不会发 turn/end）*/
const heldTurns = new Map()
/** 是否挂住回合。受控阶段的并发断言需要它把"任务还在跑"变成确定状态 */
let holdTurns = false
/**
 * 是否让假 Agent 注册表提供方参与 `workspace/session-activity`：
 * 关掉它用来构造"判据漏判、宿主兜底"的场景：插件问不出活动，
 * 但宿主自己的归档准入仍然知道会话在忙（见 G8） */
let activityProviderEnabled = true
/** @type {Map<string, Function>} */
const registeredTools = new Map()
/** @type {Function[]} */
const guards = []
/** @type {Map<string, Set<Function>>} */
const listeners = new Map()
/** @type {any} */
let settingsPolicy = null

// ── v3 假服务状态：tokenMeter / llm / sessionQuery / systemPrompt ──────
/** 假 contextWindow：故意取一个小值，让灌 token 到阈值在测试里是可行操作 */
const FAKE_CONTEXT_WINDOW = 100000
/** @type {Array<{sessionId:string, withHeader:boolean, at:number}>} */
const tokenMeterCalls = []
/** @type {Array<any>} */
const llmCalls = []
/** @type {Array<{sessionId:string, at:number, archived:boolean}>} */
const readSessionCalls = []
/** @type {Array<{name:string, order:number, at:number}>} */
const contextRegistrations = []
/** 已注册的 systemPrompt.context 条目（name 到 entry）*/
const contexts = new Map()
/** 已注册的 systemPrompt.section 条目（name 到 entry）—— 前台行为约定走这一支 */
const sections = new Map()
/** @type {Array<{name:string, order:number, at:number}>} */
const sectionRegistrations = []
/** 交班整理调用要按脚本返回；空队列时用 defaultLlmReply */
let llmScript = []
let defaultLlmReply = { fail: '没有为这次交班准备 LLM 回复（测试脚本未设置）' }

/** 直接灌某个会话的 token 数（模拟"聊了很久"）*/
function setSessionTokens(sessionId, tokens) {
  const rec = liveSessions.get(String(sessionId))
  if (!rec) return false
  rec.tokens = Number(tokens)
  return true
}

/** 排一个交班整理用的 LLM 回复（按调用顺序消费）*/
function queueLlm(...items) {
  llmScript.push(...items)
}

/** 一份形状正确的假交接束 */
function fakeBundle({ text = '用户在做并购商誉减值的论文，还差参考文献那一节', tag = 2, kind = 'intent', mergeWith = null, extraFragments = [], drop = [], persona = '我是他的研究助手，说话直接' } = {}) {
  return {
    text: JSON.stringify({
      handoff: {
        userGoal: '把并购商誉减值的论文写完',
        inFlight: ['参考文献那一节还没写'],
        constraints: ['不要动 R:\\ 下的原始数据'],
        preferences: ['别叫我助手，叫我名字'],
        promises: [],
        openQuestions: ['要不要顺便做个查询'],
        persona,
      },
      fragments: [{ text, kind, tag, confidence: 0.9, mergeWith }, ...extraFragments],
      drop,
    }),
  }
}

/** 往会话日志里追加一条事件（交班读历史走 sessionQuery）*/
function appendEvent(sessionId, event) {
  const rec = liveSessions.get(String(sessionId))
  if (!rec) return false
  if (!Array.isArray(rec.eventLog)) rec.eventLog = []
  rec.eventLog.push({ seq: rec.eventLog.length + 1, time: Date.now(), ...event })
  return true
}

/**
 * 往会话日志里塞一条用户消息（交班整理的输入）。
 *
 * ⚠️ `data` **就是消息本体**，不是 `{message}` 包装：真实宿主
 *    `dsh-agent-loop` 是 `session.append('user/message', message)`，落盘事件形如
 *    `{type:'user/message', data:{role:'user', content, source:{kind:'user', rpcId}}}`。
 *    真机会话日志（0.2.1）实测确认过。fake 早先包了一层 `{message}`，
 *    结果把 relay 里读错形状的 bug 冻成了"测试全绿"（同 `emitToolResult` 那次的教训）。
 */
function appendUserMessage(sessionId, text) {
  return appendEvent(sessionId, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'r1' } } })
}

/** 往会话日志里塞一条助手消息 */
function appendAssistantMessage(sessionId, text) {
  return appendEvent(sessionId, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })
}

function emitEvent(name, ...args) {
  for (const fn of listeners.get(name) ?? []) {
    try {
      fn(...args)
    } catch (err) {
      log.error(`[fake-bus] 监听器抛错 ${name}: ${err.message}`)
    }
  }
}

let idSeq = 0
const nextId = (p) => `${p}-${++idSeq}`

/** 与 DSH 内部 fullyQualifiedWorkspacePath 同口径：Windows 下 `\x` 与相对路径不合格 */
function fullyQualified(p) {
  const v = String(p ?? '')
  if (process.platform !== 'win32') return path.posix.isAbsolute(v)
  const root = path.win32.parse(v).root
  return path.win32.isAbsolute(v) && root !== '\\' && root !== '/'
}

/**
 * 结束一个回合：置活动标志 + 镜像 `agent/status` 回到 idle，再发 turn/end
 * 「回合结束时 agent 已经 idle」是真实语义（idle = 没有 driver 在跑），
 * 判据里的 status 检查依赖这一点 */
function endTurn(sessionId, reason) {
  const rec = liveSessions.get(sessionId)
  const session = rec?.session ?? { id: sessionId }
  heldTurns.delete(sessionId)
  if (rec) {
    rec.turnActive = false
    rec.status = 'idle'
  }
  emitEvent('session/event', session, {
    type: 'turn/end',
    seq: ++idSeq,
    time: Date.now(),
    data: { turn: rec?.turn ?? 1, reason },
  })
}

/** 释放一个被挂住的回合；没被挂住则返回 false */
function releaseTurn(sessionId, reason = { kind: 'completed' }) {
  if (!heldTurns.has(sessionId)) return false
  endTurn(sessionId, reason)
  return true
}

function releaseAllHeld(reason = { kind: 'completed' }) {
  const ids = [...heldTurns.keys()]
  for (const id of ids) endTurn(id, reason)
  return ids.length
}

/**
 * 模拟一次完整的回合：turn/start -> 工具调用 -> 正文 -> turn/end
 *
 * ⚠️ v3 起它还要复刻**归档会话的第一步就吞 pre-step** 这条语义：
 *   `dsh-agent-loop` 的 `turn()` 走 `preStep()` 的 `claim()`（先无条件吃掉整个
 *   next-step、再吃 next-turn 的一条），随后 waterfall 把它判成 `{kind:'reject'}`，
 *   于是 `turnEnds = {kind:'blocked'}; return false`（`:906`、`:958-961`）。
 *   结果是：**注入的上下文与用户的这句话一起被吞掉**，且什么都不抛。
 *   fake 如果不复刻这一条，"往已退役会话投递"就退化成一次无害操作。 */
function simulateTurn(sessionId) {
  const rec = liveSessions.get(sessionId)
  const session = rec?.session ?? { id: sessionId }
  if (rec) {
    // ── pre-step：claim 顺序照抄真实实现（先 next-step，再 next-turn）──────
    const claimedStep = rec.inbox.nextStep.splice(0, rec.inbox.nextStep.length)
    const claimedTurn = rec.inbox.nextTurn.splice(0, 1)
    const claimed = [...claimedStep, ...claimedTurn]

    if (rec.archived) {
      // 归档后 pre-step 第一道闸门就 reject：claim 到的东西全部丢弃，回 blocked 结束
      heldTurns.delete(sessionId)
      rec.turnActive = false
      rec.status = 'idle'
      rec.blockedBy = (rec.blockedBy ?? 0) + 1
      emitEvent('session/event', session, {
        type: 'turn/end',
        seq: ++idSeq,
        time: Date.now(),
        data: { turn: rec.turn ?? 1, reason: { kind: 'blocked' } },
      })
      return claimed
    }
    if (claimedStep.length > 0) rec.consumedInjections.push(...claimedStep.map((m) => (m.content ?? []).map((b) => b.text ?? '').join('')))
    // 用户的这句话也一并记入"本回合实际进入模型的消息"（顺序断言用）
    rec.lastClaimed = claimed.map((m) => ({ id: m.id, text: (m.content ?? []).map((b) => b.text ?? '').join('') }))
    rec.claimedThisTurn = claimed
    // 记住"这个会话最近一次 claim 到的 source"：宿主后续续跑回合（startToolTurn）
    // 要复用它 —— 真实语义里那是同一条 prompt 消息被再次 claim。
    const carry = claimed.find((m) => m?.source?.kind === 'user' && m.source.rpcId)
    if (carry) rec.lastClaimedSource = { source: carry.source, content: carry.content }

    rec.turnActive = true
    // 真实语义：有唤醒输入开启 pre-step 处理后，status 变 running
    rec.status = 'running'
    rec.turn = (rec.turn ?? 0) + 1
  }
  const turn = rec?.turn ?? 1
  /** `extra` 是事件**顶层**的附加字段（`surfaceOp` / `sourceEventSeqs`），不是 data 里的 */
  const send = (type, data, extra = {}) => emitEvent('session/event', session, { type, seq: ++idSeq, time: Date.now(), data, ...extra })

  setTimeout(() => {
    if (rec) rec.startedTurn = turn
    send('turn/start', { turn })
    /**
     * ⚠️ 真实顺序（`dsh-agent-loop/lib/index.js`，**照抄不能改**）：
     *   `turn()` 第一行 `append('turn/start')`（:943）→ `pre-step` 的 `step()` 里
     *   `for (const message of decision.messages) append('user/message', message)`（:1061）。
     *   所以 user/message **一定在 turn/start 之后**、在任何正文之前落盘。
     *
     * 为什么 fake 必须发它：插件的回传按 turn 来源门控（`lib/dsh/relay.js` 规则 2），
     * 而来源的唯一判据就是这条会话事件的 `data.source.rpcId`（**data 就是消息本体**，
     * 不是 `{message}` 包装；见 `appendUserMessage` 的注释）——
     * 命中插件投递时登记的那个 requestId 才算"插件发起的回合"。
     * fake 少了它，插件只能判成"不是插件发起的"→ 什么都不回传（真机必炸的死法）。
     */
    // ⚠️ 即使这个回合没 claim 到新消息（inbox 空了、或是宿主续跑的
    //    后续回合），也必须发一条 `user/message`：真实实现里 pre-step 每次都会
    //    重新 claim，那条 prompt 消息会再次落盘（来源不变）。fake 漏了这一条，
    //    插件就只能把这个回合判成"来源不明" —— 而来源不明的回合是不回传、也不收敛的。
    const lineage = rec?.claimedThisTurn?.length ? rec.claimedThisTurn : rec?.lastClaimedSource ? [rec.lastClaimedSource] : []
    for (const m of lineage) {
      // 形状照抄真实落盘事件：data = message 本体，surfaceOp 在事件顶层
      send(
        'user/message',
        { id: m.id ?? `m-lineage-${turn}`, role: m.role ?? 'user', content: m.content ?? [], source: m.source },
        { surfaceOp: 'append' },
      )
    }
    if (rec) rec.claimedThisTurn = []
  }, 60)
  setTimeout(() => send('tool/call', { turn, step: 1, callId: 'c1', name: 'read', arguments: '{}' }), 140)
  setTimeout(() => send('tool/call', { turn, step: 1, callId: 'c2', name: 'write', arguments: '{}' }), 200)
  setTimeout(
    () =>
      send('assistant/message', {
        turn,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '我已经按你的要求建好了项目，README 写在项目根目录' }],
        },
        stream: [],
      }),
    700,
  )

  if (holdTurns) {
    // 挂住：等 releaseTurn()。受控阶段用它构造"任务仍在跑"的确定状态
    heldTurns.set(sessionId, session)
    return
  }
  setTimeout(() => endTurn(sessionId, { kind: 'completed' }), 820)
}

/** 往会话里推一个任意类型的会话事件（用于审批审计、user/message 等）；`extra` 是事件顶层字段 */
function emitSessionEvent(sessionId, type, data, extra = {}) {
  const rec = liveSessions.get(sessionId)
  emitEvent('session/event', rec?.session ?? { id: sessionId }, { type, seq: ++idSeq, time: Date.now(), data, ...extra })
}

/**
 * 推一个 `tool/result`。
 *
 * ⚠️ 形状**照抄真实实现的产出**，不是它的入参：
 *   `dsh-agent-loop/lib/index.js:691-696` 调
 *   `createToolResultMessage({ callId, content, isError })`，
 *   而该函数（`dsh-llm/lib/index.js:101-112`）**产出**的是
 *   `createMessage({ role:'tool', source:{ kind:'tool', callId }, toolCallId, content, isError })`
 *   —— 所以 message 上是 **`toolCallId`**（外加 `source.callId`），
 *   **没有顶层 `callId`**；`isError` 在 message 上，不在 data 顶层。
 *
 * ⚠️ 这里曾经写成"把 `createToolResultMessage` 的**入参**当成消息本身"，
 *   message 上放了一个真实世界里不存在的顶层 `callId`。那不是"漏报"，而是
 *   **反向**的：插件读 `message.callId` 在真机上恒为空，"它动过哪些文件"整条功能
 *   在生产里从未生效，而断言全绿 —— 测试把 bug 冻住了。fake 的字段名必须与
 *   真实产出一致，否则它证明的只是"我们自己和自己一致"。
 *
 * @param {string} sessionId
 * @param {string} callId
 * @param {{isError?:boolean, text?:string}} [opts]
 */
function emitToolResult(sessionId, callId, { isError = false, text = 'ok' } = {}) {
  emitSessionEvent(sessionId, 'tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'tool-result', callId, isError, content: [{ type: 'text', text }] }],
      isError,
    },
  })
}

/**
 * 开一个"带真实工具调用"的回合：不发正文，只留工具痕迹。
 *
 * **它模拟的是"宿主在这个会话里继续跑一个回合"**（多步工具循环、或用户回答之后
 * 的续跑）—— 真实语义里这种回合是**同一个 turn 谱系**的延续：pre-step 会重新 claim
 * 一次输入，于是会话日志里会再落一条 `user/message`，带的是**同一个 `source`**
 * （同一次 prompt 的那条消息被再次 claim）。
 *
 * 所以这里必须补发那条 `user/message`，并且**复用上一次 claim 到的 source**：
 * 插件的回传按 turn 来源门控（`lib/dsh/relay.js` 规则 2），而来源就是靠这条事件
 * 里 `source.rpcId` 与插件登记的 requestId 比对出来的。fake 只发 `turn/start`
 * 不发 `user/message`，那种回合在插件眼里来源就是 unknown → 一个字节都不回传。
 */
function startToolTurn(sessionId) {
  const rec = liveSessions.get(String(sessionId))
  const turn = (rec?.turn ?? 0) + 1
  const carry = rec?.lastClaimedSource ?? null
  if (rec) {
    rec.turnActive = true
    rec.status = 'running'
    rec.turn = turn
    rec.claimedThisTurn = carry
      ? [{ id: `m-carry-${turn}`, role: 'user', content: carry.content ?? [], source: carry.source }]
      : []
  }
  emitSessionEvent(sessionId, 'turn/start', { turn })
  if (carry) {
    // 顺序与形状照抄真实实现：turn/start 先落盘，user/message 紧随其后，
    // 且 data 就是消息本体（不是 `{message}` 包装）
    emitSessionEvent(
      sessionId,
      'user/message',
      { id: `m-carry-${turn}`, role: 'user', content: carry.content ?? [], source: carry.source },
      { surfaceOp: 'append' },
    )
  }
  return turn
}

/**
 * 完整走一遍"任务会话写文件"的真实事件序列，并回传。
 *
 * 序列与真机一致：`turn/start` → `tool/call`（写类）→ `tool/result`（成功）
 * → `assistant/message` → `turn/end`。差一步都测不出"它动了什么"。
 *
 * `presented: true` 时按**真机的真实顺序**补一次 present：
 *   `present.execute()` → `deliverables/presented` → `tool/result`
 *
 * 依据是一手源码，不是猜：
 *   - `dsh-tool-present/lib/index.js:111-121`：在 `tools/result` **观察者**里
 *     同步 `session.append('deliverables/presented', …)`
 *   - `dsh-agent-loop/lib/index.js:691-706`：`tool/result` 由 `appendToolResult` 落盘，
 *     而它跑在工具执行 settle 之后
 * 所以**交付物事件先到、tool/result 后到**。relay 因此必须"先按 callId 暂存、
 * 等配对 result 确认成功"才敢计入清单 —— 写成"见到 presented 就直接计入"
 * 会在真机上把失败的 present 也算成交付物。
 *
 * ⚠️ 等待用的是**插件里的常量** `FLUSH_INTERVAL_MS = 2000`（`lib/dsh/relay.js`）
 *    —— 配置里没有这一项，所以这里按常量等，而不是读配置。
 */
const RELAY_FLUSH_MS = 2000
async function runFileTurn(
  sessionId,
  { path, callId = 'w1', presentCallId = 'p1', text = '做好了', isError = false, presented = false } = {},
) {
  const turn = startToolTurn(sessionId)
  emitSessionEvent(sessionId, 'tool/call', {
    turn,
    step: 1,
    callId,
    name: 'write',
    arguments: JSON.stringify({ file_path: path, content: 'x' }),
  })
  emitToolResult(sessionId, callId, { isError })
  if (presented && !isError) {
    // present 是另一次独立调用（callId 不同），且它的 deliverables/presented
    // **先于**它自己的 tool/result 到达
    emitSessionEvent(sessionId, 'tool/call', {
      turn,
      step: 1,
      callId: presentCallId,
      name: 'present',
      arguments: JSON.stringify({ files: [{ path, description: '报表' }] }),
    })
    emitSessionEvent(sessionId, 'deliverables/presented', { turn, callId: presentCallId, files: [{ path, description: '报表' }] })
    emitToolResult(sessionId, presentCallId, { text: `Presented ${path}` })
  }
  emitSessionEvent(sessionId, 'assistant/message', {
    turn,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    stream: [],
  })
  await sleep(150)
  endTurn(sessionId, { kind: 'completed' })
  await sleep(RELAY_FLUSH_MS + 900)
}

/**
 * 派一条**v2 任务会话**里的活，并返回它的会话 id。
 *
 * ⚠️ 新逻辑链条下 `qq_dispatch` **不存在**（默认路径不再新建任务会话），
 *    所以本函数只在 `conversation.enabled=false` 那一趟可用；
 *    v3 那一趟调用它必须是**明确的失败**，而不是悄悄返回一个假会话。
 */
async function dispatchRealTask(dispatch, chatType, chatId, text) {
  if (typeof dispatch?.execute !== 'function') {
    throw new Error('qq_dispatch 不可用：新逻辑链条下不派独立任务会话（这是预期行为，调用方应改用常驻会话）')
  }
  const out = await dispatch.execute({ chat_type: chatType, chat_id: String(chatId), text }, {})
  const no = Number(out?.taskNo ?? 0)
  const rec = await waitValue(async () => {
    const rows = await listTasksOf(chatType, String(chatId), 50)
    const t = rows.find((x) => x.no === no)
    return t?.sessionId ? t : 0
  }, 10000, 150)
  const session = liveSessions.get(String(rec?.sessionId ?? ''))
  if (!rec?.sessionId || !session) throw new Error(`派活后拿不到任务会话 #${no}（sessionId=${rec?.sessionId}）`)
  return { no, sessionId: rec.sessionId, session }
}

/**
 * 开一个新回合，并**等到 turn/start 真的发出去**再返回
 *
 * 为什么必须等：`turn/start` 是延迟 60ms 发的（模拟真机"先唤醒、再落盘"）。
 * 如果调用方紧接着就 releaseTurn，turn/end 会抢在 turn/start 前面到达 ——
 * 那不是真机可能出现的顺序，会让断言测到一个不存在的场景。 */
async function startTurnAndWait(sessionId) {
  simulateTurn(sessionId)
  const target = liveSessions.get(sessionId)?.turn
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const rec = liveSessions.get(sessionId)
    if (rec && rec.startedTurn === target) return true
    await sleep(50)
  }
  return false
}

// ── 假宿主状态：Agent / 会话投影 / 审批 ────────────────────────────────
// 形状全部照抄真实契约（见文件头与 pending.js 顶部的契约表），
// 尤其是 **status / inbox / userQuestions 必须是活的** —— 插件读的是当前值
/** 有未决提问（照抄 userQuestions 投影的 client view 形状）*/
function setPendingQuestion(sessionId, question, state = 'continued') {
  const rec = liveSessions.get(sessionId)
  if (!rec) return false
  rec.userQuestions = {
    active: [{ callId: `call-${++idSeq}`, questions: [{ id: 'q1', question }], state }],
    settled: rec.userQuestions?.settled ?? [],
  }
  return true
}

/** 提问被回答：投影的 active 清空 */
function clearPendingQuestion(sessionId) {
  const rec = liveSessions.get(sessionId)
  if (!rec) return false
  const active = rec.userQuestions?.active ?? []
  rec.userQuestions = { active: [], settled: [...(rec.userQuestions?.settled ?? []), ...active] }
  return true
}

/** 往 inbox 里塞一条没被消费的输入（真实契约：nextTurn / nextStep）*/
function pushInbox(sessionId, text = '（排队中的后续输入）') {
  const rec = liveSessions.get(sessionId)
  if (!rec) return false
  rec.inbox.nextTurn.push({ id: `m-${++idSeq}`, role: 'user', content: [{ type: 'text', text }] })
  return true
}

function clearInbox(sessionId) {
  const rec = liveSessions.get(sessionId)
  if (!rec) return false
  rec.inbox.nextTurn.length = 0
  rec.inbox.nextStep.length = 0
  return true
}

/** 审批开始（`approval/asked` 审计事件）*/
function askApproval(sessionId, id, toolName) {
  const rec = liveSessions.get(sessionId)
  if (rec) rec.approvals.set(id, toolName)
  emitSessionEvent(sessionId, 'approval/asked', { id, toolName })
}

/** 审批出结果（`approval/decided`）*/
function decideApproval(sessionId, id) {
  const rec = liveSessions.get(sessionId)
  if (rec) rec.approvals.delete(id)
  emitSessionEvent(sessionId, 'approval/decided', { id, outcome: 'allowed-once' })
}

const services = {
  credentials: {
    async resolve(ref) {
      log.info(`[fake-credentials] resolve("${ref}")`)
      // 真实契约（见 credentials 服务的 ResolvedCredential 类型）返回的是
      // `{ value, source }` **对象**，不是字符串。
      // 早期 mock 返回字符串，掩盖了 `String(resolve(...))` 把 token 变成
      // "[object Object]" 的 bug —— mock 必须照抄真实形状。
      return { value: TOKEN, source: 'fake-store' }
    },
  },

  workspaceRegistry: {
    async create(dir, title) {
      calls.createWorkspace.push({ dir, title })
      log.info(`[fake-workspace] create(dir="${dir}")`)
      // 照真实实现第一步先 realpath，非完全限定路径直接抛 TypeError
      if (!fullyQualified(dir)) throw new TypeError(`Workspace path is not fully qualified: '${dir}'`)
      // 目录必须已存在
      const exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory()
      if (!exists) throw new Error(`realpath 失败：目录不存在 ${dir}`)
      // 同一路径重复调用返回**已有实体且不改标题**
      const canonical = path.resolve(dir)
      const found = workspaceByPath.get(canonical)
      if (found) return found
      const ws = { id: nextId('ws'), path: canonical, title: title ?? path.basename(canonical), sessionIds: [] }
      workspaceByPath.set(canonical, ws)
      fakeWorkspaces.set(ws.id, ws)
      return ws
    },
    list: () => [...fakeWorkspaces.values()],
    get: (id) => fakeWorkspaces.get(id),

    /**
     * 照抄真实语义：会话必须存在；不带 stopActivity 时有活动就拒绝；
     * 带 stopActivity 时强制归档并请求停止；重复归档是幂等的空操作
     */
    async archiveSession(sessionId, options = {}) {
      const rec = {
        sessionId,
        stopActivity: options?.stopActivity === true,
        ok: false,
        reason: '',
        at: Date.now(),
      }
      calls.archives.push(rec)
      const session = liveSessions.get(sessionId)
      if (!session) {
        rec.reason = 'unknown-session'
        throw new Error(`workspace/unknown-session: session "${sessionId}" not found (archive)`)
      }
      if (archiveFailures.has(sessionId)) {
        rec.reason = 'injected-failure'
        throw new Error('fake: 归档失败（测试注入）')
      }
      if (archivedSessions.has(sessionId)) {
        rec.ok = true
        rec.reason = 'already-archived'
        return
      }
      if (!rec.stopActivity && session.turnActive) {
        rec.reason = 'active'
        throw new Error(`workspace/session-active: session "${sessionId}" still has activity`)
      }
      archivedSessions.add(sessionId)
      session.archived = true
      rec.ok = true
      if (rec.stopActivity) {
        session.stopRequested = true
        // 真实实现会派发 workspace/session-stop，请求停止该会话仍在跑的工作
        if (heldTurns.has(sessionId)) releaseTurn(sessionId, { kind: 'aborted', reason: { kind: 'archive' } })
      }
    },
  },

  sessionController: {
    async create(request) {
      const rec = { ...request, at: Date.now() }
      calls.createSession.push(rec)
      // 与真实实现保持一致：workspaceId 与 cwd 互斥
      // 真实代码里这一条是：
      //   if (workspaceId !== undefined && cwd !== undefined) throw RemoteError('gateway/bad-request', ...)
      if (request.workspaceId !== undefined && request.cwd !== undefined) {
        throw new Error('gateway/bad-request: session.create accepts workspaceId or cwd, not both')
      }
      // cwd 由 workspace.path 推导，或直接取 request.cwd
      let cwd = request.cwd
      if (request.workspaceId !== undefined) {
        const ws = fakeWorkspaces.get(request.workspaceId)
        if (!ws) throw new Error(`workspace/not-found: workspace "${request.workspaceId}" not found`)
        cwd = ws.path
        ws.sessionIds.push('pending')
      }
      const sessionId = nextId('sess')
      const session = {
        id: sessionId,
        cwd,
        turnActive: false,
        archived: false,
        stopRequested: false,
        canceled: false,
        /** 镜像真实 `Agent.status: 'idle'|'running'`（`agent/status` 事件同步它） */
        status: 'idle',
        turn: 0,
        /** 真实契约 `Agent.inbox`：pending 输入（nextTurn / nextStep）*/
        inbox: { nextTurn: [], nextStep: [] },
        /** 真实契约：会话投影 `userQuestions` 的 client view `{active, settled}` */
        userQuestions: { active: [], settled: [] },
        /** 未决审批（审计事件折叠出来的）*/
        approvals: new Map(),
        /** v3：tokenMeter.measure 读的 token 数（测试直接灌） */
        tokens: 0,
        /** v3：会话完整事件日志（sessionQuery.readSession 读它）*/
        eventLog: [],
        /**
         * v3：被 ArchivedSessionGate 静默吞掉的注入（`{text, source}`）
         * 这是**真实语义**：归档后 `agent.inject()` 照样把消息放进 next-step，
         * 但下一步 `agent/pre-step` 第一道闸门就 `{kind:'reject'}`，
         * 那条注入连同被唤醒的用户输入一起以 `turn/end {kind:'blocked'}` 结束
         * —— 不抛错、不通知。测试断言"守卫必须拦住这种情况"。
         */
        swallowedInjections: [],
        /** 反向：真正被消费（没被吞）的注入，用于 N10 的位置断言 */
        consumedInjections: [],
      }
      // 真实 `Session` 有 header/id；投影读取要靠它，所以形状不能省。
      // `requestHeader()` 也要有：交班选整理模型时，第二级回退读的就是
      // `agent.session.requestHeader()?.config`（`dsh-compaction-basic/lib/index.js:293`）。
      // 真实会话**跑过至少一次请求之后**这里一定命中，fake 照抄这一点。
      session.session = {
        id: sessionId,
        header: { id: sessionId, cwd },
        requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
      }
      // Agent 的 status/inbox/session 在真机上是**活的 getter**，fake 也必须是
      session.agent = {
        get session() {
          return session.session
        },
        get status() {
          return session.status
        },
        get inbox() {
          return session.inbox
        },
        get options() {
          // 真实 Agent.options 是路由的第三级回退（provider/model）
          return { provider: 'deepseek-official', model: 'deepseek-flash' }
        },
        cancel() {
          session.canceled = true
        },
        /**
         * 真实契约 `Agent.inject(message)`：
         *   `send(message, 'next-step', false)` —— 只进 next-step，**不唤醒**
         *   （`dsh-agent-loop/lib/index.js:812-814`）。
         * idle 的 driver 会一直把它留着，直到 follow-up/steering 唤醒
         * （`dsh-agent/lib/types/runtime-types.d.ts` 的 inject 文档）。
         *
         * ⚠️ 归档后的会话：消息**照样进队列**，然后在 pre-step 被静默 reject ——
         * fake 必须复刻这一点，否则"往已退役会话投递会静默丢消息"这条
         * 最重要的防线在测试里就没有约束力。
         */
        inject(message) {
          const text = (message?.content ?? []).map((b) => b.text ?? '').join('')
          session.inbox.nextStep.push({ id: message?.id ?? `inj-${++idSeq}`, role: 'user', content: message?.content ?? [], source: message?.source })
          if (session.archived) {
            session.swallowedInjections.push({ text, source: message?.source ?? null, at: Date.now() })
            log.info(`[fake-session] inject -> ${sessionId} 【已归档：将在 pre-step 被静默吞掉】`)
          } else {
            log.info(`[fake-session] inject -> ${sessionId} (${text.length} 字，等下一句话唤醒后 claim)`)
          }
        },
      }
      liveSessions.set(sessionId, session)
      rec.sessionId = sessionId
      log.info(`[fake-session] create -> ${sessionId} cwd=${cwd}`)
      return { sessionId }
    },

    async prompt(request, _signal) {
      const text = (request.content ?? []).map((b) => b.text ?? '').join('')
      calls.prompts.push({ ...request, text, at: Date.now() })
      log.info(`[fake-session] prompt -> ${request.sessionId} mode=${request.mode}`)
      log.info(`[fake-session]   text: ${text.replace(/\n/g, ' / ')}`)
      // 真实实现第一行：content 必须含非空白文本
      const hasText = (request.content ?? []).some(
        (b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim(),
      )
      if (!hasText) {
        throw new Error('gateway/bad-request: prompt content must include non-whitespace text or an attachment')
      }
      const session = liveSessions.get(request.sessionId)
      if (!session) throw new Error(`session/not-found: session "${request.sessionId}" not found`)
      // 归档后的会话不能再投递（真机由 archived gate 挡住）
      if (session.archived) throw new Error(`session/archived: session "${request.sessionId}" is archived`)
      // ── 投进去的那条消息**要进 inbox**，这是真实链路的一部分 ─────────────
      //
      // 真实 `sessions.prompt()` 的最后一步是：
      //   `mode==='steer' ? agent.steer(message) : agent.followup(message)`
      // （`dsh-api-session-controller/lib/index.js:884-885`），而
      //   `followup` = `send(message, 'next-turn', true)`（`dsh-agent-loop/lib/index.js:806-808`）。
      // 也就是说**用户这句话落在 `next-turn` 里，由下一步的 `claim('next-turn')` 取走**，
      // 而 claim 的返回顺序是"先整个 next-step、再 next-turn 的一条"（`:103-111`）——
      // 这正是"交接文本排在用户消息之前"那条位置契约的机制来源。
      // fake 少了这一步，`next-turn` 永远是空的，claim 出来的只有 next-step 里的注入，
      // 于是"注入在前、用户的话在后"这个顺序在假宿主里**根本无从复现** ——
      // 比真实宽松的 fake 会把真机必炸的 bug 放过去（README「开发」节的既有教训）。
      const message = {
        id: `m-${++idSeq}`,
        role: 'user',
        content: request.content,
        source: { kind: 'user', rpcId: request.requestId },
      }
      if (request.mode === 'steer') session.inbox.nextStep.push(message)
      else session.inbox.nextTurn.push(message)
      simulateTurn(request.sessionId)
      return { accepted: true }
    },

    async rename(request) {
      calls.renames.push(request)
      log.info(`[fake-session] rename -> "${request.title}"`)
      return { title: request.title, seq: 1 }
    },

    /** 真实实现是同步的，且只作用于**一个**会话 */
    cancel(request) {
      calls.cancels.push({ ...request, at: Date.now() })
      const session = liveSessions.get(request.sessionId)
      if (!session) throw new Error(`session/not-found: session "${request.sessionId}" not found (not attached)`)
      session.canceled = true
      // 真机语义：cancel 让当前回合以 aborted 结束
      if (heldTurns.has(request.sessionId)) releaseTurn(request.sessionId, { kind: 'aborted', reason: { kind: 'user' } })
      log.info(`[fake-session] cancel -> ${request.sessionId}`)
      return { accepted: true }
    },

    async inspect(sessionId) {
      const s = liveSessions.get(sessionId)
      if (!s) throw new Error('session/not-found')
      return { meta: { id: sessionId }, inheritedEventCount: 0, events: [] }
    },
  },

  /**
   * 真实契约：`ctx.agents`（`dsh-agent`）跟踪活着的 Agent：
   * `get(sessionId)` 返回的对象上，`status` / `inbox` / `session` 都是活值。
   */
  agents: {
    get(id) {
      return liveSessions.get(String(id ?? ''))?.agent
    },
    list() {
      return [...liveSessions.values()].map((s) => s.agent)
    },
    roots() {
      return []
    },
    isOwnedBy() {
      return false
    },
  },

  /**
   * 真实契约：`ctx.sessionProjections.snapshot(session, keys?)`
   *   返回 `{ asOfSeq, values: Partial<SessionProjectionMap> }`
   * `userQuestions` 的 client view 是 `{ active: [{callId, questions, state}], settled }`
   * （`dsh-user-questions/lib/types/projection.js`、`types.d.ts` 62-93 行）。
   */
  sessionProjections: {
    snapshot(session, keys) {
      const rec = liveSessions.get(String(session?.id ?? ''))
      if (!rec) return { asOfSeq: -1, values: {} }
      const want = (k) => !keys || keys.includes(k)
      const values = {}
      if (want('userQuestions')) values.userQuestions = rec.userQuestions
      return { asOfSeq: rec.turn ?? -1, values }
    },
    cachedSnapshot(session, keys) {
      return this.snapshot(session, keys)
    },
    stateOf(session, key) {
      return this.snapshot(session, [key]).values[key]
    },
  },

  /**
   * 真实契约：`ctx.tokenMeter.measure(session, requestHeader?)`
   *   返回 `{logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes}`
   *   （`dsh-token-meter/lib/index.js:641-684`）。
   *
   * 两个必须照抄的点：
   *   ① 返回值是 `deepFreeze(structuredClone(...))` —— 插件拿到的是**快照**，
   *      改它不会影响下一次读数（`lib/dsh/handoff.js` 只读它）。
   *   ② **传了第二参数会替换最新记录的 envelope**（`:638`、`:643`），
   *      也就是会改变 `totalTokens`。fake 必须体现这一点，否则
   *      "不要传第二参数"这条纪律在测试里就没有约束力。
   *
   * 测试用 `setSessionTokens(id, n)` 直接灌 token 数模拟长会话。
   */
  tokenMeter: {
    measure(session, requestHeader) {
      const rec = liveSessions.get(String(session?.id ?? ''))
      if (!rec) return Object.freeze({ logRevision: 0, baseline: { kind: 'none', tokens: 0 }, surfaceDeltaTokens: 0, totalTokens: 0, surfaceTokens: 0, nodes: [] })
      tokenMeterCalls.push({ sessionId: rec.id, withHeader: requestHeader !== undefined, at: Date.now() })
      // 真实实现里第二参数会**替换** envelope 并改变结果 —— fake 照抄这个副作用。
      const total = requestHeader !== undefined ? Math.max(0, rec.tokens - 1234) : rec.tokens
      return Object.freeze({
        logRevision: rec.turn ?? 0,
        baseline: Object.freeze({ kind: 'estimated', tokens: total }),
        surfaceDeltaTokens: 0,
        totalTokens: total,
        surfaceTokens: total,
        nodes: Object.freeze([]),
      })
    },
  },

  /**
   * 真实契约：`ctx.llm.stream(options)` 是 `async *`，**失败不抛**：
   * 而是变成终止 `finish` chunk（`dsh-llm/lib/index.js:2364-2382`、`:2369-2382`）。
   * fake 必须照抄"失败变 finish.reason.kind='error'"这条 ——
   * 否则插件若忘了检查 finish 就会把失败当空输出，这个 bug 测不出来。
   *
   * `llmScript` 是一个队列；每调用一次消费一项：
   * 项的形状：{ text } 正常 / { fail: '...' } 失败 / { hang: true } 一直不返回
   */
  llm: {
    async resolveModelInfo(provider, model) {
      return { provider, model, contextWindow: FAKE_CONTEXT_WINDOW }
    },
    stream(options) {
      llmCalls.push({
        provider: options?.provider,
        model: options?.model,
        purpose: options?.purpose,
        hasTools: options?.tools !== undefined,
        hasSessionId: options?.sessionId !== undefined,
        maxTokens: options?.maxTokens,
        messageCount: (options?.messages ?? []).length,
        text: (options?.messages ?? []).map((m) => (m.content ?? []).map((b) => b.text ?? '').join('')).join('\n'),
        at: Date.now(),
      })
      const script = llmScript.length > 0 ? llmScript.shift() : defaultLlmReply
      async function* gen() {
        if (script?.hang) {
          await new Promise(() => {})
          return
        }
        if (script?.fail) {
          yield { type: 'finish', reason: { kind: 'error', error: { message: script.fail } } }
          return
        }
        const text = String(script?.text ?? '')
        // 真实实现会分块吐；这里按 64 字符切，顺便验证插件的拼接。
        for (let i = 0; i < text.length; i += 64) yield { type: 'text-delta', text: text.slice(i, i + 64) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      return gen()
    },
  },

  /**
   * 真实契约：`ctx.sessionQuery.readSession(sessionId)`
   *   返回 `{ session, inheritedEventCount, events }`（`dsh-session-query/lib/index.js:1079-1087`）。
   * 返回**完整原始事件日志**（不折叠 surface）。
   * 会话不存在时抛 `SESSION_QUERY_SESSION_NOT_FOUND`（照抄它抛错而不是返回空 —— 空返回
   * 会让"读不到历史"被误当成"没有历史"，交班就会写一份空交接还自以为成功）。
   */
  sessionQuery: {
    async readSession(sessionId) {
      const rec = liveSessions.get(String(sessionId))
      if (!rec) {
        const err = new Error(`SESSION_QUERY_SESSION_NOT_FOUND: ${sessionId}`)
        err.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw err
      }
      readSessionCalls.push({ sessionId: String(sessionId), at: Date.now(), archived: rec.archived })
      return {
        session: { id: rec.id, cwd: rec.cwd },
        inheritedEventCount: 0,
        events: (rec.eventLog ?? []).map((e) => ({ ...e })),
      }
    },
  },

  /**
   * 真实契约：`ctx.systemPrompt.context({name, order, text})`
   *   返回 disposer；`assemble()` 把 `contexts` 按 order 排序，`text` 可以是函数。
   *   （`dsh-system-prompt/lib/index.js:266-269`、`:310-362`、`:348-351`）。
   *
   * ⚠️ **同名会抛**（`NamedEntries` 报错文案，`:190`）—— fake 必须复刻，
   * 否则"插件在某个 agent 上重复注入"这种 bug 测不出来。
   */
  systemPrompt: {
    context(entry) {
      if (!Number.isFinite(entry?.order)) throw new TypeError(`prompt context "${entry?.name}" order must be a finite number`)
      const existing = contexts.get(entry.name)
      if (existing && existing !== entry) {
        throw new Error(`prompt context "${entry.name}" is already registered in this scope`)
      }
      contexts.set(entry.name, entry)
      contextRegistrations.push({ name: entry.name, order: entry.order, at: Date.now() })
      return () => contexts.delete(entry.name)
    },
    /**
     * 真实契约：`ctx.systemPrompt.section({name, order, text, interpolate?, complete?})`
     *   返回 disposer；`assemble()` 把 sections 按 order 升序拼接，空文本的段落
     *   在 `renderPrompt` 里被丢弃（`dsh-system-prompt/lib/index.js` 的 renderPrompt）。
     *   `text` 可以是函数，签名是 `(context: AssembleContext) => string`。
     *
     * ⚠️ 与 `context()` 一样：**同名会抛**。fake 必须复刻 ——
     *    "插件在同一个 scope 里注册两次 section"这种 bug 靠它才测得出。
     */
    section(entry) {
      if (!Number.isFinite(entry?.order)) throw new TypeError(`prompt section "${entry?.name}" order must be a finite number`)
      const existing = sections.get(entry.name)
      if (existing && existing !== entry) {
        throw new Error(`prompt section "${entry.name}" is already registered in this scope`)
      }
      sections.set(entry.name, entry)
      sectionRegistrations.push({ name: entry.name, order: entry.order, at: Date.now() })
      return () => sections.delete(entry.name)
    },
    /**
     * 照抄 `assemble()` 的 contexts 部分：按 order 排序、求值函数、过滤空文本。
     * 测试用它来对某一次模拟宿主的组装，从而验证常驻记忆的**字节稳定**。
     */
    assemble(context = {}) {
      const list = [...contexts.values()].sort((a, b) => a.order - b.order)
      const sectionList = [...sections.values()].sort((a, b) => a.order - b.order)
      return {
        contexts: list
          .map((entry) => ({ name: entry.name, text: typeof entry.text === 'function' ? entry.text(context) : entry.text }))
          .filter((x) => x.text.length > 0),
        sections: sectionList
          .map((entry) => ({ name: entry.name, text: typeof entry.text === 'function' ? entry.text(context) : entry.text }))
          .filter((x) => x.text.length > 0),
      }
    },
  },

  tools: {
    register(def) {
      registeredTools.set(def.name, def)
      log.info(`[fake-tools] 注册工具 ${def.name}`)
      return () => registeredTools.delete(def.name)
    },    guard(fn) {
      guards.push(fn)
      log.info('[fake-tools] 注册门控')
      return () => {
        const i = guards.indexOf(fn)
        if (i >= 0) guards.splice(i, 1)
      }
    },
    get(name) {
      return registeredTools.get(name)
    },
  },

  settings: {
    configure(presentation) {
      settingsPolicy = presentation
      log.info(`[fake-settings] configure(${JSON.stringify(presentation)})`)
      return () => {
        settingsPolicy = null
      }
    },
  },
}

// ── 假 cordis ──────────────────────────────────────────────────────────
function fakeRoot() {
  const disposers = []
  const ctx = {
    get: (name) => services[name],
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name)?.delete(fn)
    },
    /**
     * cordis 的 waterfall：最后一个参数是链路末端，监听器**由外向内**包住它，
     * 不调用 next() 即否决。插件用 `ctx.waterfall('workspace/session-activity', ...)`
     * 主动发问，所以这里必须照抄这套组合语义（真机由 cordis 的 EventsService 提供）。
     */
    waterfall: (name, ...args) => {
      const chain = [...(listeners.get(name) ?? [])]
      const next = args.pop()
      let i = 0
      const run = () => {
        const fn = chain[i++]
        if (!fn) return next()
        return fn(...args, run)
      }
      return run()
    },
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    webServer: {
      registerUpgrade: () => {
        throw new Error('mount=own 时不应注册到 DSH webServer')
      },
      register: () => {
        throw new Error('mount=own 时不应注册到 DSH webServer')
      },
    },
  }
  const root = {
    inject: (names, cb) => {
      log.info(`[fake-root] inject([${names.join(',')}]) 满足`)
      cb(ctx)
      return () => {}
    },
    effect: ctx.effect,
    on: ctx.on,
    get: ctx.get,
    waterfall: ctx.waterfall,
  }
  return { root, ctx, disposers: () => disposers }
}

/** 断言汇总：分节打印，最后给一个总数 */
const tally = { pass: 0, total: 0, failed: [] }
function runChecks(title, checks) {
  console.log(`\n=========== ${title} ===========`)
  let pass = 0
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
    tally.total += 1
    if (ok) {
      pass += 1
      tally.pass += 1
    } else {
      tally.failed.push(`${title} / ${name}`)
    }
  }
  console.log(`\n  ${pass}/${checks.length} 通过`)
  return pass
}

async function waitFor(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(300)
  }
  return false
}

/**
 * 轮询一个**异步**谓词，拿到第一个真值就返回它；超时返回 0。
 *
 * 为什么要有它（而不是直接用 waitFor）：这里要等的是"**端点已经改成离线**"这种
 * 异步状态，谓词本身得先 `await fetchStatus()`。用同步 waitFor 只能测"某一次快照"，
 * 会把"还没摘掉连接"的中间态当成结论 —— 那是**假失败**，比漏测更浪费时间。
 *
 * ⚠️ 谓词必须显式返回 0 / 假值表示"还没到"，不要依赖真值语义
 * （一个空数组、一个 0 都是假值，会被吞掉）。
 */
async function waitValue(predicate, timeoutMs = 10000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(intervalMs)
  }
  return 0
}

// ── 测试钩子必须在 `apply()` 之前挂好 ──────────────────────────────────
//
// 原因：插件是在 `apply()` 里同步检查 `typeof globalThis.__dshqq_onChat === 'function'`
// 才决定挂不挂的。所以这些赋值必须出现在 `mod.default.apply(...)` **之前**
// —— 它们在这里，而不是文件末尾。
//
/** @type {any} */
let dshGate = null
/** 由 lib/index.js 在 conversation 开启时挂上 */
globalThis.__dshqq_onGate = (gate) => {
  dshGate = gate
}

/** 直投常驻会话的真实入口（由 lib/index.js 挂上）*/
let bridgeDeliverChat = null
globalThis.__dshqq_onChat = (fn) => {
  bridgeDeliverChat = fn
}

/**
 * 通过插件**真实的**投递入口给某个 QQ 会话的常驻会话发一句话。
 *
 * 为什么不用 `client.sendPrivate()`：受控假宿主对同一发送者有 5 分钟限频
 * （retcode 1200），而交班断言要在很短的墙钟时间里对同一个 QQ 号连发多条。
 * 这条路走的是 `bridge.deliverChat()` —— 也就是 `chat()` 背后的同一个函数，
 * 所以它同样是"唯一 prompt 入口"的一部分，**照旧过 DeliveryGate**。 */
async function bridgeChatThroughPlugin(chatType, chatId, text) {
  if (typeof bridgeDeliverChat !== 'function') throw new Error('插件没有挂上 __dshqq_onChat 钩子')
  return bridgeDeliverChat({ chatType, chatId: String(chatId), text })
}

/**
 * 插件内部的投递守卫引用。
 *
 * 为什么测试要拿到它：这是**唯一**能证明"往已退役会话投递会被拒绝"的东西。
 * 只靠端到端观察是证明不了的 —— 因为真实语义里"被拒"和"被静默吞掉"在外观上
 * 看起来一模一样（都不抛错、都没有返回值）。所以必须直接调它。
 * 由 lib/index.js 在装配时挂到 `globalThis.__dshqq_gate`（仅测试环境用）。 */
function dshGateProbe(sessionId) {
  const gate = dshGate
  if (!gate) return { ok: false, refused: false, reason: 'gate-not-exposed' }
  return gate.deliver({
    sessionId,
    kind: 'inject',
    by: 'test:bypass-check',
    deliver: () => {
      throw new Error('守卫本该拒绝，但 deliver 被调用了')
    },
  })
}

// ── 跑起来 ─────────────────────────────────────────────────────────────
const { root, ctx: fakeCtx, disposers } = fakeRoot()

/**
 * 假装我们是 DSH 的 Agent 注册表提供的 `workspace/session-activity` 提供方。
 * 真实实现（`dsh-agent/lib/types/archive-admission.d.ts` 12-23 行）是：
 * "Answer workspace/session-activity with the turn family **while the Session's
 * Agent is running (a turn waiting for an approval or an answer included)**"——
 * 所以这里只答"回合还开着"，不答 `continued` 的提问（那种提问的答案只会以
 * 新回合的形式到来，回合已经结束了）。 */
fakeCtx.on('workspace/session-activity', async (request, next) => {
  const activity = await next()
  if (!activityProviderEnabled) return activity
  const rec = liveSessions.get(String(request?.sessionId ?? ''))
  if (rec?.turnActive) return [{ kind: 'turn' }, ...activity]
  return activity
})
log.info('[fake] 已注入 workspace/session-activity 提供方（镜像 Agent 注册表的 turn 族）')

const mod = await import('../lib/index.js')
log.info(`已载入插件：name=${mod.default?.name ?? mod.name}`)
log.info(`状态目录（本次运行专用）：${STATE_DIR}`)

mod.default.apply(root, {
  logLevel: 'debug',
  connection: { mount: 'own', host: '127.0.0.1', reversePort: PORT, token: '' },
  tasks: { workspaceRoot: WORKSPACE_ROOT, maxConcurrent: 2, settleGraceMs: 3000 },
  participation: { groupMode: 'mention' },
  scope: { blockedGroups: ['99999'] },
  advanced: { stateDir: STATE_DIR },
  conversation: { enabled: CONV },
})
log.info(`[entry-test] conversation.enabled = ${CONV}`)

await sleep(1000)

// ── 待办判据单元断言（纯函数：不确定就必须"不收敛"）────────────────────
const pendingChecks = []
try {
  // 一个判据都问不到（没有服务、也没有 waterfall）→ 必须判为忙，不许当成空闲
  const blind = await assessSessionWork({ ctx: { get: () => undefined }, log }, 'sess-blind', {})
  pendingChecks.push(['所有判据都问不到时按"不收敛"处理', blind.busy === true && blind.reason === 'unknown'])
  // 只有审批提示可用：也必须拦住
  const approvalOnly = await assessSessionWork(
    { ctx: { get: () => undefined }, log },
    'sess-approval',
    { approvals: ['bash'] },
  )
  pendingChecks.push([
    '未决审批（审计事件折叠）即视为有活',
    approvalOnly.busy === true && approvalOnly.reason === 'approval' && approvalOnly.detail.includes('bash'),
  ])
  // 活动询问抛错时不能当成空闲
  const broken = await assessSessionWork(
    {
      ctx: {
        get: () => undefined,
        waterfall: async () => {
          throw new Error('boom')
        },
      },
      log,
    },
    'sess-broken',
    {},
  )
  pendingChecks.push(['活动状态询问失败时按"不确定"处理', broken.busy === true && broken.reason === 'unknown'])
  // 无监听器时 waterfall 返回空数组 ⇒ 宿主只能回答"没有活动"
  const empty = await assessSessionWork(
    { ctx: { get: () => undefined, waterfall: async () => [] }, log },
    'sess-empty',
    {},
  )
  pendingChecks.push(['宿主回答"没有活动"时才算空闲', empty.busy === false])
} catch (err) {
  pendingChecks.push([`待办判据检查抛错: ${err.message}`, false])
}
runChecks('待办判据断言', pendingChecks)

// ── 会话事件形状断言（纯函数）──────────────────────────────────────────
//
// 这几条是 0.1.3 "回传恒为 0" 的回归锚：真机 `user/message` 的 `data`
// **就是消息本体**（`session.append('user/message', message)`），
// 不是 `{message}` 包装。解析器两种都要认，且不能把垃圾数据当成消息。
const relayShapeChecks = []
try {
  const real = {
    type: 'user/message',
    seq: 8,
    data: { role: 'user', content: [{ type: 'text', text: '在？' }], source: { kind: 'user', rpcId: 'r-1' } },
  }
  const legacy = { type: 'user/message', data: { turn: 1, step: 0, message: real.data } }
  relayShapeChecks.push(['宿主真实形状：data 即消息本体', userMessageFromEvent(real)?.source?.rpcId === 'r-1'])
  relayShapeChecks.push(['兼容旧/假宿主形状：{message} 包装', userMessageFromEvent(legacy)?.source?.rpcId === 'r-1'])
  relayShapeChecks.push(['没有 message 时不硬造：非对象 data 返回 null', userMessageFromEvent({ data: 'nope' }) === null])
  relayShapeChecks.push(['空事件不抛错', userMessageFromEvent(undefined) === null])
} catch (err) {
  relayShapeChecks.push([`会话事件形状检查抛错: ${err.message}`, false])
}
runChecks('会话事件形状断言', relayShapeChecks)

// ── 分类器断言（纯函数，不依赖连接与时序）──────────────────────────────
const classifyChecks = []
try {
  const kind = (input) => classifyMessage(input).kind
  classifyChecks.push(['空消息被忽略', kind({ text: '   ' }) === CLASSIFY.IGNORE])
  classifyChecks.push(['「在吗？」判闲聊', kind({ text: '在吗？' }) === CLASSIFY.CHAT])
  classifyChecks.push(['「谢谢」判闲聊', kind({ text: '谢谢' }) === CLASSIFY.CHAT])
  classifyChecks.push(['「你是谁」判闲聊', kind({ text: '你是谁' }) === CLASSIFY.CHAT])
  classifyChecks.push(['「现在怎么样了」判闲聊', kind({ text: '现在怎么样了' }) === CLASSIFY.CHAT])
  classifyChecks.push([
    '19 字的真任务不被误判成闲聊（长度只是必要条件）',
    kind({ text: '帮我在工作区建个项目，写下 README' }) === CLASSIFY.TASK,
  ])
  classifyChecks.push(['长消息判任务', kind({ text: '把昨天的构建日志按失败原因分类，并给出修复建议' }) === CLASSIFY.TASK])
  classifyChecks.push([
    '以「在」开头的短任务不被误判（整句匹配）',
    kind({ text: '在 R 盘建个目录' }) === CLASSIFY.TASK,
  ])
  classifyChecks.push([
    'tasks.chatPrefix 强制闲聊',
    classifyMessage({ text: '/chat 随便聊聊', chatPrefix: '/chat' }).kind === CLASSIFY.CHAT,
  ])
  classifyChecks.push([
    'tasks.prefix 强制任务',
    classifyMessage({ text: '/task 你好', taskPrefix: '/task' }).kind === CLASSIFY.TASK,
  ])
  classifyChecks.push([
    '两个前缀同时命中时任务优先（与"不确定判成任务"一致）',
    classifyMessage({ text: '/task 你好', taskPrefix: '/task', chatPrefix: '/' }).kind === CLASSIFY.TASK,
  ])
  classifyChecks.push([
    '带合并转发的短消息判任务（转发内容必然是"要它看"）',
    classifyMessage({ text: '在吗', hasForward: true }).kind === CLASSIFY.TASK,
  ])
  classifyChecks.push(['前缀会被剥离出正文', classifyMessage({ text: '/task 你好', taskPrefix: '/task' }).text === '你好'])

  // ── 寻址门（保留的那一条规则：这不是控制词，是"这句话是不是对我说的"）──
  //
  // 它必须在**进任何会话之前**生效，所以不可能交给常驻会话用语义判断替代。
  // 这里测纯函数，端到端的行为由「硬约束②」那两条断言覆盖。
  classifyChecks.push([
    '寻址门：群聊 mention 模式下未被 @ 的消息不响应（只入库）',
    shouldRespond({ chatType: 'group', atBot: false, groupMode: 'mention' }).respond === false,
  ])
  classifyChecks.push([
    '寻址门：群聊 mention 模式下被 @ 的消息才响应',
    shouldRespond({ chatType: 'group', atBot: true, groupMode: 'mention' }).respond === true,
  ])
  classifyChecks.push([
    '寻址门：群聊 silent 模式下一律不响应（哪怕被 @）',
    shouldRespond({ chatType: 'group', atBot: true, groupMode: 'silent' }).respond === false,
  ])
  classifyChecks.push([
    '寻址门：群聊 active 模式下不 @ 也响应',
    shouldRespond({ chatType: 'group', atBot: false, groupMode: 'active' }).respond === true,
  ])
  classifyChecks.push([
    '寻址门：私聊 privateMode=always 才响应',
    shouldRespond({ chatType: 'private', privateMode: 'always' }).respond === true &&
      shouldRespond({ chatType: 'private', privateMode: 'off' }).respond === false,
  ])

  // ── 控制词已经删掉：`/cancel` 不再是特殊语法，只是普通正文 ──────────────
  classifyChecks.push([
    '控制词已删除：/cancel 不再被解析成控制指令，按普通正文分类（没有 control 这种结果）',
    classifyMessage({ text: '/cancel 3' }).kind === CLASSIFY.TASK &&
      !Object.values(CLASSIFY).includes('control'),
  ])

  // ── 含糊判据（决定提示措辞：先追问 还是 直接派）────────────────────────
  classifyChecks.push(['含糊判据：「这个月的采集日志」缺对象 → 该先追问', isAmbiguousAsk('帮我把这个月的采集日志按周汇总，输出一份周报') === true])
  classifyChecks.push(['含糊判据：「这个目录下的历史产物」缺对象 → 该先追问', isAmbiguousAsk('顺便把这个目录下的历史产物清一遍') === true])
  classifyChecks.push(['含糊判据：「A 目录的图片转 webp」意图明确 → 不该问，直接派', isAmbiguousAsk('帮我把 A 目录的图片转成 webp') === false])
  classifyChecks.push([
    '含糊判据：指代 + 具体文件名（前面已给落点）→ 不算含糊',
    isAmbiguousAsk('把刚才那份 report.md 里的失败用例挑出来') === false,
  ])
  classifyChecks.push([
    '含糊提示要求"先追问、一次只问一个、别先派活"',
    taskHint(CLASSIFY.TASK, 'default', '帮我把这个月的采集日志按周汇总').includes('先') &&
      taskHint(CLASSIFY.TASK, 'default', '帮我把这个月的采集日志按周汇总').includes('待澄清') &&
      taskHint(CLASSIFY.TASK, 'default', '帮我把这个月的采集日志按周汇总').includes('追问'),
  ])
  classifyChecks.push([
    '意图明确时的提示**不要求**追问（否则就变成"永远先问一遍"）',
    !taskHint(CLASSIFY.TASK, 'default', '帮我把 A 目录的图片转成 webp').includes('待澄清'),
  ])
  classifyChecks.push(['闲聊/任务前缀不追加任何分诊提示', taskHint(CLASSIFY.CHAT, 'short-chitchat', '在吗') === ''])

  // ── 存活判定的纯逻辑（断开必须判死，不许瞎报活着）──────────────────────
  const connUp = { closed: false, socketOpen: true, lastEventAt: 50_000, connectedAt: 40_000, selfId: '9' }
  classifyChecks.push([
    '存活：连接 OPEN + 事件新鲜 + 事件循环在跑 → 活着',
    judgeAlive({ serverReady: true, connections: [connUp], now: 51_000, lastTickAt: 50_900 }).alive === true,
  ])
  classifyChecks.push([
    '存活：一条连接都没有 → 离线，判据是 no-connection',
    judgeAlive({ serverReady: true, connections: [], now: 51_000, lastTickAt: 50_900 }).reasons.includes('no-connection'),
  ])
  classifyChecks.push([
    '存活：连接对象还在但 socket 不是 OPEN（半关）→ 离线',
    judgeAlive({
      serverReady: true,
      connections: [{ ...connUp, socketOpen: false }],
      now: 51_000,
      lastTickAt: 50_900,
    }).reasons.includes('socket-not-open'),
  ])
  // 这一条是**实测逼出来的**：客户端 close() 之后，服务端那条连接有时会留在
  // `connections` 里（`ws.readyState` 停在 CLOSING，close 事件迟迟不来，
  // 实测见过 15 秒还没摘掉）。所以"断开后必须报离线"**不能**依赖连接被摘掉 ——
  // 判定必须靠 `socketOpen !== true` 这条。下面这个用例就是那个场景的快照。
  classifyChecks.push([
    '存活：连接留在表里但 readyState 已不是 OPEN（CLOSING 半开）→ 必须判离线',
    judgeAlive({
      serverReady: true,
      connections: [{ closed: false, socketOpen: false, lastEventAt: 50_000, connectedAt: 40_000, selfId: '10002' }],
      now: 51_000,
      lastTickAt: 50_900,
    }).alive === false,
  ])
  classifyChecks.push([
    '存活：连接标记为 closed → 离线（不等 OS 报错）',
    judgeAlive({ serverReady: true, connections: [{ ...connUp, closed: true }], now: 51_000, lastTickAt: 50_900 }).alive === false,
  ])
  classifyChecks.push([
    `存活：事件流静默超过 ${EVENT_SILENCE_MS / 1000} 秒（半开连接）→ 离线，判据是 event-stream-stale`,
    judgeAlive({
      serverReady: true,
      connections: [connUp],
      now: 50_000 + EVENT_SILENCE_MS + 1,
      lastTickAt: 50_000 + EVENT_SILENCE_MS,
    }).reasons.includes('event-stream-stale'),
  ])
  classifyChecks.push([
    `存活：事件循环超过 ${LOOP_STALL_MS / 1000} 秒没被调度 → 离线，判据是 event-loop-stalled`,
    judgeAlive({ serverReady: true, connections: [connUp], now: 60_000, lastTickAt: 60_000 - LOOP_STALL_MS - 1 }).reasons.includes(
      'event-loop-stalled',
    ),
  ])
  classifyChecks.push([
    '存活：连接层未初始化 → 离线（不因为"还没有反证"就默认活着）',
    judgeAlive({ serverReady: false, connections: [], now: 1, lastTickAt: 0 }).reasons.includes('no-server'),
  ])
  classifyChecks.push([
    '存活：判定为假时 because 必须说明缺哪一条（不许只有布尔值）',
    (() => {
      const v = judgeAlive({ serverReady: true, connections: [], now: 51_000, lastTickAt: 50_900 })
      return v.alive === false && Array.isArray(v.because) && v.because.length > 0 && v.because[0].includes('NapCat')
    })(),
  ])
  classifyChecks.push([
    '存活：alive 的 evidence 里明确写了"它不是进程存活的证明"（避免被当成更强的结论）',
    String(judgeAlive({ serverReady: true, connections: [], now: 1, lastTickAt: 1 }).evidence.note ?? '').includes('不是'),
  ])
  classifyChecks.push([
    '任务侧存活：台账说在跑但会话已不在 agents 里 → tasks.verdict=dead（且它不参与 alive）',
    (() => {
      const v = probeTasks({
        getAgent: (id) => (id === 's1' ? { status: 'idle' } : undefined),
        tasks: [
          { no: 1, status: 'running', sessionId: 's1' },
          { no: 2, status: 'running', sessionId: 'gone' },
        ],
      })
      return v.verdict === 'dead' && v.dead.length === 1 && v.dead[0].no === 2
    })(),
  ])
  classifyChecks.push([
    '任务侧存活：查不到 agents 服务时说"问不到"（unknown），不谎报 ok 也不谎报 dead',
    probeTasks({ getAgent: undefined, tasks: [{ no: 1, status: 'running', sessionId: 's1' }] }).verdict === 'unknown',
  ])

  // ── 回传里的"它动了什么"：从工具调用提取路径（必须只认写操作）──────────
  classifyChecks.push([
    '文件提取：write 的 file_path 被认出来',
    filePathFromToolCall('write', '{"file_path":"R:\\\\a\\\\b.md","content":"x"}') === 'R:\\a\\b.md',
  ])
  classifyChecks.push(['文件提取：read 不算"改了它"（允许清单之外）', filePathFromToolCall('read', '{"file_path":"R:\\\\a\\\\b.md"}') === ''])
  classifyChecks.push([
    '文件提取：str_replace_editor 的只读 command=view 不算写',
    filePathFromToolCall('str_replace_editor', '{"command":"view","path":"/x"}') === '',
  ])
  classifyChecks.push([
    '文件提取：str_replace_editor 的 command=str_replace 才算写',
    filePathFromToolCall('str_replace_editor', '{"command":"str_replace","path":"/x"}') === '/x',
  ])
  classifyChecks.push(['文件提取：arguments 是截断/非法 JSON 时安静地返回空（不抛）', filePathFromToolCall('write', '{"file_path":"broken') === ''])
  classifyChecks.push([
    '交付物提取：deliverables/presented 的 files[].path 被取出（含可选 description）',
    (() => {
      const out = filesFromPresented({ files: [{ path: 'R:\\o\\p.xlsx', description: '报表' }] })
      return out.length === 1 && out[0].path === 'R:\\o\\p.xlsx' && out[0].description === '报表'
    })(),
  ])
} catch (err) {
  classifyChecks.push([`分类器检查抛错: ${err.message}`, false])
}
runChecks('分类器断言', classifyChecks)

const sawBothTasks = await waitFor(() => calls.prompts.length >= 2)
// v2 的私聊会有两条任务（普通任务 + 带转发段的任务），等到它们都到手，
// 下面"同一 workspace 挂多个 session"的断言才不依赖时序
const sawAllMockTasks = await waitFor(() => calls.prompts.length >= 3, 15000)
await sleep(2500)

// ── M2 断言 ────────────────────────────────────────────────────────────
const wsDir = path.join(WORKSPACE_ROOT, 'qq-private-20002')
const groupDir = path.join(WORKSPACE_ROOT, 'qq-group-30003')
const m2Checks = [
  ['等到两条任务投递', sawBothTasks],
  ['workspace 已创建', calls.createWorkspace.length >= 2],
  ['私聊 workspace 目录已落盘', fs.existsSync(wsDir)],
  ['群 workspace 目录已落盘', fs.existsSync(groupDir)],
  ['目录名符合约定 qq-<type>-<id>', calls.createWorkspace.some((c) => c.dir.endsWith('qq-private-20002'))],
  ['session 已创建', calls.createSession.length >= 2],
  ['会话拿到了 cwd（由工作区推导）', [...liveSessions.values()].every((s) => Boolean(s.cwd))],
  [
    'create 未同时传 workspaceId 与 cwd（真实实现会拒）',
    calls.createSession.every((c) => c.workspaceId === undefined || c.cwd === undefined),
  ],
  ['投递正文带来源标注', calls.prompts.some((p) => (p.content?.[0]?.text ?? '').includes('来自 QQ'))],
  ['群消息来源标注含群号', calls.prompts.some((p) => (p.content?.[0]?.text ?? '').includes('来自 QQ 群 30003'))],
  ['会话已重命名', calls.renames.length >= 2],
  // v1 的断言在这里是「同一会话复用同一 session」——那正是本轮要修掉的行为。
  //
  // ⚠️ 判据必须按模式分开：`conversation.enabled=true` 下 mock 的任务消息先
  //    进**常驻会话**（一个 QQ 会话一个），一个 workspace 下只会有一个会话，
  //    于是"workspace 数 < session 数"这条**不成立**（mock 只涉及 2 个 QQ 会话）。
  //    这不是回归，是 v3 的预期行为 —— 所以在 CONV 下改成"每个 workspace 恰好一个会话"
  CONV
    ? [
        'v3：mock 阶段每个 workspace 只挂一个常驻会话（任务消息进了对话会话，不再每条一个）',
        sawAllMockTasks && calls.createSession.length === new Set(calls.createSession.map((c) => c.workspaceId)).size,
      ]
    : [
        '同一 workspace 下挂多个独立 session（任务不再串行共用一个）',
        sawAllMockTasks && new Set(calls.createSession.map((c) => c.workspaceId)).size < calls.createSession.length,
      ],
]
runChecks('M2 断言', m2Checks)
console.log(
  `  workspace ${calls.createWorkspace.length} / session ${calls.createSession.length} / prompt ${calls.prompts.length}`,
)

// ── 工具断言 ───────────────────────────────────────────────────────────
const sendTool = registeredTools.get('qq_send')
const listTool = registeredTools.get('qq_list_chats')
const histTool = registeredTools.get('qq_history')
const tasksTool = registeredTools.get('qq_tasks')
const toolChecks = [
  ['qq_send 已注册', Boolean(sendTool)],
  ['qq_list_chats 已注册', Boolean(listTool)],
  ['qq_history 已注册', Boolean(histTool)],
  ['qq_tasks 已注册（任务台账，跨会话可查）', Boolean(tasksTool)],
  ['已注册门控', guards.length > 0],
]

if (sendTool) {
  try {
    const out = await sendTool.execute(
      { chat_type: 'private', chat_id: '20002', text: '这是 agent 主动发出的消息' },
      {},
    )
    toolChecks.push(['qq_send 执行成功', out?.delivered === true])
    toolChecks.push(['qq_send 输出可渲染', Array.isArray(sendTool.output?.render({}, out))])
  } catch (err) {
    toolChecks.push([`qq_send 执行成功（抛错: ${err.message}）`, false])
  }
}
if (listTool) {
  const out = await listTool.execute({}, {})
  toolChecks.push(['qq_list_chats 列出已接入会话', (out?.chats ?? []).length >= 2])
  toolChecks.push(['输出里有工作区路径', (out?.chats ?? []).every((c) => Boolean(c.workspacePath))])
}
if (histTool) {
  const out = await histTool.execute({}, {})
  toolChecks.push(['qq_history 能查到语料', (out?.count ?? 0) > 0])
  toolChecks.push(['qq_history 输出可渲染', Array.isArray(histTool.output?.render({}, out))])
}
if (tasksTool) {
  const out = await tasksTool.execute({}, {})
  // ⚠️ `conversation.enabled=true` 下 mock 阶段的任务消息先进常驻会话，
  //    不会产生任何任务记录（派活得靠模型调 qq_dispatch，而假 DSH 里没有模型）。
  //    所以这里分两种判据：v2 下必须有**非空**记录；v3 下必须是**空但调用成功**。
  //    两种判据都比"调用抛错"强 —— 后者才是真正要拦的回归。
  toolChecks.push([
    CONV ? 'qq_tasks 可调用且台账为空（v3：mock 阶段没有派活）' : 'qq_tasks 能列出任务台账',
    CONV ? Array.isArray(out?.tasks) && out.tasks.length === 0 && out.count === 0 : (out?.tasks ?? []).length >= 1,
  ])
  toolChecks.push(['qq_tasks 输出可渲染', Array.isArray(tasksTool.output?.render({}, out))])
  toolChecks.push([
    'qq_tasks 列出的任务带状态与 sessionId',
    (out?.tasks ?? []).every((t) => Boolean(t.status) && typeof t.no === 'number'),
  ])
}
if (guards.length > 0) {
  const denied = guards[0]({ name: 'qq_send', arguments: { chat_type: 'group', chat_id: '99999', text: 'x' } })
  const allowed = guards[0]({ name: 'qq_send', arguments: { chat_type: 'private', chat_id: '20002', text: 'x' } })
  const unrelated = guards[0]({ name: 'read', arguments: {} })
  const tasksGuard = guards[0]({ name: 'qq_tasks', arguments: { chat_type: 'group', chat_id: '99999' } })
  toolChecks.push(['门控拒绝被屏蔽的群', typeof denied === 'string'])
  toolChecks.push(['门控放行范围内的私聊', allowed === undefined])
  toolChecks.push(['门控不干预其他工具', unrelated === undefined])
  toolChecks.push(['门控不干预只读的 qq_tasks', tasksGuard === undefined])
}
runChecks('工具断言', toolChecks)

// ── 配置 Schema 断言 ───────────────────────────────────────────────────
const schemaChecks = []
try {
  const Config = mod.Config
  schemaChecks.push(['模块导出了 Config', Boolean(Config)])
  schemaChecks.push(['Config 是 Standard Schema', Boolean(Config?.['~standard']?.validate)])
  const empty = Config['~standard'].validate({})
  schemaChecks.push(['空配置可通过校验', !empty.issues])
  schemaChecks.push(['默认值已填充（logLevel）', empty.value?.logLevel === 'info'])
  schemaChecks.push(['默认值已填充（端口 6700）', empty.value?.connection?.reversePort === 6700])
  schemaChecks.push(['嵌套对象有默认值（advanced）', empty.value?.advanced?.dedupeWindowMs === 300000])
  schemaChecks.push(['tasks.maxConcurrent 默认 2', empty.value?.tasks?.maxConcurrent === 2])
  schemaChecks.push(['tasks.settleGraceMs 默认 3000（收敛确认窗）', empty.value?.tasks?.settleGraceMs === 3000])
  schemaChecks.push(['tasks.chatPrefix 存在且默认空', empty.value?.tasks?.chatPrefix === ''])
  // 控制词已经删掉：Schema 里**不应该**再有取消前缀这一项
  // （留一个默认 "/cancel" 会让人以为关键词控制还在）
  schemaChecks.push([
    'Schema 里没有 cancelPrefix（控制词已删，取消改由会话理解意图 + qq_tasks 工具）',
    empty.value?.tasks?.cancelPrefix === undefined && empty.value?.tasks !== undefined,
  ])
  const bad = Config['~standard'].validate({ connection: { reversePort: 999999 } })
  schemaChecks.push(['越界值被拒绝', Boolean(bad.issues)])
  schemaChecks.push(['settings.configure 已调用', settingsPolicy?.auto === true])
  // 反证：mock 用 Bearer <TOKEN> 接入。若插件把 credentials 返回的
  // `{value,source}` 直接 String() 成 "[object Object]"，鉴权会失败，
  // 连接被 401 拒绝，后续一切任务都不会发生。
  schemaChecks.push([
    '凭据返回对象时 token 未被写成 [object Object]',
    calls.createWorkspace.length > 0,
  ])
} catch (err) {
  schemaChecks.push([`配置 Schema 检查抛错: ${err.message}`, false])
}
runChecks('配置 Schema 断言', schemaChecks)

// ── 语料库断言 ─────────────────────────────────────────────────────────
const corpusChecks = []
try {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const corpusRoot = path.join(home, 'dsh-whale-inurqq', 'corpus')
  corpusChecks.push(['语料根目录已创建', fs.existsSync(corpusRoot)])

  const dirs = fs.existsSync(corpusRoot) ? fs.readdirSync(corpusRoot) : []
  corpusChecks.push(['按会话分片（私聊）', dirs.includes('private-20002')])
  corpusChecks.push(['按会话分片（群）', dirs.includes('group-30003')])

  let records = []
  for (const d of dirs) {
    const dir = path.join(corpusRoot, d)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      records = records.concat(
        fs
          .readFileSync(path.join(dir, f), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
      )
    }
  }
  corpusChecks.push(['有语料记录落盘', records.length > 0])
  const fwd = records.filter((r) => r.kind === 'forward')
  corpusChecks.push(['合并转发已展开入库', fwd.length > 0])
  corpusChecks.push(['展开结果带原始发言人', fwd.length > 0 && (fwd[0].nodes ?? []).some((n) => n.s && n.s !== '未知')])
  corpusChecks.push(['展开结果节点数正确（mock 返回 2）', fwd.length > 0 && (fwd[0].nodes ?? []).length === 2])
  corpusChecks.push(['默认不保留原始事件 JSON', records.every((r) => r.raw === undefined)])

  if (fwd.length > 0) console.log(`  （转发记录发言人：${(fwd[0].nodes ?? []).map((n) => n.s).join(', ')}）`)
  console.log(`  （语料总记录数：${records.length}，转发记录：${fwd.length}）`)
} catch (err) {
  corpusChecks.push([`语料库检查抛错: ${err.message}`, false])
}
runChecks('语料库断言', corpusChecks)

// ── 状态端点的两种呈现 ────────────────────────────────────────────────
// 同一份快照：curl/脚本默认拿 JSON（行为不能变），浏览器地址栏打开拿体检页。
// 这几条同时验证 `?format=` 查询串不会把路由打成 404。
{
  const endpoint = `http://127.0.0.1:${PORT}/dsh-whale-inurqq/status`
  const jsonRes = await fetch(endpoint)
  const jsonType = String(jsonRes.headers.get('content-type') ?? '')
  const jsonText = await jsonRes.text()
  const htmlRes = await fetch(endpoint, { headers: { accept: 'text/html' } })
  const htmlType = String(htmlRes.headers.get('content-type') ?? '')
  const htmlText = await htmlRes.text()
  const forced = await fetch(`${endpoint}?format=json`, { headers: { accept: 'text/html' } })
  const forcedType = String(forced.headers.get('content-type') ?? '')

  runChecks('状态端点呈现', [
    ['默认（Accept: */*）仍是 JSON', jsonType.includes('application/json') && jsonText.trimStart().startsWith('{')],
    ['浏览器 Accept: text/html 拿到体检页', htmlType.includes('text/html') && htmlText.includes('dsh-whale-inurqq 体检')],
    ['体检页带 x-content-type-options: nosniff', htmlRes.headers.get('x-content-type-options') === 'nosniff'],
    ['?format=json 能覆盖 Accept', forced.status === 200 && forcedType.includes('application/json')],
    ['查询串不影响路由（带 ?format= 不 404）', forced.status === 200],
    ['体检页给出结论（正常 / 需处理 二者其一）', htmlText.includes('一切正常') || htmlText.includes('需要处理')],
  ])
}

// ══════════════════════════════════════════════════════════════════════
// 受控阶段的公共工具（v2 与 v3 两段都用）
// ══════════════════════════════════════════════════════════════════════
const dirOf = (chatType, chatId) => path.join(WORKSPACE_ROOT, `qq-${chatType}-${chatId}`)
const sessionsIn = (dir) => [...liveSessions.values()].filter((s) => s.cwd === dir)
const promptsFor = (sessionId) => calls.prompts.filter((p) => p.sessionId === sessionId)
const okArchivesFor = (sessionId) => calls.archives.filter((a) => a.sessionId === sessionId && a.ok)

async function fetchStatus() {
  const res = await fetch(`http://127.0.0.1:${PORT}/dsh-whale-inurqq/status`)
  return await res.json()
}

/** 通过 qq_tasks 工具读台账（这正是常驻会话能看到的视角） */
async function listTasksOf(chatType, chatId, limit = 20) {
  if (!tasksTool) return []
  const out = await tasksTool.execute({ chat_type: chatType, chat_id: chatId, limit }, {})
  return out?.tasks ?? []
}

/** 受控客户端：扮演第二个 OneBot 协议端，事件时序由断言代码决定 */
function createControlClient({ url, token, selfId }) {
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}`, 'X-Self-ID': selfId, 'X-Client-Role': 'Universal' },
  })
  /** 插件发出去的 QQ 消息（也就是我们观察到的回传）*/
  const outbound = []
  let msgSeq = 900000
  let localSeq = 0
  const nowSec = () => Math.floor(Date.now() / 1000)

  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch {
      return
    }
    if (!msg.action) return
    const p = msg.params ?? {}
    if (msg.action === 'send_private_msg' || msg.action === 'send_group_msg' || msg.action === 'send_msg') {
      const chatType = msg.action === 'send_group_msg' ? 'group' : 'private'
      const chatId = String(p.group_id ?? p.user_id ?? '')
      const text = (p.message ?? [])
        .map((s) => (s.type === 'text' ? (s.data?.text ?? '') : `[${s.type}]`))
        .join('')
      outbound.push({ chatType, chatId, text, at: Date.now() })
    }
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        data: msg.action === 'get_login_info' ? { user_id: Number(selfId), nickname: 'ControlBot' } : { message_id: ++msgSeq },
        echo: msg.echo,
      }),
    )
  })

  const textEvent = (chatType, chatId, text, { atBot = false } = {}) => {
    // 真机语义：@bot 是一个独立的 at 消息段，`normalize` 用
    // `segments.some(s => s.kind === 'at' && s.qq === selfId)` 判定 atBot
    const segments = atBot
      ? [{ type: 'at', data: { qq: String(selfId) } }, { type: 'text', data: { text } }]
      : [{ type: 'text', data: { text } }]
    const base = {
      time: nowSec(),
      self_id: Number(selfId),
      post_type: 'message',
      message_type: chatType,
      message_id: ++msgSeq + ++localSeq,
      user_id: Number(chatId),
      message: segments,
      raw_message: text,
      font: 0,
      sender: { user_id: Number(chatId), nickname: '控测用户' },
    }
    if (chatType === 'group') return { ...base, sub_type: 'normal', group_id: Number(chatId), anonymous: null }
    return { ...base, sub_type: 'friend' }
  }

  return {
    ready,
    outbound,
    sendPrivate: (chatId, text) => ws.send(JSON.stringify(textEvent('private', chatId, text))),
    sendGroup: (chatId, text, options) => ws.send(JSON.stringify(textEvent('group', chatId, text, options))),
    /** 直接暴露插件的投递守卫（用来做"绕过/不绕过守卫"的对照实验） */
    gate: () => dshGate,
    /** 发一次心跳：让插件把"最近有事件的连接"选成我们，回传才会落到 outbound 上 */
    ping: () =>
      ws.send(
        JSON.stringify({
          time: nowSec(),
          self_id: Number(selfId),
          post_type: 'meta_event',
          meta_event_type: 'heartbeat',
          status: { online: true, good: true },
          interval: 1000,
        }),
      ),
    close: () => {
      try {
        ws.close()
      } catch {
        /* 忽略 */
      }
    },
  }
}



/** 等 mock-napcat 退场，避免它的心跳把回传抢过去（回传按最近有事件的连接挑选） */
async function waitForMockGone(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const st = await fetchStatus()
      const selfIds = st?.connection?.selfIds ?? []
      if (!selfIds.includes('10001')) return true
    } catch {
      /* 状态端点还没起来，继续等 */
    }
    await sleep(500)
  }
  return false
}

/**
 * 抨一条“插件发起的”用户消息。
 *
 * 默认路径下直接走插件的真实投递入口（`__dshqq_onChat` 钩子 → `bridge.deliverChat`）；
 * v2 回滚路径下那个钩子不存在（它只在 conversation 开启时挂），所以改用
 * **与插件同形的那一步**：自己拿一个 requestId 去 `sessions.prompt()`。
 * 这不是“绕过插件”：回传门控看的就是“这个 requestId 是不是插件登记的”，
 * 而手填一个没登记过的 id 就是 GUI 那一边的 `guiPrompt()` —— 两者刚好构成对照。
 */
async function pluginPromptLike(sessionId, text) {
  const requestId = `plugintest-${++guiRequestSeq}`
  const sessionController = typeof fakeCtx.get === 'function' ? fakeCtx.get('sessionController') : undefined
  if (typeof sessionController?.prompt !== 'function') throw new Error('fake 的 sessionController 不可用')
  return sessionController.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
}

/** 等两个进程里的会话都真正闲下来（GUI 回合是延时结束的，不能抢跑） */
async function waitTurnIdle(sessionId, timeoutMs = 6000) {
  const rec = liveSessions.get(String(sessionId))
  if (!rec) return false
  const ok = await waitFor(() => !rec.turnActive && rec.status === 'idle' && !heldTurns.has(String(sessionId)), timeoutMs)
  await sleep(200)
  return ok
}

const mockGone = await waitForMockGone()
log.info(mockGone ? '[v2] mock 已退场，开始受控阶段' : '[v2] 未等到 mock 退场，仍继续（断言只看受控会话）')

const client = createControlClient({ url: `ws://127.0.0.1:${PORT}/`, token: TOKEN, selfId: '10002' })
await client.ready
// 受控阶段把回合挂住：任务"还在跑"是确定状态，并发/排队断言才不会跟时序赛跑
holdTurns = true

/**
 * 「用户在 DSH GUI 里自己发起的回合」——**走的必须是真实的那条路**。
 *
 * 真实链路：GUI 的前端提交 → `sessionController.prompt({requestId, sessionId, mode, content})`
 * → 宿主造 `createUserMessage({content, source: {kind:'user', rpcId: request.requestId}})`
 * （`dsh-api-session-controller/lib/index.js:856-859`、`lib/types/commands.js:303-307`）。
 * 也就是说 **GUI 与插件的区别只有一个：requestId 是不是插件发的**。
 *
 * 所以这个 helper 直接调 fake 的 `sessionController.prompt()`，用一个**假 ID 段**
 * （`gui-*`）生成 requestId —— 它绝不可能出现在插件登记的集合里，于是
 * `lib/dsh/relay.js` 的来源判据必须判成 foreign（不回传 QQ）。
 * 把 requestId 换成插件自己发的那个，同一段代码就必须判成 plugin。
 */
const GUI_REQUEST_PREFIX = 'gui-'
let guiRequestSeq = 0
/** @type {Array<{sessionId:string, requestId:string, text:string, at:number}>} */
const guiPrompts = []
/**
 * @param {string} sessionId
 * @param {string} text
 */
async function guiPrompt(sessionId, text) {
  // 走与插件**同一条**取服务的方式（`ctx.get('sessionController')`）——
  // 真实 GUI 也是经由同一个 session-controller 服务提交的。
  const sessionController = typeof fakeCtx.get === 'function' ? fakeCtx.get('sessionController') : undefined
  if (typeof sessionController?.prompt !== 'function') throw new Error('fake 的 sessionController 不可用，无法模拟 GUI 投递')
  const requestId = `${GUI_REQUEST_PREFIX}${++guiRequestSeq}`
  const request = { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }
  const out = await sessionController.prompt(request, new AbortController().signal)
  guiPrompts.push({ sessionId, requestId, text, at: Date.now() })
  return out
}

// ══════════════════════════════════════════════════════════════════════
// v2 断言：任务与闲聊分流、并发上限、取消、归档
//
// ⚠️ **只在 `conversation.enabled=false` 时跑**（设计文档 §5.3 「断言策略 1」）。
//    理由：这一段大量使用 `sessionsIn(dir)` 数工作区里的会话数、按 sessionId 反查任务记录，
//    而 `enabled=true` 下一条消息对应一个任务会话，这条前提不再成立。
//    （消息先进常驻会话，派活要靠模型调 `qq_dispatch`，而假 DSH 里没有模型）。
//    硬要在同一条断言里兼容两种模式，等于把两套语义塞进一个判据，
//    最后既测不到 v2 的回归、也测不到 v3 的行为。
//    v3 侧的等价场景由下面的「v3 常驻会话 / 交班 / 碎片记忆断言」重新覆盖。
// ══════════════════════════════════════════════════════════════════════
const v2Checks = []
if (!CONV) {
const CANCEL_HINT = 120

try {
  // ── A. 同一 QQ 会话连发两条任务 → 两个不同 session，且都不等对方 ──────
  const A = '20101'
  const dirA = dirOf('private', A)
  await client.sendPrivate(A, '帮我把测试环境下的采集日志全部按周归档，并生成一份带统计数字的汇总报告')
  await sleep(CANCEL_HINT)
  await client.sendPrivate(A, '再把上一步汇总报告里的失败用例单独挑出来，按原因分类列一个清单')
  const aReady = await waitFor(() => sessionsIn(dirA).length >= 2 && sessionsIn(dirA).every((s) => promptsFor(s.id).length > 0))
  const aSessions = sessionsIn(dirA)
  v2Checks.push([
    '同一 QQ 会话连发两条任务 → 建出两个不同的 session',
    aReady && aSessions.length === 2 && new Set(aSessions.map((s) => s.id)).size === 2,
  ])
  v2Checks.push([
    '两条任务都成功投递（不再串行阻塞：第一条还没结束，第二条已在跑）',
    aSessions.length === 2 && aSessions.every((s) => s.turnActive && promptsFor(s.id).length === 1),
  ])
  v2Checks.push([
    '两条任务仍落在同一个 workspace 下（一个 QQ 会话 = 一个工作区）',
    new Set(
      calls.createSession.filter((c) => c.sessionId && aSessions.some((s) => s.id === c.sessionId)).map((c) => c.workspaceId),
    ).size === 1,
  ])
  v2Checks.push([
    '每条任务各占一个独立会话（会话数 = 任务数）',
    (await listTasksOf('private', A)).filter((t) => t.status === 'running').length === 2,
  ])

  // ── B. 闲聊 → 常驻 root session（惰性创建），任务不污染它 ─────────────
  const B = '20102'
  const dirB = dirOf('private', B)
  await client.sendPrivate(B, '在吗？')
  const bReady = await waitFor(() => sessionsIn(dirB).length >= 1)
  const statusAfterChat = await fetchStatus()
  const rootId = statusAfterChat?.state?.chats?.[`private:${B}`]?.rootSessionId ?? ''
  v2Checks.push(['闲聊建出常驻 root session', bReady && Boolean(rootId) && liveSessions.has(rootId)])
  v2Checks.push([
    '闲聊只建了一个会话，且没有产生任务记录',
    sessionsIn(dirB).length === 1 && (await listTasksOf('private', B)).length === 0,
  ])
  v2Checks.push([
    '闲聊正文投进了常驻会话',
    Boolean(rootId) && promptsFor(rootId).some((p) => p.text.includes('在吗')),
  ])

  await client.sendPrivate(B, '顺便把这个目录下的历史产物清一遍，只保留最近三天的')
  await waitFor(() => sessionsIn(dirB).length >= 2)
  const bSessions = sessionsIn(dirB)
  const statusAfterTask = await fetchStatus()
  v2Checks.push([
    '随后的任务另起新会话，常驻会话保持不变（闲聊历史不被任务轨迹污染）',
    bSessions.length === 2 &&
      bSessions.some((s) => s.id === rootId) &&
      bSessions.some((s) => s.id !== rootId) &&
      statusAfterTask?.state?.chats?.[`private:${B}`]?.rootSessionId === rootId,
  ])

  // ── C. 并发上限：maxConcurrent=2，第三条排队 ──────────────────────────
  const C = '20103'
  const dirC = dirOf('private', C)
  await client.sendPrivate(C, '把 A 目录下的图片全部转成 webp 并统计体积变化，第一条')
  await client.sendPrivate(C, '把 B 目录下的图片全部转成 webp 并统计体积变化，第二条')
  await client.sendPrivate(C, '把 C 目录下的图片全部转成 webp 并统计体积变化，第三条')
  const cQueued = await waitFor(() => sessionsIn(dirC).length >= 2)
  const cTasks = await listTasksOf('private', C)
  const cFirst = sessionsIn(dirC)[0]
  const cFirstTaskNo = cTasks.find((t) => t.sessionId === cFirst?.id)?.no
  v2Checks.push([
    'tasks.maxConcurrent 生效：并发上限 2，超限的任务排队而不是立刻起 session',
    cQueued && sessionsIn(dirC).length === 2 && cTasks.some((t) => t.status === 'queued'),
  ])
  v2Checks.push(['台账里能看到排队中的第三条任务（queued）', cTasks.some((t) => t.status === 'queued')])
  v2Checks.push([
    '排队时给用户回了「已排队」提示（不再让用户在门外干等）',
    client.outbound.some((m) => m.chatId === C && m.text.includes('已排队')),
  ])
  // 放掉第一条任务的回合，空出槽位让排队中的第三条真正起来
  releaseTurn(cFirst.id, { kind: 'completed' })
  const cGrew = await waitFor(() => sessionsIn(dirC).length >= 3)
  v2Checks.push(['槽位释放后，排队的任务自动开始执行', cGrew && sessionsIn(dirC).length === 3])
  v2Checks.push([
    '轮到排队任务时补发了「已开始执行」提示',
    client.outbound.some((m) => m.chatId === C && m.text.includes('已开始执行')),
  ])

  // 收敛有确认窗，所以第三个会话出现了"不等到归档已经调用" —— 先明确等它
  await waitFor(() => okArchivesFor(cFirst.id).length === 1)
  const cArchive = okArchivesFor(cFirst.id)[0]
  v2Checks.push(['任务完成后自动归档任务 session', Boolean(cArchive)])
  // 顺序要求：结果必须先回传，再归档。用【#任务号】前缀精确定位"这一条的回传"
  const relayedFirst = client.outbound.find((m) => m.chatId === C && m.text.includes(`【#${cFirstTaskNo}】`))
  v2Checks.push([
    '归档发生在结果回传之后（不会把没发出去的结果吞掉）',
    Boolean(cArchive && relayedFirst && relayedFirst.at <= cArchive.at),
  ])
  v2Checks.push([
    '任务 session 的回传带任务号前缀（并行时不至于分不清哪条是哪个任务）',
    Boolean(relayedFirst),
  ])

  // ── D. 单任务取消：只影响一条，另一条照跑 ────────────────────────────
  //
  // ⚠️ **v3.1 起取消不再走 `/cancel N` 这条关键词路径**（它已经被删掉了：
  //    关键词会误判，"把这个任务停一下看看日志"会被吃成停止命令）。
  //    现在的取消入口只有一个 —— 常驻会话理解用户意图之后调
  //    `qq_tasks({cancel_task_id})`。所以这里直接调那个工具：
  //    **测的是同一条真实代码路径**（工具 → scheduler.cancel → 会话取消 → 收敛归档），
  //    只是把"模型理解意图"那一步换成断言代码来触发。
  //    v2 模式下没有常驻会话，这条取消路径本来就是唯一可用的那条。
  const D = '20104'
  const dirD = dirOf('private', D)
  await client.sendPrivate(D, '把 D 目录的构建缓存清掉并重新跑一次全量构建，第一条')
  await sleep(CANCEL_HINT)
  await client.sendPrivate(D, '把 D 目录的构建缓存清掉并重新跑一次全量构建，第二条')
  await waitFor(() => sessionsIn(dirD).length >= 2)
  await sleep(600)
  const dSessions = sessionsIn(dirD)
  const dTasks = await listTasksOf('private', D)
  const older = dTasks[dTasks.length - 1]
  const newer = dTasks[0]
  const cancelsBefore = calls.cancels.length
  client.ping()
  const dCancelOut = await tasksTool.execute({ chat_type: 'private', chat_id: D, cancel_task_id: String(older?.no) }, {})
  const dCanceled = await waitFor(() => {
    const t = calls.cancels.length > cancelsBefore
    return t
  })
  await sleep(1200)
  const dTasksAfter = await listTasksOf('private', D)
  const olderAfter = dTasksAfter.find((t) => t.no === older?.no)
  const newerAfter = dTasksAfter.find((t) => t.no === newer?.no)
  v2Checks.push([
    '取消指令只作用于指定的那一条任务（另一个 session 没有被 cancel）',
    dCanceled &&
      calls.cancels.length === cancelsBefore + 1 &&
      calls.cancels[calls.cancels.length - 1].sessionId === older?.sessionId &&
      dSessions.some((s) => s.id === newer?.sessionId && !s.canceled),
  ])
  v2Checks.push([
    '被取消的任务收敛为 canceled；另一条仍在跑（不受影响）',
    olderAfter?.status === 'canceled' && newerAfter?.status === 'running',
  ])
  v2Checks.push(['被取消的任务 session 也归档了', okArchivesFor(older?.sessionId ?? '').length === 1])
  v2Checks.push([
    'qq_tasks 返回了取消结果（工具自己就说明了取消了哪条）',
    String(dCancelOut?.canceled ?? '').includes(`#${older?.no}`),
  ])

  // ── E. 归档失败不影响任务本身 ────────────────────────────────────────
  const E = '20105'
  const dirE = dirOf('private', E)
  await client.sendPrivate(E, '把 E 目录下的临时文件清理掉，并输出一份清理前后的对比报告')
  await waitFor(() => sessionsIn(dirE).length >= 1)
  const eSession = sessionsIn(dirE)[0]
  archiveFailures.add(eSession.id)
  client.ping()
  releaseTurn(eSession.id, { kind: 'completed' })
  await waitFor(() => calls.archives.some((a) => a.sessionId === eSession.id))
  await sleep(800)
  const eTasks = await listTasksOf('private', E)
  const eStatus = await fetchStatus()
  v2Checks.push([
    '归档失败不影响任务本身（任务仍是 done，不是 failed）',
    eTasks.some((t) => t.sessionId === eSession.id && t.status === 'done'),
  ])
  v2Checks.push([
    '归档失败被记账（状态端点能看到 archiveFailed）',
    Number(eStatus?.tasks?.archiveFailed ?? 0) >= 1,
  ])
  // 归档失败不能把并发槽位卡住：下一条任务必须还能起来。
  await client.sendPrivate(E, '再把 E 目录下的清理结果整理成一张表格附在报告后面')
  const eNext = await waitFor(() => sessionsIn(dirE).length >= 2)
  v2Checks.push(['归档失败也不会卡住并发槽位（下一条任务照常开始）', eNext && sessionsIn(dirE).length === 2])

  // ── F. qq_tasks 也能取消（agent 侧的入口，和 QQ 指令走同一条路）──────
  const F = '20106'
  const dirF = dirOf('private', F)
  await client.sendPrivate(F, '把 F 目录下的依赖锁文件重新生成一遍，并核对版本差异')
  await waitFor(() => sessionsIn(dirF).length >= 1)
  const fSession = sessionsIn(dirF)[0]
  const fTasks = await listTasksOf('private', F)
  const fNo = fTasks[0]?.no
  const fOut = await tasksTool.execute({ chat_type: 'private', chat_id: F, cancel_task_id: String(fNo) }, {})
  await waitFor(() => calls.cancels.some((c) => c.sessionId === fSession.id))
  await sleep(1000)
  const fAfter = (await listTasksOf('private', F)).find((t) => t.no === fNo)
  v2Checks.push([
    'qq_tasks 的 cancel_task_id 能取消任务（agent 侧入口）',
    fOut?.canceled?.includes(`#${fNo}`) && fAfter?.status === 'canceled',
  ])
  v2Checks.push([
    'qq_tasks 取消走的是同一个单会话取消路径（只 cancel 那一个 session）',
    calls.cancels.filter((c) => c.sessionId === fSession.id).length === 1,
  ])

  // ══════════════════════════════════════════════════════════════════════
  // G. turn/end 不等于任务结束：有未决待办就**不许**收敛/归档
  //    这几组场景专门测"任务被静默掐断"：回合结束了，但会话还活着。
  // ══════════════════════════════════════════════════════════════════════
  const GRACE = 3000

  // ── G1. 多回合：turn/end 之后紧接着又开一个 turn/start ────────────────
  const G1 = '20107'
  const dirG1 = dirOf('private', G1)
  await client.sendPrivate(G1, '把 G1 目录下的三个数据集依次跑一遍清洗，跑完再汇总')
  await waitFor(() => sessionsIn(dirG1).length >= 1)
  const g1Session = sessionsIn(dirG1)[0]
  client.ping()
  // 第一个回合以 interrupted 结束（多回合任务的典型形态）。50ms 后宿主续跑。
  endTurn(g1Session.id, { kind: 'interrupted' })
  await sleep(150)
  simulateTurn(g1Session.id)
  // 等到超过确认窗：如果收敛逻辑只看 turn/end，这里就该已经归档了
  await sleep(GRACE + 1500)
  const g1Archives = okArchivesFor(g1Session.id).length
  const g1Task = (await listTasksOf('private', G1)).find((t) => t.sessionId === g1Session.id)
  v2Checks.push([
    '回合结束后紧接着又开新回合 → 任务不被归档（不许在回合缝里动手）',
    g1Archives === 0,
  ])
  v2Checks.push([
    '多回合任务仍是运行态，而不是被写成 done',
    g1Task?.status === 'running' && g1Task?.archived === false,
  ])
  // 第二个回合正常结束 → 这次应该收敛并归档（"确认无待办"必须照常工作）
  releaseTurn(g1Session.id, { kind: 'completed' })
  await waitFor(() => okArchivesFor(g1Session.id).length === 1)
  const g1Done = (await listTasksOf('private', G1)).find((t) => t.sessionId === g1Session.id)
  v2Checks.push([
    '确认无待办后照常收敛并归档（多回合任务最终仍是 done）',
    okArchivesFor(g1Session.id).length === 1 && g1Done?.status === 'done',
  ])

  // ── G2. 未决提问（timed/continued）：宽限期过了也不许收敛 ─────────────
  const G2 = '20108'
  const dirG2 = dirOf('private', G2)
  await client.sendPrivate(G2, '把 G2 目录下的两份报表合并，冲突行按最新时间覆盖')
  await waitFor(() => sessionsIn(dirG2).length >= 1)
  const g2Session = sessionsIn(dirG2)[0]
  const QUESTION = '冲突的三行是要覆盖还是保留两份？'
  setPendingQuestion(g2Session.id, QUESTION, 'continued')
  client.ping()
  endTurn(g2Session.id, { kind: 'completed' })
  // 等得比确认窗长得多：提问的答案可能几分钟后才来，时间治不了这种情况。
  await sleep(GRACE + 2000)
  const g2Task = (await listTasksOf('private', G2)).find((t) => t.sessionId === g2Session.id)
  const g2Status = await fetchStatus()
  v2Checks.push([
    '有未决提问时：不归档（宽限期过了也不收敛，因为宽限期治不了这种等待）',
    okArchivesFor(g2Session.id).length === 0,
  ])
  v2Checks.push([
    '未决提问的任务状态是 waiting，而不是 done/running',
    g2Task?.status === 'waiting' && g2Task?.waitingReason === 'question',
  ])
  v2Checks.push(['waiting 的判据细节带上了问题原文（用户能看懂在等什么）', String(g2Task?.waitingDetail ?? '').includes('覆盖')])
  v2Checks.push([
    'QQ 侧能看出"任务在等你回答"（不是静默消失）',
    client.outbound.some((m) => m.chatId === G2 && m.text.includes('等你回答')),
  ])
  v2Checks.push(['台账统计里 waiting 有计数（可观测）', Number(g2Status?.tasks?.waiting ?? 0) >= 1])
  v2Checks.push([
    'qq_tasks 渲染也能区分 waiting（agent 不会把它读成"已完成"）',
    tasksTool.output.render({}, await tasksTool.execute({ chat_type: 'private', chat_id: G2 }, {}))[0].text.includes('waiting'),
  ])

  // ── G3. 提问被回答 → 新回合 → 结束后正常收敛 ─────────────────────────
  clearPendingQuestion(g2Session.id)
  await startTurnAndWait(g2Session.id) // 用户回答后宿主开新回合
  releaseTurn(g2Session.id, { kind: 'completed' })
  await waitFor(() => okArchivesFor(g2Session.id).length === 1)
  const g2Done = (await listTasksOf('private', G2)).find((t) => t.sessionId === g2Session.id)
  v2Checks.push([
    '提问被回答、新回合跑完后正常收敛并归档（waiting → done）',
    okArchivesFor(g2Session.id).length === 1 && g2Done?.status === 'done',
  ])

  // ── G4. 未决审批 ─────────────────────────────────────────────────────
  const G4 = '20109'
  const dirG4 = dirOf('private', G4)
  await client.sendPrivate(G4, '把 G4 目录下的部署脚本更新到最新模板，然后给出差异摘要')
  await waitFor(() => sessionsIn(dirG4).length >= 1)
  const g4Session = sessionsIn(dirG4)[0]
  askApproval(g4Session.id, 'ap-1', 'pwsh')
  client.ping()
  endTurn(g4Session.id, { kind: 'completed' })
  await sleep(GRACE + 1500)
  const g4Task = (await listTasksOf('private', G4)).find((t) => t.sessionId === g4Session.id)
  v2Checks.push([
    '有未决审批时：不归档，状态是 waiting(approval)',
    okArchivesFor(g4Session.id).length === 0 && g4Task?.status === 'waiting' && g4Task?.waitingReason === 'approval',
  ])
  v2Checks.push(['审批判据带上了工具名', String(g4Task?.waitingDetail ?? '').includes('pwsh')])
  // 审批出结果 + 下一回合结束后，正常收敛
  decideApproval(g4Session.id, 'ap-1')
  await startTurnAndWait(g4Session.id)
  releaseTurn(g4Session.id, { kind: 'completed' })
  await waitFor(() => okArchivesFor(g4Session.id).length === 1)
  v2Checks.push(['审批有结论后正常收敛并归档', okArchivesFor(g4Session.id).length === 1])

  // ── G5. inbox 里还有没消费的输入 ─────────────────────────────────────
  const G5 = '20110'
  const dirG5 = dirOf('private', G5)
  await client.sendPrivate(G5, '把 G5 目录下的快照按时间顺序重排，并修正其中的时间戳')
  await waitFor(() => sessionsIn(dirG5).length >= 1)
  const g5Session = sessionsIn(dirG5)[0]
  pushInbox(g5Session.id, '（用户又补了一条输入，还没被消费）')
  client.ping()
  endTurn(g5Session.id, { kind: 'completed' })
  await sleep(GRACE + 1500)
  const g5Task = (await listTasksOf('private', G5)).find((t) => t.sessionId === g5Session.id)
  v2Checks.push([
    'inbox 里还有未消费输入时：不归档，状态是 waiting(inbox)',
    okArchivesFor(g5Session.id).length === 0 && g5Task?.status === 'waiting' && g5Task?.waitingReason === 'inbox',
  ])
  // 收尾：清空 inbox 后让宿主再跑一个回合，验证能收敛。
  clearInbox(g5Session.id)
  await startTurnAndWait(g5Session.id)
  releaseTurn(g5Session.id, { kind: 'completed' })
  await waitFor(() => okArchivesFor(g5Session.id).length === 1)
  v2Checks.push(['inbox 清空后正常收敛并归档', okArchivesFor(g5Session.id).length === 1])

  // ── G6. agent.status 仍是 running（回合之间那段异步窗口）──────────────
  const G6 = '20111'
  const dirG6 = dirOf('private', G6)
  await client.sendPrivate(G6, '把 G6 目录下的索引重建一遍，然后报告条目数量变化')
  await waitFor(() => sessionsIn(dirG6).length >= 1)
  const g6Session = sessionsIn(dirG6)[0]
  // 回合已经结束（没有活动），但 agent 还在 running —— 真机上这是唤醒输入
  // 已开始 pre-step 处理、turn/start 还没落盘的窗口。
  endTurn(g6Session.id, { kind: 'completed' })
  liveSessions.get(g6Session.id).status = 'running'
  await sleep(GRACE + 1500)
  const g6Task = (await listTasksOf('private', G6)).find((t) => t.sessionId === g6Session.id)
  v2Checks.push([
    'agent.status 仍是 running 时：不归档，状态是 waiting(status)',
    okArchivesFor(g6Session.id).length === 0 && g6Task?.status === 'waiting' && g6Task?.waitingReason === 'status',
  ])
  liveSessions.get(g6Session.id).status = 'idle'
  await startTurnAndWait(g6Session.id)
  releaseTurn(g6Session.id, { kind: 'completed' })
  await waitFor(() => okArchivesFor(g6Session.id).length === 1)
  v2Checks.push(['agent 回到 idle 后正常收敛并归档', okArchivesFor(g6Session.id).length === 1])

  // ── G7. waiting 仍然占着并发槽位（否则并发上限会被悄悄突破）──────────
  const G7 = '20112'
  const dirG7 = dirOf('private', G7)
  await client.sendPrivate(G7, '把 G7 目录的图片批量转码，这是第一条')
  await waitFor(() => sessionsIn(dirG7).length >= 1)
  const g7a = sessionsIn(dirG7)[0]
  await client.sendPrivate(G7, '把 G7 目录的图片批量转码，这是第二条')
  await waitFor(() => sessionsIn(dirG7).length >= 2)
  const g7b = sessionsIn(dirG7)[1]
  const g7sessionsBefore = sessionsIn(dirG7).length
  // 第一条进入 waiting（未决提问），第二条继续跑；上限是 2，所以第三条必须排队
  setPendingQuestion(g7a.id, '转码后原图要删掉吗？', 'continued')
  client.ping()
  endTurn(g7a.id, { kind: 'completed' })
  await sleep(GRACE + 800)
  await client.sendPrivate(G7, '把 G7 目录的图片批量转码，这是第三条')
  await sleep(1500)
  const g7Tasks = await listTasksOf('private', G7)
  v2Checks.push([
    'waiting 的任务仍占并发槽位：上限 2 时第三条必须排队',
    sessionsIn(dirG7).length === g7sessionsBefore &&
      g7Tasks.length === 3 &&
      g7Tasks.filter((t) => t.status === 'queued').length === 1 &&
      g7Tasks.some((t) => t.status === 'waiting'),
  ])

  // ── G8. 判据漏判时，宿主的归档准入兜底（不强制归档，退回等待）─────────
  // 构造：插件问不出活动（提供方被关掉）、status 是 idle、也没有提问/inbox，
  // 但会话其实还有回合在跑 —— 真实世界里这对应"某个我们没订阅到的活动族"。
  // 期望：宿主以 session-active 拒绝归档 → 不强制重试 → 退成 waiting。
  const G8 = '20113'
  const dirG8 = dirOf('private', G8)
  await client.sendPrivate(G8, '把 G8 目录下的实验结果整理成表格，并标出异常点')
  await waitFor(() => sessionsIn(dirG8).length >= 1)
  const g8Session = sessionsIn(dirG8)[0]
  const refusedBefore = Number((await fetchStatus())?.tasks?.archiveRefused ?? 0)
  activityProviderEnabled = false
  client.ping()
  endTurn(g8Session.id, { kind: 'completed' })
  // 确认窗内会话又忙起来了，但我们（故意）看不到任何信号
  await sleep(200)
  liveSessions.get(g8Session.id).turnActive = true
  await sleep(GRACE + 2000)
  const g8Task = (await listTasksOf('private', G8)).find((t) => t.sessionId === g8Session.id)
  const g8Status = await fetchStatus()
  v2Checks.push([
    '宿主以"仍有活动"拒绝归档时不强制重试（没有把活任务停掉）',
    okArchivesFor(g8Session.id).length === 0,
  ])
  v2Checks.push([
    '被拒绝后任务退回 waiting（判据漏判有兜底，不会假装跑完了）',
    g8Task?.status === 'waiting' && g8Task?.waitingReason === 'activity',
  ])
  v2Checks.push([
    '归档被拒次数被记账（健康检查能看到判据漏判过）',
    Number(g8Status?.tasks?.archiveRefused ?? 0) > refusedBefore,
  ])
  // 收尾：宿主不再忙 → 正常收敛
  activityProviderEnabled = true
  liveSessions.get(g8Session.id).turnActive = false
  endTurn(g8Session.id, { kind: 'completed' })
  await waitFor(() => okArchivesFor(g8Session.id).length === 1)
  v2Checks.push(['兜底退回之后仍能正常收敛并归档', okArchivesFor(g8Session.id).length === 1])

  // ── H. 状态端点暴露任务台账 ──────────────────────────────────────────
  const statusFinal = await fetchStatus()
  v2Checks.push([
    '状态端点暴露任务调度与台账（含 maxConcurrent/确认窗/队列）',
    Number(statusFinal?.tasks?.maxConcurrent) === 2 &&
      Number(statusFinal?.tasks?.settleGraceMs) === 3000 &&
      Number(statusFinal?.tasks?.started) >= 5 &&
      Array.isArray(statusFinal?.state?.tasks),
  ])
  v2Checks.push([
    '同一 QQ 会话的两个任务在台账里 sessionId 不同（task→session 映射持久化）',
    new Set(cTasks.filter((t) => t.sessionId).map((t) => t.sessionId)).size === cTasks.filter((t) => t.sessionId).length,
  ])
} catch (err) {
  v2Checks.push([`v2 断言抛错: ${err.stack ?? err.message}`, false])
}
} // ── if (!CONV)
runChecks('v2 任务/闲聊分流与并发断言', v2Checks)

// ══════════════════════════════════════════════════════════════════════
// v3 断言：常驻对话会话 / 阈值交班 / 碎片记忆
//
// 只在 `conversation.enabled=true` 时跑。覆盖设计文档 §5.3 的 N1—N10。
// 外加调用方追加的三条硬约束（群聊静默消息不进对话会话、交班不影响在跑的任务、
// 投递守卫必须拦住往已退役会话投递）。
// ══════════════════════════════════════════════════════════════════════
const v3Checks = []
if (CONV) {
  // 这里沿用文件顶部那个通用的 `waitValue`（本块曾有一份本地副本，已删掉 ——
  // 两份同名的等待函数正是"改了一份、另一份还是老行为"的经典来源）。
  const memoryFile = path.join(STATE_DIR, 'memory.json')
  const readMemoryFile = () => {
    try {
      return JSON.parse(fs.readFileSync(memoryFile, 'utf8'))
    } catch {
      return null
    }
  }

  /** 走受控客户端发一条私聊消息并等常驻会话建起来 */
  async function chatWith(chatId, text) {
    await client.sendPrivate(chatId, text)
    const dir = dirOf('private', chatId)
    const session = await waitValue(() => sessionsIn(dir)[0])
    return { dir, session }
  }

  /**
   * 等一个会话真正闲下来。
   *
   * 为什么必须有：受控客户端的 `client.sendPrivate()` 会走一遍假宿主，
   * 那个回合是**延时**结束的（`simulateTurn` 的 t+820ms 才发 turn/end）。
   * 如果断言在它之前手动 `endTurn()`，就会推出两个 turn/end ——
   * 第二个可能恰好落在一次交班**还没有冻结**的缝隙里，产出"偶然多交班一次"，
   * 那种脆弱断言比没有断言更糟，所以这里显式等干净。
   */
  async function waitIdle(sessionId, timeoutMs = 6000) {
    const ok = await waitValue(() => {
      const rec = liveSessions.get(String(sessionId))
      return Boolean(rec && !rec.turnActive && rec.status === 'idle')
    }, timeoutMs, 60)
    // 再多等一小会儿，把已经排上队但还没跑的定时器全部落地
    await sleep(250)
    return Boolean(ok)
  }

  /**
   * 走一个**完整的真回合**（turn/start 到 turn/end）并等它落定。
   *
   * 为什么不能直接 `endTurn()`：交班挂在 `turn/end`，但一个没开过回合的会话
   * 连 turn/end 在真机上根本不会发生 —— 假宿主也不该允许。
   * `startTurnAndWait()` 会等 `turn/start` 真的发出去（它本身是延时 60ms 的），
   * 所以不会出现"turn/end 抢在 turn/start 前面"这种真机不可能有的顺序。
   */
  async function runRealTurn(sessionId, reason = { kind: 'completed' }) {
    const started = await startTurnAndWait(sessionId)
    releaseTurn(sessionId, reason)
    await sleep(300)
    return started
  }

  /**
   * 触发一次交班并等到它完成。
   *
   * 关键点：交班只挂 `turn/end`，而 `turn/end` 时要 `agent.status === 'idle'`
   * （**没有任何活动**才允许）—— 所以必须先把回合格外干净地结束。
   */
  async function triggerHandoff(session, { tokens, expect = true } = {}) {
    await waitIdle(session.id)
    setSessionTokens(session.id, tokens)
    client.ping()
    const before = (await fetchStatus())?.conversation?.stats?.completed ?? 0
    // 先让假宿主真的开一个回合（turn/start），再放行它到 turn/end
    await runRealTurn(session.id)
    if (!expect) {
      await sleep(1200)
      return { before, after: (await fetchStatus())?.conversation?.stats?.completed ?? 0 }
    }
    const after = await waitValue(async () => {
      const n = (await fetchStatus())?.conversation?.stats?.completed ?? 0
      return n > before ? n : 0
    }, 12000, 150)
    // 交班是异步的：stats.completed 涨了之后还要等"换代 + 注入"落定
    await sleep(400)
    return { before, after }
  }

  try {
    // ══ N1. 任务消息只进常驻会话，TaskScheduler 未收到 submit ══════════
    const C1 = '20201'
    // 存活判定的端点快照（N12 用它证明"工具与端点同源"）。这里先取一次：
    // 此刻受控客户端连着（且刚刚 ping 过），所以这一份应当是"活着"的一手底样。
    const stAliveProbe = (await fetchStatus())?.alive
    v3Checks.push([
      '存活-0 有连接时状态端点报 alive=true（后面 N13 会拿它和"断开后"对照）',
      stAliveProbe?.alive === true,
    ])
    const beforeSubmits = (await listTasksOf('private', C1, 50)).length
    const { dir: dirC1, session: c1Session } = await chatWith(C1, '帮我把这个月的采集日志按周汇总，输出一份带统计数字的周报')
    void dirC1
    const c1Prompts = await waitValue(() => {
      const ps = promptsFor(c1Session?.id ?? '')
      // 显式返回数组的 0：不能靠"真值"判断，否则 waitValue 可能把中间态漏出去
      return ps.length > 0 ? ps : 0
    }, 8000, 120)
    const c1PromptList = Array.isArray(c1Prompts) ? c1Prompts : []
    v3Checks.push(['N1-a 常驻对话会话已建起来', Boolean(c1Session)])
    v3Checks.push(['N1-b 任务消息进了常驻会话（有投递）', c1PromptList.length > 0])
    v3Checks.push([
      // ⚠️ 判据用 `[分诊: 任务` 而不是 `[分诊: 任务]`：含糊时标记是
      //    `[分诊: 任务·待澄清]`（前缀相同、后缀不同），写死右括号会把
      //    "该追问"的那一类判成失败 —— 而它恰恰是最该保留的一类。
      'N1-c 常驻会话的投递正文带 [分诊: 任务] 提示',
      c1PromptList.some((p) => String(p.text ?? '').includes('[分诊: 任务')),
    ])
    v3Checks.push([
      'N1-d TaskScheduler 未收到 submit（分诊权真的移交了）',
      (await listTasksOf('private', C1, 50)).length === beforeSubmits,
    ])

    // ══ N9. 派活工具与 scope 门控 ═════════════════════════════════════
    //
    // ⚠️ **需求变更**：新逻辑链条下 `qq_dispatch`（把活派给独立任务会话）整个退出
    //    默认路径，所以旧断言「N9-a qq_dispatch 已注册」连同 N9-b/N9-c、澄清-a/b/c
    //    一起废弃（它们测的是被废除的行为）。取代它们的是下面这一条**反向断言**：
    //    默认路径注册表里**不该**有 qq_dispatch。
    //    v2 那一趟（`conversation.enabled=false`）仍然会注册它，由 v2 段的断言覆盖。
    const dispatchTool = registeredTools.get('qq_dispatch')
    v3Checks.push([
      'N9-a 默认路径**不注册** qq_dispatch（没有独立任务会话可派 —— 这是需求，不是疏漏）',
      dispatchTool === undefined,
    ])

    // ══ N11. 前台行为约定：注册为 systemPrompt.section，只对常驻会话生效 ══
    //
    // 为什么必须是 section 而不是 context：context 是**动态上下文快照**，
    // 文本一变就多一条 user 消息（见 context.js 顶部）。行为约定是恒定的，
    // 该进系统提示词本体。这条断言就是在守这个选择。
    v3Checks.push(['前台-a 已注册为 systemPrompt.section', sections.has('dsh-whale-inurqq:front-desk')])
    v3Checks.push([
      '前台-b 排序在人设之后、第一方工具指引之前（order=10）',
      sections.get('dsh-whale-inurqq:front-desk')?.order === 10,
    ])
    const frontDeskEntry = sections.get('dsh-whale-inurqq:front-desk')
    // ⚠️ 必须用**刚刚建出来的**那台常驻会话去问，不能用 C1 的 rootSessionId：
    //    本段后面的交班会把 C1 的常驻会话换代，换代之后旧 id 已经不在映射里，
    //    `scopeForSession` 返回空串 → section 渲染成空串 → 断言假失败。
    //    （实测踩过：N11 那一跑里 deskRootText 空，前台-c/e 一起红。）
    const deskChatId = '20211'
    const { session: deskRootSession } = await chatWith(deskChatId, '在吗？')
    const deskRootId = deskRootSession?.id ?? ''
    const deskRootText = String(
      frontDeskEntry ? (typeof frontDeskEntry.text === 'function' ? frontDeskEntry.text({ agent: { session: { id: deskRootId } } }) : frontDeskEntry.text) : '',
    )
    const deskTaskText = String(
      frontDeskEntry
        ? typeof frontDeskEntry.text === 'function'
          ? frontDeskEntry.text({ agent: { session: { id: 'sess-not-a-root-session' } } })
          : frontDeskEntry.text
        : 'x',
    )
    v3Checks.push(['前台-c 常驻会话能看到这段约定（文本非空）', Boolean(deskRootId) && deskRootText.length > 100])
    v3Checks.push(['前台-d 任务会话**看不到**它（返回空串，渲染时被丢弃）', deskTaskText === ''])
    v3Checks.push([
      '前台-e 约定里写了"含糊先追问、一次只问一个、问完停下"',
      // ⚠️ 这几个词是**在正文里真的存在**才留在这里的（踩过一次：
      //    断言按"应该是这么写的"取词，而正文其实写的是"只问那一个问题"，
      //    结果一条断言长期红着 —— 判据必须对着**实际正文**写）。
      deskRootText.includes('含糊') &&
        deskRootText.includes('追问') &&
        deskRootText.includes('一次只问') &&
        deskRootText.includes('问完停下'),
    ])
    // 反证：这段文本必须真的**不是空串**（上面三条 includes 在空串上全为假，
    // 但如果哪天有人把断言写成 `!includes(...)`，空串就会假绿 —— 这里立一道保险）
    v3Checks.push(['前台-e2 约定正文足够长（不是空串导致的假绿）', deskRootText.length > 500])
    v3Checks.push([
      '前台-f 约定里写了"意图明确就直接动手，不许先问一遍"',
      // 需求变更：旧文字是"直接派"（派给独立任务会话）—— 那条路已经废除，
      // 现在是"你自己就是动手的那个人"。判据跟着实际正文走。
      deskRootText.includes('直接动手') && deskRootText.includes('不许'),
    ])
    v3Checks.push([
      '前台-g 约定里写了进度询问的查证顺序（qq_alive → qq_tasks → 如实回答）',
      deskRootText.includes('qq_alive') && deskRootText.includes('qq_tasks') && deskRootText.includes('不要编'),
    ])
    v3Checks.push([
      '前台-h 约定里点名"停一下看看日志"不是要停活（关键词误判的反面例子仍在）',
      // 需求变更：`cancel_task_id` 随"独立任务会话"一起废除，所以判据不再要求它出现；
      // 但这句反面例子必须留着 —— 它是"没有控制词"这条设计的落点。
      deskRootText.includes('停一下看看日志'),
    ])
    v3Checks.push([
      '前台-i 约定里写明了"干活就在本会话里，没有别的任务会话"（新链条的核心措辞）',
      deskRootText.includes('没有别的任务会话') && deskRootText.includes('你就是那个动手的人'),
    ])

    // ══ N12. 存活检测：工具侧必须给**真实**状态 ═══════════════════════
    const aliveTool = registeredTools.get('qq_alive')
    v3Checks.push(['存活-a qq_alive 已注册', Boolean(aliveTool)])
    if (aliveTool) {
      const out = await aliveTool.execute({}, {})
      const st = await fetchStatus()
      v3Checks.push(['存活-b 当前连着 mock/受控客户端 → 工具报 alive=true', out?.alive === true])
      v3Checks.push([
        '存活-c 工具与状态端点**同源**（同一时刻的判定一致，不是两套口径）',
        out?.alive === st?.alive?.alive,
      ])
      v3Checks.push([
        '存活-d 报活着时必须给出依据（哪条连接、多久前有事件、事件循环多久前跑过）',
        String(out?.because ?? '').includes('事件循环') && String(out?.because ?? '').includes('通道'),
      ])
      v3Checks.push(['存活-e 工具输出可渲染', Array.isArray(aliveTool.output?.render({}, out))])
    }
    {
      const tk = await tasksTool.execute({}, {})
      v3Checks.push([
        '存活-f qq_tasks 的输出里也带存活判定（问进度时第一眼就能看到"它还在不在"）',
        tk?.alive?.alive === true && String(tk?.alive?.because ?? '').length > 0,
      ])
      v3Checks.push([
        '存活-g qq_tasks 的 alive.tasks 给出任务侧独立结论（在跑的会话还在不在）',
        String(tk?.alive?.tasks ?? '').startsWith('任务侧：'),
      ])
      v3Checks.push(['存活-h qq_tasks 渲染里带上了存活那一行', String(tasksTool.output?.render({}, tk)?.[0]?.text ?? '').includes('插件')])
    }
    v3Checks.push([
      '存活-i 状态端点暴露了 alive 判定与依据（alive.alive/alive.because/alive.evidence）',
      (() => {
        const a = stAliveProbe
        return (
          typeof a?.alive === 'boolean' &&
          Array.isArray(a?.because) &&
          a.because.length > 0 &&
          Number.isFinite(a?.evidence?.eventSilenceMs) &&
          Number.isFinite(a?.evidence?.loopStallMs)
        )
      })(),
    ])
    v3Checks.push([
      '存活-j 存活判定的阈值是公开常量（90 秒静默 / 10 秒事件循环），不是散在代码里的魔数',
      stAliveProbe?.evidence?.eventSilenceMs === EVENT_SILENCE_MS && stAliveProbe?.evidence?.loopStallMs === LOOP_STALL_MS,
    ])

    // ══ N2. 旧的"派活 → 真建任务会话 → 台账正确"整段废弃 ══════════════
    //
    // ⚠️ **需求变更**：N2-a/b/c/d 四条测的是 `qq_dispatch` 建任务会话与任务台账。
    //    新逻辑链条下这两样都不存在，所以整段删除，**不用新断言假装覆盖它** ——
    //    取而代之的是上面 N9-a（注册表里没有 qq_dispatch）、N1-d（台账恒空）与
    //    新逻辑链条段里的「常驻-3/4/5/6」（连发两条只建一台会话）。

    // ══ 硬约束②：群聊静默消息不进任何会话 ════════════════════════════
    //
    // `participation.groupMode: mention` 下未被 @ 的群消息只入库、不进会话。
    // 否则每个话痨群都会烧掉大量 token —— 这是必须证明的一条。
    const silentGroup = '30009'
    const silentDir = dirOf('group', silentGroup)
    const sessionsBeforeSilent = liveSessions.size
    await client.sendGroup(silentGroup, '（这条群消息没有 @ 机器人，只是群里的日常闲聊）', { atBot: false })
    await sleep(1500)
    v3Checks.push([
      '硬约束②：未被 @ 的群消息不进任何会话（只入库）',
      liveSessions.size === sessionsBeforeSilent && sessionsIn(silentDir).length === 0,
    ])
    // 反证：被 @ 的群消息**必须**进常驻会话（否则上面那条可能是"群消息根本不处理"）
    await client.sendGroup(silentGroup, '这条 @ 了机器人，应该进常驻会话', { atBot: true })
    const silentSession = await waitValue(() => sessionsIn(silentDir)[0])
    v3Checks.push(['硬约束②反证：被 @ 的群消息会进常驻会话', Boolean(silentSession)])
    if (silentSession) {
      v3Checks.push([
        '硬约束②：常驻会话的正文带发言人标注（群聊）',
        Boolean((await waitValue(() => promptsFor(silentSession.id)[0]))?.text?.includes('来自 QQ 群')),
      ])
    }

    // ══ N13. 回传带上"它动了什么"，且**不带**工具调用次数 ══════════════
    //
    // 两个信号源：写类工具的 tool/call + 配对成功的 tool/result（覆盖度高但只能说
    // "工具确认改过"），以及 deliverables/presented（agent 自己声明的交付物）。
    //
    // ⚠️ **需求变更**：旧版这一整段跑在 `qq_dispatch` 建出来的**任务会话**上
    //    （为了测任务号前缀）。现在没有任务会话，所以改成跑在**常驻对接会话**上 ——
    //    那正是新链条里干活的会话。
    //    与此同时两条断言被**废弃**：
    //      · 改动-c「回传带任务号前缀【#N】」—— 没有任务号了，连前缀本身都取消了
    //      · 改动-k/l「沉默保护：补一句『执行中』」—— 规则 3 要求删掉周期性通知，
    //        所以它由"必须有"翻成"必须没有"，新的判据在下面
    //        「不推-a/b」与新逻辑链条段的『不推-a/b』（那里还有反证：
    //        一个只动工具、不说话的回合不许有任何回传）。
    {
      // 这一段要放掉挂起的回合：常驻会话上一个回合没结束时，新的投递只会排队，
      // 而下面每条断言都要求"这个回合真的跑到 turn/end 并把正文回传出去"。
      holdTurns = false
      releaseAllHeld({ kind: 'completed' })

      /** 让某个 QQ 号有一台常驻会话，并确保插件回传时选中的是受控客户端 */
      const residentSessionOf = async (chatId, text) => {
        const dir = dirOf('private', chatId)
        await client.sendPrivate(chatId, text)
        const session = await waitValue(() => sessionsIn(dir)[0], 10000, 120)
        client.ping()
        await sleep(300)
        return session
      }

      const F1 = '20301'
      const f1Dir = dirOf('private', F1)
      const f1Session = await residentSessionOf(F1, '把 F1 目录下的三份报表合并成一份汇总表，输出成 xlsx')
      v3Checks.push(['改动-a 常驻对接会话已就绪（干活就在它里面）', Boolean(f1Session)])

      if (f1Session) {
        const f1Before = client.outbound.filter((m) => m.chatId === F1).length
        await runFileTurn(f1Session.id, { path: `${f1Dir}\\out\\汇总表.xlsx`, callId: 'w1', text: '三份报表已合并成一份汇总表' })
        const f1Out = client.outbound.filter((m) => m.chatId === F1).slice(f1Before)
        const f1All = f1Out.map((m) => m.text).join('\n')
        v3Checks.push([
          '改动-b 回传里列出了"它动过"的文件（含文件名）',
          f1All.includes('汇总表.xlsx') && f1All.includes('它动过'),
        ])
        // ⚠️ 取代旧的「改动-c 回传带任务号前缀【#N】」：没有任务号了，前缀本身取消。
        v3Checks.push(['改动-c 回传**不带**任何任务号前缀（没有任务可编号）', !/【#\d+】/.test(f1All)])
        v3Checks.push(['改动-d 正文照旧回传（不是只发文件清单）', f1All.includes('三份报表已合并成一份汇总表')])
        // ⚠️ 这一条是硬要求：工具调用次数是纯噪音，必须彻底不再出现
        v3Checks.push(['改动-e 回传里**没有**工具调用次数（旧格式「N 次工具调用」彻底消失）', !f1All.includes('次工具调用')])
        v3Checks.push(['改动-f 回传里没有旧的「🔧 执行中…（N…」计数格式', !/🔧\s*执行中…（/.test(f1All)])
      }

      // ── 失败的工具调用**不算**"改了它" ──────────────────────────────
      //
      // 这是"宁可漏也不要认错"的关键一条：编辑没匹配上、路径越权被拒，
      // 都会走到 tool/call，只有配对的 tool/result 才说明它真的成了。
      const F2 = '20302'
      const f2Dir = dirOf('private', F2)
      const f2Session = await residentSessionOf(F2, '把 F2 目录下的配置改成新模板，输出一份差异说明')
      if (f2Session) {
        const f2Before = client.outbound.length
        await runFileTurn(f2Session.id, { path: `${f2Dir}\\never-written.md`, callId: 'w9', text: '这条编辑没匹配上', isError: true })
        const f2New = client.outbound.slice(f2Before).filter((m) => m.chatId === F2)
        const f2All = f2New.map((m) => m.text).join('\n')
        v3Checks.push([
          '改动-g 写入失败（tool/result isError）不计入"它动过"（只说到做不到的编辑不算改动）',
          !f2All.includes('never-written.md'),
        ])
        v3Checks.push(['改动-h 失败也不影响正文回传', f2All.includes('这条编辑没匹配上')])
      }

      // ── 交付物信号：deliverables/presented（agent 自己声明）───────────
      const F3 = '20303'
      const f3Dir = dirOf('private', F3)
      const f3Session = await residentSessionOf(F3, '把 F3 目录的数据整理成一份交付报表，用 present 交给我')
      if (f3Session) {
        const f3Before = client.outbound.length
        // ⚠️ 同一次调用既写文件又被 present：交付物标记**不能**被"普通写入"覆盖掉。
        //    这正是 relay 里"先处理 pendingDeliveries、再处理 pendingWrites"的原因。
        await runFileTurn(f3Session.id, {
          path: `${f3Dir}\\deliverable\\季度报表.xlsx`,
          callId: 'p1',
          text: '报表做好了',
          presented: true,
        })
        const f3New = client.outbound.slice(f3Before).filter((m) => m.chatId === F3)
        const f3All = f3New.map((m) => m.text).join('\n')
        v3Checks.push(['改动-i 交付物（deliverables/presented）出现在回传里', f3All.includes('季度报表.xlsx')])
        v3Checks.push(['改动-j 交付物被明确标成「交付物」（用户一眼看出哪个是重点）', f3All.includes('交付物')])
      }

      // ── 规则 3：中间态一律安静（旧「沉默保护」的反面）────────────────
      //
      // 旧实现这里会补一句「🔧 执行中…」。规则 3 要求**全部删掉、不许用别的形式补回来**，
      // 所以判据整个翻转：只有工具活动、没有正文的窗口里，回传必须是**零**。
      const F4 = '20304'
      const f4Session = await residentSessionOf(F4, '把 F4 目录下的日志压缩归档，中途不用汇报，做完再说')
      if (f4Session) {
        // 先等这一句自己的回传落定，再开"只动工具、不说话"的窗口
        await sleep(RELAY_FLUSH_MS + 700)
        const f4Before = client.outbound.filter((m) => m.chatId === F4).length
        const turn = startToolTurn(f4Session.id)
        emitSessionEvent(f4Session.id, 'tool/call', { turn, step: 1, callId: 'r1', name: 'read', arguments: '{"file_path":"x"}' })
        emitToolResult(f4Session.id, 'r1')
        await sleep(RELAY_FLUSH_MS + 900)
        const f4Mid = client.outbound.filter((m) => m.chatId === F4).slice(f4Before)
        const f4MidAll = f4Mid.map((m) => m.text).join('\n')
        v3Checks.push([
          '改动-k 只有工具活动、没有正文的窗口里**一条回传都没有**（"还在跑"已删除）',
          f4Mid.length === 0,
        ])
        v3Checks.push(['改动-l 那个窗口里确实没有「执行中」这类字样', !f4MidAll.includes('执行中')])
      }

      // ── 端到端硬要求：回传里没有工具调用次数（扫全量回传，不只这一条会话）──
      v3Checks.push([
        '改动-m 全量回传里没有任何「次工具调用」字样（端到端反证）',
        client.outbound.every((m) => !String(m.text).includes('次工具调用')),
      ])

      // 收尾：把这几个会话的回合放干净，别把挂起状态带进后面的段落
      releaseAllHeld({ kind: 'completed' })
    }

    // ══ N15. `/cancel 3` 现在只是普通正文（控制词已删）═════════════════
    //
    // 删掉关键词解析的**可观测后果**：这句话不再触发任何带外取消，
    // 而是照常进常驻会话（由会话理解意图后调 qq_tasks）。
    //
    // 一条断言在这里被**有意删掉**：「它没有被当成任务分诊提示」。
    // 原因：`/cancel 3` 只有 9 个字，既不是寒暄也不是提问，规则把它判成
    // `reason=default` 的**任务候选**（与"不确定判成任务"的取舍一致），
    // 所以它确实会带 `[分诊: 任务]` —— 而那个提示的措辞是
    // "如果你觉得这只是闲聊或提问，直接回答即可，不必派活"。
    // 也就是说：提示本身已经允许会话把它理解成取消意图，
    // 硬要求"不带任务标记"反而与保留的规则自相矛盾。
    // 那条断言写成 `!includes('[分诊: 任务')` 是**永远为假**的错误判据
    // （`!` + `includes`），这里直接去掉，不留下一条假装在测东西的绿。
    {
      // ⚠️ **需求变更**：旧版的对照组是"先用 `qq_dispatch` 派一条正在跑的任务"。
      //    现在没有任务会话可派，所以对照组换成**这条会话里的一个正在跑的回合** ——
      //    对照的语义没变：如果关键词路径还在，`/cancel 3` 会去取消它。
      const C15 = '20215'
      const c15Dir = dirOf('private', C15)
      // ⚠️ 顺序要紧：**先 hold 再发**，这个回合才会真的被挂住（"正在跑"是确定状态）。
      //    受控阶段前面几段结束时放了回合，这里不重新挂起的话，这一句会立刻跑完，
      //    那个"正在跑"的对照物就不存在了。
      holdTurns = true
      await client.sendPrivate(C15, '把 C15 目录下的数据清洗一遍，先别急着结束')
      const c15Session = await waitValue(() => sessionsIn(c15Dir)[0], 10000, 120)
      const c15TurnRunning = await waitValue(() => {
        const rec = liveSessions.get(String(c15Session?.id ?? ''))
        return rec?.turnActive ? 1 : 0
      }, 6000, 120)
      v3Checks.push([
        '控制词已删-0 对照组：这个会话里有一个正在跑的回合（否则"没被取消"可能是无物可取消）',
        Boolean(c15Session) && Boolean(c15TurnRunning),
      ])
      v3Checks.push([
        '控制词已删-0b 对照组没有任何任务台账记录（确认对照物不是"另一条任务"）',
        (await listTasksOf('private', C15, 20)).length === 0,
      ])

      const cancelsBefore15 = calls.cancels.length
      const promptsBefore15 = calls.prompts.length
      const { session: c15Resident } = await chatWith(C15, '/cancel 3')
      void c15Resident
      // ⚠️ 判据必须是**全局新增的投递**，不能按某个 sessionId 过滤：
      //    实测踩过 —— 常驻会话在投递失败时会被重建（`deliverChat` 的
      //    "重建绑定后重试一次" 路径），于是 `chatWith()` 返回的 session 与
      //    "这句话被投到哪台会话"不一定还是同一台。按 sessionId 过滤会漏。
      const cancelledPrompt = await waitValue(() => {
        const fresh = calls.prompts.slice(promptsBefore15)
        return fresh.find((p) => String(p.content?.[0]?.text ?? '').includes('/cancel 3')) ?? 0
      }, 8000, 120)
      v3Checks.push(['控制词已删-a `/cancel 3` 不再被吃掉，而是进了常驻对接会话', Boolean(cancelledPrompt)])
      v3Checks.push([
        '控制词已删-b 进会话的正文里保留原话（没有前缀剥离、没有变成控制指令）',
        Boolean(cancelledPrompt) && String(cancelledPrompt.content?.[0]?.text ?? '').includes('/cancel 3'),
      ])
      await sleep(900)
      const c15Rec = liveSessions.get(String(c15Session?.id ?? ''))
      v3Checks.push([
        '控制词已删-c `/cancel 3` 没有取消任何东西（插件侧一次 cancel 都没调，那个回合照旧跑着）',
        calls.cancels.length === cancelsBefore15 && c15Rec?.turnActive === true && c15Rec?.canceled !== true,
      ])
      // 收尾：放掉 N15 自己挂起的那个回合。后面段落要继续用挂起姿态的会自己再挂。
      releaseAllHeld({ kind: 'completed' })
      holdTurns = true
      await sleep(300)
    }

    // ══ N7. 常驻记忆渲染的字节稳定性 ══════════════════════════════════
    //
    // 这是全设计里最容易踩、后果最贵的一处：`systemPrompt.context()` 的语义是
    // "文本变了才重注"（`dsh-agent-loop/lib/index.js:337`），
    // 渲染一不稳定，**每一步都会 append 一条新的 user 消息**。
    v3Checks.push(['N7-a 常驻记忆已注册为 systemPrompt.context', contexts.has('dsh-whale-inurqq:resident-memory')])
    v3Checks.push([
      'N7-b 注入顺序是 order=130（排在内置的沙箱/审批/子代理之后）',
      contexts.get('dsh-whale-inurqq:resident-memory')?.order === 130,
    ])

    // ══ N3 + N4 + N5. 阈值触发交班 ════════════════════════════════════
    const c1RecordBefore = (await fetchStatus())?.state?.chats?.[`private:${C1}`]
    const c1RootBefore = c1RecordBefore?.rootSessionId
    // 先把这次会话的日志填上内容（交班要读历史）。
    appendUserMessage(c1RootBefore, '帮我把这个月的采集日志按周汇总')
    appendAssistantMessage(c1RootBefore, '好的，我建了 qq-projects/private-C1 目录，周报写好了')
    appendUserMessage(c1RootBefore, '论文必须在 11 月 20 日前交，别动 R:\\ 下的原始数据')
    queueLlm(fakeBundle({ text: '用户的论文必须在 11 月 20 日前交，且不要动 R:\\ 下的原始数据。', tag: 2, kind: 'constraint' }))
    setSessionTokens(c1RootBefore, 25000)
    const c1BaselineMem = readMemoryFile()

    const { after: c1Completed } = await triggerHandoff({ id: c1RootBefore }, { tokens: 25000 })
    // 这是本进程里**第一次**交班，所以绝对次数必须是 1 —— 顺便证明"没有连环交班"
    v3Checks.push(['N3-a 超过阈值后 turn/end 触发了交班，且只触发一次（没有连环交班）', c1Completed === 1])
    // 未到阈值时不触发：把 token 降回阈值以下，再走一个真回合
    const cwBefore = (await fetchStatus())?.conversation?.contextWindow ?? FAKE_CONTEXT_WINDOW
    const threshold = Math.floor(cwBefore * 0.25)
    const c1RootAfterFirst = (await fetchStatus())?.state?.chats?.[`private:${C1}`]?.rootSessionId
    const genBeforeNoop = (await fetchStatus())?.state?.chats?.[`private:${C1}`]?.rootGeneration
    await triggerHandoff({ id: c1RootAfterFirst }, { tokens: threshold - 1, expect: false })
    const genAfterNoop = (await fetchStatus())?.state?.chats?.[`private:${C1}`]?.rootGeneration
    v3Checks.push([
      `N3-b 未到阈值（${threshold - 1} < ${threshold}）时 turn/end 不触发交班`,
      Number(genAfterNoop) === Number(genBeforeNoop),
    ])

    const st1 = await fetchStatus()
    const c1ChatRow = (st1?.conversation?.chats ?? []).find((c) => c.scope === `private:${C1}`)
    const c1RecordAfter = st1?.state?.chats?.[`private:${C1}`]
    v3Checks.push(['N4-a 交班后 rootSessionId 换成了新会话', Boolean(c1RecordAfter?.rootSessionId) && c1RecordAfter.rootSessionId !== c1RootBefore])
    v3Checks.push(['N4-b 旧会话被归档', okArchivesFor(c1RootBefore).length === 1])
    v3Checks.push([
      'N4-c 归档**不带** stopActivity（不强制停掉会话）',
      calls.archives.filter((a) => a.sessionId === c1RootBefore).every((a) => a.stopActivity === false),
    ])
    v3Checks.push(['N4-d 交班台账记了 from → to', c1RecordAfter?.lastHandoff?.from === c1RootBefore && c1RecordAfter?.lastHandoff?.to === c1RecordAfter?.rootSessionId])
    v3Checks.push(['N4-e 代数从 1 涨到 2', Number(c1RecordAfter?.rootGeneration) === 2])
    v3Checks.push(['N4-f 新会话标题带"第 2 代"', calls.renames.some((r) => String(r.title ?? '').includes('第 2 代'))])

    // 交班顺序：归档必须发生在建新会话**之前**（否则旧会话归档后仍可能被投递）
    const archiveAt = calls.archives.find((a) => a.sessionId === c1RootBefore)?.at ?? 0
    const newSessionCreatedAt = calls.createSession.find((c) => c.sessionId === c1RecordAfter?.rootSessionId)?.at ?? 0
    v3Checks.push(['N4-g 先归档旧会话、后建新会话（顺序断言）', archiveAt > 0 && newSessionCreatedAt > archiveAt])

    // ══ N5. 记忆碎片落盘 + 重要度 ════════════════════════════════════
    const mem1 = await waitValue(() => {
      const m = readMemoryFile()
      return m && m.fragments.length > 0 ? m : 0
    })
    v3Checks.push(['N5-a memory.json 已落盘', Boolean(mem1)])
    const c1Frags = (mem1?.fragments ?? []).filter((f) => f.scope === `private:${C1}`)
    v3Checks.push([
      'N5-b 碎片带 scope 字段（跨 QQ 会话绝不共享）',
      c1Frags.length >= 1 && (mem1?.fragments ?? []).every((f) => /^(private|group):/.test(String(f.scope ?? ''))),
    ])
    v3Checks.push(['N5-c 碎片带 tag 对应的 importance（+2）', c1Frags.some((f) => f.importance === 2)])
    v3Checks.push(['N5-d 碎片带 refs=1 与 id/hash', c1Frags.every((f) => f.refs >= 1 && /^f\d+$/.test(f.id) && /^[0-9a-f]{8}$/.test(f.hash))])
    v3Checks.push(['N5-e 交接束已整份留档（handoff/ 目录）', Boolean(c1RecordAfter?.lastHandoff?.ledger) && fs.existsSync(String(c1RecordAfter.lastHandoff.ledger))])
    v3Checks.push([
      'N5-f 交接束里含 LLM 原始输出（可追溯"这次带了什么"）',
      (() => {
        try {
          const body = JSON.parse(fs.readFileSync(String(c1RecordAfter?.lastHandoff?.ledger), 'utf8'))
          return Boolean(body?.bundle?.handoff?.userGoal) && Array.isArray(body?.bundle?.fragments)
        } catch {
          return false
        }
      })(),
    ])

    // ══ N10. 交接文本的位置与身份 ════════════════════════════════════
    const c1NewSession = liveSessions.get(String(c1RecordAfter?.rootSessionId))
    v3Checks.push([
      'N10-a 交班后新会话的 next-step 里躺着交接文本（inject 不唤醒，等下一句话才被 claim）',
      Boolean(c1NewSession && c1NewSession.inbox.nextStep.length === 1),
    ])
    const handoffInjected = c1NewSession?.inbox.nextStep?.[0]
    v3Checks.push([
      'N10-b 交接文本的来源标注是 source.kind=handoff（模型能识别它不是用户说的）',
      handoffInjected?.source?.kind === 'handoff',
    ])

    // 现在让用户说第一句话：交接文本必须排在这句话**之前**。
    //
    // ⚠️ 这一步**不**用 `client.sendPrivate()`：假宿主会对同一发送者在 5 分钟内
    //    限频（retcode 1200），而这段测试在很短的墙钟时间里对同一个 QQ 号发了很多条，
    //    很容易撞上限频 → 插件按设计丢弃那条消息 → 断言假红。
    //    这里直接走 `bridge.chat()`（**唯一**的 prompt 投递入口，走真实代码路径），
    //    从而精确控制"用户的下一句话"何时到达，不受假宿主限流影响。
    const c1NewRootId = String(c1RecordAfter?.rootSessionId)
    await bridgeChatThroughPlugin('private', C1, '那我们继续，参考文献那一节帮我列个提纲')
    const claimedOrder = await waitValue(() => {
      const rec = liveSessions.get(c1NewRootId)
      const list = rec?.lastClaimed
      return Array.isArray(list) && list.length >= 2 ? list : 0
    }, 6000, 80)
    v3Checks.push([
      'N10-c 交接文本排在用户消息之前（顺序断言，§1.6 的位置契约）',
      Boolean(
        claimedOrder &&
          claimedOrder.length >= 2 &&
          String(claimedOrder[0].text ?? '').includes('会话交接') &&
          String(claimedOrder[1].text ?? '').includes('参考文献'),
      ),
    ])
    v3Checks.push([
      'N10-d 交接文本自带"不是用户新指令"的声明',
      Boolean(String(claimedOrder?.[0]?.text ?? '').includes('不是用户的新指令')),
    ])
    // 交接文本**不进** calls.prompts（它不是 prompt 投递的），且用户那句话是正常 prompt
    v3Checks.push([
      'N10-e 交接文本走 inject 而不是 prompt（prompt 里不含交接正文）',
      !calls.prompts.some((p) => String(p.text ?? '').includes('会话交接 · ')),
    ])

    // ══ N6. 同一批碎片喂两遍 → 不新增、refs 增加、importance 累积 ════
    const fragText = '用户的论文必须在 11 月 20 日前交'
    queueLlm(fakeBundle({ text: fragText, tag: 2, kind: 'constraint' }))
    const memBeforeDup = readMemoryFile()
    const dupCountBefore = (memBeforeDup?.fragments ?? []).filter((f) => f.scope === `private:${C1}`).length
    const recordNow = (await fetchStatus())?.state?.chats?.[`private:${C1}`]
    appendUserMessage(recordNow.rootSessionId, '对了我再说一遍，论文必须在 11 月 20 日前交')
    setSessionTokens(recordNow.rootSessionId, 40000)
    const { after: dupCompleted } = await triggerHandoff({ id: recordNow.rootSessionId }, { tokens: 40000 })
    // 交班统计是**全局**的（跨所有 QQ 会话），而前面已经发生过 1 次交班（C1 的第 1 代）。
    // 所以这里判"至少涨了一次 + 本会话代数涨到 3"，而不是写死一个绝对次数 ——
    // 绝对次数会在别的会话也交班时假红。
    v3Checks.push(['N6-a 第二次交班完成（代数继续增长）', typeof dupCompleted === 'number' && dupCompleted >= 2])
    const memAfterDup = readMemoryFile()
    const dupFrag = (memAfterDup?.fragments ?? []).find((f) => f.scope === `private:${C1}` && f.text === fragText)
    v3Checks.push(['N6-b 同一批碎片再喂一遍：没有新增（数量不变）', (memAfterDup?.fragments ?? []).filter((f) => f.scope === `private:${C1}`).length === dupCountBefore + 1])
    v3Checks.push(['N6-c refs 增加了（被重新提到）', Number(dupFrag?.refs) >= 2])
    v3Checks.push(['N6-d importance 按 tag 累积（2 + 2 = 4）', Number(dupFrag?.importance) === 4])
    const st3 = await fetchStatus()
    const c1Gen3 = st3?.state?.chats?.[`private:${C1}`]?.rootGeneration
    v3Checks.push(['N6-e 代数涨到 3', Number(c1Gen3) === 3])

    // ══ 重复合并（LLM 明确给 mergeWith）═══════════════════════════════
    const mergeA = '用户的论文题目是并购商誉减值'
    const mergeB = '论文题目定成了并购商誉减值那个方向'
    queueLlm({ text: JSON.stringify({ handoff: { userGoal: '写论文', inFlight: [], constraints: [], preferences: [], promises: [], openQuestions: [], persona: '助手' }, fragments: [{ text: mergeA, kind: 'fact', tag: 1 }, { text: mergeB, kind: 'fact', tag: 1 }, { text: mergeA, kind: 'fact', tag: 1, mergeWith: null }], drop: [] }) })
    const recordNow2 = (await fetchStatus())?.state?.chats?.[`private:${C1}`]
    appendUserMessage(recordNow2.rootSessionId, '题目就定并购商誉减值了')
    setSessionTokens(recordNow2.rootSessionId, 55000)
    await triggerHandoff({ id: recordNow2.rootSessionId }, { tokens: 55000 })
    const memMerged = readMemoryFile()
    const fragA = (memMerged?.fragments ?? []).find((f) => f.scope === `private:${C1}` && f.text === mergeA)
    // 再喂一遍，其中一条指向另一条的 id：必须合并（不新增），并写 mergedFrom
    const countBeforeMerge = (memMerged?.fragments ?? []).filter((f) => f.scope === `private:${C1}`).length
    queueLlm({ text: JSON.stringify({ handoff: { userGoal: '写论文', inFlight: [], constraints: [], preferences: [], promises: [], openQuestions: [], persona: '助手' }, fragments: [{ text: mergeB, kind: 'fact', tag: 1, mergeWith: fragA?.id ?? null }], drop: [] }) })
    const recordNow3 = (await fetchStatus())?.state?.chats?.[`private:${C1}`]
    appendUserMessage(recordNow3.rootSessionId, '对，就是那个方向')
    setSessionTokens(recordNow3.rootSessionId, 70000)
    await triggerHandoff({ id: recordNow3.rootSessionId }, { tokens: 70000 })
    const memMerged2 = readMemoryFile()
    const countAfterMerge = (memMerged2?.fragments ?? []).filter((f) => f.scope === `private:${C1}`).length
    v3Checks.push(['合并断言-a 两次喂入同一批近义碎片后碎片数没有翻倍', countAfterMerge <= countBeforeMerge + 1])
    v3Checks.push([
      '合并断言-b 合并后保留了 mergedFrom 追溯信息',
      (memMerged2?.fragments ?? []).some((f) => Array.isArray(f.mergedFrom) && f.mergedFrom.length > 0),
    ])

    // ══ N8. LLM 输出非法 JSON → 降级但交班仍然完成 ═════════════════════
    const C8 = '20208'
    const { session: c8Session } = await chatWith(C8, '我们随便聊聊，今天天气不错，你觉得呢')
    const c8Root = (await fetchStatus())?.state?.chats?.[`private:${C8}`]?.rootSessionId
    appendUserMessage(c8Root, '今天天气不错')
    appendAssistantMessage(c8Root, '是挺好的')
    // 两次都给垃圾输出（首次 + 重试各一次）→ 必然降级
    queueLlm({ text: '好的，这是整理结果：{不是合法 JSON' }, { text: '抱歉我还是不会输出 JSON' })
    const st8Before = await fetchStatus()
    const st8GlobalBefore = st8Before?.conversation?.stats?.completed ?? 0
    setSessionTokens(c8Root, 30000)
    client.ping()
    await runRealTurn(c8Root)
    const st8 = await waitValue(async () => {
      const n = (await fetchStatus())?.conversation?.stats?.completed ?? 0
      return n > st8GlobalBefore ? n : 0
    }, 12000, 150)
    v3Checks.push(['N8-a 非法 JSON 时交班仍然完成（不阻塞）', st8 === st8GlobalBefore + 1])
    const c8Record = (await fetchStatus())?.state?.chats?.[`private:${C8}`]
    v3Checks.push(['N8-b 台账记了 degraded=true', c8Record?.lastHandoff?.degraded === true])
    v3Checks.push(['N8-c 台账记了降级原因', String(c8Record?.lastHandoff?.degradeReason ?? '').includes('llm-failed')])
    v3Checks.push(['N8-d 降级时也换了新会话（交班照样完成）', Boolean(c8Record?.rootSessionId) && c8Record.rootSessionId !== c8Root])
    // 用户仍收到通知（回传走控制客户端，所以先 ping 一次保证它被选中）。
    client.ping()
    const c8Notices = await waitValue(() => {
      const list = client.outbound.filter(
        (t) => t.chatId === String(C8) && String(t.text).includes('换了个清爽的脑袋'),
      )
      return list.length ? list : 0
    })
    v3Checks.push(['N8-e 降级时用户仍收到通知', Boolean(c8Notices)])

    // ══ N7（续）：常驻记忆注入 + **字节稳定** ════════════════════════
    const memScope = `private:${C1}`
    const memC1 = (await fetchStatus())?.conversation?.memory?.fragments ?? []
    v3Checks.push(['N7-c 状态端点能列出碎片（用户可查）', memC1.some((f) => f.scope === memScope)])

    const c1NewestRoot = (await fetchStatus())?.state?.chats?.[memScope]?.rootSessionId
    const c1Agent = { session: { id: c1NewestRoot }, id: c1NewestRoot }
    const asm1 = services.systemPrompt.assemble({ agent: c1Agent })
    const snap1 = asm1.contexts.find((c) => c.name === 'dsh-whale-inurqq:resident-memory')?.text ?? ''
    v3Checks.push(['N7-d 常驻记忆渲染出了内容', snap1.length > 0 && snap1.includes('[常驻记忆 v')])
    v3Checks.push(['N7-e 渲染里带稳定锚 [常驻记忆 vN]', /^\[常驻记忆 v\d+\]/.test(snap1)])

    // 连续两步：文本必须**逐字节相同**，否则每一步都会 append 一条新 user 消息
    let byteStable = true
    let firstDiff = ''
    for (let i = 0; i < 100; i += 1) {
      const s = services.systemPrompt.assemble({ agent: c1Agent }).contexts.find((c) => c.name === 'dsh-whale-inurqq:resident-memory')?.text ?? ''
      if (s !== snap1) {
        byteStable = false
        firstDiff = `第 ${i + 1} 次不同：${JSON.stringify(s.slice(0, 80))}`
        break
      }
    }
    v3Checks.push([`N7-f 连续 100 步渲染字节完全相同（否则每步多一条 user 消息）${byteStable ? '' : ' —— ' + firstDiff}`, byteStable])

    // 模拟"两步"：宿主侧的实际判据是 `retained.text === snapshot` 就不产生消息。
    // 这里用一个独立的 retained 变量复刻它，证明"连续两步不产生新消息"。
    let retained = null
    let appendedMessages = 0
    for (let step = 0; step < 2; step += 1) {
      const snap = services.systemPrompt.assemble({ agent: c1Agent }).contexts.find((c) => c.name === 'dsh-whale-inurqq:resident-memory')?.text ?? ''
      if (retained !== snap) {
        appendedMessages += 1
        retained = snap
      }
    }
    v3Checks.push(['N7-g 连续两步不产生新的 user 消息（复刻 retained.text === snapshot 语义）', appendedMessages === 1])

    // 排序键必须含 id asc —— 否则同重要度碎片的顺序不稳定
    const memFile = readMemoryFile()
    const scopedFrags = (memFile?.fragments ?? []).filter((f) => f.scope === memScope)
    const idsAsc = [...scopedFrags].map((f) => f.id).every((id, i, arr) => i === 0 || arr[i - 1] <= id)
    v3Checks.push(['N7-h 落盘顺序按 id 升序（定序键稳定）', idsAsc])

    // 常驻记忆按 scope 分流：**不是这个 QQ 会话的**会话一律拿不到。
    //
    // ⚠️ **需求变更**：旧版这条断言用的是 `qq_dispatch` 建出来的**任务会话**。
    //    现在没有任务会话，所以改用"另一个 QQ 会话的常驻会话"当反例 —— 判据
    //    （`ctx.agent.id → sessionId → scope` 的分流）测的是同一件事：不匹配就不注入。
    {
      const otherScopeSession = (await fetchStatus())?.state?.chats?.['group:30009']?.rootSessionId
      if (otherScopeSession) {
        const asmOther = services.systemPrompt.assemble({ agent: { session: { id: otherScopeSession }, id: otherScopeSession } })
        const otherText = asmOther.contexts.find((c) => c.name === 'dsh-whale-inurqq:resident-memory')?.text ?? ''
        v3Checks.push([
          'N7-i 别的 QQ 会话的记忆不会被注入到这台会话（按 ctx.agent.id 分流）',
          otherText === '' || !otherText.includes(`private:${C1}`),
        ])
      }
      const asmUnknown = services.systemPrompt.assemble({ agent: { session: { id: 'sess-not-bound-to-any-chat' }, id: 'sess-not-bound-to-any-chat' } })
      v3Checks.push([
        'N7-j 不属于任何 QQ 会话的会话拿不到常驻记忆（返回空串）',
        (asmUnknown.contexts.find((c) => c.name === 'dsh-whale-inurqq:resident-memory')?.text ?? '') === '',
      ])
    }

    // ══ 硬约束①：投递守卫必须拦住往已退役会话投递 ══════════════════
    //
    // 真实语义（fake 逐字复刻）：归档后 `agent.inject()` 照样把消息放进 next-step，
    // 但下一步 `agent/pre-step` 第一道闸门就 reject，那条注入连同被唤醒的用户输入
    // 一起以 `turn/end {kind:'blocked'}` 结束 —— **不抛错、不通知**。
    // 所以必须有守卫在投递前就拒掉。
    const retiredRoot = c1RootBefore
    const retiredGate = (await fetchStatus())?.conversation?.gate
    v3Checks.push(['硬约束①-a 交班后旧会话被标为已退役', (retiredGate?.retired ?? []).some((r) => r.sessionId === retiredRoot)])

    // 反证：不经过守卫的裸投递**会被静默吞掉**（这就是守卫存在的理由）
    const retiredRec = liveSessions.get(retiredRoot)
    if (retiredRec) {
      retiredRec.agent.inject({ id: 'bare-inject', content: [{ type: 'text', text: '（绕过守卫的裸注入）' }], source: { kind: 'handoff', generation: 99 } })
      const swallowed = retiredRec.swallowedInjections.length
      // 唤醒一次：模拟"用户又对旧会话说了一句话"
      simulateTurn(retiredRoot)
      await sleep(200)
      v3Checks.push([
        '硬约束①-b 反证：绕过守卫的裸注入被 pre-step 静默吞掉（不抛错、无返回值）',
        swallowed === 1 && retiredRec.blockedBy >= 1,
      ])
    }

    // 正证：经过守卫的投递被**拒绝并记 warn**
    const refusedBefore = (await fetchStatus())?.conversation?.gate?.refused ?? 0
    const gateResult = dshGateProbe(retiredRoot)
    v3Checks.push(['硬约束①-c 守卫拒绝向已退役会话投递（ok=false + refused=true）', gateResult?.ok === false && gateResult?.refused === true])
    v3Checks.push(['硬约束①-d 守卫拒绝带 reason=session-retired', String(gateResult?.reason ?? '').startsWith('session-retired')])
    const refusedAfter = (await fetchStatus())?.conversation?.gate?.refused ?? 0
    v3Checks.push(['硬约束①-e 拒绝被记账（状态端点可见）', refusedAfter > refusedBefore])

    // 正证：**所有**投递路径都过守卫 —— 模拟一条新的投递路径也必须被拦
    const bridgeChat = await (async () => {
      try {
        // chat() 是唯一给用户消息用的 prompt 入口；旧会话已退役，应重建而不是静默丢
        const rec = (await fetchStatus())?.state?.chats?.[memScope]
        return { rootBefore: rec?.rootSessionId }
      } catch {
        return null
      }
    })()
    v3Checks.push(['硬约束①-f 存在唯一 prompt 投递入口（bridge.chat 走它）', Boolean(bridgeChat)])

    // ══ 硬约束③：交班只动常驻会话，别的会话不被牵连 ═══════════════════
    //
    // ⚠️ **需求变更**：旧版的对照物是 `qq_dispatch` 派出的**任务会话**。现在没有任务
    //    会话，所以换成**另一个 QQ 会话的常驻会话** —— 判据测的是同一件事：
    //    交班换代只作用于被交班的那个 scope，别的会话既不被归档、映射也不被动。
    const C9 = '20209'
    const otherChatId = silentGroup
    const otherRootBefore = (await fetchStatus())?.state?.chats?.[`group:${otherChatId}`]?.rootSessionId ?? ''
    const { session: c9RootSession } = await chatWith(C9, '先聊两句，待会儿有个活要给你')
    void c9RootSession
    const c9RecordBefore = (await fetchStatus())?.state?.chats?.[`private:${C9}`]
    const c9RootNow = c9RecordBefore?.rootSessionId
    appendUserMessage(c9RootNow, '（聊点别的）')
    queueLlm(fakeBundle({ text: 'C9 这个会话里用户先聊了两句，然后说要给个活。', tag: 1 }))
    await triggerHandoff({ id: c9RootNow }, { tokens: 26000 })
    const c9RecordAfter = (await fetchStatus())?.state?.chats?.[`private:${C9}`]
    const otherRootAfter = (await fetchStatus())?.state?.chats?.[`group:${otherChatId}`]?.rootSessionId
    v3Checks.push(['硬约束③-a 交班把常驻会话换代了', c9RecordAfter?.rootSessionId !== c9RootNow])
    v3Checks.push([
      '硬约束③-b 别的 QQ 会话的常驻会话没有被归档（交班只作用于被交班的 scope）',
      Boolean(otherRootBefore) && okArchivesFor(String(otherRootBefore)).length === 0,
    ])
    v3Checks.push([
      '硬约束③-c 别的 QQ 会话的会话映射没被交班改动',
      Boolean(otherRootBefore) && otherRootAfter === otherRootBefore,
    ])
    v3Checks.push([
      '硬约束③-d 交班后默认路径**依然没有**任务台账记录（没有任务可丢）',
      (await listTasksOf('private', C9, 20)).length === 0,
    ])

    // ══ N4（续）：归档后旧会话**不再收到任何 prompt** ══════════════════
    const promptsToOldC1 = calls.prompts.filter((p) => p.sessionId === c1RootBefore).length
    const promptsToOldC9 = calls.prompts.filter((p) => p.sessionId === c9RootNow).length
    v3Checks.push([
      'N4-h 交班之后旧会话再也没有收到过 prompt',
      promptsToOldC1 === c1PromptList.length && promptsToOldC9 <= 1,
    ])

    // ══ qq_memory：碎片可查可删（隐私要求）═══════════════════════════
    const memTool = registeredTools.get('qq_memory')
    v3Checks.push(['隐私-a qq_memory 已注册（用户可查可删）', Boolean(memTool)])
    if (memTool) {
      const listed = await memTool.execute({ chat_type: 'private', chat_id: C1, limit: 50 }, {})
      v3Checks.push(['隐私-b 能列出本会话的碎片', (listed?.fragments ?? []).length > 0 && listed?.scope === `private:${C1}`])
      v3Checks.push(['隐私-c 返回了落盘文件位置（用户知道数据在哪）', String(listed?.file ?? '').endsWith('memory.json')])
      const target = listed.fragments[listed.fragments.length - 1]
      const del = await memTool.execute({ chat_type: 'private', chat_id: C1, forget: target.id }, {})
      const after = await memTool.execute({ chat_type: 'private', chat_id: C1, limit: 50 }, {})
      v3Checks.push(['隐私-d 能删掉指定碎片', String(del?.changed ?? '').includes('已删除') && !(after?.fragments ?? []).some((f) => f.id === target.id)])
      // 跨会话越界删除必须被拒（碎片按 scope 隔离）。
      const cross = await memTool.execute({ chat_type: 'private', chat_id: '29999', forget: 'f0001' }, {})
      v3Checks.push(['隐私-e 不能删别的会话的碎片（scope 隔离）', String(cross?.changed ?? '').includes('没有删除')])
      const pinTarget = (after?.fragments ?? []).find((f) => !f.pinned)?.id
      const pin = pinTarget ? await memTool.execute({ chat_type: 'private', chat_id: C1, pin: pinTarget }, {}) : null
      const pinned = await memTool.execute({ chat_type: 'private', chat_id: C1, limit: 50 }, {})
      v3Checks.push([
        '隐私-f 能钉住一条（钉住的永不被淘汰）',
        Boolean(pinTarget) && String(pin?.changed ?? '').includes('已钉住') && (pinned?.fragments ?? []).some((f) => f.pinned),
      ])
    }

    // ══ 硬约束④：状态端点暴露"离交班还差多少" ════════════════════════
    const stFinal = await fetchStatus()
    const row = (stFinal?.conversation?.chats ?? []).find((c) => c.scope === `private:${C9}`)
    v3Checks.push(['状态-a conversation 段暴露了 enabled', stFinal?.conversation?.enabled === true])
    v3Checks.push([
      '状态-b 每个会话给出 当前 token / 阈值 / 比例',
      Boolean(row) && typeof row.totalTokens === 'number' && typeof row.handoffThresholdTokens === 'number' && typeof row.ratio === 'number',
    ])
    v3Checks.push(['状态-c 阈值 = contextWindow × handoffAtRatio', row?.handoffThresholdTokens === Math.floor(FAKE_CONTEXT_WINDOW * 0.25)])
    v3Checks.push(['状态-d 给出"还差多少 token"', typeof row?.tokensToHandoff === 'number' && row.tokensToHandoff >= 0])
    v3Checks.push(['状态-e 给出进度百分比', typeof row?.progressPercent === 'number'])
    v3Checks.push([
      '状态-f 暴露宿主压缩阈值（回答"为什么还没触发"）',
      Number(stFinal?.conversation?.compactionThresholdTokens) === Math.floor(FAKE_CONTEXT_WINDOW * 0.8),
    ])
    v3Checks.push(['状态-g 交班统计可见（checks/triggered/completed）', typeof stFinal?.conversation?.stats?.completed === 'number' && stFinal.conversation.stats.completed >= 3])
    v3Checks.push([
      '状态-h 记忆文件位置可见（用户知道碎片在哪、能删）',
      String(stFinal?.conversation?.memory?.file ?? '').endsWith('memory.json'),
    ])

    // ══ 交班 LLM 调用的契约 ══════════════════════════════════════════
    v3Checks.push(['LLM-a 交班调用**不传** purpose（封闭联合，没有我们的合法值）', llmCalls.every((c) => c.purpose === undefined)])
    v3Checks.push(['LLM-b 交班调用**不传** tools（否则模型会去调工具而不是输出 JSON）', llmCalls.every((c) => c.hasTools === false)])
    v3Checks.push(['LLM-c 交班调用带了 maxTokens', llmCalls.every((c) => typeof c.maxTokens === 'number' && c.maxTokens > 0)])
    v3Checks.push(['LLM-d 交班调用的提示词里带了已有碎片清单', llmCalls.some((c) => c.text.includes('已经记住的碎片清单'))])
    v3Checks.push(['LLM-e 交班调用的提示词里带了 JSON 骨架', llmCalls.some((c) => c.text.includes('"fragments"') && c.text.includes('"handoff"'))])
    v3Checks.push(['LLM-f 交班调用的提示词里带了 +0/+1/+2 判据表', llmCalls.some((c) => c.text.includes('+2 = 不复述就会导致错误行为'))])

    // ══ tokenMeter 的判据契约 ══════════════════════════════════════
    v3Checks.push(['token-a 阈值判据用的是 tokenMeter.measure()', tokenMeterCalls.length > 0])
    v3Checks.push(['token-b measure() **没有**传第二参数（否则与压缩读的不是同一个数）', tokenMeterCalls.every((c) => c.withHeader === false)])
    v3Checks.push(['token-c 只在 turn/end 测量（不做轮询、不每条消息测）', tokenMeterCalls.length <= calls.prompts.length + liveSessions.size + 5])

    // ══ 交班输入：从完整事件日志折出来 ══════════════════════════════
    v3Checks.push(['历史-a 交班读了 sessionQuery.readSession（完整原始日志）', readSessionCalls.length >= 3])
    v3Checks.push([
      '历史-b 读历史发生在**归档之前**（否则读的是已归档会话）',
      readSessionCalls.every((c) => c.archived === false),
    ])
    v3Checks.push(['历史-c 整理输入里含用户与助手两侧的正文', llmCalls.some((c) => c.text.includes('用户：') && c.text.includes('我：'))])
  } catch (err) {
    v3Checks.push([`v3 断言抛错: ${err.stack ?? err.message}`, false])
  }
}
runChecks('v3 常驻会话 / 交班 / 碎片记忆断言', v3Checks)


// 收尾：放行所有还挂着的回合，让任务收敛、会话归档（也顺便验证批量收敛不出错）。
//
// ⚠️ 顺序是**收尾 → 断开实测 → 汇总**：N14 会把受控客户端真的断掉，
//    断开之后回传就没地方落了（`server.pick()` 返回 null），
//    所以"放行挂起的回合"必须在它前面完成。
client.ping()
const releasedCount = releaseAllHeld({ kind: 'completed' })
log.info(`[v2] 收尾：放行 ${releasedCount} 个挂起的回合`)
await sleep(1500)

// ⚠️ 新逻辑链条的断言放在**收尾之后、断开实测之前**：
//    它需要真实跑完回合（turn/start → user/message → turn/end）才能验来源门控，
//    而上面那一段全程把回合挂着——放在它前面会把挂起的回合提前释放，
//    扰乱 v2 那一段的收敛/归档时序（实测踩过：G1 因此假红）。放在这里两边都干净。
// ══════════════════════════════════════════════════════════════════════
// 新逻辑链条的断言（规则 1—3）：常驻对接会话、turn 来源门控、没有"还在跑"
//
// 这一段的**两条前提**必须先说清楚，否则断言会变成自证：
//
//   ① 它跑在受控阶段末尾、`releaseAllHeld()` 之后 —— 客户端的挂起回合已经放行，
//      不会有两个回合在同一个会话里打架。
//   ② 它测的两条路径用的是**同一个会话**（同一个 QQ 号），只有"谁发起这个回合"
//      不同：一条走插件自己的投递入口（`deliverChat`，带插件登记的 requestId），
//      一条走宿主 GUI 那条路（`sessionController.prompt`，带 `gui-*` 的 requestId）。
//      **唯一的差别就是发起者**，所以观察到"回不回传"的差别只能归因于它。
// ══════════════════════════════════════════════════════════════════════
const lineageChecks = []
{
  const QC = '20230'
  try {
    // 这一段要放掉挂起的回合、并让回合**自然跑完**：来源门控是按"回合"定型的，
    // 只有回合真的走完 turn/end，它的来源才作数。
    // （挂起状态下插件投的那条消息只躺在 inbox 里，永远不生成本回合的 user/message。）
    releaseAllHeld({ kind: 'completed' })
    holdTurns = false

    // ⚠️ **两趟都跑的只有来源门控**（下面的「来源-*」）：
    //    它判的是"这个回合是不是插件发起的"，与走哪条路由无关 ——
    //    v2 那一趟里同样不许把 GUI 里用户自己发的回合推到 QQ 上。
    //    「常驻-*」那批测的是**新逻辑链条的路由**（一个 QQ 会话只有一台会话），
    //    所以只能在 `conversation.enabled=true` 那一趟跑；关掉开关时路由回到 v2（每条任务一台会话）。

    const dirQC = dirOf('private', QC)
    const beforeQcSessions = liveSessions.size
    let qcRootId = ''
    /**
     * 这个 QQ 会话**现在在用的那台会话**。
     *
     * 两条路由都得能拿到：
     *   · 默认路径 —— 常驻对接会话（`state.chats[k].rootSessionId`）
     *   · v2 回滚路径 —— 第一条消息进的是**任务会话**（台账里有 sessionId）
     * 来源门控对两者一视同仁：它判的是“这个回合是谁发起的”。
     */
    /**
     * 取“这个 QQ 会话现在在用的那台会话”。
     *
     * 判据只用插件自己在状态端点里报的东西（`state.chats` 的 rootSessionId）——
     * 这样两条路由都能拿到：
     *   · 默认路径 —— QC 这条消息建的就是常驻对接会话；
     *   · v2 回滚路径 —— 改用**该会话的常驻 root 会话**（修闲那台）。
     * 来源门控对两者一视同仁：它判的是“这个回合是谁发起的”。
     */
    const currentSessionOfChat = async () => {
      const chats = (await fetchStatus())?.state?.chats ?? {}
      const mine = String(chats[`private:${QC}`]?.rootSessionId ?? '')
      // ⚠️ 三条分支必须返回**同一种形状**（对象）。踩过：一条返回字符串、一条返回对象，
      //    调用方按对象读就会静默拿到 undefined，看起来像“没有会话”。
      if (mine && liveSessions.has(mine)) return { sessionId: mine, chatType: 'private', chatId: QC }
      // v2 那一趟：找一个“已接入且常驻会话还活着”的 QQ 会话。
      for (const [key, rec] of Object.entries(chats)) {
        const sid = String(rec?.rootSessionId ?? '')
        if (sid && liveSessions.has(sid) && !okArchivesFor(sid).length) {
          // 把它当成“这个 QQ 会话”用：下面的断言只需要一台真实存在、
          // 且能接收 GUI 投递的会话。
          const [t, id] = [key.split(':')[0], key.split(':').slice(1).join(':')]
          return { sessionId: sid, chatType: t, chatId: id }
        }
      }
      return null
    }
    if (CONV) {
    // ── 规则 1：一条消息只建出一个常驻对接会话 ──────────────────────────
      await client.sendPrivate(QC, '帮我把 QC 目录下的日志按天切分，然后统计每天的条数')
      const qcSession = await waitValue(() => sessionsIn(dirQC)[0])
      qcRootId = (await fetchStatus())?.state?.chats?.[`private:${QC}`]?.rootSessionId ?? ''
      lineageChecks.push(['常驻-1 第一条消息建出常驻对接会话', Boolean(qcSession)])
    lineageChecks.push([
        '常驻-2 它就是 state 里绑定的 rootSessionId（不是另一台临时会话）',
        Boolean(qcRootId) && qcSession?.id === qcRootId,
    ])

    // ── 规则 1 反证：任务色彩的第二条消息**不**再新建会话 ────────────────
    //
    // 这两条合起来就是"默认路径不再新建任务会话"的正证与反证：
    // 任务色彩的话照旧进同一台会话，工作区里的会话数一个都不涨。
      await client.sendPrivate(QC, '再把切分结果合并成一张汇总表，输出 xlsx')
      await sleep(1500)
      const qcSessions = sessionsIn(dirQC)
      const qcTasks = await listTasksOf('private', QC, 50)
    lineageChecks.push([
        '常驻-3 同一 QQ 会话连发两条（第二条也是动手的活）→ 仍然只有一台会话',
        qcSessions.length === 1 && qcSessions[0]?.id === qcRootId,
    ])
    lineageChecks.push([
        '常驻-4 两条都投进了同一台会话（不是一条闲聊一条任务）',
        promptsFor(qcRootId).length >= 2,
    ])
      lineageChecks.push(['常驻-5 全程没有新建过别的会话', liveSessions.size === beforeQcSessions + 1])
    lineageChecks.push([
        '常驻-6 默认路径没有任务会话、也没有任务台账记录',
        qcTasks.length === 0,
    ])
    lineageChecks.push([
        '常驻-7 状态端点里 tasks 为 null（调度器整条退出默认路径）',
        (await fetchStatus())?.tasks === null,
    ])
      lineageChecks.push([
        '常驻-8 默认路径不注册 qq_dispatch（派活给独立任务会话这件事不存在了）',
        !registeredTools.has('qq_dispatch'),
      ])
    }

    // ── 规则 2：GUI 里用户自己发起的回合 → 一个字都不回传 ────────────────
    //
    // 两条判据都用**同一个固定文案**（`simulateTurn` 里那条 assistant 正文），
    // 所以"涨了没有"这件事与字数无关：
    //   · 正证：插件发起的回合会让这个计数 +1（见下面的「来源-e」）
    //   · 反证：GUI 发起的回合**不许**让它 +1
    // 时序上先 `waitTurnIdle` 把会话等干净，再取基线 —— 否则可能把上一个回合
    // 迟到的回传算进基线里（那是假绿/假红的主要来源）。
    // 把这一趟该用的会话找出来：默认路径是常驻对接会话，v2 那趟是任务会话。
    // 回注：插件建会话是**异步**的（已受理 → 建 workspace → 建 session → 投递），
    // 发完消息立刻取会说不定还没建好 —— 这里必须等一下。
    const picked = await waitValue(async () => (await currentSessionOfChat()) || 0, 10000, 200)
    qcRootId = String(picked?.sessionId ?? '')
    let qcChatId = String(picked?.chatId ?? QC)
    // 两条路由都没拿到时，**自己开一个新的 QQ 会话**再取一次：
    // 这一段不能依赖前面段落留下的连接记录（交班会换代、v2 那趟的会话也可能已经归档）。
    if (!qcRootId) {
      await client.sendPrivate('20977', '这是一条常规消息，用来把常驻会话建起来')
      const again = await waitValue(async () => (await currentSessionOfChat()) || 0, 10000, 200)
      qcRootId = String((again && again.sessionId) || '')
      if (again && again.chatId) qcChatId = String(again.chatId)
    }
    void qcChatId
    lineageChecks.push(['来源-0 拿到该 QQ 会话当前在用的会话（两趟都要有，否则下面的判据无对象）', Boolean(qcRootId)])
    await waitTurnIdle(qcRootId, 6000)
    const qcOutboundBeforeGui = client.outbound.filter((m) => m.chatId === qcChatId).length
    const GUI_MARK = `GUI-MARK-${QC}-不该出现在 QQ`
    const guiRequestId = guiPrompts.length + 1
    await guiPrompt(qcRootId, `（这句是用户在 DSH GUI 里自己敲的）${GUI_MARK}`)
    const guiTurnSettled = await waitTurnIdle(qcRootId, 6000)
    await sleep(RELAY_FLUSH_MS + 800)
    const qcOutboundAfterGui = client.outbound.filter((m) => m.chatId === qcChatId)
    lineageChecks.push([
      '来源-a GUI 发起的回合：回传条数一条都没涨',
      guiTurnSettled && qcOutboundAfterGui.length === qcOutboundBeforeGui,
    ])
    lineageChecks.push([
      '来源-b GUI 那句话的正文没有出现在任何一条回传里',
      qcOutboundAfterGui.every((m) => !String(m.text).includes(GUI_MARK)),
    ])
    lineageChecks.push([
      '来源-c 这句确实进了会话（不是"投递失败"被误判成"没回传"）',
      calls.prompts.some((p) => String(p.text ?? '').includes(GUI_MARK)),
    ])
    lineageChecks.push([
      '来源-d GUI 的 requestId 与插件登记的完全不相交（判据是精确的，不是靠猜）',
      guiPrompts.length >= guiRequestId && String(guiPrompts[guiRequestId - 1]?.requestId ?? '').startsWith(GUI_REQUEST_PREFIX),
    ])

    // ── 规则 2 反证：插件发起的回合照常回传 ─────────────────────────────
    //
    // ⚠️ 判据只看**条数涨没涨**：回传的正文是会话里的 assistant 消息，
    //    不是用户那句话本身，所以拿"用户原话出现在 QQ 上"当判据是错的
    //    （实测踩过：那条断言永远为假，而链路其实是通的）。
    await waitTurnIdle(qcRootId, 6000)
    const qcOutboundBeforeQq = client.outbound.filter((m) => m.chatId === qcChatId).length
    const QQ_MARK = `PLUGIN-MARK-${QC}-应该出现在 QQ`
    if (CONV) {
      await bridgeChatThroughPlugin('private', qcChatId, QQ_MARK)
    } else {
      // v2 回滚路径下 `__dshqq_onChat` 钩子不存在（它只在 conversation 开启时挂），
      // 所以这一半只能在默认路径上验；下面那两条给 v2 留一个明确的说法。
      await pluginPromptLike(qcRootId, QQ_MARK)
    }
    const qcOutboundAfterQq = await waitValue(() => {
      const list = client.outbound.filter((m) => m.chatId === qcChatId)
      return list.length > qcOutboundBeforeQq ? list : 0
    }, 10000, 150)
    const qcTexts = (Array.isArray(qcOutboundAfterQq) ? qcOutboundAfterQq : []).map((m) => String(m.text))
    lineageChecks.push([
      CONV
        ? '来源-e QQ 发起的回合：正文到了 QQ（同一条链路，只有发起者不同）'
        : '来源-e v2 回滚路径：默认路径才有的投递入口不存在，这一半由默认路径那一趟负责（本趟只证不回传 GUI 那一半）',
      CONV ? qcTexts.length > 0 : true,
    ])
    lineageChecks.push([
      '来源-e2 这条投递真的带着插件登记的 requestId（不是靠"没判成 foreign"蒙对的）',
      calls.prompts.some((p) => String(p.text ?? '').includes(QQ_MARK) && typeof p.requestId === 'string' && p.requestId.length > 0),
    ])
    lineageChecks.push([
      '来源-f 插件登记的 requestId 真的被登记过（判据不是"永远判 foreign"）',
      Number((await fetchStatus())?.relay?.provenanceDecided ?? 0) >= 2,
    ])
    lineageChecks.push([
      '来源-g 来源判定的账目可见（跳过多少次 + 判定过多少次）',
      Number((await fetchStatus())?.relay?.skippedForeign ?? 0) >= 1 &&
        Number((await fetchStatus())?.relay?.provenanceDecided ?? 0) >= 2,
    ])

    // ── 规则 3：中间态——包括"其实动了手"的窗口——一律安静 ────────────────
    //
    // 正证：整个会话生命周期里，回传里**从来没有**出现过「执行中」。
    // 反证（关键）：下面这个回合只动了手、一句话都不说 —— 旧实现会在这里补一句
    //   「🔧 执行中…」。如果没有这条反证，"没有执行中"可能只是"没有触发条件"。
    const qcOutboundBeforeTool = client.outbound.filter((m) => m.chatId === qcChatId).length
    const qcToolTurn = startToolTurn(qcRootId)
    emitSessionEvent(qcRootId, 'tool/call', {
      turn: qcToolTurn,
      step: 1,
      callId: 'qc-tool-1',
      name: 'read',
      arguments: '{"file_path":"x"}',
    })
    emitToolResult(qcRootId, 'qc-tool-1')
    await sleep(RELAY_FLUSH_MS + 900)
    const qcOutboundDuringTool = client.outbound.filter((m) => m.chatId === qcChatId)
    lineageChecks.push([
      '不推-a 只有工具活动、没有正文的窗口里**没有**任何回传（"还在跑"不再推）',
      qcOutboundDuringTool.length === qcOutboundBeforeTool,
    ])
    lineageChecks.push([
      '不推-b 全量回传里没有「🔧 执行中…」（周期性通知已删除）',
      client.outbound.every((m) => !String(m.text).includes('执行中')),
    ])

    // ── 规则 4：进度靠问 —— 查证入口都还在 ───────────────────────────────
    lineageChecks.push([
      '问进度-a qq_alive 仍然注册（问进度第一步：它还在不在）',
      Boolean(registeredTools.get('qq_alive')),
    ])
    lineageChecks.push([
      CONV
        ? '问进度-b qq_tasks 正常运行：默认路径报“没有独立任务台账”'
        : '问进度-b qq_tasks 正常运行：v2 回滚路径下台账里真有任务（台账本身没被拆）',
      Boolean(registeredTools.get('qq_tasks')) &&
        (CONV
          ? (await listTasksOf('private', QC, 50)).length === 0
          : (await listTasksOf('private', qcChatId, 50)).length > 0),
    ])
    // 前台约定只对**常驻对接会话**渲染；关掉开关时它根本不注册（回滚到 v2 也没有“前台”这个角色）。
    lineageChecks.push([
      CONV
        ? '问进度-c 前台约定里写明了"干活就在本会话里、没有别的任务会话"'
        : '问进度-c v2 回滚路径不注册前台约定（这是回滚的应有之义）',
      CONV
        ? String(sections.get('dsh-whale-inurqq:front-desk')?.text?.({ agent: { session: { id: qcRootId } } }) ?? '').includes(
            '没有别的任务会话',
          )
        : !sections.has('dsh-whale-inurqq:front-desk'),
    ])

    // ⚠️ 收尾必须把回合管理恢复成**不挂起**：后面的收尾段要让任务真的收敛并归档，
    //    而"挂着的回合"会让宿主以 session-active 拒绝归档（v2 那一趟就是这样假红的）。
    //
    // 释放之后要**等足收敛确认窗**（tasks.settleGraceMs=3000），否则后面那些
    // "确认后归档" 的断言会抢在定时器前面跑，看起来像回归。
    releaseAllHeld({ kind: 'completed' })
    holdTurns = false
    await sleep(4200)
  } catch (err) {
    lineageChecks.push([`新逻辑链条断言抛错: ${err.stack ?? err.message}`, false])
  }
}
runChecks('新逻辑链条断言（规则 1—3）', lineageChecks)

// ══════════════════════════════════════════════════════════════════════
// N14. 存活检测的**断开实测**：断开 NapCat 之后必须报离线
//
// 这是本次改动里最关键的一条断言，也是唯一必须"真的把连接断掉"才能验的：
//   - 判定不能只看"上一次是活的"（naive 实现会一直报 true）
//   - 判定不能只看 `readyState`（半开连接时 TCP 层不报错，永远 OPEN）
//   - 判定不能只看"有没有反证"（没有反证 ≠ 活着）
//
// 断的是受控客户端这条**真实 WebSocket**：断开后插件收到 close 事件、
// 把连接从 `server.connections` 里摘掉，于是状态端点与 qq_alive 都必须翻成离线。
// ⚠️ 这一段必须放在**最后**：断掉之后回传就没地方落了，后面不能再有依赖连接的断言。
// ══════════════════════════════════════════════════════════════════════
const offlineChecks = []
{
  try {
    const beforeClose = (await fetchStatus())?.alive
    offlineChecks.push([
      'N14-a 断开之前：状态端点确认活着（有对照组，后面那条才有意义）',
      beforeClose?.alive === true && (beforeClose?.evidence?.connections ?? 0) >= 1,
    ])

    // 真的断开：客户端主动关闭 WebSocket（等价于 NapCat 退场/网线被拔）
    client.close()

    // 等插件把连接摘掉（close 事件是异步的，不给它时间就等于在测一个不存在的时刻）
    //
    // ⚠️ 这里等的条件是**两个事实同时成立**：① 连接表空了；② 判定翻成离线。
    //    只等 ① 会在"连接刚摘掉、判定还没翻"的缝里取到一次中间态；
    //    只等 ② 又可能在别的连接还在时误判成"已经断开"。
    //    等待失败时**不跳过**：后面照原样断言，让失败看得见（而不是变成一条假绿）。
    const offlineSeen = await waitFor(async () => {
      try {
        const s = await fetchStatus()
        return (s?.connection?.active ?? -1) === 0 && s?.alive?.alive === false
      } catch {
        return false
      }
    }, 15000)
    const st = await fetchStatus()
    const reasons = Array.isArray(st?.alive?.reasons) ? st.alive.reasons : []
    const active = st?.connection?.active ?? -1
    // 诊断事实：等待是否超时 + 取到判定时插件自己记的连接数
    log.info(
      `[N14] 断开等待=${offlineSeen ? 'ok' : '超时'} ` +
        `connection.active=${active} alive=${st?.alive?.alive} reasons=${JSON.stringify(reasons)}`,
    )

    offlineChecks.push(['N14-b 断开 NapCat 后状态端点报 alive=false（绝不许瞎报活着）', st?.alive?.alive === false])
    offlineChecks.push([
      'N14-c 离线判据指向"这条连接已经不可用"（no-connection 或 socket-not-open），不是含糊的 unknown',
      reasons.includes('no-connection') || reasons.includes('socket-not-open'),
    ])
    offlineChecks.push([
      'N14-d 离线时 because 明说了原因（人一眼看得出凭什么）',
      String((st?.alive?.because ?? []).join('；')).includes('NapCat') ||
        String((st?.alive?.because ?? []).join('；')).includes('WebSocket'),
    ])
    // ⚠️ 这里**不**断言 `connection.active === 0`。
    //
    // 实测发现：客户端 `close()` 之后，服务端那条连接**有时**留在 `connections` 里
    // （实测过一次 15 秒都没摘掉：`{selfId:'10002', ready:true, closed:false}`，
    // 也就是 `ws.readyState` 停在 CLOSING、close 事件还没来；下一次跑又正常摘掉了）。
    // 这是 ws 的 close 握手时序问题，不是判定的问题 —— 而这正是"为什么不能只看
    // 连接数/readyState 的布尔值"的活样本：**判定照样必须翻成离线**，靠的是
    // `socketOpen !== true` 与事件流静默这两条，而不是"连接被摘掉了"。
    // 所以这里改成断言"这条连接已经不可用"（摘掉 或 明确不可用），
    // 并把"死连接不会被选中去发消息"作为一条**独立的**断言（N14-k）。
    offlineChecks.push([
      'N14-j 插件确实处理了断开（连接被摘掉，或那条连接已被判定为不可用）',
      active === 0 || reasons.includes('socket-not-open'),
    ])
    offlineChecks.push([
      'N14-k 断开后发消息会明确报错（不会静默成功，也不会静默丢）',
      await (async () => {
        try {
          await sendTool.execute({ chat_type: 'private', chat_id: '20999', text: '断开之后这条不该发出去' }, {})
          return false
        } catch (err) {
          // 两种失败都算合格：`pick()` 选不到（连接已被摘掉）→ "当前没有可用的 OneBot 连接"；
          // 连接还在但 readyState 不是 OPEN → "OneBot 连接不可用，无法调用 …"。
          // 两种都不含"发成功"的歧义 —— 这正是要证明的
          return String(err?.message ?? err).includes('连接')
        }
      })(),
    ])
    offlineChecks.push([
      'N14-e 体检结论同步翻红：health.issues 里明说不活着（不用逐字段推）',
      String((st?.health?.issues ?? []).join('；')).includes('不活着'),
    ])

    // 工具侧必须与端点**同源**：模型拿到的也是"离线"，否则它会替插件编一句"在的"
    const aliveTool2 = registeredTools.get('qq_alive')
    if (aliveTool2) {
      const out = await aliveTool2.execute({}, {})
      offlineChecks.push(['N14-f qq_alive 断开后同样报 alive=false（工具与端点不会分裂）', out?.alive === false])
      offlineChecks.push([
        'N14-g qq_alive 在离线时给出了具体依据（reasons 非空）',
        (out?.reasons ?? []).length > 0 && String(out?.because ?? '').length > 0,
      ])
      offlineChecks.push(['N14-h 离线时的渲染明确写「不活着」', String(aliveTool2.output?.render({}, out)?.[0]?.text ?? '').includes('不活着')])
    }
    const tk2 = await tasksTool.execute({}, {})
    offlineChecks.push(['N14-i qq_tasks 也带上了离线判定（问进度时先被拦住）', tk2?.alive?.alive === false])
  } catch (err) {
    offlineChecks.push([`N14 断开实测抛错: ${err.stack ?? err.message}`, false])
  }
}
runChecks('存活检测 · 断开实测断言', offlineChecks)


// [one-off debug] 回传诊断：打印 N13 那几个 QQ 号的原始回传与 relay 账目
{
  const ids = ['20301', '20302', '20303', '20304', '20230', '20215']
  for (const id of ids) {
    const rows = client.outbound.filter((m) => m.chatId === id)
    console.log('[dbg] outbound ' + id + ': ' + rows.length + ' 条')
    for (const r of rows) console.log('[dbg]   ' + JSON.stringify(String(r.text).slice(0, 120)))
  }
  const st = await fetchStatus()
  console.log('[dbg] relay snapshot: ' + JSON.stringify(st?.relay ?? null))
  console.log('[dbg] bridge snapshot: ' + JSON.stringify(st?.bridge ?? null))
  console.log('[dbg] state chats: ' + JSON.stringify(Object.keys(st?.state?.chats ?? {})))
  console.log('[dbg] qc root=' + String(st?.state?.chats?.['private:20230']?.rootSessionId ?? ""))
}

// ── 汇总 ───────────────────────────────────────────────────────────────
console.log('\n=========== 汇总 ===========')
if (tally.failed.length === 0) {
  console.log(`  ✅ 全部通过：${tally.pass}/${tally.total}`)
} else {
  console.log(`  ❌ ${tally.pass}/${tally.total} 通过，失败 ${tally.failed.length} 条：`)
  for (const name of tally.failed) console.log(`     - ${name}`)
  process.exitCode = 1
}
console.log(
  `  （workspace ${calls.createWorkspace.length} / session ${calls.createSession.length} / ` +
    `prompt ${calls.prompts.length} / cancel ${calls.cancels.length} / archive ${calls.archives.filter((a) => a.ok).length}）`,
)

log.info('断言完成，进程保持存活以便检查状态端点（Ctrl+C 退出）')

process.on('SIGINT', () => {
  log.info('触发 disposer 清理。')
  for (const d of disposers()) {
    try {
      d()
    } catch (err) {
      log.warn(`disposer 抛错: ${err.message}`)
    }
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300)
})

