/**
 * 独立测试台 —— 不依赖 DSH，把真实的 OneBotReverseServer + Pipeline 挂到裸 HTTP 服务器上。
 *
 * 用途：在装进 DSH 之前验证连接层、协议层、归一化层、路由决策是否正确。
 * 它模拟的是 DSH `ctx.webServer.registerUpgrade` 提供的那个 upgrade 回调。
 *
 * 用法：
 *   终端 A: node tools/standalone-harness.mjs
 *   终端 B: node tools/mock-napcat.mjs --once
 */
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { createLogger } from '../lib/log.js'
import { resolveConfig } from '../lib/config.js'
import { Pipeline, INTENT } from '../lib/pipeline.js'
import { OneBotReverseServer } from '../lib/onebot/server.js'

const PORT = Number(process.env.HARNESS_PORT ?? 6700)
/** 默认空 = 不校验来源（对着自己的实现跑，不需要凭据）；仓库里不存 token 字面量 */
const TOKEN = process.env.HARNESS_TOKEN ?? ''
const LOG_LEVEL = process.env.HARNESS_LOG ?? 'debug'
/** 项目目录默认落临时目录，不把开发机绝对路径写进仓库 */
const WORKSPACE_ROOT = process.env.HARNESS_ROOT ?? path.join(os.tmpdir(), 'dsh-whale-inurqq-projects')

const config = resolveConfig({
  logLevel: LOG_LEVEL,
  connection: { mode: 'reverse', reversePath: '/', token: TOKEN },
  tasks: { workspaceRoot: WORKSPACE_ROOT },
})
const log = createLogger('harness', LOG_LEVEL)
for (const w of config.warnings) log.warn(w)

const pipeline = new Pipeline({ config, log })

const VERDICT = []
const consume = (decision) => {
  const label =
    decision.intent === INTENT.TASK
      ? `TASK(${decision.reason})  text="${decision.text}"`
      : decision.intent === INTENT.CHAT
        ? `CHAT(${decision.reason})  text="${decision.text}"`
        : decision.intent === INTENT.CONTROL
          ? `CONTROL(${decision.control?.kind}) target=${decision.control?.target}`
          : decision.intent === INTENT.INGEST
            ? `INGEST reason=${decision.reason}`
            : decision.intent
  VERDICT.push(label)
  console.log(`\n  ==> 决策: ${label}\n`)
}

const server = new OneBotReverseServer({
  path: '/',
  getToken: () => TOKEN,
  log,
  onEvent: (payload, conn) => {
    const decision = pipeline.handle(payload, conn)
    if (decision.intent !== INTENT.IGNORE) consume(decision)
    else console.log(`  --> 忽略: ${decision.reason}`)

    // 动作调用路径验证：合并转发必须能展开（这是 v2 语料库的前置能力）
    if (decision.intent === INTENT.INGEST && decision.reason === 'forward-record') {
      const seg = decision.message.segments.find((s) => s.kind === 'forward')
      if (!seg) return
      const t0 = Date.now()
      conn
        .call('get_forward_msg', { id: seg.id })
        .then((data) => {
          const nodes = data?.messages ?? []
          console.log(
            `  >>> get_forward_msg(${seg.id}) 返回 ${nodes.length} 个节点，` +
              `耗时 ${Date.now() - t0}ms；发言人=[${nodes.map((n) => n.data?.nickname ?? '?').join(', ')}]`,
          )
          VERDICT.push(`ACTION get_forward_msg → ${nodes.length} 节点`)
        })
        .catch((err) => {
          console.log(`  >>> get_forward_msg 失败: ${err.message}`)
          VERDICT.push(`ACTION get_forward_msg 失败: ${err.message}`)
        })
      // 顺带验证一个会失败的动作（未实现的动作应结构化报错而不是挂死）
      conn
        .call('get_login_info', {})
        .then((d) => console.log(`  >>> get_login_info → user_id=${d?.user_id} nickname=${d?.nickname}`))
        .catch((err) => console.log(`  >>> get_login_info 失败: ${err.message}`))
    }
  },
})

const httpServer = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ connection: server.snapshot(), pipeline: pipeline.snapshot() }, null, 2))
    return
  }
  res.writeHead(404)
  res.end('not found')
})

// 这就是 DSH 的 registerUpgrade 所做的事：把 upgrade 请求交给路由处理
httpServer.on('upgrade', (req, socket, head) => {
  if (server.matches(req)) {
    server.handleUpgrade(req, socket, head)
    return
  }
  server.rejectedPath += 1
  socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
  socket.destroy()
})

httpServer.listen(PORT, '127.0.0.1', () => {
  log.info(`测试台监听 http://127.0.0.1:${PORT}  （状态：/status）`)
  log.info(`等待 mock-napcat 连接，token=${TOKEN ? `${TOKEN.slice(0, 4)}…` : '(不校验)'}`)
})

process.on('SIGINT', () => {
  console.log('\n\n=========== 决策汇总 ===========')
  VERDICT.forEach((v, i) => console.log(`  ${i + 1}. ${v}`))
  console.log(`共 ${VERDICT.length} 条非忽略决策`)
  process.exit(0)
})
