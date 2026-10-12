# 跑一趟集成测试，并用参数控制 ENTRY_CONV（0 = 关常驻会话，1 = 开）。
#
# 用法:
#   powershell -NoProfile -File tools/run-conv-test.ps1 -Port 6704 -Tag run1
#   powershell -NoProfile -File tools/run-conv-test.ps1 -Port 6704 -Tag run1 -Disabled   # ENTRY_CONV=0
#   pwsh -NoProfile -File tools/run-conv-test.ps1 -Port 6704 -Tag run1 -Force            # 强杀占用端口的进程
#
# 为什么需要它:
#   1) 测试进程断言跑完后**故意不退**（还要留着检查状态端点），所以每趟必须换新端口，
#      否则新的一趟绑不上端口、重试 20 次后 mock 永远连不上 —— 变成假红。
#   2) mock 必须在受控阶段开始前就连上，两个进程要错开启动。
#   3) 输出落盘再读；PowerShell 管道提前停止消费会杀掉子进程。
#
# 路径不写死开发机目录：从脚本位置推导仓库根，证据目录默认落系统临时目录。
param(
  [int]$Port = 6704,
  [string]$Tag = 'run',
  [switch]$Disabled,
  [switch]$Force,
  [string]$OutDir = '',
  [string]$NodeExe = 'node'
)

$ErrorActionPreference = 'Continue'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $env:TEMP 'dsh-whale-inurqq-conv' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$resolved = Get-Command $NodeExe -ErrorAction SilentlyContinue
if ($resolved) {
  $NodeExe = $resolved.Source
} elseif (Test-Path 'C:\Program Files\nodejs\node.exe') {
  $NodeExe = 'C:\Program Files\nodejs\node.exe'
} else {
  Write-Output '找不到 node（PATH 与 C:\Program Files\nodejs\ 都没有）。用 -NodeExe 指定完整路径。'
  exit 2
}

# 端口冲突：默认只报告，不替用户杀进程
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $pids = @($busy | Select-Object -ExpandProperty OwningProcess -Unique)
  $info = foreach ($procId in $pids) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc) { "$($proc.ProcessName) (PID $procId)" } else { "PID $procId" }
  }
  if (-not $Force) {
    Write-Output "端口 $Port 已被占用：$($info -join '、')"
    Write-Output '换一个端口（-Port）或确认可停后加 -Force。本脚本不会默认替你杀进程。'
    exit 3
  }
  Write-Output "端口 $Port 被 $($info -join '、') 占用，-Force 已给出 —— 强制结束它们。"
  foreach ($procId in $pids) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
}

# 参数注入防护：这两个值会被拼进子进程环境与参数字符串
$Tag = $Tag.Replace("'", "''")
if ($Port -lt 1 -or $Port -gt 65535) { Write-Output "端口非法：$Port"; exit 2 }

$out = Join-Path $OutDir "$Tag.txt"
$err = Join-Path $OutDir "$Tag.err.txt"
$mockOut = Join-Path $OutDir "mock-$Tag.txt"

# 子进程的环境变量：Start-Process 会继承父进程环境，所以先设好、起完立刻还原。
# ⚠️ 不要用 -Environment 参数 —— 那是 PowerShell 7+ 才有的，Windows PowerShell 5.1
#    会直接报 "找不到与参数名称 Environment 匹配的参数"，测试进程根本起不来
#    （表现是"端口 30 秒没被监听 + 输出文件压根不存在"）。
$env:ENTRY_PORT = "$Port"
$env:ENTRY_ROOT = Join-Path $OutDir "projects-$Tag"
$env:DSH_HOME = Join-Path $OutDir "dshhome-$Tag"
$env:ENTRY_CONV = $(if ($Disabled) { '0' } else { '1' })

$entry = Start-Process -FilePath $NodeExe -ArgumentList 'tools/test-entry.mjs' `
  -WorkingDirectory $RepoRoot -NoNewWindow -PassThru `
  -RedirectStandardOutput $out -RedirectStandardError $err

# 立刻还原，别把测试用的环境留在当前会话里
foreach ($name in @('ENTRY_PORT', 'ENTRY_ROOT', 'DSH_HOME', 'ENTRY_CONV')) {
  Remove-Item "env:$name" -ErrorAction SilentlyContinue
}

# 等端口听上再起 mock（最多 30 秒）
$deadline = (Get-Date).AddSeconds(30)
$listening = $false
while ((Get-Date) -lt $deadline) {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $listening = $true; break }
  Start-Sleep -Milliseconds 400
}
if (-not $listening) { Write-Output "⚠️ 等了 30 秒端口 $Port 仍未被监听；mock 可能连不上。" }

& $NodeExe tools/mock-napcat.mjs --once --url "ws://127.0.0.1:$Port" *> $mockOut

# 等断言跑完：汇总行由测试自己打印；进程之后仍会故意存活。
# ⚠️ marker 必须连空格一起匹配："✅ 全部通过" 里 emoji 与"全"之间有一个 U+0020，
#    漏掉它 Contains 永远是 False（日志里有汇总行、脚本却报超时）。
$markerPass = [char]0x2705 + ' ' + [char]0x5168 + [char]0x90E8   # "✅ 全部"
$markerFail = [string][char]0x274C                                # "❌"
$deadline = (Get-Date).AddSeconds(220)
$done = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Path $out) {
    $tail = Get-Content $out -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($tail -and ($tail.Contains($markerPass) -or $tail.Contains($markerFail))) { $done = $true; break }
  }
  Start-Sleep -Seconds 2
}

Start-Sleep -Seconds 3
# ✅ 只杀**我们自己起的** PID。原版会按端口扫 Listen 的进程并强杀，
#    在共用机器上会误伤别人的服务 —— 已改成只处理 $entry。
#    （mock 是同步调用（& $NodeExe ...），跑完就已经退出了，不需要也没有对应的进程对象 ——
#      早先这里写 $mock.HasExited 会抛 "Cannot bind argument to parameter 'Id'"，已删。）
if (-not $entry.HasExited) { Stop-Process -Id $entry.Id -Force -ErrorAction SilentlyContinue }

Write-Output "=== SUMMARY ($Tag, port $Port, listening=$listening, done=$done) ==="
$lines = Get-Content $out -Encoding UTF8 -ErrorAction SilentlyContinue
if ($lines) {
  $lines | Where-Object { $_ -match 'FAIL' } | ForEach-Object { $_ }
  $lines | Where-Object { $_ -match '^\s+\d+/\d+ ' } | ForEach-Object { $_ }
  $lines | Select-Object -Last 6
} else {
  Write-Output "（没读到 $out）"
}
