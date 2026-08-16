param(
  [string]$InstallDirectory = "",
  [int]$TimeoutSeconds = 720
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($InstallDirectory)) {
  $InstallDirectory = Join-Path $projectRoot "tmp\installer-smoke-1.0.0\app"
}

$executable = Join-Path $InstallDirectory "宣传记录助手.exe"
if (-not (Test-Path -LiteralPath $executable)) {
  throw "未找到安装后的程序：$executable"
}

$existingListener = Get-NetTCPConnection -LocalPort 43117 -State Listen -ErrorAction SilentlyContinue
if ($existingListener) {
  throw "端口 43117 已被进程 $($existingListener.OwningProcess) 占用，无法确认测试对象。"
}

$application = Start-Process -FilePath $executable -ArgumentList "--no-open" -WindowStyle Hidden -PassThru
Write-Output "已启动安装后的程序，PID=$($application.Id)"

$health = $null
for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:43117/api/health" -TimeoutSec 2
    break
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
if ($null -eq $health) {
  throw "安装后的程序未能在 20 秒内启动本地服务。"
}
if (-not $health.ok -or -not $health.edgeAvailable) {
  throw "本地服务已启动，但没有找到可用的 Microsoft Edge。"
}
Write-Output "本地服务和 Edge 渲染器已就绪"

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod -Uri "http://127.0.0.1:43117/api/session" -WebSession $session | Out-Null

$outputDirectory = Join-Path $projectRoot "tmp\installer-smoke-1.0.0\pdf-output"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$settingsBody = @{ directory = $outputDirectory } | ConvertTo-Json -Compress
$settings = Invoke-RestMethod -Uri "http://127.0.0.1:43117/api/settings/output-directory" -Method Patch -ContentType "application/json" -Body $settingsBody -WebSession $session

$batchBody = @{
  name = "1.0.0 安装包四站点验收"
  mode = "auto"
  items = @(
    @{ url = "https://news.hubeidaily.net/mobile/c_2072230.html" },
    @{ url = "https://xwcb.hbue.edu.cn/53/c9/c186a349129/page.htm" },
    @{ url = "https://www.ctdsb.net/c1673_202405/2151487.html" },
    @{ url = "https://mp.weixin.qq.com/s/p5A-a2S38tr15vzdnwqLlQ" }
  )
} | ConvertTo-Json -Depth 5 -Compress
$batchResult = Invoke-RestMethod -Uri "http://127.0.0.1:43117/api/batches" -Method Post -ContentType "application/json" -Body $batchBody -WebSession $session
Write-Output "批量任务已提交，接受 $($batchResult.accepted) 个网址"

$batchId = $batchResult.batch.id
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$lastSummary = ""
$tasks = @()
while ((Get-Date) -lt $deadline) {
  $taskResult = Invoke-RestMethod -Uri "http://127.0.0.1:43117/api/tasks" -WebSession $session
  $tasks = @($taskResult.tasks | Where-Object { $_.batchId -eq $batchId })
  $summary = ($tasks | ForEach-Object { "$($_.status):$($_.source ?? $_.url)" }) -join " | "
  if ($summary -ne $lastSummary) {
    Write-Output $summary
    $lastSummary = $summary
  }
  if ($tasks.Count -eq $batchResult.accepted -and @($tasks | Where-Object { $_.status -notin @("completed", "failed", "cancelled") }).Count -eq 0) {
    break
  }
  Start-Sleep -Seconds 2
}

$failed = @($tasks | Where-Object { $_.status -ne "completed" })
$missing = @($tasks | Where-Object { -not $_.outputPath -or -not (Test-Path -LiteralPath $_.outputPath) })
$result = [pscustomobject]@{
  processId = $application.Id
  health = $health
  outputDirectory = $settings.outputDirectory
  batchId = $batchId
  accepted = $batchResult.accepted
  tasks = $tasks
  failedCount = $failed.Count
  missingPdfCount = $missing.Count
}
$result | ConvertTo-Json -Depth 8

if ($failed.Count -gt 0 -or $missing.Count -gt 0) {
  throw "安装包四站点验收未全部通过：失败 $($failed.Count) 个，缺少 PDF $($missing.Count) 个。"
}
