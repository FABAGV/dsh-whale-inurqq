import { POST_TYPE, MESSAGE_TYPE, SEGMENT_KIND } from './constants.js'

/**
 * 把 OneBot 的 message 字段（数组或 CQ 码字符串）归一化为内部 Segment[]。
 * NapCat 已配置 messagePostFormat=array，但这里对字符串也做兼容。
 *
 * @param {any} message
 * @returns {import('./types.js').Segment[]}
 */
export function normalizeSegments(message) {
  if (Array.isArray(message)) return message.map(normalizeSegment).filter(Boolean)
  if (typeof message === 'string') return parseCqString(message)
  return []
}

/** @param {any} seg */
function normalizeSegment(seg) {
  if (!seg || typeof seg !== 'object') return null
  const type = String(seg.type ?? '')
  const data = seg.data ?? {}
  switch (SEGMENT_KIND[type]) {
    case 'text':
      return { kind: 'text', text: String(data.text ?? '') }
    case 'image':
      return { kind: 'image', file: String(data.file ?? ''), url: data.url ? String(data.url) : undefined }
    case 'record':
      return { kind: 'record', file: String(data.file ?? ''), url: data.url ? String(data.url) : undefined }
    case 'video':
      return { kind: 'video', file: String(data.file ?? ''), url: data.url ? String(data.url) : undefined }
    case 'at':
      return { kind: 'at', qq: String(data.qq ?? '') }
    case 'reply':
      // 规范里 reply 段的 id 字段名可能是 id / message_id，两者都兜住
      return { kind: 'reply', messageId: String(data.id ?? data.message_id ?? '') }
    case 'forward':
      return { kind: 'forward', id: String(data.id ?? '') }
    default:
      return { kind: 'other', type, data }
  }
}

/**
 * 极简 CQ 码解析（仅在 message 为字符串时使用）。
 * 支持 text / image / at / reply / forward，其余归入 other。
 * @param {string} raw
 * @returns {import('./types.js').Segment[]}
 */
export function parseCqString(raw) {
  /** @type {import('./types.js').Segment[]} */
  const out = []
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g
  let last = 0
  let m
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) {
      const text = unescapeCq(raw.slice(last, m.index))
      if (text) out.push({ kind: 'text', text })
    }
    const type = m[1]
    const data = parseCqParams(m[2])
    const seg = normalizeSegment({ type, data })
    if (seg) out.push(seg)
    last = re.lastIndex
  }
  if (last < raw.length) {
    const text = unescapeCq(raw.slice(last))
    if (text) out.push({ kind: 'text', text })
  }
  return out
}

function parseCqParams(rest) {
  const data = {}
  if (!rest) return data
  for (const kv of rest.replace(/^,/, '').split(',')) {
    if (!kv) continue
    const i = kv.indexOf('=')
    if (i < 0) continue
    data[kv.slice(0, i)] = unescapeCq(kv.slice(i + 1))
  }
  return data
}

function unescapeCq(s) {
  return s
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&')
}

/**
 * 显示名解析。规范明确 sender 各字段是"尽最大努力提供"，可能缺失或过期，
 * 因此这里必须逐级兜底。
 * @param {any} sender
 * @param {string} fallbackId
 */
export function displayName(sender, fallbackId) {
  if (!sender || typeof sender !== 'object') return String(fallbackId ?? '')
  const name = sender.card || sender.nickname || sender.name
  if (name && String(name).trim()) return String(name).trim()
  return String(sender.user_id ?? fallbackId ?? '')
}

/**
 * 把 OneBot 事件分类。
 * @param {any} payload
 * @returns {'message'|'notice'|'request'|'meta'|'unknown'}
 */
export function classifyEvent(payload) {
  switch (payload?.post_type) {
    case POST_TYPE.MESSAGE:
      return 'message'
    case POST_TYPE.NOTICE:
      return 'notice'
    case POST_TYPE.REQUEST:
      return 'request'
    case POST_TYPE.META:
      return 'meta'
    default:
      return 'unknown'
  }
}

/**
 * 归一化一条消息事件为 QQMessage。
 * 不含 forward 展开 —— 展开需要发起动作调用，由上层异步完成。
 *
 * @param {any} payload
 * @param {{ selfId?: string }} [ctx]
 * @returns {import('./types.js').QQMessage | null}
 */
export function normalizeMessageEvent(payload, ctx = {}) {
  if (classifyEvent(payload) !== 'message') return null

  const chatType = payload.message_type
  if (chatType !== MESSAGE_TYPE.PRIVATE && chatType !== MESSAGE_TYPE.GROUP) return null

  const selfId = String(payload.self_id ?? ctx.selfId ?? '')
  const isGroup = chatType === MESSAGE_TYPE.GROUP
  const chatId = String(isGroup ? (payload.group_id ?? '') : (payload.user_id ?? ''))
  // ⚠️ 会话 id 只接受纯数字（长度上限 12，够 QQ 号与群号用）。
  //
  //    这不是装饰性校验：`chatId` 会**直接拼进目录名** —— 语料分片
  //    （corpus.js 的 `#chatDir`）与工作区目录（bridge.js 的 `projectPathFor`）。
  //    早先不校验时，一个伪造的 `group_id: "..\\..\\..\\x"` 就能在语料根之外
  //    建目录、写内容可控的文件（已实测复现）。QQ 号/群号本来就是纯数字，
  //    挡掉不合法的即无损；非法事件在这里就被丢掉，不会流到下游。
  if (!/^\d{1,12}$/.test(chatId)) return null
  const segments = normalizeSegments(payload.message)

  return {
    platform: 'qq',
    selfId,
    chatType: isGroup ? 'group' : 'private',
    chatId,
    messageId: String(payload.message_id ?? ''),
    senderId: String(payload.user_id ?? ''),
    senderName: displayName(payload.sender, payload.user_id),
    senderRole: payload.sender?.role ?? undefined,
    subType: String(payload.sub_type ?? ''),
    anonymous: payload.anonymous
      ? { id: String(payload.anonymous.id ?? ''), name: String(payload.anonymous.name ?? '') }
      : undefined,
    ts: Number(payload.time ?? 0) * 1000 || Date.now(),
    segments,
    atBot: segments.some((s) => s.kind === 'at' && (s.qq === selfId || s.qq === 'all')),
    raw: payload,
  }
}

/**
 * 从 QQMessage 里取出纯文本（去掉 @ 段本身，但保留 @all 的语义标记）。
 * @param {import('./types.js').QQMessage} msg
 */
export function plainText(msg) {
  const parts = []
  for (const seg of msg.segments) {
    switch (seg.kind) {
      case 'text':
        parts.push(seg.text)
        break
      case 'at':
        if (seg.qq === 'all') parts.push('@全体成员')
        else if (seg.qq !== msg.selfId) parts.push(`@${seg.qq}`)
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'record':
        parts.push('[语音]')
        break
      case 'video':
        parts.push('[视频]')
        break
      case 'forward':
        parts.push('[合并转发]')
        break
      case 'reply':
        parts.push('[引用]')
        break
      default:
        parts.push(`[${seg.type}]`)
        break
    }
  }
  return parts.join('').trim()
}

/**
 * 幂等键：message_id 在单个 OneBot 实现内唯一，叠加时间进一步降低跨实现碰撞概率。
 * @param {import('./types.js').QQMessage} msg
 */
export function idempotencyKey(msg) {
  return `${msg.selfId}:${msg.messageId}:${msg.ts}`
}
