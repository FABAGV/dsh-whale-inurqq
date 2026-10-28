/**
 * DSH 侧桥接：把 QQ 会话映射成「工作区 + 会话」。
 *
 * ## 映射粒度（v2）
 *
 *   一个 QQ 会话（群或私聊）  ↔  一个 workspace（真实目录，产物落盘）
 *                             ↔  该 workspace 下的 **1 个常驻 root session**（闲聊，惰性创建）
 *                             ↔  该 workspace 下的 **N 个任务 session**（每条任务一个，跑完归档）
 *
 * ## 为什么任务要各自一个 session（v1 的教训）
 *
 * v1 把闲聊和任务都投进同一个 session，后果有三个，都是真机上能看见的：
 *   1. **串行阻塞**：后一条消息必须等前一条跑完（一条任务可能 60+ step），
 *      用户在 QQ 那边完全看不出是在排队。
 *   2. **无法单独取消**：只能 cancel 整个会话，会连带打断正在进行的闲聊上下文。
 *   3. **上下文污染**：闲聊人格与任务轨迹共用一份历史，任务一多就触发 compaction，
 *      早期闲聊被压掉 —— "聊天对象"这个功能会**静默**失去记忆。
 * 拆开之后，这三条同时消失：任务之间互不阻塞、取消只作用于一条、闲聊历史独立留存。
 *
 * 代价是 session 数量变多，所以任务 session 跑完必须归档（见 tasks.js），
 * 否则侧边栏会被任务刷满。
 *
 * ## 宿主契约（真机源码逐条核对过，改动前务必先读）
 *
 *   - `sessionController.create({ workspaceId })` —— **只能传 workspaceId**，
 *     同时传 cwd 会在实现第一行抛 `session.create accepts workspaceId or cwd, not both`。
 *     会话的 cwd 由 `workspace.path` 推导。
 *   - `sessionController.prompt(request, signal)`，request 里 content 必须含非空白文本。
 *   - `workspaceRegistry.create(path, title)` 要求 path 是**已存在的、完全限定的绝对路径**
 *     （Windows 上 `R:\x` 合格，`\x` 与相对路径不合格）；同路径重复调用返回已有实体且**不改标题**。
 *
 * 已知问题（本期刻意不做）：同一 workspace 下的多个任务 session 共享同一个 cwd，
 * 并发写同一批文件时会互相踩。彻底解法是每个任务一个子目录，
 * 但那会改变"一个 QQ 会话 = 一个工作区"的语义（产物不再落在一起），先留着。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 插件自己发出的 prompt id 的保留窗口。
 *
 * 为什么需要上限：`mode:'queue'` 投递出去的消息**可能永远不产生 `user/message`**
 * （会话被归档、被交班换代、投递进了已退役会话）。那一条 requestId 就再也不会被
 * 命中，留着只会慢泄漏。10 分钟足够覆盖"排队等前面那个 60+ step 的回合"。
 */
const PLUGIN_PROMPT_TTL_MS = 10 * 60 * 1000
/** 每台会话最多留多少个未命中的 requestId */
const PLUGIN_PROMPT_MAX_PER_SESSION = 50
/** 最多跟踪多少台会话（交班会换代，会话 id 只会越来越多） */
const PLUGIN_PROMPT_MAX_SESSIONS = 200

