# 变更记录

## 0.1.4 — 2026-10-28

### 修复：QQ 回传恒为 0（入站正常、agent 也回复了，但一条都发不出去）

- **`user/message` 的消息形状读错了一层**。宿主是
  `session.append('user/message', message)`，事件里 `data` **就是消息本体**
  （`data.source.rpcId`）；`relay.js` 读的是 `data.message.source.rpcId`，真机上恒为
  `undefined` → 来源永远定型不了（`provenanceDecided === 0`）→ 主守卫把每个回合的
  正文都当成 GUI 回合丢掉（`relayed === 0`，`skippedForeign` 一直涨）。
  现在用 `userMessageFromEvent()` 同时认「data 即消息」与旧/假宿主的 `{message}` 包装。
- **`provenanceUnknown` 不再是一栏死数字**：来源未定型的事件单独计数（以前混进
  `skippedForeign`，把"根本没判出来"读成"判定正常"）；一个回合到 `turn/end` 仍未定型时
  会打一条 warn，不再静默丢完整轮。
- **假宿主改成真实形状**。`tools/test-entry.mjs` 发 `user/message` 时一直包着
  `{message}`，于是"读错形状"在测试里永远绿、在真机上整轮丢消息 —— 又一次
  「假宿主把 bug 冻住」（同 `emitToolResult` 那次的教训）。现在 data 直接是消息本体，
  `surfaceOp` 也放回事件顶层；改回旧代码跑这趟会红 8 条（含 `来源-e/f/g`），修复后全绿。
- 新增 4 条纯函数断言锁住两种形状；README 补上形状说明与 `provenanceUnknown` 口径。
- **体检页与 health 都不再放过这种故障**：`relayed === 0 && provenanceUnknown > 0`
  时 `health.issues` 直接点名"回传一条都没发出去、来源未定型 N 个事件"；
  页面同一栏也会写出「来源未定型 N 次（异常）」。

### 验证

- `ENTRY_CONV=1`：268/268 通过；`ENTRY_CONV=0`：183/183 通过。
- 形状依据：宿主源码（`dsh-session` / `dsh-agent-loop` 0.2.1-rc.2）与本机会话日志
  `session.v4.jsonl.zstd` 实测，不是猜。

## 0.1.3 — 2026-10-21

### 修复（来自独立复核的两条误导）

- **未连接时不再显示“最后事件 0 毫秒前”**。`alive.js` 在“从没收到过事件”时把
  `silentForMs` 置 0，页面直接渲染就与同页的“连接层未初始化”自相矛盾。
  现在按 `lastEventAt` 判断有没有事件锚点：没有就写「尚未收到事件」；
  `silentForMs` 缺失（不知道）仍写「最后事件时间未知」；真有事件时 0ms 仍准确显示。
- **“下一步”按具体原因匹配，不再张冠李戴**。`nextStepFor()` 原先是宽词优先：
  「连接层未初始化（webServer 未就绪）」被给成“启动 NapCat”，
  「交班流程异常」「归档失败」被给成“还没测出上下文窗口”。
  现在顺序是具体 → 笼统：webServer → DSH；交班/归档异常 → 看 `lastError` 与日志；
  真没测到 `contextWindow` 才提示跑完一个回合；派活链路问题指向 `bridge.stats.lastError`。
- 测试从 37 条加到 44 条，覆盖上述两种渲染与四条匹配顺序。

### 发布

- npm 同步发布 `0.1.3`（`0.1.2` 已发布，含体检页本身）。

## 0.1.2 — 2026-10-21

这一版只改**排障时人能不能看懂**，运行逻辑与 0.1.1 相同。

### 新增

- **状态端点的浏览器体检页**。用浏览器打开
  `http://127.0.0.1:<reversePort>/dsh-whale-inurqq/status` 时返回一张人读的页面：
  - 顶部一句话结论：`一切正常` / `有 N 项需要处理` / `状态还不完整`；
  - 「要处理的事」逐条列出，并附一句**下一步该动哪里**（工作区、token、协议端、端口、交班、桥接、语料库）；
  - 存活判据（`alive` 的 `because`）、最后事件/计时器时间、关键数字、交班进度、配置摘要、日志路径；
  - 通过的检查收在折叠区，不占首屏。
- **`logFile`** 写进状态快照：桌面端 stdout 归 Electron 管，这份路径是排障入口。
- **README「三分钟接入」**：五步从安装到验证，最后一步就是打开体检页看颜色。

### 保持不变（兼容性）

- `curl` / 脚本默认拿到的仍是**原来的 JSON**（`Accept: */*` → JSON）；
- `?format=json` / `?format=html` 可显式指定；
- 路由前缀、端口、鉴权、scope 门控、回传判据都没有改动；
- 状态页只读，不加载任何外部资源，所有动态值做 HTML 转义，响应带
  `x-content-type-options: nosniff` 与 `referrer-policy: no-referrer`。

### 修复

- 状态端点的路径匹配改为**只比 pathname**：带 `?format=` 的链接不再 404。
  （此前 `req.url` 全串比较，任何查询参数都会落到 404。）

### 测试

- 新增 `tools/test-status-page.mjs`（35 条）：内容协商、HTML 转义、字段缺失、强调标记。
- `tools/test-entry.mjs` +6（两趟共用）：默认 JSON、浏览器 HTML、`nosniff`、
  `?format=` 覆盖、查询串不影响路由、页面有结论。
- 两趟集成测试：`ENTRY_CONV=0` 179/179、`ENTRY_CONV=1` 264/264。

### 发布

- npm 同步发布 `0.1.2`（体检页首次可用）。

## 0.1.1

- 修复 24 处：`callId` 字段名、`turn/start` 死代码、路径穿越、交班冻结等。
- 同步 npm 发布（只改版本号字符串）。

## 0.1.0

- 首个版本：OneBot 11 反向 WS 接入、工作区/会话派活、常驻对接会话、交班、碎片记忆。
