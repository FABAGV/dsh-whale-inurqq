/**
 * 状态页（HTML 视图）的单元测试。
 *
 * 为什么单独一个文件：`tools/test-entry.mjs` 跑的是"插件在假宿主里能不能工作"，
 * 而这里测的是**同一份快照怎么给人看** —— 它不启动连接、不碰 DSH，纯函数。
 * 重点是三件事：
 *   1. 浏览器来 text/html、curl 来 * / *，分流不能反；
 *   2. 所有动态值必须转义（工作区路径/错误信息里出现 `<` 时页面不能变成注入点）；
 *   3. 字段缺失时不显示 undefined / NaN（老版本快照、半初始化状态）。
 *
 * 运行：node tools/test-status-page.mjs
 */
import {
  escapeHtml,
  formatForRequest,
  humanBytes,
  humanDuration,
  nextStepFor,
  renderStatusPage,
} from '../lib/status-page.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ===========================================================================
// 1. 内容协商
// ===========================================================================
console.log('1. 浏览器拿 HTML，curl 拿 JSON')
{
  check('浏览器导航（Accept: text/html）→ html',
    formatForRequest({ url: '/dsh-whale-inurqq/status', headers: { accept: 'text/html,application/xhtml+xml' } }) === 'html')
  check('curl 默认（Accept: */*）→ json',
    formatForRequest({ url: '/dsh-whale-inurqq/status', headers: { accept: '*/*' } }) === 'json')
  check('没有 Accept 头 → json（脚本最安全的默认）',
    formatForRequest({ url: '/dsh-whale-inurqq/status', headers: {} }) === 'json')
  check('?format=html 能覆盖 Accept（分享给人看的链接）',
    formatForRequest({ url: '/dsh-whale-inurqq/status?format=html', headers: { accept: '*/*' } }) === 'html')
  check('?format=json 能覆盖 Accept（页面里“原始 JSON”链接）',
    formatForRequest({ url: '/dsh-whale-inurqq/status?format=json', headers: { accept: 'text/html' } }) === 'json')
  check('畸形 URL 不抛、退回 JSON',
    formatForRequest({ url: 'http://[bad', headers: { accept: '*/*' } }) === 'json')
}

// ===========================================================================
// 2. 转义与格式化
// ===========================================================================
console.log('')
console.log('2. 转义与格式化')
{
  check('escapeHtml 覆盖五个字符',
    escapeHtml(`<a href="x">'&'</a>`) === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    escapeHtml(`<a href="x">'&'</a>`))
  check('humanDuration：毫秒/秒/分钟/小时',
    humanDuration(120) === '120 毫秒' && humanDuration(3000) === '3 秒' &&
      humanDuration(90_000) === '1.5 分钟' && humanDuration(120000) === '2 分钟' &&
      humanDuration(5400000) === '1.5 小时',
    [120, 3000, 90000, 120000, 5400000].map(humanDuration).join(' / '))
  check('humanDuration 对缺失/负数返回 —', humanDuration(undefined) === '—' && humanDuration(-1) === '—')
  check('★ humanDuration 对 null 返回 —（不能显示成“0 毫秒前”）', humanDuration(null) === '—')
  check('存活区块对 null 静默时间写“未知”而不是 0 秒', (() => {
    const out = renderStatusPage({ alive: { alive: false, evidence: { silentForMs: null, sinceTickMs: null } } })
    return out.includes('最后事件时间未知') && !out.includes('最后事件 0')
  })())
  check('★ 从未收到事件（silentForMs=0 且无 lastEventAt）→ 写“尚未收到事件”', (() => {
    const out = renderStatusPage({
      alive: {
        alive: false,
        because: ['连接层未初始化（webServer 服务未就绪）'],
        evidence: { silentForMs: 0, sinceTickMs: null, lastEventAt: 0, eventSilenceMs: 90000 },
      },
      health: { verdict: 'attention', issues: ['连接层未初始化（webServer 服务未就绪）'] },
    })
    return out.includes('尚未收到事件') && !out.includes('最后事件 0 毫秒前')
  })())
  check('有 lastEventAt 时 0ms 静默仍准确显示“0 毫秒前”', (() => {
    const out = renderStatusPage({
      alive: { alive: true, evidence: { silentForMs: 0, lastEventAt: 1760000000000, sinceTickMs: 10 } },
    })
    return out.includes('最后事件 0 毫秒前')
  })())
  check('humanBytes：B/KB/MB',
    humanBytes(900) === '900 B' && humanBytes(2048) === '2.0 KB' && humanBytes(3 * 1024 * 1024) === '3.0 MB')
  check('workspaceRoot 问题给出绝对路径建议', nextStepFor('tasks.workspaceRoot 未配置').includes('绝对路径'))
  check('token 问题给出凭据建议', nextStepFor('未配置 access token').includes('QQ_ONEBOT_TOKEN'))
  check('认不出的问题不硬编建议', nextStepFor('某种没见过的错误') === '')
  // 顺序回归：宽词（连接/交班）不能盖住具体原因
  check('★ webServer 未就绪 → 指向 DSH，而不是 NapCat', (() => {
    const step = nextStepFor('连接层未初始化（webServer 服务未就绪）')
    return step.includes('webServer') && !step.includes('NapCat')
  })())
  check('★ 交班流程异常 → 指向 lastError/日志，而不是“还没测出窗口”', (() => {
    const step = nextStepFor('有 2 次交班流程异常，最近一次：boom')
    return step.includes('lastError') && !step.includes('跑完一个回合')
  })())
  check('★ 归档失败 → 指向 lastError/日志', nextStepFor('有 1 次旧会话归档失败（交班仍完成）').includes('lastError'))
  check('真的没测到 contextWindow 时才说“跑完一个回合”',
    nextStepFor('还没有测量到 contextWindow').includes('跑完一个回合'))
  check('派活链路问题给出 bridge.stats.lastError 建议',
    nextStepFor('建过工作区但从未建成会话 —— 派活链路可能有问题').includes('bridge.stats.lastError'))
}

