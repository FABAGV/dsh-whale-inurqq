/**
 * 状态端点的**人读视图**（浏览器打开时）。
 *
 * 背景：状态端点原先只会吐 JSON。`health.verdict` / `health.issues` 已经写得很清楚，
 * 但它们的读者是"愿意 curl 一下再看 JSON 的人" —— 而刚装完插件的用户通常不是。
 * 于是最常见的排障路径变成"NapCat 连不上 → 不知道去问谁"。
 *
 * 这份页面只做一件事：把同一份快照翻译成**结论 + 下一步**：
 *   · 顶部一句话说清"现在能不能用"；
 *   · 有问题就逐条列出来，并在下面给一句"该动哪里"；
 *   · 关键数字（连接、最后事件、工作区、语料库、交班进度）一屏可见；
 *   · 原始 JSON 仍然保留（`?format=json`，curl 默认也拿到 JSON）。
 *
 * 约束：
 *   - 不引入任何外部资源（字体、脚本、图片都不加载），断网也能看；
 *   - 所有动态值一律 HTML 转义 —— 工作区路径、群名、错误信息都可能含 `<`；
 *   - 只读：页面里没有写操作，也不改任何配置。
 */

/**
 * 这个请求该拿 HTML 还是 JSON。
 *
 * 优先级：显式 `?format=` → `Accept` 里有没有 `text/html` → JSON。
 * `curl` 默认发 `Accept: * / *`，所以脚本行为不变；浏览器地址栏打开才走 HTML。
 * @param {{url?:string, headers?:Record<string,string|string[]|undefined>}} req
 * @returns {'html'|'json'}
 */
export function formatForRequest(req) {
  let url = null
  try {
    url = new URL(req?.url ?? '/', 'http://localhost')
  } catch {
    url = null
  }
  const explicit = url?.searchParams?.get('format')
  if (explicit === 'json' || explicit === 'html') return explicit
  const accept = String(req?.headers?.accept ?? '')
  return /\btext\/html\b/i.test(accept) ? 'html' : 'json'
}

/** HTML 转义。动态值进页面前**必须**过这里。 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 把快照里的强调标记（`**很要紧**`）转成 `<strong>`。
 * 先转义再替换，所以正文里的标签不会被当成 HTML。
 */
function emphasize(value) {
  return escapeHtml(value).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

/** 毫秒 → 人话。负数/缺失一律显示"—"。 */
export function humanDuration(ms) {
  // null 必须单独拦：Number(null) === 0，会把“不知道”显示成“0 毫秒前”。
  if (ms === null || ms === undefined || ms === '') return '—'
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1000) return `${Math.round(value)} 毫秒`
  // 90 秒这类阈值直接四舍五入成“2 分钟”会像是另一个数，所以留一位小数。
  if (value < 90_000) return `${Math.round(value / 1000)} 秒`
  if (value < 3_600_000) {
    return `${(value / 60_000).toFixed(1).replace(/\.0$/, '')} 分钟`
  }
  return `${(value / 3_600_000).toFixed(1)} 小时`
}

/** 字节 → 人话。 */
export function humanBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 针对 health.issues 的一条，给一句"该动哪里"。
 *
 * 不追求覆盖全部（issues 是宿主写的自由文本），只覆盖**首次接入最常撞的几类**；
 * 匹配不上时返回空串，页面就不显示建议 —— 不猜。
 * @param {string} issue
 * @returns {string}
 */
