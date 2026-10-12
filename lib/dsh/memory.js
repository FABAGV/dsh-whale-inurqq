/**
 * 记忆碎片：跨会话重生累积的长期记忆。
 *
 * ## 为什么是"碎片"而不是"摘要"
 *
 * 交班时让 LLM 直接写一份摘要，等于把整段历史压成一段不可解释的文本：
 * 无从知道某条信息是哪次进来的、被提到过几次、什么时候可以丢。
 * 碎片是**可累积、可排序、可老化、可追溯**的最小单元：
 *
 *   - 同一条事实被不同代会话独立说出两次 → `refs += 1`，重要性上升（这是"它重要"的证据）
 *   - 被明确钉住（`pinned`）的永远排第一，用户能显式保住一件事
 *   - 长期没被提到的会被老化降级、最终清理（否则记忆池一定被 +0 的垃圾占满）
 *
 * ## 本模块的隐私姿态（与 lib/corpus.js 一致）
 *
 * 碎片是**用户对话的提炼**，属于隐私资产。所以：
 *   - 只落本机 `$DSH_HOME/dsh-whale-inurqq/memory.json`，不向外发送
 *   - `scope` 隔离：`private:20001` 的碎片绝不会出现在 `group:30003` 的会话里
 *   - 可查（`qq_memory` 工具 / `/dsh-whale-inurqq/status`）、可删（`qq_memory { forget: 'all' }`）
 *   - 写之前先把现文件 rename 成 `memory.json.bak`，写坏一份还有上一份
 *
 * ## 纯函数占多数
 *
 * `fnv1a` / `normText` / `shingles` / `jaccard` / `absorb` / `merge` / `aging` /
 * `select` / `render` 都不碰磁盘、不碰 ctx，可以直接单测。
 * 只有 `MemoryStore` 负责落盘与串行锁。
 *
 * 数据形状见设计文档 §3.1；累积规则见 §3.2；选择规则见 §3.3。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 记忆文件版本。结构变更时 +1 并在 #migrate 里补默认值 */
export const MEMORY_VERSION = 1

/** 每个碎片最多留几条 history（防无限膨胀） */
const MAX_HISTORY = 5

/** 重要性上限 */
const MAX_IMPORTANCE = 9

/** kind 的合法取值（与提示词里的说明一一对应） */
export const FRAGMENT_KINDS = ['fact', 'intent', 'constraint', 'preference', 'promise']

/**
 * FNV-1a 32 位哈希。
 *
 * 为什么不用 crypto：① 它只是**判等**用的，不需要抗碰撞强度；
 * ② 必须是**确定性**的（同一份碎片在两次运行里得到同一个 hash），
 * 而 `hash` 会落盘、要能在人读的层面比对；③ 纯函数便于单测。
 *
 * @param {string} text
 * @returns {string} 8 位十六进制
 */
export function fnv1a(text) {
  let h = 0x811c9dc5
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    // h *= 16777619，用移位避免 32 位溢出精度问题
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 归一化：判定"是不是同一条碎片"时忽略大小写、空白与标点。
 *
 * 只用于**判等与相似度**，绝不用于渲染 —— 渲染必须用原文，
 * 否则常驻记忆会变成一堆没有标点的机器文本。
 */
export function normText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、；：？！,.;:?!"'“”‘’()（）\[\]【】《》<>~～—-]/g, '')
}

/**
 * 字符 3-gram 集合。
 *
 * **为什么是 3-gram 而不是编辑距离**：中文没有词边界，"还差参考文献"
 * vs "参考文献还没弄"的编辑距离很大但语义明显重复；3-gram 对这类
 * "换个说法"的重合度敏感得多。短于 3 字的串退化成一个整体 gram。
 */
export function shingles(norm) {
  const s = String(norm ?? '')
  const out = new Set()
  if (s.length <= 3) {
    if (s.length > 0) out.add(s)
    return out
  }
  for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3))
  return out
}

/** Jaccard 相似度：|交集| / |并集|。空集合返回 0 */
export function jaccard(a, b) {
  const A = a instanceof Set ? a : shingles(a)
  const B = b instanceof Set ? b : shingles(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  const [small, large] = A.size <= B.size ? [A, B] : [B, A]
  for (const g of small) if (large.has(g)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** token 估算：ceil(字符数 / 1.6)。中文偏保守（真机约 1.4 字/token） */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 1.6)
}

/** 补齐成 f0001 形状的 id */
export function fragmentId(seq) {
  return `f${String(seq).padStart(4, '0')}`
}

/** 从 f0137 里取回 137；不合法返回 0 */
export function fragmentSeq(id) {
  const m = /^f(\d+)$/.exec(String(id ?? ''))
  return m ? Number(m[1]) : 0
}

/** 把 LLM 给的 tag 收敛成 0/1/2；非法返回 null（调用方据此丢弃该碎片） */
export function normalizeTag(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 2) return null
  return n
}

