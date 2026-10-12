/**
 * 「前台」行为约定：一条 `systemPrompt.section()`，**只作用于常驻对接会话**。
 *
 * ## 为什么用 section 而不是 context
 *
 * `systemPrompt.context()` 造的是**动态运行时上下文快照**，语义是"文本变了就重注
 * 一条 user 消息"（见 context.js 顶部）。这里是**固定行为约定**，每步都一样，
 * 用 `section()` 才对：它进的是系统提示词本体，不进历史、不占对话轮次。
 *
 * ## 为什么不是 `dsh-persona`
 *
 * `dsh-persona` 需要 agent scope，而本插件是全局插件、在**运行时**按 session 分流
 * （同一个进程里会话是惰性建的）。`section()` 的 `text` 可以是函数，于是
 * "只给常驻对接会话注入"这件事在**一个全局注册**里就能做到：拿不到 scope 的
 * （未知会话）返回空串，section 在渲染时被丢弃
 * （`dsh-system-prompt/lib/index.js` 的 `renderPrompt`：空段落直接丢）。
 *
 * ## 两条规则（旧版的第三条"派活"已经随需求废除）
 *
 * | 规则 | 落点 |
 * |---|---|
 * | 需求含糊先追问 | 本段落 + `classify.js` 的 `taskHint` |
 * | 进度询问去查真实状态 | 本段落 + `qq_alive` / `qq_tasks` 的工具描述 |
 *
 * 旧版还有第三条"说停就取消 → `qq_tasks(cancel_task_id)`"，以及一条"派活给独立
 * 任务会话"的章节。**两者都随"每条消息新建任务会话"一起废除**：现在每个 QQ 会话
 * 只有这一台会话，干活就在它里面做，没有可派的独立任务、也没有任务号可取消。
 */

/** 段落名。同一个 scope 里同名会抛，所以插件内只能用一次 */
export const FRONTDESK_SECTION = 'dsh-whale-inurqq:front-desk'

/**
 * 排序位置：**紧跟人设之后**（`SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX = 0`），
 * 排在第一方工具指引（1000+）之前。
 *
 * 理由：它写的是"这个 agent 是谁、怎么对待用户"，属于身份层而不是工具用法层。
 * 取 10 —— 留出人设前缀与将来可能的其它身份段落的空隙，同时远小于 1000。
 */
export const FRONTDESK_ORDER = 10

/**
 * 段落正文。
 *
 * 写法上的两条自律：
 *   1. **给判据，不给口号**。"不清楚就问"这种话模型会点头然后照样硬做；
 *      "缺路径/格式/目标才算不清楚"才是可执行的判定。
 *   2. **反面例子必须真的出现过**。下面引的"把这个任务停一下看看日志"就是
 *      删掉关键词解析的直接原因（`/cancel` 前缀会把它吃成停止命令）。
 */
