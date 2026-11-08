<#
.SYNOPSIS
  注册「每周词库采集」的 Windows 计划任务（默认周日晚 22:00）。

.DESCRIPTION
  为什么不在 GitHub Actions 里跑：那份工作流要求仓库有 .git 与远端，
  而这台机器上的项目目录两者都没有 —— 定时任务看着配好了，其实一次都不会触发。
  本机计划任务不需要仓库，是这条链路上唯一能真正跑起来的东西。

  三条硬约束（都踩过）：
    1. `node` 必须写**绝对路径**：计划任务的 PATH 与你的终端不一样，
       写裸 `node` 在交互式终端能跑、在任务里报 0x2（找不到文件）。
    2. `-MultipleInstances IgnoreNew` + 采集器自带的 `.lock` 双保险：
       上一轮跑超时没结束时，下一轮不许并发写同一个 latest.json。
    3. 日志必须落盘。计划任务的 stdout 没人接收，跑挂了等于什么都没留下。

.PARAMETER DryRun
  只打印将要注册的内容，**不真的注册**。想先看一遍就加这个。

.PARAMETER Unregister
  删除同名任务。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\schedule-weekly.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File tools\schedule-weekly.ps1
  powershell -ExecutionPolicy Bypass -File tools\schedule-weekly.ps1 -Unregister
#>
[CmdletBinding()]
param(
  [string]$TaskName = "ListingStudio-Keywords-Weekly",
  [ValidateSet("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")]
  [string]$Day = "Sunday",
  [string]$Time = "22:00",
  [string]$Node = "",
  [switch]$DryRun,
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot 是 tools\；项目根是它的上一层。
# 用 $PSScriptRoot 而不是 Get-Location：计划任务/右键运行时 cwd 不是项目目录。
$Root = Split-Path -Parent $PSScriptRoot
$Collector = Join-Path $Root "tools\collect-keywords.mjs"
$LogDir = Join-Path $Root "data\keywords\logs"

if (-not (Test-Path $Collector)) {
  Write-Error "找不到采集器：$Collector（脚本不在预期位置？）"
  exit 1
}

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $existing) {
    Write-Host "没有这个任务：$TaskName（不用删）"
    exit 0
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已删除计划任务：$TaskName"
  exit 0
}

# ── 解析 node 的绝对路径 ──────────────────────────────────────────────
if (-not $Node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $Node = $cmd.Source }
}
if (-not $Node -or -not (Test-Path $Node)) {
  Write-Error @"
找不到 node。计划任务里的 PATH 和终端不一样，必须写绝对路径。
请显式指定，例如：
  -Node "C:\Program Files\nodejs\node.exe"
本机 WorkBuddy 自带的 Node 在：
  $env:USERPROFILE\.workbuddy\binaries\node\versions\
"@
  exit 1
}

$nodeVersion = (& $Node -v)
if (-not $nodeVersion) {
  Write-Error "跑 $Node -v 没有输出 —— 这个路径不是可用的 node。"
  exit 1
}
# 采集器用了 ES module + 内置 fetch，低于 20 会直接崩（不是慢，是跑不起来）
$major = 0
if ($nodeVersion -match '^v(\d+)\.') { $major = [int]$Matches[1] }
if ($major -lt 20) {
  Write-Error "Node $nodeVersion 低于 20：采集器用了内置 fetch 与 ES module，跑不起来。"
  exit 1
}

if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# ── 组装任务 ────────────────────────────────────────────────────────
# -WorkingDirectory 必须是项目根：采集器按相对路径找 assets / data。
# -Argument 只传脚本路径（带引号，路径里可能有空格），不要在这里拼重定向 ——
#   Task Scheduler 不会解析 `>>`，写了也只会被当成参数传给 node。
$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"{0}"' -f $Collector) -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $Time
# IgnoreNew：上一轮还在跑就直接跳过这一轮（配合采集器的 .lock，双保险）。
# StartWhenAvailable：机器关机错过时间点，开机后补跑一次 —— 词库晚到总比没有好。
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

$desc = "跨境 Listing 工作台：每周抓取亚马逊搜索建议词与 Best Sellers 榜单 ASIN（产物 data\keywords\latest.json）"

if ($DryRun) {
  Write-Host "（DryRun：以下内容不会真的注册）"
  Write-Host ""
  Write-Host "任务名   : $TaskName"
  Write-Host "触发     : 每周 $Day $Time"
  Write-Host "程序     : $Node  ($nodeVersion)"
  Write-Host "参数     : `"$Collector`""
  Write-Host "工作目录 : $Root"
  Write-Host "日志目录 : $LogDir"
  Write-Host "并发策略 : IgnoreNew（上一轮没跑完就跳过这一轮）"
  Write-Host ""
  Write-Host "等价的 schtasks 命令（仅供核对，不要直接复制到 cmd 里用）："
  Write-Host ('  schtasks /Create /SC WEEKLY /D {0} /ST {1} /TN "{2}" /TR "\"{3}\" \"{4}\"" /F' -f $Day, $Time, $TaskName, $Node, $Collector)
  Write-Host ""
  Write-Host "想先手动跑一次看看："
  Write-Host ('  & "{0}" "{1}"' -f $Node, $Collector)
  exit 0
}

try {
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
    -Settings $Settings -Description $desc -Force | Out-Null
} catch {
  Write-Error @"
注册失败：$($_.Exception.Message)

常见原因：在根目录 `\` 下建任务需要管理员权限。
用管理员 PowerShell 再跑一次这个脚本即可；或者把它放到当前用户的任务路径下：
  -TaskName "\Users\$env:USERNAME\$TaskName"
"@
  exit 1
}

$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "已注册计划任务：$TaskName"
Write-Host "  下次运行：$($info.NextRunTime)"
Write-Host "  日志目录：$LogDir（每次运行生成一个 YYYY-MM-DD.log）"
Write-Host ""
Write-Host "立刻验证一次（不等到周日）："
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host "  Get-ScheduledTaskInfo -TaskName $TaskName   # LastTaskResult = 0 表示成功"
