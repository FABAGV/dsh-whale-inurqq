# 复现 dsh-whale-inurqq 的集成测试：入口集成测试 + mock OneBot 客户端，输出全部落盘。
#
# 用法:
#   powershell -NoProfile -File tools/run-repro.ps1
#   powershell -NoProfile -File tools/run-repro.ps1 -Port 6710
#   powershell -NoProfile -File tools/run-repro.ps1 -Port 6700 -Force   # 强杀占用该端口的进程
#
# 设计取舍（每条都是踩出来的）:
#   1) 端口被占用时**默认只报告并退出，绝不替用户杀进程** —— 6700 正是插件的默认
#      reversePort，无条件强杀会直接把用户正在运行的 bot 停掉。要清理必须显式 -Force。
#   2) 路径全部从脚本位置推导，不写死开发机目录；别人 clone 下来也能直接跑。
#   3) 本脚本只做"起进程 + 落盘 + 打印"，不做断言；断言由 tools/test-entry.mjs 自己打印。
param(
  [int]$Port = 6700,
  [switch]$Force,
  [string]$OutDir = '',
  [string]$NodeExe = 'node'
)

$ErrorActionPreference = 'Continue'

if (-not $OutDir) { $OutDir = Join-Path $env:TEMP 'dsh-whale-inurqq-repro' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Get-ChildItem (Join-Path $OutDir '*.log') -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

$RepoRoot = Split-Path -Parent $PSScriptRoot

# 解析 node 可执行文件（默认交给 PATH，找不到再退回常见安装位置）
$resolved = Get-Command $NodeExe -ErrorAction SilentlyContinue
if ($resolved) {
  $NodeExe = $resolved.Source
} elseif (Test-Path 'C:\Program Files\nodejs\node.exe') {
  $NodeExe = 'C:\Program Files\nodejs\node.exe'
} else {
  Write-Output "找不到 node（PATH 与 C:\Program Files\nodejs\ 都没有）。用 -NodeExe 指定完整路径。"
  exit 2
}

$EntryOut = Join-Path $OutDir 'entry.out.log'
$EntryErr = Join-Path $OutDir 'entry.err.log'
$MockOut = Join-Path $OutDir 'mock.out.log'
$MockErr = Join-Path $OutDir 'mock.err.log'

# ── 端口冲突：默认不杀，只报告 ──────────────────────────────────────────────
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $pids = @($busy | Select-Object -ExpandProperty OwningProcess -Unique)
  $info = foreach ($procId in $pids) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc) { "$($proc.ProcessName) (PID $procId)" } else { "PID $procId" }
  }
  if (-not $Force) {
    Write-Output "端口 $Port 已被占用：$($info -join '、')"
    Write-Output '本脚本不会替你杀进程。三个选择：'
    Write-Output "  1) 换端口：-Port 6710"
    Write-Output "  2) 确认那个进程可以停：-Force（会强制结束上面列出的进程）"
    Write-Output '  3) 自己善后后再跑'
    exit 3
  }
  Write-Output "端口 $Port 被 $($info -join '、') 占用，-Force 已给出 —— 强制结束它们。"
  foreach ($procId in $pids) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
}

# ── 起测试进程与 mock ──────────────────────────────────────────────────────
$env:ENTRY_PORT = "$Port"
$env:ENTRY_ROOT = Join-Path $OutDir 'projects'
$env:DSH_HOME = Join-Path $OutDir 'dshhome'

$entry = Start-Process -FilePath $NodeExe -ArgumentList 'tools/test-entry.mjs' -WorkingDirectory $RepoRoot `
  -RedirectStandardOutput $EntryOut -RedirectStandardError $EntryErr `
  -WindowStyle Hidden -PassThru

# 等插件把端口听上（最多 30 秒），避免与 mock 抢跑
$deadline = (Get-Date).AddSeconds(30)
$listening = $false
while ((Get-Date) -lt $deadline) {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $listening = $true; break }
  Start-Sleep -Milliseconds 400
}
if (-not $listening) {
  Write-Output "⚠️ 等了 30 秒端口 $Port 仍未被监听，测试进程可能没起来。请看 $EntryErr"
}

$mock = Start-Process -FilePath $NodeExe -ArgumentList @('tools/mock-napcat.mjs', '--once', '--url', "ws://127.0.0.1:$Port") `
  -WorkingDirectory $RepoRoot -RedirectStandardOutput $MockOut -RedirectStandardError $MockErr `
  -WindowStyle Hidden -PassThru

$mock.WaitForExit(60000) | Out-Null

# 等断言真正跑完 —— 汇总行形如 "✅ 全部通过：173/173"，进程之后仍会故意存活。
# ⚠️ 不能用固定睡眠：整套断言现在要 ~100 秒，睡 6 秒会把还没出汇总的进程杀掉，
#    结果是"退出码 0 但日志里没有汇总行"，看着像通过、其实什么都没证明。
# ⚠️ marker 必须**连空格一起**匹配：实测日志里是 "✅ 全部通过"，emoji 与"全"之间有一个
#    U+0020。早先只拼 [char]0x2705+0x5168+0x90E8，漏了那个空格，Contains 永远是 False
#    —— 表现就是"日志里明明有汇总行，脚本却说等满超时"。
$markerPass = [char]0x2705 + ' ' + [char]0x5168 + [char]0x90E8   # "✅ 全部"
$markerFail = [string][char]0x274C                                # "❌"
$deadline = (Get-Date).AddSeconds(240)
$done = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Path $EntryOut) {
    $tail = Get-Content $EntryOut -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($tail -and ($tail.Contains($markerPass) -or $tail.Contains($markerFail))) { $done = $true; break }
  }
  Start-Sleep -Seconds 2
}
Start-Sleep -Seconds 2

# 收尾：只杀**我们自己起的**那个 PID，不按端口扫（按端口扫会误伤别人的进程）
if (-not $entry.HasExited) { Stop-Process -Id $entry.Id -Force -ErrorAction SilentlyContinue }
if (-not $mock.HasExited) { Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

Write-Output "=== SUMMARY (port $Port, listening=$listening, done=$done) ==="
if (-not $done) { Write-Output "⚠️ 等满 240 秒也没等到汇总行 —— 断言可能没跑完，下面的日志是断点处的现场。" }

Write-Output '################ ENTRY stdout ################'
Get-Content $EntryOut -Encoding UTF8 -ErrorAction SilentlyContinue
Write-Output '################ ENTRY stderr ################'
Get-Content $EntryErr -Encoding UTF8 -ErrorAction SilentlyContinue
Write-Output '################ MOCK stdout ################'
Get-Content $MockOut -Encoding UTF8 -ErrorAction SilentlyContinue
Write-Output '################ MOCK stderr ################'
Get-Content $MockErr -Encoding UTF8 -ErrorAction SilentlyContinue
Write-Output '################ 日志目录 ################'
Write-Output $OutDir
