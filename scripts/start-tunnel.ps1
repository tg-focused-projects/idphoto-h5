# 启动 frpc：把本地 8000 映射到 frps 110.40.183.197:8000
#   powershell -ExecutionPolicy Bypass -File scripts\start-tunnel.ps1
#
# token 解析顺序：
#   1) 环境变量 FRP_AUTH_TOKEN
#   2) 本目录 .env 里的 FRP_AUTH_TOKEN=...
#   3) D:\Qwen-Image-Edit-2511\.env（本机原有那份，复用即可）
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Get-FrpToken {
  if ($env:FRP_AUTH_TOKEN) { return $env:FRP_AUTH_TOKEN.Trim() }
  $candidates = @("$root\.env", "D:\Qwen-Image-Edit-2511\.env")
  foreach ($f in $candidates) {
    if (-not (Test-Path $f)) { continue }
    $line = @(Get-Content $f | Where-Object { $_ -match '^FRP_AUTH_TOKEN=' })
    if ($line.Count -gt 0) { return $line[0].Substring('FRP_AUTH_TOKEN='.Length).Trim() }
  }
  return ''
}

$token = Get-FrpToken
if (-not $token) { throw '找不到 FRP_AUTH_TOKEN（环境变量 / h5\.env / D:\Qwen-Image-Edit-2511\.env）' }

$frpc = @(
  "D:\Qwen-Image-Edit-2511\tools\frp\frp_0.70.1_windows_amd64\frpc.exe",
  "C:\DSH\tools\frp\frpc.exe",
  (Get-Command frpc -ErrorAction SilentlyContinue).Source
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $frpc) { throw '找不到 frpc.exe' }

if (Get-Process frpc -ErrorAction SilentlyContinue) {
  Get-Process frpc | ForEach-Object { Stop-Process -Id $_.Id -Force }
  Start-Sleep -Seconds 2
  Write-Host '已停掉旧的 frpc'
}

$env:FRP_AUTH_TOKEN = $token
try {
  & $frpc verify -c "$root\frpc.toml"
  if ($LASTEXITCODE -ne 0) { throw 'frpc.toml 校验失败' }
  Start-Process $frpc -ArgumentList @('-c', "$root\frpc.toml") -WindowStyle Hidden `
    -RedirectStandardOutput "$root\frpc.out.log" -RedirectStandardError "$root\frpc.err.log"
} finally {
  Remove-Item Env:FRP_AUTH_TOKEN -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 4
if (-not (Get-Process frpc -ErrorAction SilentlyContinue)) { throw 'frpc 启动即退出，看 frpc.out.log' }

$base = 'http://110.40.183.197:8000'
Write-Host "公网 base: $base"
Write-Host "健康检查 : $base/api/health （需要 Bearer key）"
