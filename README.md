# dsh-whale-inurqq

把 **QQ** 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：QQ 变成 DSH 的任务入口、语境来源和对话对象。

本插件是 **OneBot 11 协议的客户端**。它不实现任何 QQ 协议细节（登录、签名、加密都由协议端负责），因此可以像任何 IM 通道插件一样中立地分发。

---

## 三分钟接入（先跑通，再看设计）

1. **装上**：`dsh plugin --profile <你的profile> add dsh-whale-inurqq`（本仓库源码用 `add link:<目录绝对路径>`），然后重启 DSH。
2. **填工作区**：设置 → 插件 → dsh-whale-inurqq，把 `tasks.workspaceRoot` 填成一个**绝对路径**（如 `D:\qq-projects`，目录要存在且可写）。
3. **配 NapCat**：在它的 `config/onebot11.json` 里加一个反向 WebSocket 客户端，`url` 指向 `ws://127.0.0.1:6700`，`messagePostFormat` 必须是 `array`，`token` 填一个强口令（详见[配置 NapCat](#配置-napcat)）。
4. **填同一个 token**：在 DSH 凭据里加 `QQ_ONEBOT_TOKEN`（推荐），或在插件配置的 `connection.token` 里直接填。
5. **打开体检页**：<http://127.0.0.1:6700/dsh-whale-inurqq/status>

体检页顶部一句话就能回答"现在能不能用"：

- 绿色「**一切正常**」→ 回到 QQ 私聊 bot 发一句"在吗"，应该会收到回复；
- 黄色「**有 N 项需要处理**」→ 每条问题下面都写了**下一步该动哪里**，照着做即可。

> 体检页是**只读**的，不加载任何外部资源；脚本和监控仍然拿 JSON（`curl` 默认就是 JSON，或加 `?format=json`）。

---

## 它做什么

```
QQ 里发消息  →  插件归一化  →  分类：闲聊 / 任务（只决定措辞，不决定路由）
                                   │
                                   └──► **一个常驻对接会话**（每个 QQ 会话唯一）
                                          · 聊天和干活都在这里，不再为每条消息新建会话
                                          · 上下文到阈值 → 交班换新会话（碎片记忆继续用）
                                          · 由插件发起的 turn → 回传 QQ
                                          · 不主动推"还在跑"（进度靠问）

用户在 DSH GUI 里自己发起的 turn ──► 一条都不推 QQ
```

- **一个 QQ 会话（群或私聊）= 一个 DSH 工作区**（真实目录，产物落盘）
- 该工作区下有 **1 个常驻对接会话**：聊天和干活都在它里面
- 上下文用到窗口的 `conversation.handoffAtRatio`（默认 0.25）时**交班换代**，
  新会话接手、旧会话归档
- 进度**不主动推**：用户问才查真实状态（`qq_alive` + `qq_tasks`）再如实回答

### 回传的判据是「这个 turn 是谁发起的」

这是规则，不是启发式 —— 也不是"用户在不在电脑前"那种猜法：

| 这个回合的开头那条 `user/message` | 结论 |
|---|---|
| `source.rpcId` ∈ 插件发出的 prompt id 集合 | **插件发起的**（QQ 来的话）→ 照常回传 QQ |
| 不命中（例如用户在 DSH GUI 里自己敲的那句） | **GUI 发起的** → 这个回合一个字都不回传 |

依据是宿主自己记下的事实，不是推测：插件投递的 prompt 带 `requestId`
（`lib/dsh/bridge.js` 的 `promptSession`），宿主把它写进消息的
`source.rpcId`（`dsh-api-session-controller/lib/index.js:856-859`），那条消息落成
会话事件 `user/message`（`dsh-agent-loop/lib/index.js:1061`）。

⚠️ 事件形状：`user/message` 的 `event.data` **就是消息本体**
（宿主是 `session.append('user/message', message)`），判据字段是 `data.source.rpcId`，
**不是** `data.message.source.rpcId`。0.1.3 读错了这一层，真机上恒为 `undefined`
→ 每个回合都被当成"来源不明"丢掉，表现就是入站与 agent 回复都正常、QQ 侧一条回传都收不到
（`relay.relayed === 0`、`relay.provenanceDecided === 0`）。0.1.4 起两种形状都认。

**为什么这条重要**：常驻对接会话同时也是用户会在 GUI 里直接打开的会话。
没有这条门控，用户在电脑前自己敲一句话，QQ 那边就会莫名收到一段回传。

### 回传里**没有**"还在跑"

中间态一律安静：有正文就发正文，动过文件就列文件，两样都没有就什么都不发。
（曾经有过一句周期性 `🔧 执行中…`，连它带"工具调用次数"一起删掉了 ——
那些既不表示进度也不表示还要多久。）

进度靠**问**：`qq_alive` → `qq_tasks` → 如实回答，**不许编**进度或完成时间。

### 交班换新会话

```
上下文到阈值（默认 25% 窗口）→ 整理成交接束 + 碎片记忆落盘
  → 归档旧会话 → 建新会话 → 注入交接文本 → 在 QQ 上说一句"我整理了一下"
```

- 阈值判据用 `tokenMeter.measure(session).totalTokens`（与宿主压缩同一个数），**只在 `turn/end` 测**
- `handoffAtRatio` 必须**低于**宿主 compaction 的 `thresholdRatio`，否则压缩会先把历史摘要掉
- 交接文本走 `agent.inject()`（不唤醒、排在用户下一句话之前），不走 `prompt()`
- 交班期间新来的消息**排队**（`frozenQueue`），交班结束按原顺序补投 ——
  既不会丢，也不会另起一个会话

### `turn/end` 不等于回合结束

`turn/end` 只说明"模型此刻不欠回应"。未决提问/审批、以及被新输入打断的回合
（`interrupted`）都不该被当成终态 —— 判据与处理见 `lib/dsh/pending.js` 与
`lib/dsh/tasks.js` 的 `settleSession`（后者只服务 v2 回滚路径）。

### 回滚开关：`conversation.enabled: false`

关掉它 = 回到 v2 行为：**每条任务一个新会话**（受 `tasks.maxConcurrent` 限流、
跑完归档）、注册 `qq_dispatch`、不建常驻记忆、不挂交班监视器。
保留它是为了随时能回到旧行为做对照 —— 默认路径不再是那样。

---

## 前置条件

| 组件 | 说明 |
|---|---|
| Node.js | ≥ 20（开发时用 24.19.0 验证） |
| 一个 OneBot 11 协议端 | 推荐 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) |
| 一个 QQ 号 | 建议用小号 |

