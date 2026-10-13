/**
 * 消息定性：两条**只剩下来**的规则 —— 寻址门 + 用户显式前缀。
 *
 * 这里曾经有三类规则：寻址、显式前缀、以及"控制指令关键词"（`/cancel [N|all]`）。
 * 第三类已经删掉了，理由是**关键词会误判**：
 * "把这个任务停一下看看日志" 会被前缀匹配吃成停止命令 —— 而那正是用户
 * 想让它做的事（看日志），不是取消。控制意图交给常驻会话理解，再由它调
 * `qq_tasks(cancel_task_id)`（那个工具的取消能力本来就有）。
 *
 * ## 寻址门（保留）：这不是控制词，是"这句话是不是对我说的"
 *
 * `participation.groupMode: mention` 下，**未被 @ 的群消息只入库、不进任何会话**。
 * 它判的不是"说什么"，而是"要不要理这一句"—— 与用户说了什么内容无关，
 * 所以它既无法被 LLM 语义判断替代（判断发生在进会话之前，会话还没看到它），
 * 也不能像关键词那样误伤任意一句话。
 *
 * ## 显式前缀（保留）：用户主动设的开关
 *
 * `tasks.prefix` / `tasks.chatPrefix` 是**用户显式配置**的（默认都是空字符串，
 * 留空即不启用）。留着的理由：它是用户自己按下的开关，语义明确、不会误判，
 * 而且是常驻会话不可用时的兜底分诊依据。
 *
 * ## 剩下的判断权交给常驻会话
 *
 * "这条到底是要我干活、还是闲聊、还是在问进度"不再由规则决定：
 * 消息照进常驻会话，由它决定要不要 `qq_dispatch`、要不要 `qq_tasks`。
 * 规则只负责**提前把明显的东西标出来**（见 `taskHint`），标错最多让会话多问一句。
 *
 * 本模块刻意不依赖 ctx / config / 日志，可以被单独 import 与测试。
 */

/** 分类结果 */
export const CLASSIFY = {
  /** 空消息或纯空白：不处理 */
  IGNORE: 'ignore',
  /** 闲聊：进该会话的常驻 root session */
  CHAT: 'chat',
  /** 任务：新建独立任务 session */
  TASK: 'task',
}

/** 短消息阈值（字符数，空白不计）。超过它的一律不判闲聊 */
export const SHORT_MESSAGE_MAX_CHARS = 20

/**
 * 整句匹配的寒暄/社交模式。
 * 这里刻意用**整句**匹配（normalize 去掉空白与句末标点后再比对），
 * 而不是 `^在` 这类前缀匹配 —— 否则"在 R:\x 建个目录"这种短任务会被误判成闲聊。
 */
const FULL_PATTERNS = [
  // 在吗 / 在不在
  /^(在|在吗|在么|在嘛|在不在|你在吗|你在么|有人吗|在的|在不在呀)$/,
  // 问候与道别
  /^(你好|您好|哈喽|哈啰|嗨|hi|hello|hey|早上好|早安|早|中午好|下午好|晚上好|晚安|拜拜|再见|bye|see you)$/i,
  // 致谢
  /^(谢谢|谢谢你|多谢|感谢|辛苦了|辛苦|thanks|thank you|thx|3q)$/i,
  // 收到/附和
  /^(好的|好嘞|好|嗯|嗯嗯|哦|噢|收到|了解|明白|ok|okay|okk)$/i,
  // 对 bot 自身的问题（典型的闲聊开场）
  /^(你是谁|你叫什么|你叫啥|你是什么|你会什么|你能做什么|你能干什么|你是做什么的|你几岁了|你叫什么名字)$/,
  // 测试性搭话
  /^(测试|测试一下|test|testing|ping)$/i,
  // 只有一个问号
  /^[?？]+$/,
]

/**
 * 询问进度类：短句 + 整句匹配才算闲聊。
 *
 * ⚠️ 判成闲聊**不等于**"随便答一句"。常驻会话收到这类话时的契约是
 * **先去查真实状态再答**（`qq_alive` + `qq_tasks`），见 frontdesk.js 的规则。
 */
const QUESTION_PATTERNS = [
  /^(现在)?(怎么样|如何|进展|进度|状态)$/,
  /^(好了吗|好了没|好了嘛|好了么|完成了吗|完成没|跑完了吗|跑完了没|弄好了吗|做完了吗|可以了吗)$/,
  /^(还要多久|多久好|啥时候好|什么时候好|到哪了)$/,
]

/**
 * 「需求含糊」的迹象：**没有宾语**的指代 + 光秃秃的动词。
 *
 * 这条判据只用来**换一种提示措辞**（让常驻会话先追问），不改变消息去向 ——
 * 判错了代价只是多问一句，成本远小于"硬派一个自己猜的任务"。
 * 所以它故意做得**保守**：只在"整句从头到尾都没有具体路径"时才成立
 * （见 `isAmbiguousAsk` 里的路径检查）。
 */
const VAGUE_REFERENCE =
  /(这个|那个|这些|那些|这份|那份|这批|那批|刚才的|刚说的|上次的|之前的|上面说的|前面说的|刚刚的)/

