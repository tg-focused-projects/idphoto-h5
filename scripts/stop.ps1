# 停掉 idphoto 服务（8000）与 frpc 隧道
#   powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
$ErrorActionPreference = 'SilentlyContinue'

foreach ($port in 8000, 8088, 8090, 8095) {
  $conn = Get-NetTCPConnection -State Listen -LocalPort $port
  if ($conn) {
    Stop-Process -Id $conn[0].OwningProcess -Force
    Write-Host "已停 :$port (pid $($conn[0].OwningProcess))"
  }
}

Get-Process frpc | ForEach-Object {
  Stop-Process -Id $_.Id -Force
  Write-Host "已停 frpc (pid $($_.Id))"
}

Write-Host '完成。ngrok 未动（它是本机 chatgpt2api 38650 的通道，与本项目无关）。'