export function nextStepFor(issue) {
  const text = String(issue ?? '')
  // 顺序必须是“具体 → 笼统”：`连接` / `交班` 这种宽词会盖住更具体的原因
  // （`连接层未初始化` 不是 NapCat 没开，而是 DSH 的 webServer 没就绪）。
  if (text.includes('未初始化') || text.includes('webServer')) {
    return 'DSH 的 Web 服务还没就绪：重启 DSH，或确认当前 profile 里有 webServer 服务（不是协议端的问题）。'
  }
  if (text.includes('交班流程异常') || text.includes('归档失败')) {
    return '看日志里的 lastError 与 $DSH_HOME/dsh-whale-inurqq/plugin.log；归档失败通常是磁盘权限或会话仍有活动。'
  }
  if (text.includes('contextWindow') || text.includes('交班阈值')) {
    return '交班需要先跑完一个回合才能测出上下文窗口；如果一直测不到，确认 conversation.enabled 为 true 且宿主会话正常。'
  }
  if (text.includes('建过工作区但从未建成会话') || text.includes('派活链路')) {
    return '派活链路可能有问题：看状态端点 bridge.stats.lastError 与 plugin.log，确认 DSH 的 workspace/session 服务可用。'
  }
  if (text.includes('workspaceRoot')) {
    return '在 DSH 设置 → 插件 → dsh-whale-inurqq 里把 tasks.workspaceRoot 填成绝对路径（如 D:\\qq-projects），并确认该目录可写。'
  }
  if (text.includes('access token') || text.includes('token')) {
    return '在 DSH 凭据里添加 QQ_ONEBOT_TOKEN，并让 NapCat 的 onebot11.json 里 token 与它一致；也可以直接在插件配置的 connection.token 里填。'
  }
  if (text.includes('协议端') || text.includes('NapCat') || text.includes('没有可用连接')) {
    return '确认 NapCat 已启动并扫码登录，且它的 websocketClients.url 指向本插件监听的地址与端口（默认 ws://127.0.0.1:6700）。'
  }
  if (text.includes('端口') || text.includes('EADDRINUSE')) {
    return '端口被别的进程占着：关掉残留的旧实例，或把 connection.reversePort 换一个端口，并同步改 NapCat 的 url。'
  }
  if (text.includes('桥接') || text.includes('DSH')) {
    return 'DSH 的 workspace / session 服务还没就绪：重启 DSH，或确认当前 profile 里有这些服务。'
  }
  if (text.includes('语料库')) {
    return '检查 $DSH_HOME/dsh-whale-inurqq/corpus 是否可写；磁盘满或权限不足都会让采集停摆。'
  }
  return ''
}

