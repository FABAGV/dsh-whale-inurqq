// Repair tools/test-entry.mjs so it is syntactically valid again.
//
// Usage:
//   node tools/repair-test-entry.mjs <input-utf8> <output-mjs>
//
// Input is the ANSI-inverse recovered text. The only remaining damage is `\uFFFD?`
// holes where one or two characters were destroyed. Holes inside COMMENTS are
// cosmetic; holes inside STRING LITERALS break the file, and there the missing
// characters are almost always the same three things:
//
//   - the closing quote of a single-quoted string
//   - a Chinese full stop `。`
//   - a newline that was part of the source layout
//
// The repair loop therefore: render a candidate, run `node --check`, read the ONE
// reported error, repair that specific hole, and repeat. Every change is logged.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const HOLE = '\uFFFD'
const [, , inPath, outPath] = process.argv
if (!inPath || !outPath) {
  console.error('usage: node repair-test-entry.mjs <in> <out>')
  process.exit(2)
}

let text = fs.readFileSync(inPath, 'utf8').replace(/\r\n/g, '\n')

/** Replace the n-th hole (0-based) with `ins`. */
function replaceHole(src, n, ins) {
  let count = -1
  let i = 0
  while (true) {
    const j = src.indexOf(HOLE, i)
    if (j < 0) throw new Error(`hole #${n} not found (only ${count + 1} holes)`)
    count += 1
    let end = j + 1
    if (src[end] === '?') end += 1
    if (count === n) return src.slice(0, j) + ins + src.slice(end)
    i = end
  }
}

/** All holes with their character offsets (post-replacement text). */
function holes(src) {
  const out = []
  let i = 0
  while (true) {
    const j = src.indexOf(HOLE, i)
    if (j < 0) break
    let end = j + 1
    if (src[end] === '?') end += 1
    out.push({ start: j, end, index: out.length })
    i = end
  }
  return out
}

function check(p) {
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' })
    return { ok: true, err: '' }
  } catch (e) {
    return { ok: false, err: String(e.stderr ?? e.stdout ?? e.message) }
  }
}

const log = []
let repaired = 0
const MAX = 500

for (let attempt = 0; attempt < MAX; attempt += 1) {
  fs.writeFileSync(outPath, text, 'utf8')
  const { ok, err } = check(outPath)
  if (ok) {
    console.log(`VALID after ${repaired} repairs`)
    break
  }
  const m = /:(\d+)\s*\n/.exec(err)
  if (!m) {
    console.log('cannot locate error in:\n' + err.slice(0, 1500))
    break
  }
  const ln = Number(m[1])
  const arr = text.split('\n')
  const line = arr[ln - 1] ?? ''
  const before = arr.slice(0, ln - 1).join('\n')
  const offset = before.length + (ln > 1 ? 1 : 0)

  // Which hole is on (or nearest before) this line?
  const hs = holes(text)
  const lineEnd = offset + line.length
  const onLine = hs.filter((h) => h.start >= offset - 1 && h.start <= lineEnd + 1)
  const target = onLine.length > 0 ? onLine[onLine.length - 1] : hs.filter((h) => h.start <= lineEnd).pop()
  if (!target) {
    console.log(`no hole near line ${ln}; cannot repair. line=${JSON.stringify(line.slice(0, 160))}`)
    break
  }

  const holeIdx = target.index
  const ctx = text.slice(Math.max(0, target.start - 120), target.end + 120)

  // Heuristic repair for a hole inside a string literal: the string lost its
  // closing quote plus (usually) a Chinese full stop. If the next non-space char
  // after the hole is `}` `,` `)` `]` or a line break, close the string.
  const after = text.slice(target.end)
  const nextNonSpace = after.match(/^\s*(\S)/)?.[1] ?? ''
  let ins
  if (nextNonSpace === '}' || nextNonSpace === ',' || nextNonSpace === ')' || nextNonSpace === ']') {
    ins = "'"
  } else {
    ins = "'"
  }
  log.push({ line: ln, holeIdx, ins, ctx })
  console.log(`repair #${repaired + 1}: line ${ln} hole#${holeIdx} -> ${JSON.stringify(ins)}  ctx=${JSON.stringify(ctx.slice(60, 180))}`)
  text = replaceHole(text, holeIdx, ins)
  repaired += 1
}

fs.writeFileSync(outPath, text, 'utf8')
fs.writeFileSync(outPath + '.repair-log.json', JSON.stringify(log, null, 1), 'utf8')
const final = check(outPath)
console.log('final: ' + (final.ok ? 'VALID' : 'STILL INVALID\n' + final.err.slice(0, 800)))
