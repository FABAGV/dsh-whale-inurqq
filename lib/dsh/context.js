/**
 * 常驻记忆的注入：把 `MemoryStore` 里该会话的碎片，变成模型每步都能看到的背景。
 *
 * ## 为什么用 `systemPrompt.context()` 而不是塞一条消息
 *
 * `ctx.systemPrompt.context({name, order, text})` 注册的**不是**"一段固定 system prompt"，
 * 而是**动态运行时上下文快照**（`dsh-agent-loop/lib/index.js:298-349`）：
 *
 *   - 每一步 `preStep` 都重算一次：`assemble()` → `renderContextSections()` → `joinContextSections()`
 *     （`dsh-agent-loop/lib/index.js:907-910`）
 *   - `project(current, sections)` 里第一句就是
 *     `if (this.retained?.text === snapshot) return`（`:337`）
 *     —— **文本不变就不产生任何消息**
 *   - 文本变了才 `createUserMessage({source:{kind:'runtime-context', form:'snapshot'}})`
 *     并在下一次变化时把旧的那条**替换**掉（`:325`、`:338-348`）
 *
 * 所以它满足"不会被下一轮冲掉"（旧快照是被替换，不是被淹没），
 * 代价是：**每变一次就在历史里多一条 user 消息**。
 *
 * ## 因此本模块的头号约束是"字节稳定"
 *
 * ⚠️ 如果渲染结果不稳定（哪怕只是两条同重要度碎片的顺序换了一下），
 * **每一步都会 append 一条新的 user 消息** —— 历史会被自己的记忆灌满。
 *
 * 保证手段：
 *   1. 排序键含 `id asc` 兜底（见 memory.js 的 `compareFragments`）
 *   2. 渲染文本里**不含任何活值**（时间戳、token 数、代数都不进去）
 *   3. 版本锚 `[常驻记忆 v<N>]` 的 `N` 只在碎片集合真正增删时变（`MemoryStore.revision`）
 *   4. 渲染结果按 `(scope, revision, injectMode)` **缓存**：
 *      缓存命中时返回**同一个字符串实例**，连重新拼接都省掉
 *
 * ## 一个全局注册 + 按 `context.agent.id` 分流
 *
 * 注册回调收到的 `context` 是 `{ agent, scope, signal? }`
 * （`dsh-agent/lib/index.js:291-297` 的 `assembleContextFor`，由 `:907` 每步传入）。
 * `context.agent` 就是那个会话的 agent —— 于是**一个全局注册**就能让每个会话
 * 看到自己的那份记忆，不需要在 `agent/created` 里逐个注册（生命周期简单得多：
 * 插件卸载即撤销）。
 */
import { select, render } from './memory.js'

/** 注册名。同一个 scope 里同名会抛（`NamedEntries`），所以插件内只能用一次 */
export const CONTEXT_NAME = 'dsh-whale-inurqq:resident-memory'

/**
 * 排序位置：排在内置的三个之后，紧邻。
 *
 * `dsh-system-prompt/lib/index.js:44-48` 的 `CONTEXT_ORDERS` 只定义了
 * `SANDBOX_POLICY:110 / APPROVAL_POLICY:115 / SUBAGENT_DELEGATION:120`。
 * 放小了会被沙箱策略压在前面，放大了可能盖住子代理委派说明 —— 取 130。
 */
export const CONTEXT_ORDER = 130

/**
 * @param {object} opts
 * @param {any} opts.ctx cordis 上下文（用来取 systemPrompt 服务）
 * @param {import('./memory.js').MemoryStore} opts.memory
 * @param {import('./state.js').StateStore} opts.state
 * @param {ReturnType<import('../log.js').createLogger>} opts.log
 * @param {(sessionId:string)=>string} opts.scopeForSession sessionId → `chatType:chatId`，空串表示不是常驻会话
 * @param {() => {budgetTokens:number, injectMode:string}} opts.policy
 * @returns {() => void} disposer
 */