/** 取嵌套字段，缺了返回 undefined（页面不能因为老版本少一个字段就炸）。 */
function pick(object, path) {
  let current = object
  for (const key of String(path).split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

function badge(text, tone) {
  return `<span class="badge ${tone}">${escapeHtml(text)}</span>`
}

function fact(label, value, note) {
  const shown = value === undefined || value === null || value === '' ? '—' : String(value)
  return (
    `<div class="fact"><div class="fact-label">${escapeHtml(label)}</div>` +
    `<div class="fact-value">${escapeHtml(shown)}</div>` +
    (note ? `<div class="fact-note">${escapeHtml(note)}</div>` : '') +
    '</div>'
  )
}

/**
 * 渲染整页。
 * @param {object} snapshot 与 JSON 端点**同一份**对象（index.js 的 statusSnapshot）
 * @returns {string} 完整 HTML
 */
export function renderStatusPage(snapshot) {
  const data = snapshot && typeof snapshot === 'object' ? snapshot : {}
  const health = data.health && typeof data.health === 'object' ? data.health : {}
  const alive = data.alive && typeof data.alive === 'object' ? data.alive : {}
  const config = data.config && typeof data.config === 'object' ? data.config : {}
  const connection = data.connection && typeof data.connection === 'object' ? data.connection : null
  const corpus = data.corpus && typeof data.corpus === 'object' ? data.corpus : {}
  const conversation = data.conversation && typeof data.conversation === 'object' ? data.conversation : {}
  const pipeline = data.pipeline && typeof data.pipeline === 'object' ? data.pipeline : {}
  const relay = data.relay && typeof data.relay === 'object' ? data.relay : {}

  const issues = Array.isArray(health.issues) ? health.issues : []
  const okItems = Array.isArray(health.ok) ? health.ok : []
  const healthy = health.verdict === 'ok'
  const aliveFlag = alive.alive === true

  const issueCards = issues.length
    ? issues
        .map((issue, index) => {
          const step = nextStepFor(issue)
          return (
            `<li class="issue"><div class="issue-text">${emphasize(issue)}</div>` +
            (step ? `<div class="issue-step"><span>下一步</span>${escapeHtml(step)}</div>` : '') +
            '</li>'
          )
        })
        .join('')
    : ''

  const aliveBecause = Array.isArray(alive.because) ? alive.because : []
  const aliveLines = aliveBecause.length
    ? `<ul class="reasons">${aliveBecause.map(line => `<li>${emphasize(line)}</li>`).join('')}</ul>`
    : '<p class="muted">没有可显示的判据。</p>'
  const silentFor = humanDuration(pick(alive, 'evidence.silentForMs'))
  const sinceTick = humanDuration(pick(alive, 'evidence.sinceTickMs'))
  // `alive.js` 在“从没收到过事件”时把 silentForMs 置 0。直接渲染会得到
  // “最后事件 0 毫秒前”，与同页的“连接层未初始化”自相矛盾。
  // 有没有事件锚点，看 lastEventAt；兼容没有该字段的老快照时退到 silentForMs > 0。
  const lastEventAt = Number(pick(alive, 'evidence.lastEventAt'))
  const silentRaw = Number(pick(alive, 'evidence.silentForMs'))
  const hasEventAnchor =
    (Number.isFinite(lastEventAt) && lastEventAt > 0) ||
    (Number.isFinite(silentRaw) && silentRaw > 0)
  let silenceLine
  if (silentFor === '—') {
    // 没有这个数 = 不知道，不等于“没有事件”
    silenceLine = '最后事件时间未知'
  } else if (!hasEventAnchor) {
    silenceLine = '尚未收到事件'
  } else {
    silenceLine = `最后事件 ${silentFor}前`
  }
  const tickLine = sinceTick === '—' ? '计时器状态未知' : `计时器 ${sinceTick}前跑过`

  const conversations = Array.isArray(conversation.chats) ? conversation.chats : []
  const conversationRows = conversations
    .slice(0, 5)
    .map(row => {
      const name = row.chatName || row.chatId || row.scope || '（未命名）'
      const progress = Number.isFinite(row.progressPercent) ? Math.min(100, Math.max(0, row.progressPercent)) : null
      const percent = progress === null ? '—' : `${progress}%`
      return (
        `<tr><td>${escapeHtml(name)}</td>` +
        `<td class="num">${escapeHtml(row.generation ?? '—')}</td>` +
        `<td class="num">${escapeHtml(Number.isFinite(row.totalTokens) ? Math.round(row.totalTokens).toLocaleString('en-US') : '—')}</td>` +
        `<td class="num">${escapeHtml(percent)}</td></tr>`
      )
    })
    .join('')

  const port = config.port ?? ''
  const endpoint = port ? `http://127.0.0.1:${port}/dsh-whale-inurqq/status` : '/dsh-whale-inurqq/status'

  const questions = issues.length
  const verdictTitle = healthy
    ? '✅ 一切正常'
    : questions > 0
      ? `⚠️ 有 ${questions} 项需要处理`
      : '⚠️ 状态还不完整'
  const verdictNote = healthy
    ? '插件、连接、工作区与常驻会话都通过了检查。下面是可以核对的依据。'
    : questions > 0
      ? '先看下面「要处理的事」，每条都给了下一步。'
      : '插件可能还没完成启动，或状态端点拿到了半份数据；稍后刷新一次再看。'

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-whale-inurqq 体检</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:28px 18px 48px;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2328;background:#f6f8fa}
main{max-width:860px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:15px;margin:26px 0 10px;color:#57606a;letter-spacing:.02em}
.sub{color:#57606a;font-size:13px;margin:0 0 18px}
.verdict{border-radius:12px;padding:16px 18px;border:1px solid #d0d7de;background:#fff;margin:16px 0 8px}
.verdict.ok{border-color:#1a7f37;background:#f0fff4}
.verdict.warn{border-color:#bf8700;background:#fff8c5}
.verdict-title{font-size:18px;font-weight:700;margin:0 0 4px}
.verdict-note{margin:0;font-size:13px;color:#57606a}
.badge{display:inline-block;border-radius:999px;padding:2px 9px;font-size:12px;border:1px solid #d0d7de;background:#fff;color:#57606a;vertical-align:2px}
.badge.ok{color:#1a7f37;border-color:#1a7f37}
.badge.warn{color:#9a6700;border-color:#bf8700}
.card{border:1px solid #d0d7de;border-radius:10px;background:#fff;padding:14px 16px;margin:10px 0}
.muted{color:#57606a}
.issue{list-style:none;border-left:3px solid #bf8700;padding:8px 0 8px 12px;margin:0 0 8px}
.issue:last-child{margin-bottom:0}
.issue-text{white-space:pre-wrap;word-break:break-word}
.issue-step{margin-top:4px;font-size:13px;color:#57606a}
.issue-step span{display:inline-block;font-weight:600;color:#9a6700;margin-right:8px}
ul.issues,ul.reasons{margin:0;padding:0}
ul.reasons{list-style:disc;padding-left:20px}
ul.reasons li{margin:2px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.fact{border:1px solid #d0d7de;border-radius:10px;background:#fff;padding:10px 12px}
.fact-label{font-size:12px;color:#57606a}
.fact-value{font-size:17px;font-weight:650;word-break:break-word}
.fact-note{font-size:12px;color:#57606a}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eaeef2}
th{color:#57606a;font-weight:600}
td.num{text-align:right;font-variant-numeric:tabular-nums}
code{font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:#eaeef2;border-radius:4px;padding:1px 5px;word-break:break-all}
details summary{cursor:pointer;color:#57606a}
footer{margin-top:28px;color:#57606a;font-size:12px}
a{color:#0969da}
@media (prefers-color-scheme:dark){
 body{background:#0d1117;color:#e6edf3}
 .card,.fact,.verdict,.badge{background:#161b22;border-color:#30363d}
 .verdict.ok{background:#0f2a1a;border-color:#238636}
 .verdict.warn{background:#2b2200;border-color:#9e6a03}
 h2,.sub,.muted,.fact-label,.fact-note,.issue-step,th,footer,details summary{color:#8b949e}
 code,pre{background:#21262d}
 th,td{border-color:#30363d}
 a{color:#58a6ff}
}
</style>
</head>
<body>
<main>
  <h1>dsh-whale-inurqq 体检</h1>
  <p class="sub">版本 ${escapeHtml(data.version ?? '—')} · 生成于 ${escapeHtml(new Date(Number(data.now) || Date.now()).toLocaleString('zh-CN', { hour12: false }))} ·
    <a href="?format=json">查看原始 JSON</a></p>

  <section class="verdict ${healthy ? 'ok' : 'warn'}">
    <p class="verdict-title">${verdictTitle}</p>
    <p class="verdict-note">${verdictNote}</p>
  </section>

  ${issues.length ? `<h2>要处理的事</h2><ul class="issues">${issueCards}</ul>` : ''}

  <h2>它现在到底还活着吗</h2>
  <div class="card">
    <p>${aliveFlag ? badge('活着', 'ok') : badge('不活着', 'warn')}
      <span class="muted" style="margin-left:8px">这一项只认“有连接 + 事件没静默 + 计时器在跑”，缺一条就报不活着。</span></p>
    ${aliveLines}
    <p class="muted" style="margin-bottom:0">${escapeHtml(silenceLine)} · ${escapeHtml(tickLine)} ·
      事件静默阈值 ${escapeHtml(humanDuration(pick(alive, 'evidence.eventSilenceMs')))}</p>
  </div>

  <h2>关键状态</h2>
  <div class="grid">
    ${fact('协议端连接', connection ? `${connection.active ?? 0} 条` : '未初始化', connection?.selfIds?.length ? `selfId ${connection.selfIds.join('、')}` : '')}
    ${fact('工作区父目录', config.workspaceRoot || '（未配置）', config.workspaceRoot ? '每个 QQ 会话在其下建一个子目录' : '必填，否则任务无处落盘')}
    ${fact('语料库', `${corpus.chats ?? 0} 个会话`, `${humanBytes(corpus.bytes)} · 保留 ${corpus.retainDays ?? '—'} 天`)}
    ${fact('常驻对话', config.conversationEnabled === false ? '已回滚到 v2' : '开启', config.conversationEnabled === false ? '每条任务新建一个会话' : `交班阈值 ${Math.round((config.handoffAtRatio ?? 0) * 100)}% 窗口`)}
    ${fact('收到消息', pick(pipeline, 'stats.messages') ?? '—', `事件 ${pick(pipeline, 'stats.events') ?? 0} · 去重 ${pick(pipeline, 'stats.duplicates') ?? 0} · 越界 ${pick(pipeline, 'stats.outOfScope') ?? 0}`)}
    ${fact('回传判定', relay.provenanceDecided ?? '—', `GUI 发起而跳过 ${relay.skippedForeign ?? 0} 次`)}
  </div>

  ${conversationRows ? `<h2>交班进度（离阈值还有多远）</h2>
  <div class="card"><table>
    <thead><tr><th>会话</th><th class="num">第几代</th><th class="num">当前 token</th><th class="num">占阈值</th></tr></thead>
    <tbody>${conversationRows}</tbody>
  </table></div>` : ''}

  <h2>配置摘要</h2>
  <div class="card"><table>
    <tbody>
      <tr><th>连接方式</th><td>${escapeHtml(config.mode ?? '—')} · 挂载 ${escapeHtml(config.mount ?? '—')}${port ? ` · 端口 ${escapeHtml(port)}` : ''} · 路径 <code>${escapeHtml(config.path ?? '—')}</code></td></tr>
      <tr><th>鉴权</th><td>${config.authRequired ? '已配置 access token' : '未配置（不建议）'}</td></tr>
      <tr><th>群聊参与</th><td>${escapeHtml(config.groupMode ?? '—')}</td></tr>
      <tr><th>状态端点</th><td><code>${escapeHtml(endpoint)}</code></td></tr>
      <tr><th>日志</th><td><code>${escapeHtml(data.logFile ?? '—')}</code></td></tr>
    </tbody>
  </table></div>

  ${okItems.length ? `<details><summary>通过的检查（${okItems.length} 项）</summary><ul class="reasons">${okItems
    .map(item => `<li>${emphasize(item)}</li>`)
    .join('')}</ul></details>` : ''}

  <footer>
    只读页面：不包含任何写操作，数据只在本机生成与展示。<br>
    脚本或监控请取 <a href="?format=json">JSON</a>（<code>curl</code> 默认就是 JSON）。
  </footer>
</main>
</body>
</html>`
  return html
}
