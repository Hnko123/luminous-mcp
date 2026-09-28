$ErrorActionPreference = 'Stop'

function Test-NodeVersion {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { return $false }
  $version = & $nodeCommand.Source --version
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.') { return $false }
  return [int]$Matches[1] -ge 22
}

if (-not (Test-NodeVersion)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'Node.js 22 or newer is required. Install Node.js LTS, then rerun this script.'
  }
  Write-Host 'Installing Node.js LTS with winget...'
  winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw 'Node.js installation failed.' }
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Test-NodeVersion)) {
    throw 'Node.js 22 or newer was not found after installation. Open a new PowerShell window and rerun this script.'
  }
}
Set-Location $PSScriptRoot
npm.cmd ci
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