> ⚠️ **账号风险提示**：NapCat 属于第三方协议端，用真人 QQ 号登录可能被腾讯判定异常，
> 存在被限制或封禁的风险。用哪个号请自行权衡。本插件本身不接触 QQ 协议，也不做任何破解。

> ⚠️ **权限提示**：QQ 触发的新会话会继承你 DSH profile 的**默认权限预设**。
> 如果你把默认设成 `danger-full-access` + `approval: never`，那么**任何能给你 bot 发消息的人
> （在 scope 允许范围内）都会得到不受限的文件与 shell 执行能力**。
> 公开部署前请务必收紧 `scope`（只允许自己的号），或改用更严格的默认预设。

---

## 安装

```bash
dsh plugin --profile <你的profile> add dsh-whale-inurqq
# 或本地开发：
dsh plugin --profile <你的profile> add link:<本目录绝对路径>
```

装完重启 DSH。

### 从 `dsh-qq` 改名而来（老用户必读）

本插件原名 `dsh-qq`，现名 **`dsh-whale-inurqq`**。改名是无情的字符串替换，**运行时数据目录也跟着变了**：

| | 旧（原名） | 新 |
|---|---|---|
| 包名 / 插件 id | `dsh-qq` | `dsh-whale-inurqq` |
| 运行时数据 | `$DSH_HOME/dsh-qq/` | `$DSH_HOME/dsh-whale-inurqq/` |
| 状态端点 | `/dsh-qq/status` | `/dsh-whale-inurqq/status` |
| 日志 | `$DSH_HOME/dsh-qq/plugin.log` | `$DSH_HOME/dsh-whale-inurqq/plugin.log` |

**代价说清楚**：不搬的话，新名字会当成全新安装 —— 会话绑定与任务台账（`state.json`）、
语料库（`corpus/`）、常驻记忆（`memory.json`）都读不到，**旧的还在磁盘上，没有丢**。

搬一次就好（DSH 先停掉）：

```bash
# 1) 先把旧插件卸掉（它仍以旧包名注册在 profile 里）
dsh plugin --profile <你的profile> remove dsh-qq

# 2) 装上新的
dsh plugin --profile <你的profile> add dsh-whale-inurqq

# 3) 搬运行时数据（$DSH_HOME 默认 ~/.dsh）
#    Windows PowerShell：
Rename-Item "$env:USERPROFILE\.dsh\dsh-qq" "$env:USERPROFILE\.dsh\dsh-whale-inurqq"
#    Linux / macOS：
#    mv ~/.dsh/dsh-qq ~/.dsh/dsh-whale-inurqq
```

**不想搬也行**：把 `advanced.stateDir` 指回旧目录（`~/.dsh/dsh-qq`），
会话绑定与任务台账就能照旧读到（常驻记忆的 `memory.json` 也落在 `stateDir` 下）。
⚠️ **但语料库不吃 `stateDir`** —— `lib/corpus.js` 里它硬编码在 `$DSH_HOME/dsh-whale-inurqq/corpus`，
不搬目录的话要单独把 `corpus/` 挪过去，否则 `qq_history` 会查不到历史。

profile patch 里的配置键（`tasks.workspaceRoot` 等）**不受改名影响**，不用动。

---

## 配置 NapCat

