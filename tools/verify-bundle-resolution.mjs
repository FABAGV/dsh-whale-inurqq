// 验证 dsh-whale-inurqq 作为 DSH bundle 能否被正确解析与加载。
// 关键点：从 profile 的 node_modules 解析（而不是插件自己的 node_modules）。
//
// 用法：
//   node tools/verify-bundle-resolution.mjs
//   node tools/verify-bundle-resolution.mjs --profile web      # 或给个绝对路径
//   DSH_PROFILE=<profile 目录> node tools/verify-bundle-resolution.mjs
// 默认 profile 取 $DSH_HOME/profiles/web（DSH_HOME 默认 ~/.dsh）。
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const profileArg = process.argv.indexOf('--profile')
const PROFILE =
  profileArg >= 0 && process.argv[profileArg + 1]
    ? path.resolve(process.argv[profileArg + 1])
    : (process.env.DSH_PROFILE ?? path.join(DSH_HOME, 'profiles', 'web'))
console.log(`profile = ${PROFILE}`)
const results = []
const check = (name, ok, extra = '') => {
  results.push([name, ok, extra])
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`)
}

console.log('=== 1. 入口文件与 package.json ===')
const pkgPath = path.join(PROFILE, 'node_modules', 'dsh-whale-inurqq', 'package.json')
check('profile/node_modules/dsh-whale-inurqq/package.json 可达', fs.existsSync(pkgPath))
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
check('main 字段存在', Boolean(pkg.main), pkg.main)
const entry = path.join(PROFILE, 'node_modules', 'dsh-whale-inurqq', pkg.main ?? 'lib/index.js')
check('入口文件存在', fs.existsSync(entry), entry)
check('dsh.bundle.patch 已声明', Boolean(pkg.dsh?.bundle?.patch), pkg.dsh?.bundle?.patch)
const patchPath = path.join(PROFILE, 'node_modules', 'dsh-whale-inurqq', pkg.dsh?.bundle?.patch ?? 'cordis.patch.yml')
check('patch 文件存在', fs.existsSync(patchPath))
check('type=module', pkg.type === 'module')

console.log('\n=== 2. 依赖解析（从 profile 视角）===')
// 用 profile 下的解析器解析依赖，模拟 DSH 的加载环境
const { createRequire } = await import('node:module')
const req = createRequire(path.join(PROFILE, 'node_modules', 'dsh-whale-inurqq', 'package.json'))
for (const dep of ['ws', '@deepseek-ai/schemastery']) {
  try {
    const p = req.resolve(dep)
    check(`依赖可解析 ${dep}`, true, p.replace(PROFILE, '<profile>'))
  } catch (err) {
    check(`依赖可解析 ${dep}`, false, err.code ?? err.message)
  }
}

console.log('\n=== 3. 真正 import 插件入口 ===')
let mod
try {
  mod = await import(pathToFileURL(entry).href)
  check('import 成功', true)
  check('有 default.apply', typeof mod.default?.apply === 'function')
  check('导出 Config', Boolean(mod.Config))
  check('导出 name', Boolean(mod.name ?? mod.default?.name), mod.name ?? mod.default?.name)
} catch (err) {
  check('import 成功', false)
  console.log('\n--- import 抛错原文 ---')
  console.log(err?.stack ?? err)
}

console.log('\n=== 4. cordis.patch.yml 语法 ===')
try {
  const yaml = fs.readFileSync(patchPath, 'utf8')
  check('patch 非空', yaml.trim().length > 0)
  check('patch 含 insert 段', /insert:/.test(yaml))
  check('patch 含 id: dsh-whale-inurqq', /id:\s*dsh-whale-inurqq/.test(yaml))
  check('patch 含 name: dsh-whale-inurqq', /name:\s*dsh-whale-inurqq/.test(yaml))
} catch (err) {
  check('读取 patch', false, err.message)
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length) {
  console.log('失败项：')
  for (const [n, , extra] of failed) console.log(`  - ${n} ${extra}`)
  process.exitCode = 1
}
