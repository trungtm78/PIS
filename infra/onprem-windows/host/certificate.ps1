# The TLS certificate of the web edge (secrets\web\tls_cert and tls_key, read by nginx in the web container).
#
#   certificate.ps1 -Mode acme -HostName name.example.vn -WebRoot C:\path\to\webroot [-Staging]
#       A certificate of Let's Encrypt through the HTTP-01 challenge. Port 80 of this host belongs to ANOTHER web server (not to this installation): the challenge file
#       is written below <WebRoot>\.well-known\acme-challenge of that server and removed afterwards; its configuration is not touched. Inbound port 80 is opened in the
#       Windows firewall by a rule of its own for the minutes of the request only, and closed again whatever happens.
#   certificate.ps1 -Mode renew
#       The same request again, only when the certificate in use ends within 30 days (host\daily.ps1 calls this every day).
#   certificate.ps1 -Mode private -HostName name.example.vn
#       A certificate of a private authority made on this host (browsers and the mobile application do NOT trust it until the authority certificate,
#       state\private-ca.crt, is installed on the device). The fallback where Let's Encrypt cannot reach port 80.
#
# After a new certificate is in place nginx is told to read it (when the web container runs), and the scheduled task MACHVON_CERT_RELOAD_TASK of the
# environment file (another web server that serves the same name with these files) is started again. No key leaves the host; nothing secret is printed.
param(
  [Parameter(Mandatory)][ValidateSet('acme', 'renew', 'private')][string]$Mode,
  [string]$HostName = '',
  [string]$WebRoot = '',
  [switch]$Staging,
  [switch]$Force
)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator

$webSecrets = Join-Path $script:SecretsDir 'web'
$acmeDir = Join-Path $script:MachvonRoot 'acme'
$acmeState = Join-Path $script:StateDir 'acme.json'
$ruleName = 'MACHVON ACME HTTP-01 (temporary)'
New-Item -ItemType Directory -Force $script:StateDir | Out-Null

function ConvertTo-Pem([string]$Label, [byte[]]$Bytes) {
  return "-----BEGIN $Label-----`n" + [Convert]::ToBase64String($Bytes, 'InsertLineBreaks').Replace("`r`n", "`n") + "`n-----END $Label-----`n"
}

function Get-CurrentCertificate {
  $path = Join-Path $webSecrets 'tls_cert'
  if (-not (Test-Path $path)) { return $null }
  $match = [regex]::Match((Get-Content $path -Raw), '-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----')
  if (-not $match.Success) { return $null }
  return New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (, [Convert]::FromBase64String(($match.Groups[1].Value -replace '\s', '')))
}

function Install-Certificate([string]$CertificatePem, [string]$KeyPem) {
  Protect-Directory $webSecrets -Containers
  Write-TextFile (Join-Path $webSecrets 'tls_cert.new') $CertificatePem
  Write-TextFile (Join-Path $webSecrets 'tls_key.new') $KeyPem
  Move-Item -Force (Join-Path $webSecrets 'tls_cert.new') (Join-Path $webSecrets 'tls_cert')
  Move-Item -Force (Join-Path $webSecrets 'tls_key.new') (Join-Path $webSecrets 'tls_key')
  $certificate = Get-CurrentCertificate
  Say ("certificate in place: subject " + $certificate.Subject + ", issuer " + $certificate.Issuer + ", ends " + $certificate.NotAfter.ToString('yyyy-MM-dd'))
  if (Test-Path $script:EnvFile) {
    $web = Compose ps --quiet web | Select-Object -First 1
    if ($web) {
      Invoke-Quiet { & docker exec $web 'C:\nginx\nginx.exe' -p 'C:\nginx' -s reload }
      if ($LASTEXITCODE -eq 0) { Say 'nginx reads the new certificate' } else { Say 'nginx was not reloaded: restart the web service (docker compose restart web)' }
    }
    # Another web server of this host that serves the same name with these files (a redirect of port 443 to this installation, for example) reads a
    # certificate only when it starts: MACHVON_CERT_RELOAD_TASK names the scheduled task that runs it, and the task is started again. Unset: nothing else is touched.
    $reloadTask = Get-Setting 'MACHVON_CERT_RELOAD_TASK'
    if ($reloadTask -ne '') {
      if (Get-ScheduledTask -TaskName $reloadTask -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $reloadTask
        Start-Sleep -Seconds 2
        Start-ScheduledTask -TaskName $reloadTask
        Say "the scheduled task '$reloadTask' was started again, so that its web server reads the new certificate"
      } else {
        Say "MACHVON_CERT_RELOAD_TASK names '$reloadTask', but there is no such scheduled task: start that web server again by hand"
      }
    }
  }
}

