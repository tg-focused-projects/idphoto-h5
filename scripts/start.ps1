# 一键起「生图后端（8000，公网模式）+ frpc 隧道」
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1
#
# 结果：
#   本地 H5   http://127.0.0.1:8000
#   公网 API  http://110.40.183.197:8000
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

Write-Host '[1/2] 启动 idphoto 服务 :8000（公网模式，所有 API 需要 key）'
if (Test-Port 8000) {
  Write-Host '     8000 已在监听，跳过（要重启先 scripts\stop.ps1）'
} else {
  $env:PORT = '8000'
  $env:IDPHOTO_PUBLIC = '1'
  try {
    Start-Process node -ArgumentList 'server.mjs' -WorkingDirectory $root -WindowStyle Hidden `
      -RedirectStandardOutput "$root\server.log" -RedirectStandardError "$root\server.err.log"
  } finally {
    Remove-Item Env:PORT, Env:IDPHOTO_PUBLIC -ErrorAction SilentlyContinue
  }
  if (-not (Wait-Port 8000)) { throw '8000 起不来，看 server.err.log' }
}

Write-Host '[2/2] 启动 frpc 隧道'
& powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\start-tunnel.ps1"

$key = ''
if (Test-Path "$root\api-keys.json") {
  $key = ((Get-Content "$root\api-keys.json" -Raw | ConvertFrom-Json).keys)[0]
}
Write-Host ''
Write-Host "本地 H5   : http://127.0.0.1:8000"
Write-Host "公网 API  : http://110.40.183.197:8000"
Write-Host "API key   : $($key.Substring(0, [Math]::Min(12, $key.Length)))…（完整值在 api-keys.json）"
Write-Host ''
Write-Host "自检: curl -H `"Authorization: Bearer <key>`" http://110.40.183.197:8000/api/health"