export function registerResidentMemory({ ctx, memory, log, scopeForSession, policy }) {
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (!systemPrompt || typeof systemPrompt.context !== 'function') {
    log.info('[context] systemPrompt 服务不可用，常驻记忆不会被注入（只落盘）')
    return () => {}
  }

  /**
   * 渲染缓存：key = `${scope}|${revision}|${budget}|${mode}`。
   * 命中时返回**同一个字符串**，保证字节稳定（连重新拼接都不做）。
   * @type {Map<string, {text:string, tokens:number, count:number}>}
   */
  const cache = new Map()
  const stats = { renders: 0, cacheHits: 0, injected: 0, empty: 0, lastError: null }

  const renderFor = (scope) => {
    const { budgetTokens, injectMode } = policy()
    if (injectMode === 'off' || budgetTokens <= 0) return { text: '', tokens: 0, count: 0 }

    const key = `${scope}|${memory.revision}|${budgetTokens}`
    const cached = cache.get(key)
    if (cached) {
      stats.cacheHits += 1
      return cached
    }

    const { picked, usedTokens } = select(memory.all(), scope, budgetTokens)
    // ⚠️ render 的第二个参数是**版本锚**，不是代数也不是时间 —— 它必须只随碎片集合变化
    const text = render(picked, memory.revision)
    const value = { text, tokens: usedTokens, count: picked.length }
    // 缓存不能无限长（每次碎片变化都会产生新 key），只留最近 32 份
    if (cache.size > 32) cache.clear()
    cache.set(key, value)
    stats.renders += 1
    return value
  }

  const disposer = systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    /**
     * 每一步都会被调用。这里必须**极快**且**纯**：
     * 不写盘、不发网络、不产生随机数，只做"查 scope → 查缓存"。
     */
    text: (context) => {
      try {
        const sessionId = String(context?.agent?.session?.id ?? context?.agent?.id ?? '')
        if (!sessionId) return ''
        const scope = scopeForSession(sessionId)
        if (!scope) return '' // 任务会话/未知会话：不注入（常驻记忆只服务常驻会话）
        const out = renderFor(scope)
        if (out.text) {
          stats.injected += 1
        } else {
          stats.empty += 1
        }
        return out.text
      } catch (err) {
        // 注入失败绝不能打断回合：宁可这一步没有记忆，也不要会话报错
        stats.lastError = String(err?.message ?? err)
        log.warn(`[context] 渲染常驻记忆失败: ${stats.lastError}`)
        return ''
      }
    },
  })

  log.info(`[context] 已注册常驻记忆注入（name=${CONTEXT_NAME} order=${CONTEXT_ORDER}）`)

  const off = typeof disposer === 'function' ? disposer : () => {}
  return Object.assign(
    () => {
      cache.clear()
      try {
        off()
      } catch {
        /* 已撤销 */
      }
    },
    { snapshot: () => ({ ...stats, cacheSize: cache.size }) },
  )
}

/**
 * 全局注册 + 按 agent 分流的**反查缓存**。
 *
 * 每次 assemble 都查一次 `agent.id → sessionId → scope`，而 `StateStore.findBySession`
 * 是 O(chats × tasks) 的线性扫描。所以这里做一层短 TTL 缓存：
 *   - 正向：sessionId → scope（空串是合法结果，表示"不是常驻会话"，也要缓存）
 *   - 交班切换映射时调 `invalidate(sessionId)` 把它踢掉
 *
 * 为什么用映射表而不是扫描：`context()` 的回调在**每一步**都会被调用，
 * 在里面做线性扫描会让"每一步"都多一次 O(n) —— 会话一多就是可见的延迟。
 */
export class ScopeResolver {
  /**
   * @param {object} opts
   * @param {import('./state.js').StateStore} opts.state
   */
  constructor({ state }) {
    this.state = state
    /** @type {Map<string, string>} sessionId → scope（'' = 不是常驻会话） */
    this.cache = new Map()
  }

  /** sessionId → `chatType:chatId`；不是常驻会话返回 '' */
  resolve(sessionId) {
    const id = String(sessionId ?? '')
    if (!id) return ''
    if (this.cache.has(id)) return this.cache.get(id)
    const chat = this.state.findBySession(id)
    const scope = chat && chat.kind === 'root' ? `${chat.chatType}:${chat.chatId}` : ''
    if (this.cache.size > 512) this.cache.clear()
    this.cache.set(id, scope)
    return scope
  }

  /** 会话归属变了（交班/绑定清空/归档）时必须调用，否则会一直读到旧 scope */
  invalidate(sessionId) {
    if (sessionId === undefined) {
      this.cache.clear()
      return
    }
    this.cache.delete(String(sessionId))
  }

  /** 登记一条已知映射（交班把新会话标成 root 时可以顺手写进去） */
  remember(sessionId, scope) {
    this.cache.set(String(sessionId), String(scope ?? ''))
  }
}