在 NapCat 的 `config/onebot11.json` 里加一个**反向 WebSocket 客户端**：

```json
{
  "network": {
    "websocketClients": [
      {
        "name": "dsh-whale-inurqq-reverse",
        "enable": true,
        "url": "ws://127.0.0.1:6700",
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "reconnectInterval": 5000,
        "token": "<你的 access token>",
        "heartInterval": 30000
      }
    ]
  }
}
```

三个要点：

1. **`url` 指向插件**。插件默认自己监听 `127.0.0.1:6700`（`connection.mount: "own"`），
   NapCat 是主动连过来的一方。所以不用公网、不用端口映射。
2. **`messagePostFormat` 必须是 `array`**（消息段数组）。
3. **`token` 要与插件侧一致**。插件默认从 DSH 凭据 `QQ_ONEBOT_TOKEN` 读取；
   也可以用配置项 `connection.token` 直接写。

然后扫码登录：

```bash
cd <NapCat 目录>
./napcat.bat          # 控制台会打印二维码
```

---

## 配置项

```yaml
logLevel: info                    # debug | info | warn | error

connection:
  mode: reverse                   # reverse（推荐）| forward（暂未实现）
  mount: own                      # own = 插件自建服务端；dsh = 挂在 DSH 的 webServer 上
  host: 127.0.0.1                 # 只绑本机
  reversePort: 6700               # 必须与 NapCat 的 url 一致
  reversePath: /
  tokenRef: QQ_ONEBOT_TOKEN       # 从 DSH 凭据读取
  token: ''                       # 兜底值；留空且凭据也为空时表示不校验来源
  callTimeoutMs: 15000
  forwardUrl: ''                  # mode=forward 时用（暂未实现）

scope:                            # 会话白名单；空数组 = 全部允许
  groups: []
  friends: []
  blockedGroups: []
  blockedFriends: []

participation:
  groupMode: mention              # silent = 只记录不发言；mention = 被 @ 才响应；active = 自行判断
  privateMode: always

tasks:
  workspaceRoot: ''               # 必填：QQ 项目目录的父目录
  prefix: ''                      # 可选：强制任务的前缀，如 /task（优先级最高）
  chatPrefix: ''                  # 可选：强制闲聊的前缀，如 /chat（留空不启用）
  maxConcurrent: 2                # ⚠️ 只对 v2 回滚路径有意义（见 conversation.enabled）
  settleGraceMs: 3000             # 同上

ingest:
  forwardRecords: true            # 合并转发自动展开入语料（v3）
  groupArchive: true
  storeRawEvents: false

corpus:
  retainDays: 30                  # 语料保留天数，到期自动清理

conversation:                     # 常驻对接会话（默认开启）
  enabled: true                   # false = 回滚到 v2（每条任务一个新会话 + 并发上限）
  handoffAtRatio: 0.25            # 上下文用到窗口的多少比例时交班
  minTokensBetweenHandoffs: 20000 # 两次交班之间至少要增长多少 token，防止刚建好又交班
  memoryBudgetTokens: 2000        # 常驻记忆注入新会话的 token 预算（0 = 不注入）
  injectMode: context             # 注入方式；conversation.enabled=false 时不生效
  dispatchHint: true              # 在正文尾部标 [分诊: 任务]
  handoffRetainDays: 90           # 交班产物保留天数
  handoffInputChars: 120000       # 交班整理输入的字数上限
  handoffMaxTokens: 4000          # 交班整理输出的 token 上限
  fragmentMergeJaccard: 0.82      # 碎片记忆合并的相似度阈值
  fragmentAskJaccard: 0.3         # 碎片记忆追问的相似度阈值
  agingEveryGens: 10              # 每几代做一次记忆老化
  maxFragmentsPerChat: 500        # 每个会话最多保留多少条碎片

insight:                          # 定时洞察（占位，v1 未启用）
  enabled: false
  schedule: '0 22 * * *'
  pushTarget: ''

advanced:
  dedupeWindowMs: 300000          # 消息去重窗口（重连后 NapCat 可能重放）
  dedupeMaxEntries: 4096
  relayFlushMs: 2000              # 回传的合并窗口（只影响"有内容要发"的那几次）
  stateDir: ''                    # 运行时状态目录；留空用 $DSH_HOME/dsh-whale-inurqq
```

> 上面是**默认值**（由 `lib/schema.js` 定义，DSH 据此自动生成设置页）。

> ⚠️ **`conversation.enabled` 默认是 `true`**（需求定稿：默认路径就是一个常驻对接会话）。
> 设成 `false` 是**回滚开关**：整条回到 v2 的"每条任务一个新会话 + 并发上限 +
> `qq_dispatch`"行为，用于随时对照旧行为。这一条与早期"默认 false"的约定相反 ——
> 因为规则要求**默认路径**就不再新建任务会话，默认 false 等于需求在默认配置下没落地。

---

## 状态查询

