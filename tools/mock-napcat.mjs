/**
 * Mock NapCat —— 模拟 OneBot 11 反向 WebSocket 客户端。
 *
 * 用途：在**没有登录真实 QQ 号**的情况下验证 dsh-whale-inurqq 插件的连接层、归一化层与路由决策。
 * 它做的事和 NapCat 完全一样：连上插件的 WS 端口、带上 OneBot 握手头、推送事件、响应动作调用。
 *
 * 脚本覆盖（v2）：
 *   - 私聊任务 / 群聊未 @ / 群聊 @bot / 合并转发
 *   - notice 与重复事件
 *   - **闲聊 vs 任务分流**（「在吗？」「谢谢」应进常驻会话）
 *   - **两条几乎同时到达的任务**（应各自独立会话、并行执行，而不是串行排队）
 *   - 「/cancel」控制指令（只取消最近一条任务，不碰其他任务）
 *
 * 用法：
 *   node tools/mock-napcat.mjs                        # 默认连 ws://127.0.0.1:6700
 *   node tools/mock-napcat.mjs --url ws://127.0.0.1:6700 --token <access token>
 *   node tools/mock-napcat.mjs --self 10001 --once    # 发完脚本就退出
 *
 * 默认 token 取环境变量 MOCK_NAPCAT_TOKEN（为空表示不带 Authorization 头）。
 * **仓库里不存任何 token 字面量**：本地测试台不校验来源（`token: ''`），
 * 而对接真实 NapCat 时用的是你 profile 里那个 token，不该进版本库。
 */
import { WebSocket } from 'ws'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const URL_ = arg('url', 'ws://127.0.0.1:6700')
const TOKEN = arg('token', process.env.MOCK_NAPCAT_TOKEN ?? '')
const SELF_ID = arg('self', '10001')
const ONCE = has('once')
const GAP = Number(arg('gap', '900'))

let seq = 1
const now = () => Math.floor(Date.now() / 1000)

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), '[mock-napcat]', ...a)
}

/** 构造一条消息事件 */
function messageEvent({ chatType, chatId, senderId, senderName, segments, card }) {
  const base = {
    time: now(),
    self_id: Number(SELF_ID),
    post_type: 'message',
    message_type: chatType,
    message_id: seq++,
    user_id: Number(senderId),
    message: segments,
    raw_message: segments.map((s) => (s.type === 'text' ? s.data.text : `[CQ:${s.type}]`)).join(''),
    font: 0,
    sender: { user_id: Number(senderId), nickname: senderName, ...(card ? { card } : {}) },
  }
  if (chatType === 'group') {
    return { ...base, sub_type: 'normal', group_id: Number(chatId), anonymous: null, sender: { ...base.sender, role: 'member' } }
  }
  return { ...base, sub_type: 'friend' }
}

/** 测试脚本：每项是一条要推送的事件。id 用于显式引用（重复推送），gap 覆盖默认间隔 */
const SCRIPT = [
  {
    id: 'lifecycle',
    label: 'META lifecycle（connect）',
    event: { time: now(), self_id: Number(SELF_ID), post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' },
  },
  {
    id: 'heartbeat',
    label: 'META heartbeat',
    event: { time: now(), self_id: Number(SELF_ID), post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: true }, interval: 30000 },
  },
  {
    id: 'private-task-1',
    label: '私聊任务 → 期望 TASK（新建独立任务会话）',
    event: messageEvent({
      chatType: 'private', chatId: '20002', senderId: '20002', senderName: '测试用户',
      segments: [{ type: 'text', data: { text: '帮我在工作区建个项目，写个 README' } }],
    }),
  },
  {
    id: 'group-silent',
    label: '群聊未 @ → 期望 INGEST(group-not-mentioned)',
    event: messageEvent({
      chatType: 'group', chatId: '30003', senderId: '20003', senderName: '群友甲', card: '甲甲',
      segments: [{ type: 'text', data: { text: '今天天气不错' } }],
    }),
  },
  {
    id: 'group-task',
    label: '群聊 @bot → 期望 TASK',
    event: messageEvent({
      chatType: 'group', chatId: '30003', senderId: '20003', senderName: '群友甲', card: '甲甲',
      segments: [
        { type: 'at', data: { qq: SELF_ID } },
        { type: 'text', data: { text:  ' 帮我查一下这个报错' } },
      ],
    }),
  },
  {
    id: 'private-forward-task',
    label: '私聊带合并转发段 → 期望 TASK（转发内容作为语境）',
    event: messageEvent({
      chatType: 'private', chatId: '20002', senderId: '20002', senderName: '测试用户',
      segments: [
        { type: 'text', data: { text: '帮我看看这段对话' } },
        { type: 'forward', data: { id: 'FORWARD_DEMO_ID' } },
      ],
    }),
  },
  {
    id: 'recall',
    label: 'notice 群撤回 → 期望 IGNORE(notice)',
    event: { time: now(), self_id: Number(SELF_ID), post_type: 'notice', notice_type: 'group_recall', group_id: 30003, user_id: 20003, operator_id: 20003, message_id: 1 },
  },
  {
    id: 'duplicate',
    label: '重复推送上一条私聊任务 → 期望 IGNORE(duplicate)',
    dupOf: 'private-task-1',
  },
  // ── v2：任务/闲聊分流 ────────────────────────────────────────────────
  {
    id: 'private-chat',
    label: '私聊闲聊「在吗？」→ 期望 CHAT（进常驻会话，不新建任务会话）',
    event: messageEvent({
      chatType: 'private', chatId: '20002', senderId: '20002', senderName: '测试用户',
      segments: [{ type: 'text', data: { text: '在吗？' } }],
    }),
  },
  {
    id: 'group-chat',
    label: '群聊 @bot 闲聊「谢谢」→ 期望 CHAT',
    event: messageEvent({
      chatType: 'group', chatId: '30003', senderId: '20003', senderName: '群友甲', card: '甲甲',
      segments: [
        { type: 'at', data: { qq: SELF_ID } },
        { type: 'text', data: { text: ' 谢谢' } },
      ],
    }),
  },
  // ── v2：并发任务（彼此间隔很小，用来观察是否真的并行）──────────────────
  {
    id: 'parallel-a',
    label: '私聊任务 A → 期望 TASK（与下一条并行，各自独立会话）',
    gap: 200,
    event: messageEvent({
      chatType: 'private', chatId: '20002', senderId: '20002', senderName: '测试用户',
      segments: [{ type: 'text', data: { text: '帮我把这个月的采集日志按周汇总，输出一份带统计数字的周报' } }],
    }),
  },
  {
    id: 'parallel-b',
    label: '私聊任务 B → 期望 TASK（不应等 A 跑完）',
    gap: 200,
    event: messageEvent({
      chatType: 'private', chatId: '20002', senderId: '20002', senderName: '测试用户',
      segments: [{ type: 'text', data: { text: '再把上一条周报里的待办事项抽出来，按优先级排个顺序' } }],
    }),
  },
  {
    id: 'cancel',
    label: '私聊 /cancel → 期望 CONTROL（只取消最近一条任务）',
    event: messageEvent({
      chatType: 'private', chatId: '20002', senderId: '20002', senderName: '测试用户',
      segments: [{ type: 'text', data: { text: '/cancel' } }],
    }),
  },
]

