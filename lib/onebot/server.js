/**
 * 反向 WebSocket 服务端：NapCat 作为客户端连进来。
 *
 * 之所以用反向 WS：用户不需要公网、不需要端口映射，装完即可用。
 * NapCat 侧配置见 <NapCat 安装目录>\napcat\config\onebot11.json
 * 每 5000ms 重连一次，所以插件随起随连，不需要 NapCat 重启。
 */
import { WebSocketServer } from 'ws'
import { OneBotConnection } from './connection.js'

/**
 * 解析 `Authorization: Bearer xxx` 之外，OneBot 反向上报还会带 `X-Self-ID` 与 `X-Client-Role`。
 * @param {import('node:http').IncomingMessage} req
 */
function readHandshake(req) {
  const auth = req.headers['authorization'] ?? ''
  const bearer = /^Bearer\s+(.+)$/i.exec(String(auth))?.[1]?.trim() ?? ''
  return {
    token: bearer,
    selfId: String(req.headers['x-self-id'] ?? '').trim(),
    role: String(req.headers['x-client-role'] ?? '').trim() || 'Universal',
  }
}

export class OneBotReverseServer {
  /**
   * @param {object} opts
   * @param {string} opts.path
   * @param {() => string} opts.getToken 读取期望的 access token；返回空字符串表示不校验。
   *   用函数而非值，是因为 token 可能在插件启动后才从 DSH 凭据里异步载入。
   * @param {ReturnType<import('../log.js').createLogger>} opts.log
   * @param {(payload: any, conn: OneBotConnection) => void} opts.onEvent
   */
  constructor({ path, getToken, isAuthReady, log, onEvent }) {
    this.path = path
    this.getToken = typeof getToken === 'function' ? getToken : () => ''
    /** 鉴权信息是否已解析完成；未就绪时一律拒绝（fail-closed） */
    this.isAuthReady = typeof isAuthReady === 'function' ? isAuthReady : () => true
    this.log = log
    this.onEvent = onEvent
    this.wss = new WebSocketServer({ noServer: true })
    /** @type {Set<OneBotConnection>} */
    this.connections = new Set()
    this.rejectedAuth = 0
    this.rejectedNotReady = 0
    this.rejectedPath = 0
    this.totalAccepted = 0
  }

  /** 判断这条 upgrade 请求是不是我们要接的 */
  matches(req) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      return url.pathname === this.path
    } catch {
      return false
    }
  }

  /**
   * 由 `ctx.webServer.registerUpgrade` 的回调直接调用。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  handleUpgrade(req, socket, head) {
    // 鉴权信息尚未解析完成时必须 fail-closed。
    // 背景：token 可能来自 DSH 凭据，而凭据解析是异步的 —— 若此时按「expected 为空
    // 即不校验」处理，凭据-only 部署的首个连接会被放行，形成 fail-open 窗口。
    // NapCat 每 5 秒重连一次，所以直接拒绝并让它重试是安全且无感的。
    if (!this.isAuthReady()) {
      this.rejectedNotReady += 1
      this.log.warn('[onebot] 拒绝连接：鉴权信息尚未就绪（凭据仍在解析），请稍后重试')
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const hs = readHandshake(req)
    const expected = this.getToken() ?? ''

    if (expected && hs.token !== expected) {
      this.rejectedAuth += 1
      this.log.warn(
        `[onebot] 拒绝连接：token 不匹配（收到 ${hs.token ? `Bearer ${hs.token.slice(0, 4)}…` : '无 token'}）`,
      )
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.totalAccepted += 1
      const conn = new OneBotConnection({
        socket: ws,
        log: this.log,
        selfId: hs.selfId,
        role: hs.role,
      })
      this.connections.add(conn)
      this.log.info(
        `[onebot] NapCat 已连接 selfId=${hs.selfId || '未知'} role=${hs.role} 当前连接数=${this.connections.size}`,
      )

      conn.on('event', (payload) => {
        try {
          this.onEvent(payload, conn)
        } catch (err) {
          this.log.error(`[onebot] 事件处理抛错: ${err?.stack ?? err}`)
        }
      })

      conn.on('close', () => {
        this.connections.delete(conn)
        this.log.info(`[onebot] 连接断开，剩余连接数=${this.connections.size}`)
      })

      conn.markReady()
    })
  }

  /** 取一条可用连接（优先 ready 且最近有事件的） */
  pick() {
    let best = null
    for (const conn of this.connections) {
      if (conn.closed) continue
      if (!best) {
        best = conn
        continue
      }
      if (conn.lastEventAt > best.lastEventAt) best = conn
    }
    return best
  }

  snapshot() {
    return {
      path: this.path,
      authRequired: Boolean(this.getToken()),
      accepted: this.totalAccepted,
      rejectedAuth: this.rejectedAuth,
      rejectedNotReady: this.rejectedNotReady,
      authReady: this.isAuthReady(),
      active: this.connections.size,
      connections: [...this.connections].map((c) => c.snapshot()),
      selfIds: [...new Set([...this.connections].map((c) => c.selfId).filter(Boolean))],
    }
  }

  async closeAll() {
    const all = [...this.connections]
    this.connections.clear()
    for (const conn of all) {
      try {
        conn.close(1001, 'dsh-whale-inurqq shutting down')
      } catch {
        /* 忽略 */
      }
    }
    await new Promise((resolve) => this.wss.close(() => resolve()))
  }
}
