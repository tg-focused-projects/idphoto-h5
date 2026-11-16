# 守护脚本：确保「本机 8000 服务 + frpc 隧道」一直在
#   powershell -ExecutionPolicy Bypass -File scripts\watch.ps1
#
# 幂等、静默、不阻塞，适合被计划任务每 5 分钟跑一次：
#   1) 8000 没监听        → 起 server.mjs（公网模式）
#   2) 本地 health 不是 401/200 → 杀掉重启（卡死的情况）
#   3) frpc 进程不在      → 起隧道
#   4) 本地正常但公网不通 → 重启 frpc（隧道假死，进程还在）
#
# 注意：
#   - 本文件必须存成 UTF-8 **with BOM**，否则 PowerShell 5.1 按 ANSI 读，中文串会被截断。
#   - 健康检查用 curl.exe（--noproxy），不用 Invoke-WebRequest：后者会走系统代理，容易卡住。
#   - 起子进程一律用 Start-Process（不等待），不用 & 调用，避免守护任务自己挂住。

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'watch.log'
$node = 'node'
$curl = 'curl.exe'

function Write-Log([string]$msg) {
  $line = '{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

function Test-Port([int]$port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

function Wait-Port([int]$port, [int]$timeoutSec = 20) {
  for ($i = 0; $i -lt $timeoutSec * 2; $i++) {
    if (Test-Port $port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Http-Code([string]$url) {
  $out = & $curl -s --noproxy '*' -o NUL -w '%{http_code}' -m 10 $url 2>$null
  $code = 0
  [int]::TryParse(([string]$out).Trim(), [ref]$code) | Out-Null
  return $code
}

$C2A_KEY = 'C:\Users\Administrator\.dsh\chatgpt2api-native\admin-key'

function Start-Server {
  $env:PORT = '8000'
  $env:IDPHOTO_PUBLIC = '1'
  $env:C2A_KEY_FILE = $C2A_KEY
  Start-Process $node -ArgumentList 'server.mjs' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $root 'server.log') `
    -RedirectStandardError (Join-Path $root 'server.err.log')
  Remove-Item Env:PORT, Env:IDPHOTO_PUBLIC -ErrorAction SilentlyContinue
}

function Start-Tunnel {
  Start-Process 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', (Join-Path $PSScriptRoot 'start-tunnel.ps1')) -WindowStyle Hidden
}

$action = @()

# ---- 1) 本地服务 ----
if (-not (Test-Port 8000)) {
  Start-Server
  if (Wait-Port 8000) { $action += 'started server:8000' } else { $action += 'FAILED start server:8000' }
}

# ---- 2) 本地 health（401 = 公网模式未带 key，也算健康）----
$localCode = Http-Code 'http://127.0.0.1:8000/api/health'
if ($localCode -ne 401 -and $localCode -ne 200) {
  $action += "local health=$localCode -> restart"
  $c = Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  Start-Server
  Wait-Port 8000 15 | Out-Null
  $localCode = Http-Code 'http://127.0.0.1:8000/api/health'
}

# ---- 3) 隧道 ----
if (-not (Get-Process frpc -ErrorAction SilentlyContinue)) {
  Start-Tunnel
  Start-Sleep -Seconds 5
  $action += $(if (Get-Process frpc -ErrorAction SilentlyContinue) { 'started frpc' } else { 'FAILED start frpc' })
}

# ---- 4) 公网体检（本地正常才查，避免误杀）----
if ($localCode -eq 401 -or $localCode -eq 200) {
  $pubCode = Http-Code 'http://110.40.183.197:8000/api/health'
  if ($pubCode -ne 401 -and $pubCode -ne 200) {
    $action += "public health=$pubCode -> restart frpc"
    Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    Start-Tunnel
    Start-Sleep -Seconds 6
    $action += "public health after restart=$(Http-Code 'http://110.40.183.197:8000/api/health')"
  }
}

if ($action.Count -gt 0) { Write-Log ($action -join '; ') }
exit 0