/** 把 LLM 给的 kind 收敛成合法值，非法归为 fact */
export function normalizeKind(value) {
  const k = String(value ?? '').trim().toLowerCase()
  return FRAGMENT_KINDS.includes(k) ? k : 'fact'
}

/**
 * 累积规则（设计文档 §3.2，确定性、不用 LLM）：
 *
 *   observe(f, tag, gen):
 *     if 已有: f.refs += 1; f.importance = min(9, f.importance + tag)   // +0 就是不变
 *     else:    f.id = nextId(); f.importance = tag; f.refs = 1
 *     f.lastSeenAt = now; f.lastSeenGen = gen
 *
 * 注意 `tags` 里 +0 的语义：**有信息但不动手就无所谓** —— 它照样进库（有可能日后
 * 被重新提到而升级），只是第一次进来时 importance 是 0。
 *
 * @param {object[]} fragments 会被就地修改
 * @param {object} input
 * @param {string} input.text
 * @param {number} input.tag 0|1|2
 * @param {string} [input.kind]
 * @param {number} [input.confidence]
 * @param {string} [input.scope]
 * @param {number} input.gen 当前会话代数
 * @param {number} input.now
 * @param {(offset:number)=>string} input.nextId
 * @param {{mergeJaccard:number, askJaccard:number}} input.thresholds
 * @param {string} [input.mergeWith] LLM 明确指认的等价碎片 id
 * @returns {{action:'new'|'dup'|'merged'|'ask'|'dropped', id:string, fragment?:object, similarity?:number}}
 */
export function observe(fragments, input) {
  const {
    text,
    tag,
    kind,
    confidence,
    scope,
    gen,
    now,
    nextId,
    thresholds,
    mergeWith,
  } = input

  const body = String(text ?? '').trim()
  if (!body) return { action: 'dropped', id: '' }

  const norm = normText(body)
  const hash = fnv1a(norm)
  const grams = shingles(norm)

  // ⚠️ **判重只在同一个 scope 内做**。
  //
  // 跨 QQ 会话的碎片绝不参与判等、相似度或合并 —— 这条既是隐私边界
  // （`private:20001` 的话不该影响 `group:30003` 的记忆），也是正确性要求：
  // 两个群里各有人说了一句一模一样的话，那是**两件事**，不该共用一条记录、
  // 更不该把一边的 refs/importance 累积到另一边去。
  const sameScope = (f) => !scope || f.scope === String(scope)

  // ① 完全相同（哈希判等）
  let hit = fragments.find((f) => sameScope(f) && f.hash === hash)
  let similarity = 1

  if (!hit) {
    // ②③ 相似度：取最像的那一条
    let best = null
    let bestSim = 0
    for (const f of fragments) {
      if (!sameScope(f)) continue
      const sim = jaccard(grams, f.norm)
      if (sim > bestSim) {
        bestSim = sim
        best = f
      }
    }
    if (best && bestSim >= thresholds.mergeJaccard) {
      hit = best
      similarity = bestSim
    } else if (best && bestSim >= thresholds.askJaccard) {
      // ③ 可能重复（同一件事换了个说法）：交给这次交班的同一次 LLM 裁决（mergeWith）。
      //
      // 判据依据（实测，与 README「开发」节的标定数据一致）：中文真实改写的
      // 字符 3-gram Jaccard 只有 0.1—0.4，而"只差一个关键参数"的两条
      // （`不要动 R:\ 下的原始数据` vs `不要动 D:\ ...`）能到 0.50。
      // 也就是说**在这个区间里"高相似"根本不等于"同一条"**，
      // 直接并成一条正是"丢信息"的最坏路径 —— 所以两条都留着。
      //
      // 但也不能当成全新的一条：同一件事的第二种说法，是"又被提到了一次"的
      // 直接证据。所以新记录**继承已有那条的累积证据**：
      //   refs       = 已有那条的 refs + 1        （这是第 N 次被提到）
      //   importance = 已有那条的 importance + tag（重要性照常加法累积）
      // 于是一条事实被反复说起时，无论每次换不换说法，重要性都会涨。
      // LLM 明确给了 `mergeWith` 时以它为准（下面走合并路径，不新增）。
      const target = mergeWith ? fragments.find((f) => sameScope(f) && f.id === String(mergeWith)) : null
      if (target) {
        hit = target
        similarity = jaccard(grams, target.norm)
      } else {
        const created = createFragment({ body, norm, hash, tag, kind, confidence, scope, gen, now, nextId })
        created.refs = Math.max(1, Number(best.refs) || 1) + 1
        created.importance = Math.min(MAX_IMPORTANCE, (Number(best.importance) || 0) + (Number(tag) || 0))
        created.history = pushHistory(created.history, { at: now, gen, delta: 0, by: 'restated', ref: best.id })
        fragments.push(created)
        return { action: 'ask', id: created.id, fragment: created, similarity: bestSim }
      }
    }
  }

  // LLM 明确指定了 mergeWith 时优先按它走（比相似度更权威）
  if (!hit && mergeWith) {
    const target = fragments.find((f) => sameScope(f) && f.id === String(mergeWith))
    if (target) {
      hit = target
      similarity = jaccard(grams, target.norm)
    }
  }

  if (hit) {
    // ── 已有碎片：合并（不新增）────────────────────────────────────
    hit.refs += 1
    hit.importance = Math.min(MAX_IMPORTANCE, hit.importance + tag)
    hit.lastSeenAt = now
    hit.lastSeenGen = gen
    hit.updatedAt = now
    // 信息量更大的那条留在 text 上（改写的说法往往更具体）
    if (body.length > hit.text.length) {
      hit.text = body
      hit.norm = norm
      hit.hash = hash
    }
    if (kind && hit.confidence === 0 && typeof confidence === 'number') hit.confidence = confidence
    hit.history = pushHistory(hit.history, { at: now, gen, delta: tag, by: 'llm', ref: '' })
    return { action: 'dup', id: hit.id, fragment: hit, similarity }
  }

  // ── 新碎片 ──────────────────────────────────────────────────────
  const created = createFragment({ body, norm, hash, tag, kind, confidence, scope, gen, now, nextId })
  fragments.push(created)
  return { action: 'new', id: created.id, fragment: created, similarity: 0 }
}