function New-PrivateCertificate {
  if ($HostName -eq '') { Fail '-HostName is required' }
  $store = 'Cert:\LocalMachine\My'
  $authoritySubject = "CN=MACHVON private authority ($HostName)"
  $authority = Get-ChildItem $store | Where-Object { $_.Subject -eq $authoritySubject -and $_.NotAfter -gt (Get-Date).AddDays(400) } | Select-Object -First 1
  if ($null -eq $authority) {
    # The key of the authority stays in the machine store and cannot be exported.
    $authority = New-SelfSignedCertificate -Type Custom -Subject $authoritySubject -KeyAlgorithm ECDSA_nistP256 -KeyExportPolicy NonExportable -KeyUsage CertSign, CRLSign -KeyUsageProperty Sign `
      -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0') -CertStoreLocation $store -NotAfter (Get-Date).AddYears(10)
  }
  $leaf = New-SelfSignedCertificate -Type Custom -Subject "CN=$HostName" -DnsName $HostName -Signer $authority -KeyAlgorithm ECDSA_nistP256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1') -CertStoreLocation $store -NotAfter (Get-Date).AddDays(397)
  try {
    $key = [Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($leaf)
    $keyPem = ConvertTo-Pem 'PRIVATE KEY' ($key.Key.Export([Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob))
    $authorityPem = ConvertTo-Pem 'CERTIFICATE' $authority.RawData
    Install-Certificate ((ConvertTo-Pem 'CERTIFICATE' $leaf.RawData) + $authorityPem) $keyPem
    Write-TextFile (Join-Path $script:StateDir 'private-ca.crt') $authorityPem
    Say ("the authority certificate to install on devices: " + (Join-Path $script:StateDir 'private-ca.crt'))
  } finally {
    # The key of the server certificate lives in the secret file only.
    Remove-Item ("$store\" + $leaf.Thumbprint) -DeleteKey -ErrorAction SilentlyContinue
  }
}

function Get-WinAcme {
  $exe = Join-Path $acmeDir 'wacs\wacs.exe'
  if (Test-Path $exe) { return $exe }
  $pins = Get-Content (Join-Path $PSScriptRoot '..\images.json') -Raw | ConvertFrom-Json
  $artifact = $pins.artifacts.WIN_ACME
  Protect-Directory $acmeDir
  $zip = Join-Path $acmeDir 'wacs.zip'
  Invoke-Native 'the download of win-acme' { & curl.exe -fsSL --retry 3 -o $zip $artifact.url }
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $artifact.sha256) { Remove-Item $zip; Fail 'the win-acme archive does not have the pinned SHA-256' }
  Expand-Archive $zip (Join-Path $acmeDir 'wacs') -Force
  Remove-Item $zip
  return $exe
}

function Request-AcmeCertificate([string]$Name, [string]$Root, [bool]$UseStaging) {
  if ($Name -eq '' -or $Root -eq '') { Fail '-HostName and -WebRoot are required' }
  if (-not (Test-Path $Root)) { Fail "the web root $Root does not exist" }
  $exe = Get-WinAcme
  $pemDir = Join-Path $acmeDir $(if ($UseStaging) { 'pem-staging' } else { 'pem' })
  Protect-Directory $pemDir
  $arguments = @('--accepttos', '--source', 'manual', '--host', $Name, '--validation', 'filesystem', '--webroot', $Root, '--store', 'pemfiles', '--pemfilespath', $pemDir, '--notaskscheduler', '--force', '--verbose')
  # The authority is named: the default of win-acme is another one (ZeroSSL), which wants an account with an e-mail address.
  $arguments += @('--baseuri', $(if ($UseStaging) { 'https://acme-staging-v02.api.letsencrypt.org/directory' } else { 'https://acme-v02.api.letsencrypt.org/directory' }))
  $challengeDir = Join-Path $Root '.well-known'
  $hadWellKnown = Test-Path $challengeDir
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80 -Profile Any | Out-Null
  Say 'inbound port 80 is open for the challenge'
  try {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & $exe @arguments 2>&1 | ForEach-Object { "$_" }
    $status = $LASTEXITCODE
    $ErrorActionPreference = $previous
    Write-Log 'certificate' (($output | Select-Object -Last 60) -join "`n")
  } finally {
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Say 'inbound port 80 is closed again'
    # What the challenge left in the web root of the other server is removed (only when this script created it).
    $leftover = Join-Path $challengeDir 'acme-challenge'
    if (Test-Path $leftover) { Remove-Item -Recurse -Force $leftover -ErrorAction SilentlyContinue }
    if (-not $hadWellKnown -and (Test-Path $challengeDir) -and @(Get-ChildItem $challengeDir -Force).Count -eq 0) { Remove-Item -Force $challengeDir -ErrorAction SilentlyContinue }
  }
  $chain = Join-Path $pemDir "$Name-chain.pem"
  $key = Join-Path $pemDir "$Name-key.pem"
  if ($status -ne 0 -or -not (Test-Path $chain) -or -not (Test-Path $key) -or (Get-Item $chain).LastWriteTime -lt (Get-Date).AddMinutes(-15)) {
    $reason = ($output | Where-Object { $_ -match 'error|invalid|unauthorized|timeout|refused|rateLimited' } | Select-Object -Last 4) -join ' / '
    Fail "Let's Encrypt did not issue a certificate for $Name (the log is $script:LogDir\certificate.log): $reason"
  }
  if ($UseStaging) {
    Say "the STAGING authority issued a certificate for ${Name}: the challenge works. It is not installed; run again without -Staging."
    return
  }
  Install-Certificate ((Get-Content $chain -Raw).Replace("`r`n", "`n")) ((Get-Content $key -Raw).Replace("`r`n", "`n"))
  Write-TextFile $acmeState ((@{ hostName = $Name; webRoot = $Root } | ConvertTo-Json) + "`n")
}

switch ($Mode) {
  'private' { New-PrivateCertificate }
  'acme' { Request-AcmeCertificate $HostName $WebRoot ([bool]$Staging) }
  'renew' {
    if (-not (Test-Path $acmeState)) { Say 'no Let''s Encrypt certificate was requested on this host: nothing to renew'; break }
    $current = Get-CurrentCertificate
    if (-not $Force -and $null -ne $current -and $current.NotAfter -gt (Get-Date).AddDays(30)) { Say ("the certificate ends " + $current.NotAfter.ToString('yyyy-MM-dd') + ': no renewal yet'); break }
    $state = Get-Content $acmeState -Raw | ConvertFrom-Json
    Request-AcmeCertificate $state.hostName $state.webRoot $false
  }
}
