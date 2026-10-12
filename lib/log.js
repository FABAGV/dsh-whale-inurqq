/**
 * 极简分级日志。前缀统一，便于在 dsh 日志里 grep。
 *
 * 可选地把日志同时镜像到文件：桌面端插件的 stdout 归 Electron 管，
 * 出问题时看不到，所以运行时诊断必须落一份到磁盘。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/** 默认镜像位置：$DSH_HOME/dsh-whale-inurqq/plugin.log */
export function defaultLogFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-whale-inurqq', 'plugin.log')
}

function appendLine(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${line}\n`, 'utf8')
  } catch {
    /* 落盘失败不能影响插件本身 */
  }
}

export function createLogger(namespace = 'dsh-whale-inurqq', minLevel = 'info', file = null) {
  const threshold = LEVELS[minLevel] ?? LEVELS.info
  const emit = (level, args) => {
    if ((LEVELS[level] ?? 99) < threshold) return
    const line = `[${namespace}]`
    if (level === 'error') console.error(line, ...args)
    else if (level === 'warn') console.warn(line, ...args)
    else console.log(line, ...args)
    if (file) {
      const text = args
        .map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : safeJson(a)))
        .join(' ')
      appendLine(file, `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${line} ${text}`)
    }
  }
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    file,
    child: (sub) => createLogger(`${namespace}:${sub}`, minLevel, file),
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
