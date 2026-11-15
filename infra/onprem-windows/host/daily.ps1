# The daily task of the installation (registered by register.ps1, run by SYSTEM at night). Each part is tried even when an earlier one failed; the exit status is
# 1 when any part failed, and <root>\logs\daily.log says which.
#   1 backup of the databases (backup.ps1 -Label daily);
#   2 renewal of the Let's Encrypt certificate when it ends within 30 days (certificate.ps1 -Mode renew);
#   3 fresh signatures for clamd (freshclam inside the clamav container);
#   4 rotation of the access log of the edge (kept 30 days in the weblogs volume).
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
$failed = @()
function Step([string]$Name, [scriptblock]$Run) {
  try { & $Run | ForEach-Object { Write-Log 'daily' "$Name $_" } } catch { $script:failed += $Name; Write-Log 'daily' "$Name FAILED $($_.Exception.Message)" }
}
Step 'backup' { & (Join-Path $PSScriptRoot 'backup.ps1') -Label 'daily' }
Step 'certificate' { & (Join-Path $PSScriptRoot 'certificate.ps1') -Mode renew }
Step 'signatures' {
  $clamav = Compose ps --quiet clamav | Select-Object -First 1
  if (-not $clamav) { throw 'the clamav service does not run' }
  Invoke-Native 'freshclam' { & docker exec $clamav 'C:\clamav\freshclam.exe' --config-file=C:\clamav\freshclam.conf --stdout }
}
Step 'weblog' {
  $web = Compose ps --quiet web | Select-Object -First 1
  if (-not $web) { throw 'the web service does not run' }
  $stamp = Get-Date -Format 'yyyyMMdd'
  Invoke-Native 'rotating the access log' { & docker exec $web cmd /S /C "cd /d C:\nginx\logs && (if exist access.log move /Y access.log access-$stamp.log > NUL) && C:\nginx\nginx.exe -p C:\nginx -s reopen && forfiles /P C:\nginx\logs /M access-*.log /D -30 /C `"cmd /c del @path`" 2> NUL & exit /b 0" }
}
if ($failed.Count -gt 0) { Write-Log 'daily' ('FAILED parts: ' + ($failed -join ', ')); exit 1 }
Write-Log 'daily' 'every part succeeded'
