/**
 * 合并转发展开。
 *
 * OneBot 里 `forward` 段只带一个 id，必须调 `get_forward_msg` 才能拿到内容。
 * 这是 QQ 相对微信的核心差异：转发进来的聊天记录是**结构化**的，
 * 带原始发言人、时间、消息段，而不是一张不可解析的卡片。
 *
 * 各实现返回的 node 结构并不统一（NapCat 用 user_id/nickname/content，
 * 也有实现用 uin/name/message），因此这里必须逐字段兜底。
 */
import { normalizeSegments } from './normalize.js'

/** 单个 node → 归一化节点 */
function normalizeNode(raw) {
  const d = raw?.data ?? raw ?? {}
  const content = d.content ?? d.message ?? []
  const segments = normalizeSegments(content)
  const ts = Number(d.time ?? d.timestamp ?? 0)

  return {
    senderId: String(d.user_id ?? d.uin ?? d.qq ?? ''),
    senderName: String(d.nickname ?? d.name ?? d.card ?? d.user_id ?? d.uin ?? '未知'),
    ts: ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : undefined,
    segments,
    text: segmentsToText(segments),
  }
}

/** 节点内消息段 → 纯文本 */
function segmentsToText(segments) {
  const parts = []
  for (const seg of segments) {
    switch (seg.kind) {
      case 'text':
        parts.push(seg.text)
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
      case 'at':
        parts.push(seg.qq === 'all' ? '@全体成员' : `@${seg.qq}`)
        break
      case 'forward':
        parts.push('[嵌套转发]')
        break
      default:
        parts.push(`[${seg.type}]`)
        break
    }
  }
  return parts.join('').trim()
}

/**
 * 展开一个合并转发。
 * @param {import('./connection.js').OneBotConnection} conn
 * @param {string} id
 * @returns {Promise<{id: string, nodes: Array<{senderId:string,senderName:string,ts?:number,segments:any[],text:string}>}>}
 */
export async function expandForward(conn, id) {
  const data = await conn.call('get_forward_msg', { id }, { timeoutMs: 20000 })
  const list = data?.messages ?? data?.message ?? (Array.isArray(data) ? data : [])
  const nodes = (Array.isArray(list) ? list : [])
    .map(normalizeNode)
    .filter((n) => n.text || n.segments.length > 0)
  return { id: String(id), nodes }
}

/**
 * 把展开结果渲染成给模型读的文本。
 * 带行号，便于模型引用具体某条。
 * @param {{nodes: Array<{senderName:string,ts?:number,text:string}>}} record
 * @param {{maxChars?: number, header?: string}} [opts]
 */
export function formatForward(record, opts = {}) {
  const maxChars = opts.maxChars ?? 6000
  const lines = []
  const header = opts.header ?? `【合并转发聊天记录，共 ${record.nodes.length} 条】`
  lines.push(header)

  let used = header.length
  let truncated = 0
  for (const [i, n] of record.nodes.entries()) {
    const time = n.ts ? `${new Date(n.ts).toISOString().slice(5, 16).replace('T', ' ')} ` : ''
    const line = `${i + 1}. ${time}${n.senderName}: ${n.text || '（空）'}`
    if (used + line.length > maxChars) {
      truncated = record.nodes.length - i
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  if (truncated > 0) lines.push(`…（还有 ${truncated} 条未展示）`)
  return lines.join('\n')
}
