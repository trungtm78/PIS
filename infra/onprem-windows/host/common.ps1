# Shared by the host scripts of the Windows-container deployment (dot-sourced). Windows PowerShell 5.1, run as an administrator.
# Nothing here prints a secret value.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:MachvonRoot = if ($env:MACHVON_ROOT) { $env:MACHVON_ROOT } else { Join-Path $env:ProgramData 'MACHVON' }
$script:ComposeDir = Join-Path $script:MachvonRoot 'compose'
$script:ComposeFile = Join-Path $script:ComposeDir 'compose.yaml'
$script:EnvFile = Join-Path $script:ComposeDir '.env'
$script:SecretsDir = Join-Path $script:MachvonRoot 'secrets'
$script:BackupDir = Join-Path $script:MachvonRoot 'backups'
# Mounted into the db container at C:\backup: a dump is written here by the container and moved out by the host at once.
$script:BackupSpool = Join-Path $script:MachvonRoot 'backup-spool'
$script:StateDir = Join-Path $script:MachvonRoot 'state'
$script:LogDir = Join-Path $script:MachvonRoot 'logs'
# The well-known identifier of ContainerUser of a process-isolated Windows container.
$script:ContainerUserSid = 'S-1-5-93-2-2'

function Say([string]$Line) { Write-Output ("machvon: " + $Line) }
function Fail([string]$Line) { throw ("machvon: FAILED " + $Line) }

function Assert-Administrator {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'run this script as an administrator' }
}

# A native command that must succeed. Its output is passed through.
function Invoke-Native {
  param([Parameter(Mandatory)][string]$What, [Parameter(Mandatory)][scriptblock]$Command)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { Fail "$What ended with status $LASTEXITCODE" }
}

# A native command whose output and status do not matter (a probe, a clean-up). Sets $LASTEXITCODE.
function Invoke-Quiet([scriptblock]$Command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command 2>&1 | Out-Null } finally { $ErrorActionPreference = $previous }
}

# The output of a native command as text lines, whatever it writes to its error stream. Sets $LASTEXITCODE.
function Get-Native([scriptblock]$Command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command 2>$null | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $previous }
}

function Compose {
  # docker compose with the environment file and the compose file of the installation. Extra arguments follow.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & docker compose --env-file $script:EnvFile -f $script:ComposeFile @args 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $previous }
}

# The directory of the host that holds the uploaded objects: the volume the api service mounts at C:\data\objects. The files are plain files under the Docker
# data directory, which administrators of the host can read and write.
function Get-ObjectsDirectory {
  $api = Compose ps --all --quiet api | Select-Object -First 1
  if (-not $api) { Fail 'the api container does not exist' }
  $mounts = (Get-Native { & docker inspect $api --format '{{json .Mounts}}' }) -join '' | ConvertFrom-Json
  $source = ($mounts | Where-Object { $_.Destination -ieq 'C:\data\objects' } | Select-Object -First 1).Source
  if (-not $source -or -not (Test-Path -LiteralPath $source -PathType Container)) { Fail 'the volume of the uploaded objects was not found' }
  return $source
}

function Assert-Compose([string]$What) { if ($LASTEXITCODE -ne 0) { Fail "$What ended with status $LASTEXITCODE" } }

function Get-Setting([string]$Name) {
  if (-not (Test-Path $script:EnvFile)) { return '' }
  $line = Get-Content $script:EnvFile | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -Last 1
  if ($null -eq $line) { return '' }
  return $line.Substring($Name.Length + 1).Trim()
}

function Set-Setting([string]$Name, [string]$Value) {
  $lines = @(Get-Content $script:EnvFile)
  $found = $false
  $lines = $lines | ForEach-Object { if ($_ -match "^$([regex]::Escape($Name))=") { $found = $true; "$Name=$Value" } else { $_ } }
  if (-not $found) { $lines += "$Name=$Value" }
  Write-TextFile $script:EnvFile (($lines -join "`n") + "`n")
}

# Text as UTF-8 without a byte order mark and with the line ends given (a secret or a configuration file read inside a container).
function Write-TextFile([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function New-RandomHex([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
  return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

function New-RandomBase64([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($buffer)
}

# A directory only administrators and the system may use. With -Containers, ContainerUser may read it (the secret directory of one service);
# with -ContainersModify it may also write there (the spool the database container writes its dumps to).
function Protect-Directory {
  param([Parameter(Mandatory)][string]$Path, [switch]$Containers, [switch]$ContainersModify)
  New-Item -ItemType Directory -Force $Path | Out-Null
  # The access list is written through .NET: the host has no account NAME for the identifier of ContainerUser, which icacls would insist on.
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', $inherit, 'None', 'Allow')))
  }
  if ($Containers -or $ContainersModify) {
    $rights = if ($ContainersModify) { 'Modify' } else { 'ReadAndExecute' }
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($script:ContainerUserSid)), $rights, $inherit, 'None', 'Allow')))
  }
  [IO.Directory]::SetAccessControl($Path, $acl)
}

function Wait-Healthy {
  param([Parameter(Mandatory)][string[]]$Services, [int]$Seconds = 600)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ($true) {
    $pending = @()
    foreach ($service in $Services) {
      $id = (Compose ps --quiet $service | Select-Object -First 1)
      $health = if ($id) { Get-Native { & docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $id } } else { 'absent' }
      if ($health -ne 'healthy') { $pending += "$service=$health" }
    }
    if ($pending.Count -eq 0) { return }
    if ((Get-Date) -gt $deadline) { Fail ("not healthy after $Seconds seconds: " + ($pending -join ' ')) }
    Start-Sleep -Seconds 5
  }
}

function Write-Log([string]$Name, [string]$Line) {
  New-Item -ItemType Directory -Force $script:LogDir | Out-Null
  Add-Content -Path (Join-Path $script:LogDir "$Name.log") -Value ((Get-Date -Format s) + ' ' + $Line)
}