export const FRONTDESK_TEXT = `你是这个 QQ 会话的**唯一对接人**：用户直接跟你说话，而**聊天和干活都发生在你自己这台会话里** —— 没有别的任务会话替你跑，你就是那个动手的人。
写文件、跑命令、查语料都用你自己的工具去做；做完把结果告诉用户，别描述成"我已经派出去了"。

## 一、要动手的事：用户把话说明白之前，先问

在动手之前先过一遍这三项。**任何一项还缺、而且从对话史里也补不出来，就在 QQ 上追问一次，一次只问一个坑，问完停下等回答，不要先闷头做一个自己猜的东西**：

1. **对象**：对哪个目录 / 哪个文件？含糊的指代（"这个""刚才那个"）如果前面没有落点，就是缺。
2. **产物**：要什么结果、什么格式？语料库里查得到就查，不该问用户。
3. **范围**：只做这一份，还是这个目录下全部？

追问只问最关键的那一个，不要列清单盘问。

**但意图明确时直接动手，不许先问一遍。** "帮我把 A 目录的图片转成 webp" 三项都齐，直接做。
"帮我把这个月的采集日志按周汇总" 缺对象（哪个目录的日志？），先问一句再做。

拿不准是"缺关键信息"还是"用户觉得你该知道"时，问一句的代价远小于闷头做错一整个任务；
但**"先确认一下"不能变成口头禅** —— 每一条都要问一遍，用户会觉得你什么都不会做。

## 二、进度询问：先去查，再如实回答

"好了吗""到哪了""怎么还没好""刚才那个呢" —— 这类话**不是闲聊**。按这个顺序查：

1. \`qq_alive\`：先确认机器和 QQ 通道还是活的。**离线就直说离线**（并说明理由），别猜进度。
2. \`qq_tasks\`：看真实状态。在跑就说在跑；查不到记录就说"查不到这条记录"，**不要编**。
   不要编"快了""马上就好""已经完成了"，也不要编一个新的进度百分比。
   注意：现在没有独立任务台账这回事，台账为空是正常的 —— 你现在做的这件事就在本会话里，
   用户问的就是它，如实说你做到哪一步了。

说"卡住"要有依据（比如某个命令长时间没返回），不要凭感觉说。

## 三、"停一下"先分清是停活还是别的事

用户说"停一下""别做了""不要了"时，先判断他到底要停什么：

- **"停一下看看日志"、"先别改了，把这个文件给我看看"** —— 这不是要停活，是要你看/给他看，
  照做即可。判断不准就问一句。
- 真的是要停掉当前这件事：**你就在这台会话里，停下来就是了** —— 别再往下做，
  把"我停在哪一步、已经动了什么"说清楚。没有别的会话需要你去取消。`


/**
 * 渲染这个会话该看到的段落（不是常驻对接会话 → 空串）。
 *
 * @param {string} scope `chatType:chatId`；空串表示不是常驻对接会话
 * @returns {string}
 */
export function frontDeskTextFor(scope) {
  return scope ? FRONTDESK_TEXT : ''
}

/**
 * 注册段落。与 `registerResidentMemory` 同一个姿态：拿不到服务就退化成 no-op。
 *
 * @param {object} opts
 * @param {any} opts.ctx cordis 上下文（用来取 systemPrompt 服务）
 * @param {ReturnType<import('../log.js').createLogger>} opts.log
 * @param {(sessionId:string)=>string} opts.scopeForSession sessionId → `chatType:chatId`，空串表示不是常驻会话
 * @returns {() => void} disposer
 */
export function registerFrontDesk({ ctx, log, scopeForSession }) {
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    log.info('[frontdesk] systemPrompt 服务不可用，前台行为约定不会被注入')
    return () => {}
  }

  const stats = { rendered: 0, skipped: 0, lastError: null }
  const disposer = systemPrompt.section({
    name: FRONTDESK_SECTION,
    order: FRONTDESK_ORDER,
    /**
     * 每一步都会被调用，必须**极快**且**纯**：只做一次反查 + 一次常量返回。
     * 渲染结果**逐字节恒定**（非对接会话恒为空串），所以不产生额外历史。
     */
    text: (context) => {
      try {
        const sessionId = String(context?.agent?.session?.id ?? context?.agent?.id ?? '')
        if (!sessionId) {
          stats.skipped += 1
          return ''
        }
        const scope = scopeForSession(sessionId)
        if (!scope) {
          // 未知会话（例如 v2 回滚路径上的任务会话）：**不注入** —— 它们有自己的任务正文
          stats.skipped += 1
          return ''
        }
        stats.rendered += 1
        return frontDeskTextFor(scope)
      } catch (err) {
        // 注入失败绝不能打断回合：宁可这一步没有约定，也不要会话报错
        stats.lastError = String(err?.message ?? err)
        log.warn(`[frontdesk] 渲染失败: ${stats.lastError}`)
        return ''
      }
    },
  })

  log.info(`[frontdesk] 已注册前台行为约定（name=${FRONTDESK_SECTION} order=${FRONTDESK_ORDER}，只对常驻对接会话生效）`)

  const off = typeof disposer === 'function' ? disposer : () => {}
  return Object.assign(
    () => {
      try {
        off()
      } catch {
        /* 已撤销 */
      }
    },
    { snapshot: () => ({ ...stats }) },
  )
}
