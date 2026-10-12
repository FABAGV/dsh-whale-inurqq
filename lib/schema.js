/**
 * 插件配置 Schema。
 *
 * ⚠️ 重要：这里**故意不做 `volatile()`**。下面是踩过的坑，改之前务必读完。
 *
 * ## 坑：volatile 会摧毁配置传递
 *
 * `dsh-settings` 的 `volatileForm(schema)` 只收集被标为 volatile 的叶子字段；
 * 一个都没有时会在 `describe()` 里把整个插件条目丢弃 —— 即**设置页只显示
 * volatile 字段，没有就看不到这个插件**。
 *
 * 看起来"给所有字段加 volatile"就能解决。**但那样配置就传不进来了。**
 * 实测（schemastery 3.18）：
 *
 *     const S = z.object({ a: z.string().default('x').volatile(), b: z.string().default('y') })
 *     S['~standard'].validate({ a: 'q' })     // → { a: {}, b: 'y' }
 *     //                                            ↑ 默认值与传入值**都**被丢弃，变成空对象
 *
 * 而宿主正是通过 `resolveConfig(runtime, config)`（内部即
 * `runtime.Config['~standard'].validate(config)`）把配置交给插件的。
 * 所以 `tasks.workspaceRoot` / `connection.token` 一旦标为 volatile，
 * 插件收到的是 `{}` 而不是用户配置的值 —— `path.join({}, ...)` 直接抛错，
 * **每条任务都会失败**。
 *
 * volatile 的真实语义是「该字段的值来自运行时活值源（reactive ref），与静态配置无关」，
 * 和「让这个字段出现在设置页」不是一回事。要用它必须**同时**改成从活值源读取，
 * 只加标记会静默地丢掉配置。
 *
 * ## 因此本插件的配置来源
 *
 *   - profile 的 `cordis.patch.yml`（手改，或由 DSH 的插件配置界面写入）
 *   - 改完会触发 Loader 重新应用本插件，**无需重启 DSH**
 *   - 运行期体检与统计走状态端点：http://127.0.0.1:<reversePort>/dsh-whale-inurqq/status
 *
 * 将来若要做 GUI 设置页，正确路径是：标 volatile **并且**改成从活值源读取，
 * 两者同时做，且必须用真实 loader 验证 `workspaceRoot` 仍能送达。
 *
 * ## 另一条注意
 *
 * `resolveConfig` 走的是 Standard Schema 的 `~standard.validate`，是鸭子类型判定，
 * 所以本插件自带的 schemastery 与宿主自带的可以共存。
 */
import z from '@deepseek-ai/schemastery'

/** 恒等包装：保留调用点形状，便于日后确认活值源方案后统一改造 */
const v = (schema) => schema