**用浏览器打开（推荐）**：<http://127.0.0.1:6700/dsh-whale-inurqq/status>

返回的是一张**体检页**（不是裸 JSON）：顶部一句话结论（「一切正常」/「有 N 项需要处理」/「状态还不完整」），
下面依次是：

- **要处理的事**：每条问题下面附一句"下一步该动哪里"（工作区没配、token 没配、端口被占、协议端没连上……）；
- **它现在到底还活着吗**：判据逐条列出，以及"最后事件多久前、计时器多久前跑过"；
- **关键状态**：连接数与 selfId、工作区、语料库规模、常驻对话开关、收到多少消息、回传判定；
- **交班进度**：每个常驻会话第几代、当前 token、占阈值百分比；
- **配置摘要与日志路径**：排障时一眼找到 `plugin.log`。

页面行为：

- **只读**：没有任何写操作，也不会改配置；
- **不加载外部资源**（字体/脚本/图片），断网也能看；
- 所有动态值都做过 HTML 转义；响应带 `x-content-type-options: nosniff`；
- 脚本/监控请取 JSON：`curl` 默认就是 JSON，也可以显式加 `?format=json`（与页面里的「查看原始 JSON」链接一致）。

JSON 里包含连接状态、事件统计、工作区映射、回传来源判定的账目，以及任务调度与任务台账
（**只在 v2 回滚路径上非 null**）。
出问题时先看 `health.verdict`：票数不为 ok 时 `health.issues` 会直接说哪里不对
（例如"有 N 条任务会话归档失败""有 N 条任务在排队"）。

`relay` 段里有两项专门回答**规则 2 有没有生效**：

| 字段 | 含义 |
|---|---|
| `provenanceDecided` | 判定过多少次"这个回合是谁发起的"（plugin 与 foreign 都算） |
| `skippedForeign` | 有多少个事件因为"这个回合**判明**不是插件发起的而**整个跳过**（GUI 那一摊） |
| `provenanceUnknown` | 有多少个事件因为来源**还没定型**而跳过。正常应恒为 0；它在涨说明这个回合没等到可用的 `user/message`（事件没送到，或形状读错）——先查这一栏，再看 `skippedForeign` |
| `trackedTurns` | 当前记着来源的会话数 |

> 排障锚点：`relayed` 恒为 0 且 `provenanceDecided` 恒为 0、`provenanceUnknown` 在涨，
> 说明 `user/message` 根本没被定型（0.1.3 就是这样整轮丢回传的）。
> 宿主的事件形状是 `data` **即消息本体**（`data.source.rpcId`），不是 `data.message`。

### `alive`：它现在到底还活着吗

响应最前面是一个 `alive` 判定，形如：

```jsonc
"alive": {
  "alive": true,
  "because": [
    "QQ 通道：1 条连接、WebSocket 处于 OPEN，最近 3 秒内收到过事件帧（selfId=123456）",
    "插件自身：事件循环 120 毫秒前刚跑过一次（阈值 10000 毫秒）"
  ],
  "reasons": [],
  "evidence": { "connections": 1, "lastEventAt": 1750000000000, "silentForMs": 3000,
                "eventSilenceMs": 90000, "sinceTickMs": 120, "loopStallMs": 10000, "note": "…" },
  "tasks": { "available": true, "verdict": "ok", "running": 1, "waiting": 0, "dead": [], "because": "…" }
}
```

- **`alive` 只有必需判据全过才是 `true`；任一条缺失即 `false`** —— 判定原则是
  "**绝不瞎报活着**"（用户按"它还活着"去等，比一开始就知道掉线贵得多）
- 必需判据三条：① 有一条连接、`WebSocket.readyState === OPEN`；② 事件流没有静默
  超过 **90 秒**（NapCat 的 heartbeat 是周期性事件，90 秒 = 3 个心跳周期）；③ 插件的
  计时器在 **10 秒**内真的被调度过（事件循环没被长同步任务堵住）
- `because` 是**凭什么**这么判，`false` 时会逐条说明缺的是哪一条；
  `evidence` 是裸数值，便于人核对阈值
- **`tasks` 不参与 `alive`**：它回答的是另一个问题（台账自称在跑的任务，会话是否还在）。
  混在一起会让 `alive=false` 变得无法解释
- ⚠️ `alive` 里那条"事件循环还在跑"**不是进程存活的证明** —— 进程真的不在时，
  这个端点根本不会响应。它证的是"没有被长同步任务堵住"
- **断开实测里发现的一件事（判据因此才长成这样）**：客户端 `close()` 之后，
  服务端那条连接**有时**会留在 `connections` 里（`ws.readyState` 停在 CLOSING、
  close 事件迟迟不来；实测见过 15 秒还没摘掉），下一次跑又正常摘掉了。
  所以"断开必须报离线"**不能**建立在"连接被摘掉"上，只能建立在
  "socket 不是 OPEN"与"事件流静默"上 —— 这两条才是可靠的，连接计数不是。

