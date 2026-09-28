$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22 or newer is required.' }
if ([int]((node --version).TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node.js 22 or newer is required.' }
Set-Location $PSScriptRoot
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
node src/index.js setup
if ($LASTEXITCODE -ne 0) { throw 'Device setup failed' }
$launcher = Join-Path $PSScriptRoot 'run-hidden.vbs'
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument ('//B "' + $launcher + '"') -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Luminous Neo Agent' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'Luminous Neo Agent'
Write-Host 'Luminous Neo Agent installed and started.'