// ===========================================================================
// 3. 渲染：健康快照
// ===========================================================================
const healthy = {
  plugin: 'dsh-whale-inurqq',
  version: '9.9.9',
  now: 1760000000000,
  logFile: 'C:\\Users\\x\\.dsh\\dsh-whale-inurqq\\plugin.log',
  alive: {
    alive: true,
    because: ['QQ 通道：1 条连接、WebSocket 处于 OPEN，最近 3 秒内收到过事件帧（selfId=123）'],
    evidence: { silentForMs: 3000, sinceTickMs: 120, eventSilenceMs: 90000 },
  },
  config: {
    mode: 'reverse',
    mount: 'own',
    path: '/',
    port: 6700,
    authRequired: true,
    groupMode: 'mention',
    workspaceRoot: 'D:\\qq-projects',
    conversationEnabled: true,
    handoffAtRatio: 0.25,
  },
  connection: { active: 1, selfIds: ['123'] },
  pipeline: { stats: { messages: 42, events: 120, duplicates: 3, outOfScope: 2 } },
  corpus: { chats: 3, bytes: 2048, retainDays: 30 },
  relay: { provenanceDecided: 11, skippedForeign: 4 },
  conversation: {
    handoffAtRatio: 0.25,
    chats: [
      { scope: 'group:1', chatName: '测试群', generation: 2, totalTokens: 12000, progressPercent: 12 },
    ],
  },
  health: { verdict: 'ok', issues: [], ok: ['access token 已配置（来源：config）'] },
}

console.log('')
console.log('3. 健康快照')
{
  const html = renderStatusPage(healthy)
  check('顶部结论是“一切正常”', html.includes('一切正常') && !html.includes('要处理的事'))
  check('存活判据逐条列出', html.includes('selfId=123'))
  check('关键数字：工作区 / 语料库 / 连接',
    html.includes('D:\\qq-projects') && html.includes('3 个会话') && html.includes('1 条'))
  check('交班表显示群名与百分比', html.includes('测试群') && html.includes('12%'))
  check('日志路径可见（排障入口）', html.includes('plugin.log'))
  check('页面里有原始 JSON 链接', html.includes('?format=json'))
  check('声明 viewport 与编码（手机上也能看）',
    html.includes('<meta charset="utf-8">') && html.includes('name="viewport"'))
  check('不加载任何外部资源（断网可用）', !/<(script|link|img|iframe)\b/i.test(html))
  check('通过项收在 details 里，不占首屏', html.includes('<details>') && html.includes('通过的检查（1 项）'))
}

// ===========================================================================
// 4. 渲染：有问题 + 恶意输入
// ===========================================================================
console.log('')
console.log('4. 有待处理项 + 转义')
{
  const nasty = JSON.parse(JSON.stringify(healthy))
  nasty.health = {
    verdict: 'attention',
    issues: [
      'tasks.workspaceRoot 未配置 —— 任务无法落盘',
      '未配置 access token —— 任何进程都能连入，不建议',
      '<script>alert(1)</script> 不该原样出现',
    ],
    ok: [],
  }
  nasty.config.workspaceRoot = '<img src=x onerror=alert(2)>'
  const html = renderStatusPage(nasty)

  check('结论给出问题条数', html.includes('有 3 项需要处理'))
  check('三条问题都显示', html.includes('tasks.workspaceRoot 未配置') &&
    html.includes('未配置 access token') && html.includes('不该原样出现'))
  check('每条都给了“下一步”', (html.match(/下一步/g) || []).length >= 2)
  check('workspaceRoot 建议包含绝对路径', html.includes('绝对路径'))
  check('token 建议包含 QQ_ONEBOT_TOKEN', html.includes('QQ_ONEBOT_TOKEN'))
  check('★ 动态值被转义：没有可执行的 script',
    !html.includes('<script>') && html.includes('&lt;script&gt;'))
  check('★ 工作区里的 img 标签没有被当成 HTML',
    !html.includes('<img src=x') && html.includes('&lt;img src=x onerror=alert(2)&gt;'))
  check('快照里的 **强调** 转成 strong（先转义再替换）', (() => {
    const withMark = JSON.parse(JSON.stringify(nasty))
    withMark.health.issues = ['**很要紧** 的错误']
    const out = renderStatusPage(withMark)
    return out.includes('<strong>很要紧</strong>')
  })())
}

// ===========================================================================
// 5. 字段缺失（半初始化 / 老版本快照）
// ===========================================================================
console.log('')
console.log('5. 字段缺失时不露出 undefined / NaN')
{
  const bare = renderStatusPage({})
  check('不出现 undefined', !bare.includes('undefined'))
  check('不出现 NaN', !bare.includes('NaN'))
  check('结论退回“状态还不完整”而不是假装健康', bare.includes('状态还不完整'))
  check('连接未初始化时如实写', bare.includes('未初始化'))

  const partial = renderStatusPage({ health: { verdict: 'attention', issues: ['只有一条'] } })
  check('只有 issues 也能渲染', partial.includes('只有一条'))
}

console.log('')
console.log('='.repeat(64))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(64))
process.exit(fail === 0 ? 0 : 1)