/**
 * 归一化：去首尾空白、句末标点与语气助词，便于整句匹配
 */
function normalize(text) {
  return String(text ?? '')
    .trim()
    .replace(/[?？!！。.,，、~～;；:：]+$/g, '')
    .trim()
    // 语气助词不影响"这句话是不是寒暄"：'现在怎么样了' / '你是谁啊' / '谢谢啦'
    .replace(/[了呢吧啊呀哦嘛哈嘞]+$/g, '')
    .trim()
}

/** 计字符数（空白不计，按码点计 —— 别把 emoji 算成两个） */
export function countChars(text) {
  return Array.from(String(text ?? '').replace(/\s+/g, '')).length
}

/** 是否是寒暄/闲聊短句（不含长度判断，便于单测） */
export function looksLikeChitchat(text) {
  const t = normalize(text)
  if (!t) return false
  for (const re of FULL_PATTERNS) if (re.test(t)) return true
  for (const re of QUESTION_PATTERNS) if (re.test(t)) return true
  return false
}

/**
 * ── 寻址门 ────────────────────────────────────────────────────────────
 *
 * bot 该不该在这个会话里回应。**这是"要不要理"的规则，不是"理什么"的规则。**
 *
 * 契约（与 `config.js` 的 `participation` 同源）：
 *   - group + silent  → 永不回应（只入库）
 *   - group + mention → 只有被 @ 才回应
 *   - group + active  → 全部回应
 *   - private         → 只看 `privateMode`（always = 全部回应）
 *
 * @param {object} input
 * @param {'private'|'group'|string} input.chatType
 * @param {boolean} [input.atBot] 这条消息是否 @ 了 bot（群聊用；私聊恒为 false）
 * @param {string} [input.groupMode] `participation.groupMode`
 * @param {string} [input.privateMode] `participation.privateMode`
 * @returns {{respond:boolean, reason:string}}
 */
export function shouldRespond({
  chatType,
  atBot = false,
  groupMode = 'mention',
  privateMode = 'always',
} = {}) {
  if (chatType === 'group') {
    if (groupMode === 'silent') return { respond: false, reason: 'group-not-mentioned' }
    if (groupMode === 'mention') {
      return atBot ? { respond: true, reason: 'group-mentioned' } : { respond: false, reason: 'group-not-mentioned' }
    }
    return { respond: true, reason: 'group-active' }
  }
  if (privateMode !== 'always') return { respond: false, reason: 'private-disabled' }
  return { respond: true, reason: 'private' }
}

/**
 * 给一条消息定性。
 *
 * 规则顺序（前两段是用户显式指令，优先级最高）：
 *   1. 空/纯空白                        → ignore
 *   2. 命中 tasks.prefix（任务前缀）      → task（强制）
 *   3. 命中 tasks.chatPrefix（闲聊前缀）  → chat（强制）
 *   4. 带合并转发等附件                  → task（转发一段记录必然是"要它看"）
 *   5. 短消息 且 命中寒暄/提问模式        → chat
 *   6. 其余                              → task
 *
 * 第 2 步排在第 3 步前面：两个前缀同时命中只可能出现在互相嵌套的配置里
 * （如 chatPrefix="/" + taskPrefix="/task"），此时按更"主动"的解释走 ——
 * 与"不确定判成任务"的取舍一致。
 *
 * ⚠️ **这里不再有控制指令分支**：`/cancel 3` 现在和别的正文一样走分类
 * （默认落到 task 分支，再由常驻会话理解成取消意图）。
 *
 * @param {object} input
 * @param {string} input.text 去掉 @bot 残留后的正文
 * @param {string} [input.chatPrefix] 强制闲聊前缀
 * @param {string} [input.taskPrefix] 强制任务前缀（配置项 tasks.prefix）
 * @param {boolean} [input.hasForward] 是否带合并转发段
 * @returns {{kind:string, reason:string, text:string}} text 是去掉前缀后的正文
 */
export function classifyMessage({ text, chatPrefix = '', taskPrefix = '', hasForward = false } = {}) {
  const raw = String(text ?? '')
  const trimmed = raw.trim()
  if (!trimmed) return { kind: CLASSIFY.IGNORE, reason: 'empty', text: '' }

  const tp = String(taskPrefix ?? '')
  if (tp && trimmed.startsWith(tp)) {
    // 只发了前缀（"/task"）时保留原文，避免把空串投给 session
    return { kind: CLASSIFY.TASK, reason: 'task-prefix', text: trimmed.slice(tp.length).trim() || trimmed }
  }

  const cp = String(chatPrefix ?? '')
  if (cp && trimmed.startsWith(cp)) {
    return { kind: CLASSIFY.CHAT, reason: 'chat-prefix', text: trimmed.slice(cp.length).trim() || trimmed }
  }

  // 带附件的消息不可能是寒暄：转发记录 + 一句话就是在派活
  if (hasForward) return { kind: CLASSIFY.TASK, reason: 'forward-attachment', text: trimmed }

  if (countChars(trimmed) < SHORT_MESSAGE_MAX_CHARS && looksLikeChitchat(trimmed)) {
    return { kind: CLASSIFY.CHAT, reason: 'short-chitchat', text: trimmed }
  }

  return { kind: CLASSIFY.TASK, reason: 'default', text: trimmed }
}