const ws = new WebSocket(URL_, {
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'X-Self-ID': SELF_ID,
    'X-Client-Role': 'Universal',
  },
})

/** 动作调用应答：让插件的 call() 能拿到结果 */
function respond(echo, action) {
  const data = (() => {
    switch (action) {
      case 'get_login_info':
        return { user_id: Number(SELF_ID), nickname: 'MockBot' }
      case 'get_version_info':
        return { app_name: 'mock-napcat', protocol_version: 'v11', app_version: '0.0.1' }
      case 'get_forward_msg':
        return {
          messages: [
            { type: 'node', data: { user_id: 20003, nickname: '甲甲', time: now() - 120, content: [{ type: 'text', data: { text: '（模拟转发节点 1）' } }] } },
            { type: 'node', data: { user_id: 20004, nickname: '乙乙', time: now() - 60, content: [{ type: 'text', data: { text: '（模拟转发节点 2）' } }] } },
          ],
        }
      case 'send_private_msg':
      case 'send_group_msg':
      case 'send_msg':
        return { message_id: seq++ }
      default:
        return {}
    }
  })()
  ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }))
}

ws.on('open', async () => {
  log(`已连接 ${URL_}  selfId=${SELF_ID}`)
  /** @type {Map<string, any>} 已发过的事件，供 dupOf 精确复制 */
  const sentById = new Map()

  for (const step of SCRIPT) {
    let event = step.event
    if (step.dupOf) {
      const src = sentById.get(step.dupOf)
      if (!src) {
        log(`跳过 ${step.label}（找不到 ${step.dupOf}）`)
        continue
      }
      // 完全相同的重复事件（同 message_id + 同 time）
      event = JSON.parse(JSON.stringify(src))
    }
    if (!event) continue

    log(`→ ${step.label}`)
    ws.send(JSON.stringify(event))
    if (step.id) sentById.set(step.id, event)
    await new Promise((r) => setTimeout(r, step.gap ?? GAP))
  }

  log('脚本发送完毕')
  if (ONCE) {
    await new Promise((r) => setTimeout(r, 800))
    ws.close()
    process.exit(0)
  }
  log('保持连接中（Ctrl+C 退出）。每秒发一次心跳。')
  setInterval(() => {
    ws.send(
      JSON.stringify({
        time: now(), self_id: Number(SELF_ID), post_type: 'meta_event',
        meta_event_type: 'heartbeat', status: { online: true, good: true }, interval: 1000,
      }),
    )
  }, 1000)
})

ws.on('message', (raw) => {
  let msg
  try {
    msg = JSON.parse(raw.toString('utf8'))
  } catch {
    log('← 非 JSON:', raw.toString('utf8').slice(0, 200))
    return
  }
  if (msg.action) {
    const p = msg.params ?? {}
    if (msg.action === 'send_private_msg' || msg.action === 'send_group_msg' || msg.action === 'send_msg') {
      const to = p.group_id ? `群${p.group_id}` : `私聊${p.user_id ?? '?'}`
      const text = (p.message ?? [])
        .map((s) => (s.type === 'text' ? s.data?.text : `[${s.type}]`))
        .join('')
      log(`← 回传 → ${to}: ${text.replace(/\n/g, ' ⏎ ')}`)
    } else {
      log(`← 动作调用 ${msg.action}`)
    }
    respond(msg.echo, msg.action)
    return
  }
  log('← 其他报文:', JSON.stringify(msg).slice(0, 200))
})

ws.on('close', (code, reason) => log(`连接关闭 code=${code} ${reason?.toString() ?? ''}`))
ws.on('error', (err) => log(`错误: ${err.message}`))