export class DshBridge {
  /**
   * @param {object} opts
   * @param {any} opts.ctx cordis 上下文（已注入所需服务）
   * @param {ReturnType<import('../config.js').resolveConfig>} opts.config
   * @param {ReturnType<import('../log.js').createLogger>} opts.log
   * @param {import('./state.js').StateStore} opts.state
   * @param {import('./handoff.js').DeliveryGate} [opts.gate]
   *   单点投递守卫。**所有**向会话投递的路径都必须经过它 ——
   *   否则"往已归档会话投递"会变成一次静默的数据丢失（见 handoff.js 的 DeliveryGate 注释）。
   *   不传时用一个永远放行的空守卫，保证老调用点（例如单测）不必改。
   * @param {(sessionId:string)=>void} [opts.onUserPrompt]
   *   每次**用户消息**投递成功后的回调。交班用它判断"交接文本已经和用户的话
   *   同批交付了"（见 handoff.js 的 `pendingDelivery`）—— 这个事实只有投递入口
   *   知道，所以必须在这里回调出去。
   */
  constructor({ ctx, config, log, state, gate, onUserPrompt }) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.state = state
    this.onUserPrompt = typeof onUserPrompt === 'function' ? onUserPrompt : null
    this.gate =
      gate ??
      ({
        deliver: ({ deliver }) => ({ ok: true, value: deliver() }),
        deliverAsync: async ({ deliver }) => ({ ok: true, value: await deliver() }),
        retire: () => false,
        isRetired: () => false,
        snapshot: () => ({ retiredCount: 0, note: 'no-gate' }),
      })
    this.disposed = false
    /** 每个会话一把串行锁，避免并发建 workspace/session 时重复创建 */
    /** @type {Map<string, Promise<any>>} */
    this.locks = new Map()
    /**
     * 本插件自己发出的 prompt 的 requestId（sessionId → Map<requestId, 发出时刻>）。
     *
     * ## 它是干什么的（规则 2 的判据来源）
     *
     * 一个会话里的回合有两种来源：**本插件投递的**（QQ 来的话）与**用户自己在 DSH
     * GUI 里发的**。回传只允许前者。而宿主把这件事**记在会话日志里**：
     * `sessionController.prompt()` 造的是
     * `createUserMessage({content, source: {kind:'user', rpcId: request.requestId}})`
     * （`dsh-api-session-controller/lib/index.js:856-859`，不透明索引编出来的同一段在
     * `lib/types/commands.js:303-307`），这条消息随后由 `agent-loop` 落成会话事件
     * `user/message`（`dsh-agent-loop/lib/index.js:1061`）。
     *
     * 所以判据是**精确的**：`user/message` 的 `data.source.rpcId` 命中
     * 本集合 → 这个回合是插件发起的；没命中 → 是 GUI 里用户自己发的。
     * 不需要猜"用户在不在电脑前"。
     *
     * ⚠️ 登记在 `sessions.prompt()` **之前**：`mode:'queue'` 的投递不会立刻产生
     *    `user/message`（要等轮到它那个回合），登记晚了就漏判。
     * ⚠️ requestId 是 `randomUUID()`，只会被精确命中、不会与 GUI 的撞车，
     *    所以**不必**在命中后删除；过期只按时间与条数裁剪（见 #notePromptRequest）。
     * @type {Map<string, Map<string, number>>}
     */
    this.pluginPromptIds = new Map()
    this.stats = {
      workspacesCreated: 0,
      workspacesReused: 0,
      sessionsCreated: 0,
      rootSessionsCreated: 0,
      bindingsReused: 0,
      chatsDelivered: 0,
      failed: 0,
      lastError: null,
    }
  }

  #svc(name) {
    try {
      return typeof this.ctx.get === 'function' ? this.ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  /** 单飞：同一个 key 上的操作串行执行 */
  #withLock(key, fn) {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(
      key,
      next.catch(() => {}),
    )
    return next
  }

  /**
   * 磁盘上这份会话绑定还可信吗？
   *
   * ⚠️ 为什么必须校验：工作区目录名是从 `chatType`/`chatId` **推导**出来的
   *    （`projectPathFor`），而绑定来自 `state.json` —— 它可能被手改过、被旧版本写过，
   *    或者 `tasks.workspaceRoot` 后来改过。只判"有没有 workspaceId"就复用会踩两个坑：
   *      1. 记录的 workspacePath 与本会话推导出的目录**对不上** —— 那么这条绑定的
   *         归属是可疑的（现场与日志不一致），而且 `sessions.create({workspaceId})`
   *         的 cwd 由 DSH 按 id 解析，插件自己无从发现；
   *      2. `workspaceId` 指向已被删除的工作区时，`sessions.create` 会一直失败，
   *         而"有 workspaceId 就 return"是硬返回 —— 那个 QQ 会话将**再也建不出会话**。
   *
   * 判据刻意只比 **目录名**（`qq-<chatType>-<chatId>`），不比完整路径：
   *   · `registry.create` 返回的是 **realpath**，Windows 上大小写/短名可能与传入值不同，
   *     严格全路径比对会把所有正常绑定都判成不可信 → 每次启动重建一遍工作区与会话；
   *   · 只比目录名足够拦住"绑定被写到别的目录上"，且用户改 `workspaceRoot` 时
   *     旧绑定仍按原样复用（与改动前的行为一致，不制造意外迁移）。
   *
   * @param {{chatType:'private'|'group', chatId:string}} chat
   * @param {{workspacePath?:string}} cached
   */
  #bindingMatchesChat(chat, cached) {
    let expectedName = ''
    try {
      expectedName = path.basename(this.projectPathFor(chat.chatType, chat.chatId))
    } catch {
      return false // chatType/chatId 本身非法 —— 这份绑定不可信
    }
    const actual = cached?.workspacePath
    if (typeof actual !== 'string' || !actual) return false
    return path.basename(actual).toLowerCase() === expectedName.toLowerCase()
  }

  /**
   * workspace 目录：`<workspaceRoot>/qq-<chatType>-<chatId>`
   *
   * ⚠️ 这里必须自带校验，**不能只靠入口那道**：目录名是拼出来的，而 `ensureProject`
   *    紧接着就 `fs.mkdirSync(dir, { recursive: true })`。早先没有守卫，于是
   *    `chatId = "..\\..\\..\\x"` 会直接在 workspaceRoot 之外建目录 ——
   *    实测复现过。入口（`normalize.js`）是第一道闸，这里是纵深防御的第二道：
   *    `StateStore` 里历史遗留的绑定（旧版本被注入过的 `state.json`）也会走到这里，
   *    而"升级"并不会自动清掉那种 key。
   */
  projectPathFor(chatType, chatId) {
    const root = this.config.tasks.workspaceRoot
    if (!root) throw new Error('tasks.workspaceRoot 未配置，无法建立工作区')
    if (chatType !== 'private' && chatType !== 'group') {
      throw new Error(`非法会话类型：${chatType}`)
    }
    const id = String(chatId)
    if (!/^\d{1,12}$/.test(id)) throw new Error(`非法会话 id：${id}`)
    const dir = path.join(root, `qq-${chatType}-${id}`)
    const resolved = path.resolve(dir)
    const rootResolved = path.resolve(root)
    if (!resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(`工作区目录越出 workspaceRoot：${resolved}`)
    }
    return dir
  }

  #services() {
    const registry = this.#svc('workspaceRegistry')
    const sessions = this.#svc('sessionController')
    if (!registry || !sessions) {
      throw new Error('DSH 服务不可用：workspaceRegistry / sessionController 未就绪')
    }
    return { registry, sessions }
  }

  /**
   * 保证该 QQ 会话有可用的 **workspace**（不含 session —— root session 是惰性创建的）。
   * @param {{chatType:'private'|'group', chatId:string, chatName?:string}} chat
   */
  async ensureProject(chat) {
    const key = `${chat.chatType}:${chat.chatId}`
    return this.#withLock(key, async () => {
      const cached = this.state.get(chat.chatType, chat.chatId)
      // ⚠️ **早返回也要校验绑定**（理由见 `#bindingMatchesChat`）。这里不能写成
      //    "有 workspaceId 就复用"：那样 projectPathFor 的三道校验全被绕过。
      const trusted = cached?.workspaceId ? this.#bindingMatchesChat(chat, cached) : false
      if (cached?.workspaceId && !trusted) {
        this.log.warn(
          `[bridge] 丢弃不可信的会话绑定 ${chat.chatType}/${chat.chatId}：记录的工作区是 ` +
            `${JSON.stringify(cached.workspacePath ?? null)}，与本会话推导出的目录不符，将重建`,
        )
        this.state.remove(chat.chatType, chat.chatId)
      }
      if (trusted) {
        // 名字可能后来才知道（群名片/昵称），顺手补上，不必重建工作区
        if (chat.chatName && cached.chatName !== chat.chatName) {
          cached.chatName = chat.chatName
          this.state.set(chat.chatType, chat.chatId, cached)
        }
        this.stats.bindingsReused += 1
        return cached
      }

      const { registry } = this.#services()

      const dir = this.projectPathFor(chat.chatType, chat.chatId)
      // workspaceRegistry.create 要求目录已存在（否则 realpath 失败）。
      // 先看目录是否存在，用于区分「新建」与「复用」—— 计数器必须诚实，
      // 排障时靠的就是这些数字。
      const dirExisted = fs.existsSync(dir)
      fs.mkdirSync(dir, { recursive: true })

      const title = chat.chatName?.trim() || `QQ ${chat.chatType === 'group' ? '群' : '私聊'} ${chat.chatId}`
      const workspace = await registry.create(dir, title)
      if (dirExisted) this.stats.workspacesReused += 1
      else this.stats.workspacesCreated += 1
      this.log.info(`[bridge] 工作区就绪（${dirExisted ? '复用' : '新建'}）：${workspace.title} → ${workspace.path}`)

      const now = Date.now()
      const record = {
        chatType: chat.chatType,
        chatId: chat.chatId,
        chatName: chat.chatName ?? '',
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        workspaceTitle: workspace.title,
        /** 常驻 root session（闲聊用）；'' 表示还没建（惰性） */
        rootSessionId: cached?.rootSessionId ?? '',
        /** 常驻会话的代数（v3 交班用）：1 = 初代。交班一次 +1 */
        rootGeneration: Number.isInteger(cached?.rootGeneration) && cached.rootGeneration >= 1 ? cached.rootGeneration : 1,
        /** 上一次交班的台账（含 from/to/ratio/degraded）；没交过班时为 null */
        lastHandoff: cached?.lastHandoff ?? null,
        createdAt: cached?.createdAt ?? now,
        tasks: cached?.tasks ?? 0,
        taskIds: cached?.taskIds ?? [],
        lastTaskAt: cached?.lastTaskAt ?? 0,
        lastMessageId: cached?.lastMessageId ?? '',
      }
      this.state.set(chat.chatType, chat.chatId, record)
      return record
    })
  }

  /**
   * 建一个 session（**只传 workspaceId**）。这是全插件唯一建 session 的地方，
   * 契约校验点集中在这里，避免哪天有人在别处顺手加上 cwd。
   * @param {any} record 会话绑定记录
   * @param {string} title 会话标题
   */
  async newSession(record, title) {
    const { sessions } = this.#services()
    const created = await sessions.create({ workspaceId: record.workspaceId })
    this.stats.sessionsCreated += 1
    this.log.info(`[bridge] 会话就绪：${created.sessionId}（cwd 由工作区推导：${record.workspacePath}）`)
    // 起个能认出来的名字（失败不影响任务）
    try {
      await sessions.rename({ sessionId: created.sessionId, title })
    } catch (err) {
      this.log.debug(`[bridge] 会话重命名跳过: ${err?.message ?? err}`)
    }
    return created.sessionId
  }

  /**
   * 惰性创建（或复用）该 QQ 会话的常驻 root session —— 闲聊的落脚点。
   * 只有真的来了闲聊才建，纯任务型会话不会白占一个 session。
   * @param {any} record
   * @returns {Promise<string>} rootSessionId
   */
  async ensureRootSession(record) {
    const key = `${record.chatType}:${record.chatId}`
    return this.#withLock(`${key}#root`, async () => {
      const fresh = this.state.get(record.chatType, record.chatId) ?? record
      if (fresh.rootSessionId) return fresh.rootSessionId
      const title = fresh.chatName?.trim() || `QQ ${fresh.chatType === 'group' ? '群' : '私聊'} ${fresh.chatId}`
      const sessionId = await this.newSession(fresh, `QQ · ${title}`)
      this.stats.rootSessionsCreated += 1
      this.state.setRootSession(fresh.chatType, fresh.chatId, sessionId)
      return sessionId
    })
  }

  /**
   * 登记一个"本插件即将发出的 prompt id"，供规则 2 的来源判据使用。
   *
   * 裁剪规则（两条都要，缺一条都会长成慢泄漏）：
   *   - 时间：超过 {@link PLUGIN_PROMPT_TTL_MS} 的直接丢（`queue` 模式下一条消息
   *     排十分钟还没被消费，基本只剩"被别的回合吞掉/会话退役"两种结局）；
   *   - 条数：每台会话只留最近 {@link PLUGIN_PROMPT_MAX_PER_SESSION} 条。
   *
   * ⚠️ **不在命中后删除**：同一台会话里排队着好几条插件消息时，命中一条不能
   *    作废其余的。裁剪只按上面两条，判定才是精确的。
   */
  notePromptRequest(sessionId, requestId) {
    const sid = String(sessionId ?? '')
    const rid = String(requestId ?? '')
    if (!sid || !rid) return
    let map = this.pluginPromptIds.get(sid)
    if (!map) {
      map = new Map()
      this.pluginPromptIds.set(sid, map)
    }
    const now = Date.now()
    for (const [id, at] of map) {
      if (now - at > PLUGIN_PROMPT_TTL_MS) map.delete(id)
    }
    map.set(rid, now)
    while (map.size > PLUGIN_PROMPT_MAX_PER_SESSION) {
      const oldest = map.keys().next()
      if (oldest.done) break
      map.delete(oldest.value)
    }
    // 会话本身已经不在映射里时，顺手把它那份也清掉（会话归档/换代后不再有事件）
    if (this.pluginPromptIds.size > PLUGIN_PROMPT_MAX_SESSIONS) {
      for (const [key, value] of this.pluginPromptIds) {
        if (key !== sid && value.size === 0) this.pluginPromptIds.delete(key)
        if (this.pluginPromptIds.size <= PLUGIN_PROMPT_MAX_SESSIONS) break
      }
      // 仍然超量：按插入顺序丢掉最早的整台会话记录（最可能是早就换代掉的那些）
      while (this.pluginPromptIds.size > PLUGIN_PROMPT_MAX_SESSIONS) {
        const oldest = this.pluginPromptIds.keys().next()
        if (oldest.done || oldest.value === sid) break
        this.pluginPromptIds.delete(oldest.value)
      }
    }
  }

  /**
   * 这条 `user/message` 是不是本插件投递的？（规则 2 的**唯一**判据）
   *
   * 依据是一手源码，不是猜：`sessionController.prompt()` 把 requestId 写进
   * `source.rpcId`（`dsh-api-session-controller/lib/index.js:856-859`），那条消息
   * 落成会话事件 `user/message`（`dsh-agent-loop/lib/index.js:1061`），于是
   * `event.data.source.rpcId` 就是"谁发起的这个回合"的权威答案。
   * GUI 里用户自己发的消息走的是同一条 `prompt()`，但带的是**它自己**的 requestId，
   * 不在本集合里 —— 所以判定是精确的，不需要靠"最近有没有 GUI 活动"去猜。
   */
  isPluginRequest(sessionId, requestId) {
    const rid = String(requestId ?? '')
    if (!rid) return false
    return this.pluginPromptIds.get(String(sessionId ?? ''))?.has(rid) === true
  }

  /** 投递正文的来源标注：让 agent 知道这句话是谁从哪说的 */
  buildPromptText({ chatType, chatName, chatId, senderName, text }) {
    const header =
      chatType === 'group'
        ? `[来自 QQ 群 ${chatName || chatId}，发言人 ${senderName || '未知'}]`
        : `[来自 QQ 私聊，发言人 ${senderName || '未知'}]`
    return `${header}\n${text}`
  }

  /**
   * 投递一条正文到指定 session。
   *
   * ⚠️ **这是全插件唯一的 `sessions.prompt()` 调用点**，也是唯一的 prompt 侧投递入口。
   * 它必须走 `DeliveryGate` —— 因为"归档后投递"是**静默失败**：
   * 宿主不抛错、不通知，`ArchivedSessionGate` 在 `agent/pre-step` 直接 reject，
   * 那条消息连同被唤醒的用户输入一起以 `blocked` 结束。
   * 把"这台会话还能不能收"的判断**收在一处**，是唯一能让这类失败有声的办法。
   *
   * @param {string} sessionId
   * @param {string} text
   * @param {string} [by] 调用点标识（排障用）
   */
  async promptSession(sessionId, text, by = 'bridge:prompt') {
    const { sessions } = this.#services()

    // ⚠️ requestId 先生成再登记，且**登记在投递之前** —— 判定要用的就是这一个 id
    //    （见 pluginPromptIds 的注释）。`mode:'queue'` 时 user/message 要等轮到它
    //    那个回合才出现，登记晚了就会把"插件自己发起的回合"误判成 GUI 的。
    const requestId = randomUUID()
    this.notePromptRequest(sessionId, requestId)

    // 守卫：如果这台会话已退役，`deliver` 的闭包根本不会被调用
    const outcome = await this.gate.deliverAsync({
      sessionId,
      kind: 'prompt',
      by,
      deliver: () =>
        sessions.prompt(
          {
            requestId,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
          new AbortController().signal,
        ),
    })
    if (!outcome.ok) {
      if (outcome.refused) {
        const err = new Error(`session-retired: 拒绝向已退役会话投递（${sessionId}）`)
        err.code = 'session-retired'
        throw err
      }
      throw outcome.error ?? new Error(outcome.reason ?? '投递失败')
    }
    // 投递成功 = 下一次 claim 会把"用户这句话"和已经躺在 next-step 里的交接文本
    // 一起交给模型（顺序见 handoff.js §1.6 的位置契约）。交班据此停止补投。
    try {
      this.onUserPrompt?.(sessionId)
    } catch (err) {
      this.log.debug(`[bridge] onUserPrompt 回调失败（不影响投递）: ${err?.message ?? err}`)
    }
    return outcome.value
  }

  /** 反查某个 session 的活 agent（交班注入交接文本要用） */
  async ensureAgent(sessionId) {
    const agents = this.#svc('agents')
    if (!agents || typeof agents.get !== 'function') return null
    for (let i = 0; i < 20; i += 1) {
      const agent = agents.get(sessionId)
      if (agent) return agent
      // sessions.create 返回时 agent 应当已就绪；万一有极短的发布延迟就等一下
      await new Promise((r) => setTimeout(r, 25))
    }
    return null
  }

  /**
   * 投一条用户消息到该 QQ 会话的常驻会话（**唯一**的用户消息 prompt 入口）。
   *
   * 契约：`chat()` 与测试钩子都走它，所以"重建绑定/重试一次"这套语义只有一份实现。
   * 它内部调 `promptSession()`，而后者过 `DeliveryGate` ——
   * 于是"这台会话还能不能收"的判断在全插件只有一处。
   *
   * @param {object} input
   * @returns {Promise<{sessionId:string, rebuilt:boolean, workspacePath:string}>}
   */
  async deliverChat({ chatType, chatId, chatName, text, senderName, by = 'bridge:chat' }) {
    const record = await this.ensureProject({ chatType, chatId, chatName })
    const body = this.buildPromptText({ chatType, chatName, chatId, senderName, text })
    let sessionId = await this.ensureRootSession(record)
    let rebuilt = false

    try {
      await this.promptSession(sessionId, body, by)
    } catch (err) {
      // 常驻会话可能已被归档/退役/删除：丢掉绑定重建一次（只重试一次，避免死循环）
      this.log.warn(`[${by}] 投递失败（${err?.message ?? err}），重建常驻会话后重试`)
      this.state.setRootSession(chatType, chatId, '')
      sessionId = await this.ensureRootSession(record)
      rebuilt = true
      try {
        await this.promptSession(sessionId, body, `${by}:retry`)
      } catch (err2) {
        this.stats.failed += 1
        this.stats.lastError = `${err2?.message ?? err2}`
        throw err2
      }
    }

    this.stats.chatsDelivered += 1
    return { sessionId, rebuilt, workspacePath: record.workspacePath }
  }

  /**
   * 闲聊：投进常驻 root session（没有就建）。
   * @param {object} input
   * @returns {Promise<{sessionId:string, rebuilt:boolean, workspacePath:string}>}
   */
  async chat(input) {
    return this.deliverChat({ ...input, by: 'bridge:chat' })
  }

  /**
   * 请求取消**某一个** session 的当前回合。
   * 这是 v2 相对 v1 的关键能力：v1 只有"整个会话"这一粒度，
   * 取消一条任务会连带打断同一 session 里的闲聊上下文。
   */
  async cancelSession(sessionId) {
    const { sessions } = this.#services()
    return sessions.cancel({ sessionId })
  }

  /**
   * 归档一个 session（从侧边栏收起来，防止任务 session 无限堆积）。
   *
   * ## 默认**不强制**
   *
   * 不带 `stopActivity` 时，宿主会先派发 `workspace/session-activity` 问一遍
   * "这个会话还有活吗"，**有活动就抛 `WorkspaceActiveSessionError` 拒绝归档**
   * （`dsh-workspace/lib/index.js` 524-540 行的 archiveSession）。
   * 这道宿主自带的闸门是刻意保留的第二重保险：调用方判据说"空闲"、宿主却说
   * "还有活"时，宁可归档失败退回等待，也不要用强制归档把仍在等用户回答的回合停掉 ——
   * 那种故障在 QQ 侧表现为"它突然不说话了"，极难排查。
   *
   * ## 什么时候才强制
   *
   * `force: true`（带 `{stopActivity:true}`）只用于**用户显式取消**与看门狗超时：
   * 那是明确的停止意图，不该被"它还在忙"挡回来。它先写归档集合，再派发
   * `workspace/session-stop` 请各提供方停下自己那一摊活。
   *
   * @param {string} sessionId
   * @param {{force?: boolean}} [options]
   */
  async archiveSession(sessionId, options = {}) {
    const { registry } = this.#services()
    if (typeof registry.archiveSession !== 'function') return false
    if (options.force) await registry.archiveSession(sessionId, { stopActivity: true })
    else await registry.archiveSession(sessionId)
    return true
  }

  /** 反查：某个 session 对应哪个 QQ 会话（进度回传与任务收敛都要用） */
  chatForSession(sessionId) {
    return this.state.findBySession(sessionId)
  }

  snapshot() {
    return { ...this.stats, locks: this.locks.size }
  }
}