function createFragment({ body, norm, hash, tag, kind, confidence, scope, gen, now, nextId }) {
  return {
    id: nextId(0),
    scope: String(scope ?? ''),
    text: body,
    norm,
    hash,
    kind: normalizeKind(kind),
    importance: Math.min(MAX_IMPORTANCE, Number(tag) || 0),
    refs: 1,
    confidence: typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    lastSeenGen: gen,
    pinned: false,
    mergedFrom: [],
    history: [{ at: now, gen, delta: Number(tag) || 0, by: 'llm', ref: '' }],
  }
}

function pushHistory(history, entry) {
  const list = Array.isArray(history) ? [...history, entry] : [entry]
  return list.slice(-MAX_HISTORY)
}

/**
 * 合并两个已有碎片（设计文档 §3.2 的 `merge`）。
 *
 *   a.text       = b.text.length > a.text.length ? b.text : a.text
 *   a.importance = min(9, max(a,b) + (|a-b| <= 1 ? 1 : 0))
 *   a.refs      += b.refs
 *   a.kind       = a.importance >= b.importance ? a.kind : b.kind
 *   a.mergedFrom = [...a.mergedFrom, b.id]
 *
 * **为什么要 +1**：同一条事实被两代会话独立说了两次，本身就是"它重要"的证据。
 *
 * @param {object[]} fragments 会被就地修改（b 被移除）
 * @param {string} idA 保留的（id 较小 / importance 较高）
 * @param {string} idB 被并入的
 * @param {number} now
 * @returns {{ok:boolean, kept?:object, reason?:string}}
 */
