# 停掉 idphoto 服务 / 路由 / ngrok
#   powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
$ErrorActionPreference = 'SilentlyContinue'

foreach ($port in 8088, 8090) {
  $conn = Get-NetTCPConnection -State Listen -LocalPort $port
  if ($conn) {
    Stop-Process -Id $conn[0].OwningProcess -Force
    Write-Host "已停 :$port (pid $($conn[0].OwningProcess))"
  }
}

Get-Process ngrok | ForEach-Object {
  Stop-Process -Id $_.Id -Force
  Write-Host "已停 ngrok (pid $($_.Id))"
}

Write-Host '完成。注意：停掉 ngrok 会同时断开 38650 的公网入口。'
