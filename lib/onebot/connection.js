import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { POST_TYPE, STATUS } from './constants.js'

/**
 * 一条 NapCat（OneBot 11 实现）连接。
 *
 * 职责：
 *  - 帧收发与 JSON 解析
 *  - 动作调用的 echo 匹配、超时与失败结构化
 *  - 心跳/存活观测
 *  - 把不认识的报文原样交给上层（便于排障）
 */
export class OneBotConnection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('ws').WebSocket} opts.socket
   * @param {{info: Function, warn: Function, error: Function, debug: Function}} opts.log
   * @param {string} [opts.selfId]
   * @param {string} [opts.role]
   * @param {number} [opts.callTimeoutMs]
   */
  constructor({ socket, log, selfId = '', role = '', callTimeoutMs = 15000 }) {
    super()
    this.socket = socket
    this.log = log
    this.selfId = selfId
    this.role = role
    this.callTimeoutMs = callTimeoutMs

    this.id = randomUUID()
    this.ready = false
    this.closed = false
    this.connectedAt = Date.now()
    this.lastEventAt = 0
    this.eventCount = 0
    this.callCount = 0
    this.lastError = null

    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout, action: string}>} */
    this.pending = new Map()
    this.echoSeq = 0

    socket.on('message', (raw) => this.#onMessage(raw))
    socket.on('close', (code, reason) => this.#onClose(code, reason))
    socket.on('error', (err) => {
      this.lastError = err?.message ?? String(err)
      this.log.warn(`[onebot:${this.selfId || '?'}] socket 错误: ${this.lastError}`)
    })
  }

  /** 连接就绪后由 server 调用 */
  markReady() {
    this.ready = true
    this.emit('ready')
  }

  #onMessage(raw) {
    let text
    try {
      text = typeof raw === 'string' ? raw : raw.toString('utf8')
    } catch (err) {
      this.log.warn(`[onebot] 无法解码帧: ${err?.message}`)
      return
    }

    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      // 非 JSON：OneBot 实现一般不会这样发，但保留原文便于排障
      this.log.debug(`[onebot] 非 JSON 帧（${text.length} 字节）`)
      this.emit('unparsed', text)
      return
    }

    // 响应帧：带 echo 且能匹配到等待中的调用
    if (payload && typeof payload === 'object' && 'echo' in payload && this.pending.has(String(payload.echo))) {
      this.#settle(payload)
      return
    }

    // 事件帧
    this.lastEventAt = Date.now()
    this.eventCount += 1
    this.emit('event', payload)
    this.emit(payload?.post_type ?? 'unknown', payload)
  }

  #settle(payload) {
    const echo = String(payload.echo)
    const entry = this.pending.get(echo)
    if (!entry) return
    this.pending.delete(echo)
    clearTimeout(entry.timer)

    if (payload.status === STATUS.FAILED || (payload.retcode !== undefined && payload.retcode !== 0)) {
      const err = new Error(
        `OneBot 动作失败 ${entry.action}: retcode=${payload.retcode} ${payload.message ?? payload.wording ?? ''}`.trim(),
      )
      err.code = 'ONEBOT_ACTION_FAILED'
      err.retcode = payload.retcode
      err.action = entry.action
      err.payload = payload
      entry.reject(err)
      return
    }
    entry.resolve(payload.data)
  }

  #onClose(code, reason) {
    if (this.closed) return
    this.closed = true
    const why = reason ? reason.toString() : ''
    this.log.info(`[onebot:${this.selfId || '?'}] 连接关闭 code=${code}${why ? ` reason=${why}` : ''}`)
    this.#rejectAll(new Error('OneBot 连接已关闭'))
    this.emit('close', { code, reason: why })
  }

  #rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }

  /**
   * 调用一个 OneBot 动作。
   * @param {string} action
   * @param {object} [params]
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<any>} 响应中的 data
   */
  call(action, params = {}, opts = {}) {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      return Promise.reject(new Error(`OneBot 连接不可用，无法调用 ${action}`))
    }
    const echo = `dshqq-${++this.echoSeq}-${randomUUID().slice(0, 8)}`
    const timeoutMs = opts.timeoutMs ?? this.callTimeoutMs

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        const err = new Error(`OneBot 动作超时 ${action}（${timeoutMs}ms）`)
        err.code = 'ONEBOT_ACTION_TIMEOUT'
        err.action = action
        reject(err)
      }, timeoutMs)
      // 定时器不应阻止进程退出
      if (typeof timer.unref === 'function') timer.unref()

      this.pending.set(echo, { resolve, reject, timer, action })
      this.callCount += 1
      try {
        this.socket.send(JSON.stringify({ action, params, echo }))
      } catch (err) {
        this.pending.delete(echo)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  /** 主动关闭 */
  close(code = 1000, reason = 'dsh-whale-inurqq closing') {
    try {
      this.socket.close(code, reason)
    } catch {
      /* 已关闭 */
    }
  }

  /** 给设置页/状态接口用的快照 */
  snapshot() {
    return {
      id: this.id,
      selfId: this.selfId,
      role: this.role,
      ready: this.ready,
      closed: this.closed,
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventAt,
      eventCount: this.eventCount,
      callCount: this.callCount,
      pendingCalls: this.pending.size,
      pendingActions: [...this.pending.values()].map((e) => e.action),
      lastError: this.lastError,
    }
  }
}
