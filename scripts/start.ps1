# 一键起「生图后端 + 路由 + 公网隧道」
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1
#
# 依赖：node、ngrok（已登录）、本机 chatgpt2api 在 38650、api-keys.json 存在
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Test-Port($port) {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

function Wait-Port($port, $timeoutSec = 20) {
  for ($i = 0; $i -lt $timeoutSec; $i++) {
    if (Test-Port $port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

Write-Host '[1/3] 启动 idphoto 服务 :8088'
if (Test-Port 8088) {
  Write-Host '     已在运行，跳过'
} else {
  Start-Process node -ArgumentList 'server.mjs' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput "$root\server.log" -RedirectStandardError "$root\server.err.log"
  if (-not (Wait-Port 8088)) { throw '8088 起不来，看 server.err.log' }
}

Write-Host '[2/3] 启动路由 :8090（/idphoto/* → 8088，其余 → 38650）'
if (Test-Port 8090) {
  Write-Host '     已在运行，跳过'
} else {
  Start-Process node -ArgumentList 'router.mjs' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput "$root\router.log" -RedirectStandardError "$root\router.err.log"
  if (-not (Wait-Port 8090)) { throw '8090 起不来，看 router.err.log' }
}

Write-Host '[3/3] 启动 ngrok 隧道 → 8090'
if (Get-Process ngrok -ErrorAction SilentlyContinue) {
  Write-Host '     ngrok 已在运行，跳过（要换目标先 scripts\stop.ps1）'
} else {
  $ng = (Get-Command ngrok -ErrorAction SilentlyContinue).Source
  if (-not $ng) { $ng = 'C:\Users\Administrator\AppData\Local\Microsoft\WindowsApps\ngrok.exe' }
  Start-Process $ng -ArgumentList @('http', '8090', '--log', 'stdout', '--log-format', 'logfmt') `
    -WindowStyle Hidden -RedirectStandardOutput "$root\ngrok.log" -RedirectStandardError "$root\ngrok.err.log"
  Start-Sleep -Seconds 6
}

$tunnels = $null
try { $tunnels = (Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 5).tunnels } catch {}
$public = if ($tunnels) { $tunnels[0].public_url } else { '(ngrok 未就绪，看 ngrok.log)' }

$key = ''
if (Test-Path "$root\api-keys.json") {
  $key = ((Get-Content "$root\api-keys.json" -Raw | ConvertFrom-Json).keys)[0]
}

Write-Host ''
Write-Host "本地 H5      : http://127.0.0.1:8088"
Write-Host "公网 API base: $public/idphoto"
Write-Host "API key      : $($key.Substring(0, [Math]::Min(12, $key.Length)))…（完整值在 api-keys.json）"
Write-Host ''
Write-Host "自检: curl -H `"Authorization: Bearer <key>`" $public/idphoto/api/health"
