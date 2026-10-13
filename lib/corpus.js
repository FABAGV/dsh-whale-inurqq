/**
 * 语料库：把 QQ 会话内容沉淀成本地可检索的语境。
 *
 * 设计约束（见设计文档第 5 节）：
 *  - 只存归一化后的结构，默认不存原始事件 JSON
 *  - 按会话 + 日期分片，便于按保留期整片删除
 *  - 提供按会话一键清除的能力（隐私不能只是承诺）
 *  - 全部留在本机，不向外发送
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 分片文件名：YYYY-MM-DD.jsonl */
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10)

export class Corpus {
  /**
   * @param {object} opts
   * @param {ReturnType<import('../config.js').resolveConfig>} opts.config
   * @param {ReturnType<import('./log.js').createLogger>} opts.log
   * @param {string} [opts.root]
   */
  constructor({ config, log, root }) {
    this.config = config
    this.log = log
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    this.root = root || path.join(home, 'dsh-whale-inurqq', 'corpus')
    this.disabled = !config.ingest.groupArchive && !config.ingest.forwardRecords
    this.stats = { appended: 0, forwardRecords: 0, pruneRuns: 0, prunedFiles: 0, searchRuns: 0, errors: 0 }
    try {
      fs.mkdirSync(this.root, { recursive: true })
    } catch (err) {
      this.log.warn(`[corpus] 无法创建语料目录 ${this.root}: ${err.message}`)
      this.disabled = true
    }
  }