export function mergeFragments(fragments, idA, idB, now) {
  const a = fragments.find((f) => f.id === String(idA))
  const b = fragments.find((f) => f.id === String(idB))
  if (!a || !b || a === b) return { ok: false, reason: 'fragment-not-found' }

  const importanceBefore = a.importance
  a.text = b.text.length > a.text.length ? b.text : a.text
  a.norm = b.text.length > a.text.length ? b.norm : a.norm
  a.hash = b.text.length > a.text.length ? b.hash : a.hash
  a.importance = Math.min(MAX_IMPORTANCE, Math.max(a.importance, b.importance) + (Math.abs(importanceBefore - b.importance) <= 1 ? 1 : 0))
  a.refs += b.refs
  a.kind = a.importance >= b.importance ? a.kind : b.kind
  a.pinned = Boolean(a.pinned || b.pinned)
  a.mergedFrom = [...(a.mergedFrom ?? []), ...(b.mergedFrom ?? []), b.id]
  a.history = pushHistory(a.history, { at: now, gen: a.lastSeenGen, delta: 0, by: 'merge', ref: b.id })
  a.updatedAt = now
  a.lastSeenAt = Math.max(a.lastSeenAt ?? 0, b.lastSeenAt ?? 0)
  a.lastSeenGen = Math.max(a.lastSeenGen ?? 0, b.lastSeenGen ?? 0)

  const idx = fragments.indexOf(b)
  if (idx >= 0) fragments.splice(idx, 1)
  return { ok: true, kept: a }
}

/**
 * 重要性老化（设计文档 §3.2 的 `aging`）。
 *
 * **为什么必须有**：`+0/+1/+2` 只涨不跌，长期一定被 +0 的碎片占满，
 * 常驻记忆的名额会被垃圾挤掉 —— 这是整个设计里唯一一处会**随时间恶化**的结构。
 *
 *   每满 agingEveryGens 代跑一次：
 *     for f where lastSeenGen <= gen - 5 and not pinned:  importance = max(0, importance - 1)
 *     for f where importance === 0 and refs === 1 and lastSeenGen <= gen - 10:  删除
 *
 * @param {object[]} fragments 会被就地修改
 * @param {number} gen 当前代数
 * @param {{everyGens:number, now:number}} options
 * @returns {{ran:boolean, decayed:number, dropped:number}}
 */
export function aging(fragments, gen, { everyGens = 10, now = Date.now() } = {}) {
  const every = Math.max(1, Number(everyGens) || 10)
  if (gen <= 0 || gen % every !== 0) return { ran: false, decayed: 0, dropped: 0 }

  let decayed = 0
  for (const f of fragments) {
    if (f.pinned) continue
    if ((f.lastSeenGen ?? 0) <= gen - 5 && f.importance > 0) {
      f.importance = Math.max(0, f.importance - 1)
      f.updatedAt = now
      f.history = pushHistory(f.history, { at: now, gen, delta: -1, by: 'aging', ref: '' })
      decayed += 1
    }
  }

  const before = fragments.length
  for (let i = fragments.length - 1; i >= 0; i -= 1) {
    const f = fragments[i]
    if (f.pinned) continue
    if (f.importance === 0 && f.refs === 1 && (f.lastSeenGen ?? 0) <= gen - 10) fragments.splice(i, 1)
  }
  return { ran: true, decayed, dropped: before - fragments.length }
}

/**
 * 常驻记忆的选择规则（设计文档 §3.3）。
 *
 * 排序：`pinned desc → importance desc → refs desc → lastSeenAt desc → id asc`
 *
 * ⚠️ **`id asc` 是必须的，不是保险**：`systemPrompt.context()` 的快照语义是
 * "文本变了才重发"（`dsh-agent-loop/lib/index.js:337` `if (this.retained?.text === snapshot) return`）。
 * 如果排序不稳定，同一份记忆每步渲染出的字符串可能不同
 * → **每一步都往历史里 append 一条新的 user 消息**。
 * `Array.prototype.sort` 在 V8 上是稳定的，但"稳定"只保证**相同输入**的顺序一致；
 * 这里改的是"相同 importance/refs/lastSeenAt 的碎片必须有一个确定的先后"，
 * 所以显式加 `id asc` 兜底 —— 它是全设计里最容易踩、后果最贵的一处。
 *
 * 截断：按 token 预算**贪心**（`break` 而不是 `continue`）。
 * 不装箱的理由：排序已经把最重要的放前面，为了塞一条小的而跳过一条大的，
 * 会让"顺序即优先级"这个可解释性失效。
 *
 * @param {object[]} fragments
 * @param {string} scope
 * @param {number} budgetTokens
 * @returns {{picked:object[], usedTokens:number, total:number}}
 */
export function select(fragments, scope, budgetTokens) {
  const pool = fragments.filter((f) => f.scope === scope)
  pool.sort(compareFragments)

  const picked = []
  let used = 0
  const budget = Math.max(0, Number(budgetTokens) || 0)
  if (budget === 0) return { picked, usedTokens: 0, total: pool.length }

  for (const f of pool) {
    const cost = estimateTokens(f.text)
    if (used + cost > budget) break
    picked.push(f)
    used += cost
  }
  return { picked, usedTokens: used, total: pool.length }
}

