param([switch]$Plan, [switch]$Remove, [switch]$Restart)
$ErrorActionPreference = 'Stop'
if ($Restart -and ($Plan -or $Remove)) { throw 'Restart cannot be combined with Plan or Remove.' }
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
if ((& $nodePath -p 'process.versions.node') -notmatch '^24\.') { throw 'Runtime maintenance requires Node 24.' }
$hash = [Security.Cryptography.SHA256]::Create()
try { $suffix = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 12) } finally { $hash.Dispose() }
$taskName = 'ProjectTaskMap-Runtime-' + $suffix
$runner = Join-Path $PSScriptRoot 'run-runtime-maintenance.ps1'
$shellPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $runner + '" -NodePath "' + $nodePath + '"'
$description = 'Project Task Map runtime maintenance for ' + $projectRoot
if ($Plan) {
  @{ taskName = $taskName; projectRoot = $projectRoot; execute = $shellPath; arguments = $arguments; runLevel = 'Limited'; credentialsStored = $false; trigger = 'Current-user logon; repeat every minute, ignoring overlapping runs' } | ConvertTo-Json -Compress
  exit 0
}
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and ($existing.Description -ne $description -or $existing.Actions.Count -ne 1 -or $existing.Actions[0].Execute -ne $shellPath -or $existing.Actions[0].Arguments -ne $arguments)) {
  throw 'An unrelated or modified task has this name; refusing to overwrite it.'
}
function Stop-ProjectWatchers {
  # Ending a scheduled PowerShell task can leave its Node child alive. Match
  # the complete launcher command before stopping only this project's watchers.
  $watchScript = Join-Path $PSScriptRoot 'maintain-runtime.mjs'
  $expectedCommand = '"' + $nodePath + '" "' + $watchScript + '" --watch'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.ExecutablePath -eq $nodePath -and $_.CommandLine.Trim() -eq $expectedCommand
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop }
}
if ($Restart) {
  if (!$existing) { throw 'Runtime task is not installed.' }
  Stop-ScheduledTask -TaskName $taskName
  Stop-ProjectWatchers
  Start-ScheduledTask -TaskName $taskName
  @{ restarted = $true; taskName = $taskName; appBackendsPreserved = $true } | ConvertTo-Json -Compress
  exit 0
}
if ($Remove) {
  if ($existing) { Stop-ScheduledTask -TaskName $taskName; Stop-ProjectWatchers; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  @{ removed = $true; taskName = $taskName } | ConvertTo-Json -Compress
  exit 0
}
foreach ($path in @((Join-Path $PSScriptRoot 'maintain-runtime.mjs'), $runner, (Join-Path $projectRoot 'dist/server/server/index.js'))) {
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Required runtime file is missing.' }
}
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $user),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$action = New-ScheduledTaskAction -Execute $shellPath -Argument $arguments -WorkingDirectory $projectRoot
Register-ScheduledTask -TaskName $taskName -Description $description -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
@{ installed = $true; taskName = $taskName; runLevel = 'Limited'; credentialsStored = $false } | ConvertTo-Json -Compress