export const Config = z.object({
  logLevel: v(
    z
      .union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')])
      .default('info')
      .description('日志详细程度。排查连接问题时设为 debug；日志同时写入 $DSH_HOME/dsh-whale-inurqq/plugin.log。'),
  ),

  connection: z
    .object({
      mode: v(
        z
          .union([z.const('reverse'), z.const('forward')])
          .default('reverse')
          .description('reverse：插件起服务端，等协议端连进来（推荐，无需公网）。forward：插件主动连出去（暂未实现）。'),
      ),
      mount: v(
        z
          .union([z.const('own'), z.const('dsh')])
          .default('own')
          .description('own：插件自己监听端口，与 NapCat 默认配置对齐。dsh：挂在 DSH 的 Web 服务上，此时 NapCat 需指向 DSH 的端口。'),
      ),
      host: v(z.string().default('127.0.0.1').description('监听地址。只绑本机，不要暴露到公网。')),
      reversePort: v(
        z
          .natural()
          .min(1)
          .max(65535)
          .default(6700)
          .description('监听端口，必须与 NapCat 的 websocketClients.url 端口一致。端口被占用时会自动重试 20 次。'),
      ),
      reversePath: v(z.string().default('/').description('反向 WebSocket 的路径。NapCat 默认连根路径。')),
      tokenRef: v(
        z
          .string()
          .default('QQ_ONEBOT_TOKEN')
          .description('从 DSH 凭据里读取 access token 的键名。推荐用凭据而不是明文配置；改这里无需重启，60 秒内生效。'),
      ),
      token: v(
        z
          .string()
          .role('secret')
          .default('')
          .description('access token 兜底值。留空且凭据也为空时表示不校验来源（不建议）。凭据优先于这里。'),
      ),
      callTimeoutMs: v(
        z.natural().min(1000).default(15000).description('单次 OneBot 动作调用的超时（毫秒）。'),
      ),
      forwardUrl: v(z.string().default('').description('forward 模式的目标地址，例如 ws://127.0.0.1:3001。')),
    })
    .description('与 OneBot 协议端的连接设置'),

  scope: z
    .object({
      groups: v(z.array(z.string()).default([]).description('群白名单。留空表示允许全部群。')),
      friends: v(z.array(z.string()).default([]).description('好友白名单。留空表示允许全部私聊。')),
      blockedGroups: v(z.array(z.string()).default([]).description('群黑名单，优先级高于白名单。')),
      blockedFriends: v(z.array(z.string()).default([]).description('好友黑名单，优先级高于白名单。')),
    })
    .description('哪些会话允许接入。同时决定哪些群会被采进语料库，qq_send 工具也受此约束'),

  participation: z
    .object({
      groupMode: v(
        z
          .union([z.const('silent'), z.const('mention'), z.const('active')])
          .default('mention')
          .description('silent：只记录不发言。mention：被 @ 才响应。active：bot 自行判断是否插话（谨慎开启）。'),
      ),
      privateMode: v(
        z
          .union([z.const('always'), z.const('never')])
          .default('always')
          .description('私聊消息是否直接当作任务处理。'),
      ),
    })
    .description('bot 在各会话里的参与程度'),

  tasks: z
    .object({
      workspaceRoot: v(
        z
          .string()
          .default('')
          .description('必填，且必须是完全限定路径（如 D:\\qq-projects）。每个 QQ 会话会在其下建一个子目录作为 DSH 工作区。'),
      ),
      prefix: v(z.string().default('').description('可选。指令前缀，例如 /task；命中后强制当作任务处理（优先级高于 chatPrefix）。')),
      chatPrefix: v(
        z
          .string()
          .default('')
          .description(
            '可选。闲聊前缀，例如 /chat；命中后强制当作闲聊处理，进该会话的常驻会话而不是新建任务会话。留空表示不启用。',
          ),
      ),
      maxConcurrent: v(
        z
          .natural()
          .min(1)
          .default(2)
          .description(
            '同一个 QQ 会话最多同时执行几条任务。超出的任务排队（会在 QQ 里收到「已排队」和「已开始」提示）。' +
              '⚠️ 只对 v2 回滚路径（conversation.enabled=false）有意义：默认路径不新建任务会话，没有并发槽位这回事。',
          ),
      ),
      settleGraceMs: v(
        z
          .natural()
          .default(3000)
          .description(
            '回合结束后的收敛确认窗（毫秒）。**治什么**：回合刚结束、新回合紧接着开始（多回合任务、被打断后续跑）这种毫秒级竞态 —— 确认窗内又开了新回合就不归档。**不治什么**：用户在几分钟后才回答提问/审批，那种等待由宿主判据（未决提问/审批/活动/inbox）长期拦住，与这个时间无关，调大它没有帮助。',
          ),
      ),
    })
    .description('任务与工作区'),

  /**
   * 常驻对接会话 + 阈值交班 + 碎片记忆。
   *
   * `enabled` 默认 **true**：这是 README 那条新逻辑链条 —— 一个 QQ 会话只接一台
   * 常驻对接会话，聊天和干活都在它里面，默认路径**不再新建任务会话**。
   *
   * `false` 是**回滚开关**：整条回到 v2（任务派成独立任务会话 + 并发上限，
   * 注册 `qq_dispatch`，不建常驻记忆、不挂交班监视器）。
   *
   * ⚠️ 仍然**绝对不用 `.volatile()`** —— 原因见本文件顶部。
   */
  conversation: z
    .object({
      enabled: v(
        z
          .boolean()
          .default(true)
          .description(
            '默认 true：一个 QQ 会话只接一台常驻对接会话，聊天和干活都在它里面做（默认路径不再新建任务会话）；' +
              '上下文到阈值时交班换新会话。改成 false 是回滚开关：回到 v2 的"每条任务一个新会话 + 并发上限"行为。',
          ),
      ),
      handoffAtRatio: v(
        z
          .number()
          .min(0.05)
          .max(0.95)
          .default(0.25)
          .description(
            '上下文用到窗口的百分之多少时交班。**必须低于宿主 compaction 的 thresholdRatio（本 profile 实测 0.8）**，' +
              '否则压缩会先把历史摘要掉，交班拿到的是残缺历史。默认 0.25：1M 窗口下约 25 万 token ' +
              '（≈18 万汉字）触发，压缩要到 80 万才动手。取 0.25 而不是 0.55 的理由是"代价不对称"——' +
              '交班是无损的，触发早了只浪费一次 LLM 调用，触发晚了就是有损。',
          ),
      ),
      minTokensBetweenHandoffs: v(
        z
          .natural()
          .default(20000)
          .description('两次交班之间至少要增长多少 token，防止新会话刚建好就被再次判定为超阈值而连环交班。'),
      ),
      memoryBudgetTokens: v(
        z.natural().min(0).default(2000).description('常驻记忆注入新会话的 token 预算。0 表示不注入。按重要性贪心截断。'),
      ),
      injectMode: v(
        z
          .union([z.const('context'), z.const('off')])
          .default('context')
          .description(
            '常驻记忆的注入方式。context = 注册为 systemPrompt 的动态运行时上下文' +
              '（每步重算、只在文本变化时产生一条消息）；off = 不注入（只落盘、不喂给模型，用于排障）。',
          ),
      ),
      dispatchHint: v(
        z
          .boolean()
          .default(true)
          .description('规则分类器判为任务时，在正文尾部给常驻会话加一条 [分诊: 任务] 提示。关掉则完全靠会话自己判断。'),
      ),
      handoffRetainDays: v(z.natural().min(0).default(90).description('交班束（handoff/ 目录）保留天数，0 表示永久保留。')),
      handoffInputChars: v(
        z.natural().min(2000).default(120000).description('交班时喂给整理模型的对话历史字符上限，超出部分从头部截断。'),
      ),
      handoffMaxTokens: v(
        z.natural().min(256).default(4000).description('交班整理这一次 LLM 调用的输出上限。'),
      ),
      fragmentMergeJaccard: v(
        z
          .number()
          .min(0.5)
          .max(1)
          .default(0.82)
          .description('碎片判为"完全重复"的字符 3-gram Jaccard 阈值。达到即合并，不新增。'),
      ),
      fragmentAskJaccard: v(
        z
          .number()
          .min(0.1)
          .max(0.99)
          .default(0.3)
          .description(
            '碎片判为"可能重复"的下界：介于它与 fragmentMergeJaccard 之间的，交给交班时的同一次 LLM 裁决（mergeWith）。' +
              '默认 0.3 而非设计文档设想的 0.6 —— 实测中文真实改写的 3-gram Jaccard 只有 0.06—0.43，' +
              '按 0.6 会让 LLM 裁决永不触发（记忆池被近义碎片灌满）。这一档**永不自动合并**，' +
              '所以调低它只增加裁决机会、不增加误合并风险。',
          ),
      ),
      agingEveryGens: v(
        z
          .natural()
          .min(1)
          .default(10)
          .description('每多少代会话做一次重要性老化（importance 减 1、清理长期未提及的 +0 碎片）。'),
      ),
      maxFragmentsPerChat: v(
        z
          .natural()
          .min(10)
          .default(500)
          .description(
            '每个 QQ 会话的碎片数量上限。老化只治"长期没被提到"，治不了"每代都新增好几条"，所以需要有这个硬上限；' +
              '超出时淘汰最不重要、最久没被提到的**非钉住**碎片（pinned 一律保住）。',
          ),
      ),
    })
    .description('常驻对接会话、阈值交班与碎片记忆。默认开启：一个 QQ 会话只接一台会话，聊天和干活都在它里面；关闭则回滚到 v2'),

  ingest: z
    .object({
      forwardRecords: v(z.boolean().default(true).description('把合并转发的内容展开并收进语料库。')),
      groupArchive: v(z.boolean().default(true).description('群消息沉淀进语料库（不进入会话上下文）。')),
      storeRawEvents: v(
        z.boolean().default(false).description('保留原始 OneBot 事件 JSON。会显著增大存储，仅排障时开启。'),
      ),
    })
    .description('语境采集。语料只存本机，按会话分片，到期自动清理'),

  insight: z
    .object({
      enabled: v(z.boolean().default(false).description('开启定时洞察：定期摘要语料并主动推送。')),
      schedule: v(z.string().default('0 22 * * *').description('洞察执行时间，cron 表达式。')),
      pushTarget: v(z.string().default('').description('洞察推送目标：群号或 QQ 号。')),
    })
    .description('主动洞察（后续版本，当前仅保留配置位）'),

  corpus: z
    .object({
      retainDays: v(z.natural().min(1).default(30).description('语料保留天数，到期自动清理。')),
    })
    .description('语料库'),

  advanced: z
    .object({
      dedupeWindowMs: v(
        z.natural().min(1000).default(300000).description('消息去重时间窗（毫秒）。防止协议端重连后重放。'),
      ),
      dedupeMaxEntries: v(z.natural().min(64).default(4096).description('去重缓存条目上限。')),
      relayFlushMs: v(
        z.natural().min(200).default(2000).description('进度回传的节流窗口（毫秒）。调小更实时，调大更省消息。'),
      ),
      stateDir: v(z.string().default('').description('状态文件目录。留空使用 $DSH_HOME/dsh-whale-inurqq。')),
    })
    .collapse()
    .description('高级选项，通常不需要改'),
})