/** 定序键：pinned → importance → refs → lastSeenAt → **id asc**（见 select 的注释） */
export function compareFragments(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
  if ((b.importance ?? 0) !== (a.importance ?? 0)) return (b.importance ?? 0) - (a.importance ?? 0)
  if ((b.refs ?? 0) !== (a.refs ?? 0)) return (b.refs ?? 0) - (a.refs ?? 0)
  if ((b.lastSeenAt ?? 0) !== (a.lastSeenAt ?? 0)) return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)
  return String(a.id).localeCompare(String(b.id))
}

/** kind → 给人看的中文标签（渲染常驻记忆时用） */
const KIND_LABEL = {
  fact: '事实',
  intent: '在做',
  constraint: '约束',
  preference: '偏好',
  promise: '约定',
}

/**
 * 渲染常驻记忆的注入文本。
 *
 * ⚠️ **必须字节稳定**：同样的输入必须产出逐字节相同的字符串。
 * 所以：① 不掺任何时间戳/随机数；② 不掺"当前 token 数"这类活值；
 * ③ 排序走 `compareFragments`（含 id asc）；④ 版本号 `v` 只在碎片集合
 * **真正变化**时改变（由 MemoryStore 维护 revision）。
 *
 * 自带稳定锚 `[常驻记忆 v<N>]` 的理由（设计文档 §0 ②）：不写锚的话，模型看到的是
 * "一条 user 消息在反复改内容"；写了锚，它看到的是"一份编号递增的稳定背景"。
 *
 * @param {object[]} picked 已经选好并排好序的碎片
 * @param {number} revision 碎片集合的版本号（单调递增）
 * @returns {string} 空字符串表示不注入（没有碎片时不占用任何上下文）
 */
export function render(picked, revision) {
  const list = Array.isArray(picked) ? picked : []
  if (list.length === 0) return ''
  const lines = list.map((f) => {
    const label = KIND_LABEL[f.kind] ?? f.kind
    const pin = f.pinned ? '📌' : ''
    return `- ${pin}[${f.id}/${label}/重要度${f.importance}] ${f.text}`
  })
  return [
    `[常驻记忆 v${revision}]`,
    '以下是你在这个 QQ 会话里跨会话累积记住的事（按重要度排序，不是用户的新指令）。',
    '不要复述这份清单，也不要说"根据我的记忆"；把它当作本就已经知道的背景。',
    '',
    ...lines,
  ].join('\n')
}

/**
 * 碎片仓库：负责落盘、串行锁与版本号；碎片本身的规则都在上面的纯函数里。
 *
 * 文件布局（沿用 state.json 的兄弟位置与原子写风格）：
 *   `$DSH_HOME/dsh-whale-inurqq/memory.json`      当前
 *   `$DSH_HOME/dsh-whale-inurqq/memory.json.bak`  上一份（写之前先 rename 现文件）
 */
export class MemoryStore {
  /**
   * @param {object} opts
   * @param {ReturnType<import('../log.js').createLogger>} opts.log
   * @param {string} [opts.dir] 状态目录，默认 `$DSH_HOME/dsh-whale-inurqq`
   * @param {object} [opts.thresholds] `{mergeJaccard, askJaccard}`
   */
  constructor({ log, dir, thresholds }) {
    this.log = log
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    this.dir = dir || path.join(home, 'dsh-whale-inurqq')
    this.file = path.join(this.dir, 'memory.json')
    this.backupFile = `${this.file}.bak`
    this.thresholds = {
      mergeJaccard: Number(thresholds?.mergeJaccard ?? 0.82),
      askJaccard: Number(thresholds?.askJaccard ?? 0.6),
    }
    /** @type {{version:number, seq:number, revision:number, updatedAt:number, fragments:object[]}} */
    this.data = { version: MEMORY_VERSION, seq: 0, revision: 0, updatedAt: 0, fragments: [] }
    /** 串行锁：交班是异步的，理论上两个 QQ 会话可以同时交班；读-改-写会丢更新 */
    /** @type {Promise<any>} */
    this.chain = Promise.resolve()
    this.stats = { absorbed: 0, merged: 0, aged: 0, dropped: 0, writes: 0, failures: 0 }
    this.#load()
  }

