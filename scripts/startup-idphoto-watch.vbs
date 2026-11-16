' 随登录自启：隐藏窗口拉起 idphoto-h5 守护进程（node watchdog.mjs）
' 放在 %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup 下即可
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\DSH\rev\idphoto\h5"
sh.Run """C:\Program Files\nodejs\node.exe"" ""C:\DSH\rev\idphoto\h5\tools\watchdog.mjs""", 0, False
