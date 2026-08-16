$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

try {
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  Invoke-RestMethod -Uri "http://127.0.0.1:43117/api/session" -WebSession $session | Out-Null
  Invoke-RestMethod -Uri "http://127.0.0.1:43117/api/shutdown" -Method Post -WebSession $session | Out-Null
} catch {
  Write-Output "本地服务已经停止或无法连接"
}

for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
  if (-not (Get-NetTCPConnection -LocalPort 43117 -State Listen -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 250
}

$workspacePrefix = $projectRoot.TrimEnd("\") + "\"
$installDirectory = [IO.Path]::GetFullPath((Join-Path $projectRoot "tmp\installer-smoke-1.0.0\app"))
if (-not $installDirectory.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "测试安装目录不在工作区内，停止卸载。"
}

$uninstaller = Join-Path $installDirectory "Uninstall 宣传记录助手.exe"
if (-not (Test-Path -LiteralPath $uninstaller)) {
  throw "未找到测试卸载程序：$uninstaller"
}

$process = Start-Process -FilePath $uninstaller -ArgumentList "/S" -WindowStyle Hidden -Wait -PassThru
Start-Sleep -Seconds 2

$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "宣传记录助手.lnk"
$startShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "宣传记录助手.lnk"
[pscustomobject]@{
  uninstallerExitCode = $process.ExitCode
  serviceStopped = -not [bool](Get-NetTCPConnection -LocalPort 43117 -State Listen -ErrorAction SilentlyContinue)
  installedExeRemoved = -not (Test-Path -LiteralPath (Join-Path $installDirectory "宣传记录助手.exe"))
  desktopShortcutRemoved = -not (Test-Path -LiteralPath $desktopShortcut)
  startMenuShortcutRemoved = -not (Test-Path -LiteralPath $startShortcut)
  installDirectoryStillExists = Test-Path -LiteralPath $installDirectory
} | ConvertTo-Json