对接会话也能拿到同一份判定：`qq_alive` 工具，以及 `qq_tasks` 输出里的 `alive` 字段
（两者与状态端点**同源**，用的是同一个判据函数）。

---

## 给 agent 的工具

| 工具 | 作用 |
|---|---|
| `qq_send` | 主动把消息发到指定 QQ 会话 |
| `qq_list_chats` | 列出已接入的会话及其工作区路径 |
| `qq_alive` | 检测本插件与 QQ 通道**现在**是否还活着，返回判定 + 依据（判据见[状态查询](#alive它现在到底还活着吗)） |
| `qq_tasks` | 查真实状态：① `alive` 存活判定；② 任务台账（默认路径下**恒为空** —— 没有独立任务会话了）。v2 回滚路径下还能传 `cancel_task_id` 取消一条 |
| `qq_history` | 检索本地语料库（含用户转发过来的合并转发记录） |
| `qq_memory` | 查看/删除该会话的常驻记忆 |
| `qq_dispatch` | ⚠️ **只在 v2 回滚路径（`conversation.enabled=false`）注册**：把一件要动手的事派给独立任务会话 |

**写类 QQ 工具都挂了 scope 门控**：`qq_send`、`qq_dispatch`、`qq_memory`、
以及带 `cancel_task_id` 的 `qq_tasks` —— 越界的会话会在工具派发前被拒绝，
而不是靠提示词约束。门控判据是"**这个工具会不会产生写副作用**"，不是按名字枚举
（早先只列了 `qq_send` / `qq_dispatch`，于是 `qq_memory` 能清掉别的会话的常驻记忆）。
`qq_list_chats` 也按同一份 scope 过滤：只列允许范围内的会话
（`scope.groups` / `scope.friends` 为空数组时 = 全部允许，行为与从前一致）。
只读工具（`qq_alive` / `qq_history` / 不带 `cancel_task_id` 的 `qq_tasks`）不在门控里。

**规则 4「进度靠问」的落点就是 `qq_alive` + `qq_tasks`**：用户问"好了吗"时，
常驻会话必须先查真实状态再如实回答 —— 而不是把"它还在不在"交给模型猜。

---

## 常驻对接会话：**它自己就是干活的那个**

`conversation.enabled: true`（默认）时，每个 QQ 会话只有**一台**会话，
由两条约定约束（写在 `lib/dsh/frontdesk.js` 的 systemPrompt section 与
`lib/classify.js` 的分诊提示里 —— **两处一致**才算落住）：

1. **需求含糊先追问**：不知道对哪个目录/哪个文件、要什么格式时，一次只问最关键的那一个，
   问完停下等回答，**不要闷头做一个自己猜的东西**。
   反过来，意图明确就直接动手（"帮我把 A 目录的图片转成 webp"没什么可问的）——
   这条不是"永远先问一遍"。
   规则侧只在**真的含糊**时换一种措辞（`lib/classify.js` 的 `isAmbiguousAsk`：
   有指代 + 整句没有具体路径），判据错了的代价只是多问一句。
2. **问进度去查真实状态**：`qq_alive` → `qq_tasks` → 如实回答。
   在跑就说在跑、跑完就说结果、查不到就说查不到，**不许编**进度或完成时间。
   台账为空是正常的（没有独立任务台账这回事）—— 用户问的就是本会话正在做的事。

「说停就停」不再是"去取消某条任务"：**你就在这台会话里，停下来就是了** ——
把"我停在哪一步、已经动了什么"说清楚。没有再往下做的理由，也没有别的会话要取消。

### 为什么没有控制词

早期版本用 `/cancel [N|all]` 这类前缀解析（`lib/classify.js` 的 `parseControl`）。
它被删掉的原因只有一个：**关键词会误判**。用户说
"把这个任务停一下看看日志"，前缀匹配会把它当成停止命令 —— 而用户要的是看日志。
现在意图判断回到常驻对接会话（它有上下文、能追问），
`classify.js` 只剩两件事：

| 保留的规则 | 为什么不能用 LLM 替代 |
|---|---|
| **寻址门**：`groupMode: mention` 下未被 @ 的群消息只入库、不进任何会话 | 它判的是"这句话是不是对我说的"，**发生在进会话之前** —— 会话还没看到这条消息，没法判断。而且它与内容无关，不会误伤 |
| **显式前缀**：`tasks.prefix` / `tasks.chatPrefix` | 用户主动设的开关（默认空 = 不启用），语义明确、不会误判 |

---

## 闲聊与任务怎么分

分类是**规则**，不调 LLM —— 它发生在每条消息的入口路径上，
为一句"在吗"多付一次模型往返不划算（规则见 `lib/classify.js`）：

| 规则 | 结果 |
|---|---|
| 空/纯空白 | 忽略 |
| **寻址门**：群聊 `mention` 模式下没 @ bot | 只入库，**不进任何会话** |
| 命中 `tasks.prefix` | 强制任务 |
| 命中 `tasks.chatPrefix` | 强制闲聊 |
| 带合并转发 | 任务（转发一段记录必然是"要它看"） |
| < 20 字 **且**整句命中寒暄/提问模式（"在吗"、"你好"、"你是谁"、"谢谢"、"现在怎么样了"…） | 闲聊 |
| 其余 | 任务 |

取舍是**宁可把不确定的判成任务**：把闲聊判成任务只是措辞上多一句"这像是要动手"的提示，
把任务判成闲聊则会让用户以为"它没干活"。

⚠️ 这里的"任务"**只是提示，不是执行指令**：分类只决定正文尾部带不带
`[分诊: 任务]`（以及要不要换成 `[分诊: 任务·待澄清]` 让会话先追问）。
**不管判成哪一类，消息都进同一台常驻对接会话** —— 路由不再由分类器决定。
（`conversation.enabled=false` 的 v2 回滚路径上，分类器仍然直接决定派活还是闲聊。）

**"问进度"（"好了吗""到哪了"）判成闲聊，但不等于随便答一句** ——
常驻会话收到这类话的契约是先去查真实状态（`qq_alive` + `qq_tasks`）再如实回答。

---

## 语境采集与语料库

这是本插件相对普通 IM 桥接的核心差异：QQ 里的聊天内容会沉淀成本地可检索的语境。

### 两条来源

1. **群聊沉淀**：bot 所在群的消息自动入库（可用 `participation.groupMode: silent` 让它只记录不发言）
2. **合并转发投喂**：用户把一段聊天记录**合并转发**给 bot

第 2 条是 QQ 独有的能力。微信的合并转发对机器人是不可解析的卡片，
而 OneBot 提供了 `get_forward_msg`，能把转发内容展开成**带原始发言人、时间、消息段的结构化节点**：

```
【合并转发聊天记录，共 12 条】
1. 10-11 15:49 甲甲: 这个方案我觉得有问题
2. 10-11 15:50 乙乙: 哪里有问题？
...
【我的问题】
他们到底在争什么
```

展开后的内容既进语料库，也作为语境投递给 DSH——所以"转发一段对话 + 问一句"是开箱即用的。

### 语料库的位置与治理

```
$DSH_HOME/dsh-whale-inurqq/corpus/<chatType>-<chatId>/<YYYY-MM-DD>.jsonl
```

- **只在本地**，不向外发送任何内容
- 按会话 + 日期分片，便于整片删除
- `corpus.retainDays`（默认 30 天）到期自动清理，启动时和每 6 小时各跑一次
- `ingest.storeRawEvents: false`（默认）不保留原始 OneBot 事件 JSON
- 一键清除：删除对应目录即可，或用状态端点确认当前规模

> ⚠️ **范围提醒**：`scope.groups` 默认为空数组 = **bot 所在的全部群都会被采集**。
> 如果你不希望某些群进语料库，务必在设置页把 `scope.groups` 配成白名单，
> 或把群号加进 `scope.blockedGroups`。

---

## 常见问题

**NapCat 连不上**
- 确认插件已启动且状态端点可达：`curl http://127.0.0.1:6700/dsh-whale-inurqq/status`
- 确认 `token` 两边一致
- 确认 `reversePort` 与 NapCat 的 `url` 端口一致
- 端口被占用时插件会**每 2 秒自动重试 20 次**（常见于上次实例没退干净）；日志里能看到重试计数
- 排查插件自身：`$DSH_HOME/dsh-whale-inurqq/plugin.log`（桌面端插件 stdout 归 Electron 管，这份文件是唯一能看到内部日志的地方）

**体检页打不开**
- 默认（`connection.mount: own`）用 `http://127.0.0.1:<connection.reversePort>/dsh-whale-inurqq/status`；
  端口被改过就用改后的值，不是永远 6700
- `mount: dsh` 时状态端点挂在 DSH 的 web 服务上：把主机与端口换成 DSH 的地址，路径不变
- 页面显示「**不活着**」不是"页面坏了"：看它下面列出的 `because`，通常是没有协议端连接、
  事件静默超过 90 秒、或事件循环被长任务堵住
- 页面显示「**有 N 项需要处理**」：逐条照着"下一步"改；改完刷新页面即可，不需要重启

**改了代码/配置但没生效**
- 桌面端启用/禁用插件**不会**刷新 ESM 模块缓存 —— 需要**重启 DSH**

**任务没有落到工作区**
- 检查 `tasks.workspaceRoot` 是否配置且有写权限
- 群聊默认需要 **@bot** 才会当任务处理，否则只入库

**"已排队" / "任务显示在等你回答" / "取消了但还在回传"**
- 这三条**只属于 v2 回滚路径**（`conversation.enabled=false`）：
  那时同一会话同时只跑 `tasks.maxConcurrent` 条（默认 2），等用户回答的任务也占着槽位，
  排队与取消都存在
- 默认路径（一个常驻对接会话）里**没有并发槽位这回事**：你发的话就排在那个会话的
  inbox 里，前一个回合跑完自然轮到它。"停一下"也不用去取消谁 ——
  会话自己停下来并说清停在哪一步

**进度回传刷屏 / 不回传**
- 回传按会话节流合并（`advanced.relayFlushMs`，默认 2 秒窗口）
- **不再报工具调用次数**（"N 次工具调用"既不表示进度也不表示还要多久，是纯噪音），
  **也不再推「🔧 执行中…」这类"还在跑"的周期性通知**：中间态一律安静，
  有正文就发正文，动过文件就列文件，两样都没有就什么都不发。
  进度靠问（"好了吗"→ 常驻会话查 `qq_alive` + `qq_tasks` 再如实回答）
- **只有插件发起的回合才回传**：用户在 DSH GUI 里自己发起的 turn 一条都不推 QQ
  （判据见[回传的判据](#回传的判据是这个-turn-是谁发起的)）。状态端点的
  `relay.skippedForeign` 记着因此跳过了多少事件；来源没定型的那些进 `relay.provenanceUnknown`
  （正常为 0，涨了就说明 `user/message` 没等到 —— 0.1.3 的回传全丢就是这个症状）
- 回传会带上**它动了什么**（改了/新建了哪些文件）。两个信号源：
  `deliverables/presented` 会话事件（agent 自己声明的交付物，标成"交付物"），
  以及写类工具（`write` / `edit` / `str_replace_editor` 的写命令）的
  `tool/call` + 配对**成功**的 `tool/result`。
  失败的工具调用**不算**改动 —— "只说到做不到"的编辑不该出现在清单里。
  ⚠️ 覆盖面如实说：`pwsh`/`bash` 里 `Set-Content` 这类写**认不出来**（参数里没有明确路径，
  命令文本不该被正则解析）。所以那份清单是"**工具确认改过的文件**"，不是文件系统真实 diff
- 只有映射到 QQ 会话的 DSH 会话才会回传
- 任务号前缀 `【#N】` **只在 v2 回滚路径**上出现（默认路径没有任务号可编）

**合并转发打不开**
- 展开失败时插件会明确告知，并提示用户改贴关键几条，而不是装作读到了
- 某些 OneBot 实现可能不支持 `get_forward_msg`，可看日志里的 `[forward] 展开失败`

---

## 开发

> ⚠️ **修改本仓库任何文件都不要用 PowerShell 的 `Get-Content` / `Set-Content` / `Out-File` 往返。**
> 它们按系统 ANSI 代码页（中文 Windows 上是 GBK）读写，会把 UTF-8 中文永久损坏——
> 而且是**静默**的：文件照样能被写出来，只是里面的中文全变成乱码，
> 少数汉字的字节还会被吞掉、连带吃掉紧跟的空格或换行（后者会把下一行代码吞进注释里）。
> **本项目已经因此毁过一次测试文件（`tools/test-entry.mjs`）。**
> 请用 Node（`fs.readFileSync(p, 'utf8')` / `fs.writeFileSync(p, s, 'utf8')`）
> 或任何专用编辑器读写这些文件。

```bash
npm install

# 状态页纯函数（不需要 DSH / NapCat）：内容协商、转义、字段缺失
node tools/test-status-page.mjs

# 方式一：独立测试台（不依赖 DSH）
node tools/standalone-harness.mjs      # 终端 A
node tools/mock-napcat.mjs --once      # 终端 B

# 方式二：入口集成测试（跑真实的 lib/index.js，用假 cordis 上下文）
# 注意用独立端口与独立 DSH_HOME，避免干扰真机
$env:ENTRY_PORT='6701'; $env:ENTRY_ROOT='D:\qq-testenv\projects'; $env:DSH_HOME='D:\qq-testenv\dshhome'
node tools/test-entry.mjs              # 终端 A
node tools/mock-napcat.mjs --once --url ws://127.0.0.1:6701   # 终端 B
```

`tools/mock-napcat.mjs` 模拟 OneBot 11 反向客户端，**无需真实 QQ 号**即可验证
连接层、归一化、去重、路由决策、任务派活、进度回传与工具门控；
它的脚本里也包含闲聊、两条并行任务，用来肉眼确认分流是否正确。

`tools/test-entry.mjs` **两趟都必须全绿**（179 + 264 条）：

| 一趟 | 断言数 | 它证明什么 |
|---|---|---|
| `ENTRY_CONV=0` | 179 | 关掉常驻对接会话开关后行为与 v2 一致（回归保命线；原有 159 条逐条保留）＋ 回传来源门控在 v2 路上也生效 ＋ 状态页两种呈现 |
| `ENTRY_CONV=1` | 264 | 常驻对接会话 / 交班 / 碎片记忆 / 前台约定 / 存活检测 / **turn 来源门控与"不推还在跑"** / **状态页两种呈现** |

两趟共用的那些段（待办判据 4、分类器 44、M2 12、工具 18、Schema 13、语料库 8、
状态端点 6、断开实测 11）**逐条不变**：它们与新需求不冲突，是"没有回归"的证据。

除了 mock 驱动的链路，它还开了一条**进程内的受控 OneBot 连接**：
v2 回滚路径上的并发上限/排队/单任务取消/归档顺序/"回合结束了但会话还有待办"，
以及默认路径上的"连发两条只建一台会话""GUI 发起的 turn 不回传"，
这些需要精确时序的场景，由断言代码决定"事件何时发、回合何时结束、会话还有没有活"，
不跟 mock 的节奏赛跑。

### 跑得快一点

`node tools/run-fast.mjs --base-port 6740 --rounds 0,1`（在 `qq-testenv` 下）
是同一个编排器的快版：端口就绪用轮询而不是死等 6 秒，汇总 250ms 一轮，
并且**两趟并行**（端口/项目目录/DSH_HOME/tag 全独立）。
实测两趟合计约 100 秒（原来是串行 4 分钟以上）。

**最后一段是"断开实测"**：断言代码把那条真实的 WebSocket 关掉，
然后要求状态端点与 `qq_alive` / `qq_tasks` 全部翻成离线 —— 这是存活检测唯一
无法靠单元测试证明的部分（"瞎报活着"的实现在单元测试里照样全绿）。
所以它被放在**最后**：断开之后回传就没有落点了。

假 DSH 服务刻意照抄了真实实现的校验与形状（`workspaceId`/`cwd` 互斥、
workspace 路径必须完全限定且目录已存在、同路径注册幂等、归档不带 `stopActivity`
时拒绝有活动的会话、归档后不得再投递、`agents.get()` 的活值 `status`/`inbox`、
`sessionProjections.snapshot()` 的 `{asOfSeq, values}`、审批的成对审计事件、
`systemPrompt.section()` 的同名即抛、`tool/result` 的 `message.callId`/`message.isError`
位置），因为比真实宽松的 fake 会漏掉真机必炸的 bug。

> ⚠️ 其中**最要紧的一条是 2026-10 补上的**：`sessionController.prompt()` 会把它拿到的
> `requestId` 写进消息的 `source.rpcId`，那条消息随后落成 `user/message` 会话事件
> （`dsh-api-session-controller/lib/index.js:856-859`、`dsh-agent-loop/lib/index.js:1061`）。
> 假宿主一开始**不发**这个事件 —— 于是"宿主续跑的下一个回合"在插件眼里来源不明，
> 回传与收敛一起被门控挡住。fake 漏一条真实契约，真机上就是"任务跑完不说话"。

### `tools/` 里每个脚本的定位

维护过程中在开发机上还有几个一次性脚本。它们的**去留已经定过**，按下面处理：

| 文件 | 在仓库里？ | 说明 |
|---|---|---|
| `tools/mock-napcat.mjs`、`tools/standalone-harness.mjs` | ✅ | 任何机器上都能跑的测试工具（mock 协议端、独立测试台） |
| `tools/test-entry.mjs` | ✅ | 入口集成测试本体（断言都在这里） |
| `tools/test-status-page.mjs` | ✅ | 状态页的纯函数测试（内容协商、HTML 转义、字段缺失） |
| `tools/verify-bundle-resolution.mjs` | ✅ | 验证作为 bundle 能被正确解析与加载 |
| `tools/run-repro.ps1`、`tools/run-conv-test.ps1`、`tools/watch-6700.ps1` | ✅ | 测试编排与连接观察。**路径全部从脚本位置推导**，证据落系统临时目录 |
| `tools/preflight-patch.yml` | ✅ | 配置 Schema 预飞模板（`workspaceRoot` 是占位符、`token` 为空，**不含任何凭据**） |
| `tools/repair-test-entry.mjs` | ✅ | 一次性修复脚本（从编码事故里救回 `test-entry.mjs`）。留作事故记录，不参与运行 |

⚠️ **编排脚本不会替用户杀进程**：`run-repro.ps1` / `run-conv-test.ps1` 发现目标端口被占用时
**默认只报告并退出（退出码 3）**，要清理必须显式加 `-Force`。理由很具体 —— `6700` 正是插件的
默认 `reversePort`，无条件强杀会**把用户正在运行的 bot 停掉**。收尾阶段也只杀**脚本自己起的 PID**，
不按端口扫（按端口扫会误伤同机器上别人的服务）。

> 另外这三个 `.ps1` 都以 **UTF-8 with BOM** 落盘：Windows PowerShell 5.1 会把无 BOM 的 UTF-8
> 脚本按 ANSI 读，中文注释会变乱码并导致解析失败（`watch-6700.ps1` 的文件头就写着这条教训）。
> 用编辑器改它们时请保留 BOM。

---

## 协议参考

OneBot 11 官方规范：<https://github.com/botuniverse/onebot-11>

## 许可证

MIT（见 [LICENSE](LICENSE)）
