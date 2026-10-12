/**
 * 幂等去重。
 *
 * 动机：NapCat 断线重连后可能重放事件，插件重启也可能重收。
 * 用 message_id + 时间的组合作为键，滑动窗口 + 容量上限。
 */
export class Dedupe {
  /**
   * @param {{windowMs?: number, maxEntries?: number}} [opts]
   */
  constructor({ windowMs = 5 * 60 * 1000, maxEntries = 4096 } = {}) {
    this.windowMs = windowMs
    this.maxEntries = maxEntries
    /** @type {Map<string, number>} key → 首次见到的时间戳 */
    this.seen = new Map()
  }

  /**
   * 首次见到返回 false，重复返回 true。
   * @param {string} key
   * @param {number} [now]
   */
  isDuplicate(key, now = Date.now()) {
    this.#evict(now)
    const prev = this.seen.get(key)
    if (prev !== undefined) return true
    this.seen.set(key, now)
    return false
  }

  #evict(now) {
    if (this.seen.size < this.maxEntries) {
      // 仍然要清掉过期项，否则小流量下会无限增长
      if (this.seen.size === 0) return
      const cutoff = now - this.windowMs
      for (const [k, t] of this.seen) {
        if (t < cutoff) this.seen.delete(k)
        else break // Map 保持插入顺序，遇到未过期的即可停
      }
      return
    }
    const cutoff = now - this.windowMs
    for (const [k, t] of this.seen) {
      if (t < cutoff || this.seen.size >= this.maxEntries) this.seen.delete(k)
      else break
    }
  }

  get size() {
    return this.seen.size
  }

  clear() {
    this.seen.clear()
  }
}
