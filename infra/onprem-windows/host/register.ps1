# Registers what the host needs around the containers. Run by install.ps1; safe to run again.
#   - the Docker service starts with the machine and is restarted when it stops; the containers restart with it (restart: always);
#   - ONE inbound firewall rule: the HTTPS port of the edge (WEB_HTTPS_PORT). Nothing else of the installation is opened;
#   - the scheduled task "MACHVON daily" (daily.ps1 as SYSTEM, every night at 02:30).
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator

Set-Service docker -StartupType Automatic
& sc.exe failure docker reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null

$port = Get-Setting 'WEB_HTTPS_PORT'
if ($port -notmatch '^\d{2,5}$') { Fail 'WEB_HTTPS_PORT is not set in the environment file' }
$ruleName = 'MACHVON HTTPS'
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Description 'The HTTPS edge of MACHVON (web container). The only port the installation publishes.' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Any | Out-Null
Say "firewall: inbound TCP $port is allowed (rule '$ruleName')"

$taskName = 'MACHVON daily'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'daily.ps1') + '"')
$trigger = New-ScheduledTaskTrigger -Daily -At '02:30'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Say "scheduled task '$taskName' runs daily.ps1 every night at 02:30"