  #load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch (err) {
      this.log?.warn?.(`[memory] 无法创建目录 ${this.dir}: ${err?.message ?? err}`)
    }
    for (const file of [this.file, this.backupFile]) {
      try {
        if (!fs.existsSync(file)) continue
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!parsed || !Array.isArray(parsed.fragments)) continue
        this.data = {
          version: MEMORY_VERSION,
          seq: Number(parsed.seq ?? 0),
          revision: Number(parsed.revision ?? 0),
          updatedAt: Number(parsed.updatedAt ?? 0),
          fragments: parsed.fragments.filter((f) => f && typeof f === 'object').map(migrateFragment),
        }
        // seq 至少要比现有 id 大：否则新碎片会复用旧 id
        const maxSeq = this.data.fragments.reduce((m, f) => Math.max(m, fragmentSeq(f.id)), 0)
        if (this.data.seq < maxSeq) this.data.seq = maxSeq
        this.log?.info?.(
          `[memory] 已载入 ${this.data.fragments.length} 条碎片 (${path.basename(file)}, revision=${this.data.revision})`,
        )
        return
      } catch (err) {
        this.log?.warn?.(`[memory] 载入 ${path.basename(file)} 失败: ${err?.message ?? err}`)
      }
    }
  }

  /** 串行执行一段读-改-写。所有会改 fragments 的操作都必须经过它 */
  #withLock(fn) {
    const next = this.chain.then(fn, fn)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * 原子落盘：先把现文件 rename 成 .bak，再 tmp + rename 写新文件。
   *
   * 顺序很关键：**先备份再写**。反过来的话（先写 tmp、再覆盖、最后备份）
   * 一旦在中间崩溃，用户丢掉的是"唯一一份"记忆。
   */
  save() {
    try {
      this.data.version = MEMORY_VERSION
      this.data.updatedAt = Date.now()
      if (fs.existsSync(this.file)) {
        try {
          fs.renameSync(this.file, this.backupFile)
        } catch {
          /* 备份失败不阻塞主写入 */
        }
      }
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
      this.stats.writes += 1
      return true
    } catch (err) {
      this.stats.failures += 1
      this.log?.warn?.(`[memory] 落盘失败: ${err?.message ?? err}`)
      return false
    }
  }

  /** 分配下一个碎片 id。同时推进 seq（id 的唯一来源，永不复用） */
  nextId(_offset = 0) {
    this.data.seq += 1
    return fragmentId(this.data.seq)
  }

  /** 某个 scope 的全部碎片（引用，调用方不要改） */
  forScope(scope) {
    return this.data.fragments.filter((f) => f.scope === String(scope ?? ''))
  }

  /** 全部碎片（引用） */
  all() {
    return this.data.fragments
  }

  /** 碎片集合的版本号：只有真正增删碎片时才变（渲染稳定锚用它） */
  get revision() {
    return this.data.revision
  }

  /**
   * 把一次交班抽出的碎片吸收进仓库。
   *
   * 这是**唯一**的入口：去重、相似度裁决、累积、合并、老化都在这里，
   * 且整个过程在一把锁里 —— 两个 QQ 会话同时交班也不会丢更新。
   *
   * @param {object} input
   * @param {string} input.scope `chatType:chatId`
   * @param {number} input.gen 本次交班后的代数
   * @param {Array<{text:string, tag:number, kind?:string, confidence?:number, mergeWith?:string|null}>} input.fragments
   * @param {string[]} [input.drop] 模型主动要求降级的碎片 id
   * @param {number} [input.agingEveryGens]
   * @param {number} [input.maxFragments] 本 scope 的碎片数量上限（防止只增不减）
   * @returns {Promise<{added:number, dup:number, merged:number, asked:number, dropped:number, bad:number, decayed:number, agedOut:number, evicted:number, revision:number, ids:string[]}>}
   */
  absorb({ scope, gen, fragments, drop = [], agingEveryGens = 10, maxFragments = 500 }) {
    return this.#withLock(() => {
      const now = Date.now()
      const pool = this.data.fragments
      const result = {
        added: 0,
        dup: 0,
        merged: 0,
        asked: 0,
        dropped: 0,
        bad: 0,
        decayed: 0,
        agedOut: 0,
        evicted: 0,
        revision: this.data.revision,
        ids: [],
      }

      const incoming = Array.isArray(fragments) ? fragments : []
      for (const raw of incoming) {
        // ① tag 必填且合法 —— 缺字段整条丢弃（设计文档 §3.2 明说）
        const tag = normalizeTag(raw?.tag)
        if (tag === null || !String(raw?.text ?? '').trim()) {
          result.bad += 1
          continue
        }
        // 判重（哈希相等 / 相似度 / 可能重复）全部由 observe 在本 scope 内完成 ——
        // 跨 QQ 会话的碎片绝不参与判重（隐私边界），这条在 observe 里强制的。
        const out = observe(pool, {
          text: raw.text,
          tag,
          kind: raw.kind,
          confidence: raw.confidence,
          scope,
          gen,
          now,
          nextId: (o) => this.nextId(o),
          thresholds: this.thresholds,
          mergeWith: raw.mergeWith ?? undefined,
        })
        if (out.action === 'new') {
          result.added += 1
          result.ids.push(out.id)
          this.stats.absorbed += 1
        } else if (out.action === 'dup') {
          result.dup += 1
          result.ids.push(out.id)
        } else if (out.action === 'ask') {
          result.asked += 1
          result.ids.push(out.id)
          this.stats.absorbed += 1
        } else {
          result.dropped += 1
        }
      }

      // ② 模型主动要求降级的（`drop` 是老化的人工通道，实现为 importance -= 1，**不是删除**）
      for (const id of Array.isArray(drop) ? drop : []) {
        const f = pool.find((x) => x.id === String(id))
        if (!f) continue
        f.importance = Math.max(0, f.importance - 1)
        f.updatedAt = now
        f.history = pushHistory(f.history, { at: now, gen, delta: -1, by: 'llm-drop', ref: '' })
        result.dropped += 1
      }

      // ③ 已存在碎片的合并裁决（LLM 输出 mergeWith 指向另一条时）
      for (const raw of incoming) {
        const target = raw?.mergeWith
        if (!target || !String(raw?.text ?? '').trim()) continue
        const source = pool.find((f) => f.hash === fnv1a(normText(String(raw.text))) && f.scope === scope)
        if (!source || source.id === String(target)) continue
        const other = pool.find((f) => f.id === String(target) && f.scope === scope)
        if (!other) continue
        // 保留 id 较小 / 重要度较高的那条
        const [keep, dropIt] =
          compareFragments(source, other) <= 0 ? [source, other] : [other, source]
        const merged = mergeFragments(pool, keep.id, dropIt.id, now)
        if (merged.ok) {
          result.merged += 1
          this.stats.merged += 1
        }
      }

      // ④ 老化（只涨不跌的记忆池最后一定被 +0 的垃圾占满）
      const ageResult = aging(pool, gen, { everyGens: agingEveryGens, now })
      result.decayed = ageResult.decayed
      result.agedOut = ageResult.dropped
      this.stats.aged += ageResult.decayed
      this.stats.dropped += ageResult.dropped

      // ⑤ 数量上限：老化只管"长期没被提到"的，管不了"每代都新增好几条 +1"。
      //    超出上限时淘汰**本 scope 里最不重要、最久没被提到**的非 pinned 碎片。
      //    pinned 一律保住：宁可略超上限，也不丢用户显式钉住的事。
      const cap = Math.max(1, Number(maxFragments) || 500)
      const countScoped = () => pool.reduce((n, f) => n + (f.scope === scope ? 1 : 0), 0)
      if (countScoped() > cap) {
        const victims = pool
          .filter((f) => f.scope === scope && !f.pinned)
          .sort((a, b) => compareFragments(b, a)) // 反序：最差的排在前面
        for (const v of victims) {
          if (countScoped() <= cap) break
          const idx = pool.indexOf(v)
          if (idx < 0) continue
          pool.splice(idx, 1)
          result.evicted += 1
        }
        this.stats.dropped += result.evicted
      }

      // ⑥ revision 只在碎片集合**真正变化**时 +1（渲染稳定锚依赖它）
      if (result.added > 0 || result.merged > 0 || ageResult.dropped > 0 || result.evicted > 0) {
        this.data.revision += 1
      }
      result.revision = this.data.revision

      this.save()
      return result
    })
  }

  /**
   * 显式增删改（用户入口，见 qq_memory 工具）。
   *
   * 刻意与 `absorb` 分开：`absorb` 是交班路径（信任 LLM 的输出形状），
   * 这里是用户路径（必须严格校验 id 与动作），混在一起会让两者都难读。
   */
  mutate({ scope, action, id, text, importance, pinned, gen }) {
    return this.#withLock(() => {
      const now = Date.now()
      const pool = this.data.fragments
      const scoped = (f) => f.scope === String(scope ?? '')

      if (action === 'pin' || action === 'unpin') {
        const f = pool.find((x) => x.id === String(id) && scoped(x))
        if (!f) return { ok: false, reason: `碎片 ${id} 不存在或不属于本会话` }
        f.pinned = action === 'pin'
        f.updatedAt = now
        f.history = pushHistory(f.history, { at: now, gen: f.lastSeenGen, delta: 0, by: action, ref: '' })
        this.data.revision += 1
        this.save()
        return { ok: true, fragment: f }
      }

      if (action === 'forget') {
        const f = pool.find((x) => x.id === String(id) && scoped(x))
        if (!f) return { ok: false, reason: `碎片 ${id} 不存在或不属于本会话` }
        pool.splice(pool.indexOf(f), 1)
        this.data.revision += 1
        this.save()
        return { ok: true, removed: 1, id: f.id, text: f.text }
      }

      if (action === 'forget-all') {
        const before = pool.length
        const kept = pool.filter((f) => !scoped(f))
        this.data.fragments = kept
        const removed = before - kept.length
        if (removed > 0) this.data.revision += 1
        this.save()
        return { ok: true, removed }
      }

      if (action === 'add') {
        const body = String(text ?? '').trim()
        if (!body) return { ok: false, reason: 'add 需要 text' }
        const out = observe(this.data.fragments, {
          text: body,
          tag: normalizeTag(importance) ?? 1,
          kind: 'fact',
          confidence: 1,
          scope,
          // 手动记住的碎片标成"当前代"，而不是 0：否则它会被立刻判成
          // "很多代没被提到"而在第一次老化时就被降级。用户显式让它记的，
          // 至少应该享受和交班碎片一样的 5 代宽限期。
          gen: Number.isInteger(gen) && gen >= 0 ? gen : 0,
          now,
          nextId: (o) => this.nextId(o),
          thresholds: this.thresholds,
        })
        this.data.revision += 1
        this.save()
        return { ok: true, action: out.action, id: out.id }
      }

      return { ok: false, reason: `未知动作 ${action}` }
    })
  }

  /** 供状态端点/工具用的快照 */
  snapshot(scope) {
    const pool = scope === undefined ? this.data.fragments : this.forScope(scope)
    return {
      file: this.file,
      backupFile: this.backupFile,
      dir: this.dir,
      count: this.data.fragments.length,
      scopeCount: pool.length,
      revision: this.data.revision,
      seq: this.data.seq,
      updatedAt: this.data.updatedAt,
      stats: { ...this.stats },
      // 状态端点要能回答"你到底记住了什么"：给出本 scope（或全部）按重要度排序的前 50 条
      fragments: [...pool].sort(compareFragments).slice(0, 50).map((f) => ({
        id: f.id,
        scope: f.scope,
        text: f.text,
        kind: f.kind,
        importance: f.importance,
        refs: f.refs,
        pinned: Boolean(f.pinned),
        lastSeenAt: f.lastSeenAt,
        lastSeenGen: f.lastSeenGen,
        mergedFrom: f.mergedFrom ?? [],
      })),
    }
  }
}

/** 补齐老版本缺的字段（结构变更时在这里加，不要在上面的读取逻辑里到处判 undefined） */
function migrateFragment(f) {
  return {
    id: String(f.id ?? ''),
    scope: String(f.scope ?? ''),
    text: String(f.text ?? ''),
    norm: typeof f.norm === 'string' ? f.norm : normText(f.text),
    hash: typeof f.hash === 'string' && f.hash ? f.hash : fnv1a(normText(f.text)),
    kind: normalizeKind(f.kind),
    importance: Math.min(MAX_IMPORTANCE, Math.max(0, Number(f.importance) || 0)),
    refs: Math.max(1, Number(f.refs) || 1),
    confidence: Number(f.confidence) || 0,
    createdAt: Number(f.createdAt) || 0,
    updatedAt: Number(f.updatedAt) || 0,
    lastSeenAt: Number(f.lastSeenAt) || 0,
    lastSeenGen: Number(f.lastSeenGen) || 0,
    pinned: Boolean(f.pinned),
    mergedFrom: Array.isArray(f.mergedFrom) ? f.mergedFrom : [],
    history: Array.isArray(f.history) ? f.history.slice(-MAX_HISTORY) : [],
  }
}