/**
 * 一条要动手的请求，是否**缺关键信息**（该先追问而不是直接派活）。
 *
 * 判据（两条同时成立才算含糊）：
 *   1. 句子里有**没有宾语的指代**（这个 / 那个 / 刚才的 / 上次的…）；
 *   2. 整句**没有任何具体路径**（盘符路径、`./x`、`xxx/yyy`、带扩展名的文件名）。
 *
 * 为什么要求"同时成立"：`把这个目录下的历史产物清一遍` 有指代但**没有**具体路径 ——
 * 那才是真的该问一句"哪个目录"。而 `把 A 目录下的图片转成 webp` 既没有指代、
 * 又有具体目标，直接派即可，不该先问一遍。
 *
 * ⚠️ 这是**提示措辞**的判据，不是执行指令：判成含糊只是让常驻会话先问一句，
 * 判错（把明确的判成含糊）的代价是多一轮对话，判反的代价是硬派一个猜出来的任务。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isAmbiguousAsk(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (!VAGUE_REFERENCE.test(t)) return false
  // 有具体路径/文件名就不算含糊：指代 + 明确目标（"这个目录下的 x.md"）足够动手
  const hasPath =
    /[A-Za-z]:[\\/]/.test(t) || // C:\ 或 R:/
    /(^|[\s（(])\.{0,2}[\\/][\w.-]/.test(t) || // ./x  ../x  /x
    /[\w.-]+[\\/][\w.-]+/.test(t) || // a/b、dir\file
    /\b[\w.-]+\.(md|txt|json|ya?ml|log|csv|tsv|xlsx?|docx?|pptx?|png|jpe?g|webp|gif|mp4|mp3|zip|tar|gz|pdf|html?|js|mjs|cjs|ts|py|ps1|sh|bat|go|rs|java|c|cpp|h)\b/i.test(t)
  return !hasPath
}

/**
 * 把分类结果翻译成"给常驻会话的提示"。
 *
 * ## 为什么是**提示**而不是**指令**
 *
 * `CLASSIFY.TASK` 不是执行指令：`index.js` 不会因为它是 task 就去 `submit()`。
 * 打开 `conversation.enabled`（默认）之后，闲聊与任务**都进同一个常驻会话**，
 * 而且**干活的就是那台会话自己** —— 默认路径不注册 `qq_dispatch`、也没有任务号。
 * （只有 `conversation.enabled=false` 的 v2 回滚路径上，分类结果才重新变成执行指令，
 * 由 `TaskScheduler` 直接建独立任务会话。）
 *
 * ## 两种措辞（这是"先追问再动手"的落点之一）
 *
 * | 情形 | 提示的落点 |
 * |---|---|
 * | 需求含糊（`isAmbiguousAsk`） | **先追问**：一次只问最关键的那一个问题，问完等回答，**不要**先闷头做一个猜的 |
 * | 其余 | 意图清楚就直接动手；别多问一遍 |
 *
 * ⚠️ 它**不是**"永远先问一遍"：第二种措辞明确写着意图清楚就直接动手。
 * 真正的行为约束还写在常驻会话的 system prompt 里（`frontdesk.js`）——
 * **两处措辞必须一致**。早先这里留着 v2 的"用 `qq_dispatch` 派活、报几号排第几"，
 * 而默认路径根本没有那个工具 —— 等于一边在系统提示里说"你就是动手的人"，
 * 一边在正文尾巴上教模型去派活。
 *
 * @param {string} kind `CLASSIFY` 里的取值
 * @param {string} [reason] `classifyMessage` 给的判据
 * @param {string} [text] 正文（用来判断含糊）
 * @returns {string} 要追加到正文尾部的提示；不需要提示时返回空串
 */
export function taskHint(kind, reason, text = '') {
  if (kind !== CLASSIFY.TASK) return ''
  // 带合并转发的短消息被判成任务，是因为"转发一段记录必然是'要它看'"。
  // 这条提示同样成立（转发内容 + 一句话就是派活），所以不区分 reason。
  const why = reason ? `（判据 ${reason}）` : ''

  if (isAmbiguousAsk(text)) {
    return (
      `\n\n[分诊: 任务·待澄清]${why} 这条像是要你动手做事，但**缺关键信息**` +
      '（不知道对哪个目录/哪个文件、或要什么格式）。**先在 QQ 上追问一次**：' +
      '一次只问最关键的那一个问题，问完就停下等回答，**不要**先闷头做一个自己猜的东西。' +
      '用户回答之后再动手。'
    )
  }

  return (
    `\n\n[分诊: 任务]${why} 规则分类器认为这条像是要你**动手做事**，而不是闲聊。` +
    '**干活的就是你自己这台会话**（默认路径没有别的任务会话可派、也没有任务号）：' +
    '意图清楚就直接动手，做完把结果告诉用户；' +
    '如果你觉得这只是闲聊或提问，直接回答即可。'
  )
}
