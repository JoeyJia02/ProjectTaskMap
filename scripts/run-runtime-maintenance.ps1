param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot 'maintain-runtime.mjs'
if (!(Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Configured Node executable is missing.' }
if (!(Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw 'Runtime maintenance script is missing.' }
$process = Start-Process -FilePath $NodePath -ArgumentList ('"' + $scriptPath + '" --watch') -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru
exit $process.ExitCode
