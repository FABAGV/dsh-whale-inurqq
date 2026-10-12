# Watch the 6700 connection and plugin status to confirm stability.
# ASCII-only on purpose: Windows PowerShell 5.1 misreads non-BOM UTF-8 .ps1 files.
param([int]$Seconds = 60)
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  $ts = (Get-Date).ToString('HH:mm:ss')
  $l = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -eq 6700
  $e = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 6700 -or $_.RemotePort -eq 6700 })
  try {
    $j = (Invoke-WebRequest 'http://127.0.0.1:6700/dsh-whale-inurqq/status' -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
    $c = $j.connection.connections[0]
    $status = "accepted=$($j.connection.accepted) rejectedAuth=$($j.connection.rejectedAuth) active=$($j.connection.active) events=$($c.eventCount) calls=$($c.callCount) selfIds=$($j.connection.selfIds -join ',')"
  } catch { $status = "status endpoint FAILED: $($_.Exception.Message)" }
  $listen = if ($l) { "listening(PID $($l.OwningProcess))" } else { "NO LISTENER" }
  Write-Output "$ts | $listen | established=$($e.Count) | $status"
  Start-Sleep -Seconds 5
}