  #chatDir(chatType, chatId) {
    // `chatType` 也参与拼目录名，所以同样要限定取值（它来自事件的 message_type，
    // 正常只可能是 private / group）
    if (chatType !== 'private' && chatType !== 'group') {
      throw new Error(`非法 chatType=${chatType}（只接受 private / group）`)
    }
    const dir = path.join(this.root, `${chatType}-${chatId}`)
    // 纵深防御：`chatId` 已经在 normalize 层被限制成纯数字（见 normalize.js），
    // 这里再确认一次解析结果没有跑出语料根目录。
    // 为什么必须有这一层：早先 `chatId` 直接来自事件字段，注入
    // `group_id: "..\\..\\..\\某目录"` 就能在任意位置 mkdir + 写文件
    // （已实测：3 个 `..` 即写出根目录）。拼接型路径一律拒绝。
    const resolved = path.resolve(dir)
    const rootResolved = path.resolve(this.root)
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(`会话目录越出语料根（chatType=${chatType} chatId=${chatId}）`)
    }
    return dir
  }

  /**
   * 追加一条归一化记录。
   * @param {object} opts
   * @param {'private'|'group'} opts.chatType
   * @param {string} opts.chatId
   * @param {string} [opts.chatName]
   * @param {string} opts.kind 'message' | 'forward'
   * @param {number} opts.ts
   * @param {object} opts.payload
   */
  append({ chatType, chatId, chatName, kind, ts, payload }) {
    if (this.disabled) return false
    try {
      const dir = this.#chatDir(chatType, chatId)
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${dayKey(ts)}.jsonl`)
      const record = { kind, ts, chatType, chatId, chatName: chatName ?? '', ...payload }
      // 原始事件只在显式开启时保留
      if (!this.config.ingest.storeRawEvents && record.raw) delete record.raw
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
      this.stats.appended += 1
      if (kind === 'forward') this.stats.forwardRecords += 1
      return true
    } catch (err) {
      this.stats.errors += 1
      this.log.warn(`[corpus] 写入失败: ${err.message}`)
      return false
    }
  }

  /** 列出所有已沉淀的会话 */
  listChats() {
    try {
      return fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const dir = path.join(this.root, d.name)
          const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
          let bytes = 0
          for (const f of files) {
            try {
              bytes += fs.statSync(path.join(dir, f)).size
            } catch {
              /* 忽略 */
            }
          }
          const [chatType, ...rest] = d.name.split('-')
          return {
            chatType,
            chatId: rest.join('-'),
            days: files.length,
            firstDay: files[0]?.replace('.jsonl', '') ?? null,
            lastDay: files[files.length - 1]?.replace('.jsonl', '') ?? null,
            bytes,
          }
        })
    } catch {
      return []
    }
  }

  /**
   * 检索语料。
   * @param {object} q
   * @param {string} [q.chatType] @param {string} [q.chatId]
   * @param {string} [q.query] 关键词（子串匹配，大小写不敏感）
   * @param {number} [q.since] 起始时间戳
   * @param {number} [q.limit]
   */
  search({ chatType, chatId, query, since, limit = 50 } = {}) {
    this.stats.searchRuns += 1
    const needle = query ? String(query).toLowerCase() : ''
    const results = []
    const cutoffDay = since ? dayKey(since) : null

    let dirs = []
    try {
      dirs = fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      return results
    }

    for (const d of dirs) {
      const [dType, ...rest] = d.name.split('-')
      const dId = rest.join('-')
      if (chatType && dType !== chatType) continue
      if (chatId && dId !== String(chatId)) continue

      const dir = path.join(this.root, d.name)
      let files = []
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse()
      } catch {
        continue
      }

      for (const f of files) {
        const day = f.replace('.jsonl', '')
        if (cutoffDay && day < cutoffDay) continue
        let lines = []
        try {
          lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)
        } catch {
          continue
        }
        // 从新到旧
        for (let i = lines.length - 1; i >= 0; i--) {
          let rec
          try {
            rec = JSON.parse(lines[i])
          } catch {
            continue
          }
          if (since && rec.ts < since) continue
          if (needle) {
            const hay = JSON.stringify(rec).toLowerCase()
            if (!hay.includes(needle)) continue
          }
          results.push(rec)
          if (results.length >= limit) return results
        }
      }
    }
    return results
  }

  /** 清空某个会话的全部语料 */
  purge(chatType, chatId) {
    try {
      // ⚠️ `#chatDir` 要在 try **里面**：它会为越界的 id 抛错，而本函数的契约是
      //    "失败返回 -1"，不是把异常抛给调用方（早先它写在外面，于是校验一加就漏了）
      const dir = this.#chatDir(chatType, chatId)
      if (!fs.existsSync(dir)) return 0
      const files = fs.readdirSync(dir)
      fs.rmSync(dir, { recursive: true, force: true })
      this.log.info(`[corpus] 已清除 ${chatType}/${chatId} 的 ${files.length} 个分片`)
      return files.length
    } catch (err) {
      this.log.warn(`[corpus] 清除失败: ${err.message}`)
      return -1
    }
  }

  /** 清空全部语料 */
  purgeAll() {
    try {
      const dirs = fs.readdirSync(this.root)
      fs.rmSync(this.root, { recursive: true, force: true })
      fs.mkdirSync(this.root, { recursive: true })
      this.log.info(`[corpus] 已清除全部语料（${dirs.length} 个会话）`)
      return dirs.length
    } catch (err) {
      this.log.warn(`[corpus] 全量清除失败: ${err.message}`)
      return -1
    }
  }

  /** 按保留期清理过期分片 */
  prune(now = Date.now()) {
    let removed = 0
    /** @type {string} */
    let cutoff = ''
    this.stats.pruneRuns += 1
    try {
      // ⚠️ 配置读取与 `dayKey` 必须在 try 内：`retainDays` 不是有限数时
      //    `new Date(NaN).toISOString()` 会抛 RangeError，而 index.js 里每 6 小时
      //    触发的那次 prune 早先没有外层 try/catch —— 那就成了未捕获异常
      //    （启动那次有 try/catch，所以只有定时那次会炸）。
      const retainDays = Number(this.config.corpus?.retainDays)
      if (!Number.isFinite(retainDays) || retainDays <= 0) {
        this.log.warn(`[corpus] corpus.retainDays=${this.config.corpus?.retainDays} 非法，跳过本次清理`)
        return 0
      }
      cutoff = dayKey(now - retainDays * 24 * 60 * 60 * 1000)
      for (const d of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const dir = path.join(this.root, d.name)
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.jsonl')) continue
          if (f.replace('.jsonl', '') < cutoff) {
            try {
              fs.unlinkSync(path.join(dir, f))
              removed += 1
            } catch {
              /* 忽略 */
            }
          }
        }
        // 空的会话目录也清掉
        try {
          if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
        } catch {
          /* 忽略 */
        }
      }
    } catch (err) {
      this.log.warn(`[corpus] 清理失败: ${err.message}`)
    }
    this.stats.prunedFiles += removed
    if (removed > 0) this.log.info(`[corpus] 保留期清理：删除 ${removed} 个过期分片（早于 ${cutoff}）`)
    return removed
  }

  snapshot() {
    const chats = this.listChats()
    return {
      root: this.root,
      disabled: this.disabled,
      retainDays: this.config.corpus.retainDays,
      chats: chats.length,
      bytes: chats.reduce((a, c) => a + c.bytes, 0),
      ...this.stats,
      detail: chats,
    }
  }
}
