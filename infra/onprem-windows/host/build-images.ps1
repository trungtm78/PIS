# Builds the images of one release on the host, from the build pack of scripts/onprem-windows-pack.mjs.
#
#   powershell -ExecutionPolicy Bypass -File build-images.ps1 -Pack C:\machvon-pack [-Only db,api]
#
# The pack is checked against its manifest first (every file, SHA-256). The images are tagged machvon/<name>-windows:<VERSION of the pack>.
# The third-party parts (PostgreSQL, pgvector, Keycloak, Java, nginx, ClamAV, Node) are downloaded inside the builds and checked against infra/onprem-windows/images.json.
# The first build of the db image installs the Microsoft C++ build tools in a build stage and takes 20 to 40 minutes; later builds reuse the cached layers.
param(
  [Parameter(Mandatory)][string]$Pack,
  [string[]]$Only = @()
)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator

$Pack = (Resolve-Path $Pack).Path
$manifestPath = Join-Path $Pack 'manifest.json'
if (-not (Test-Path $manifestPath)) { Fail "no manifest.json in $Pack" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = (Get-Content (Join-Path $Pack 'VERSION') -Raw).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$' -or $version -ne $manifest.version) { Fail 'the VERSION file of the pack is not an exact version, or differs from the manifest' }

Say "checking the pack $version against its manifest"
$count = 0
foreach ($entry in $manifest.files.PSObject.Properties) {
  $file = Join-Path $Pack ($entry.Name -replace '/', '\')
  if (-not (Test-Path -LiteralPath $file)) { Fail "the pack misses $($entry.Name)" }
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower() -ne $entry.Value) { Fail "the pack file $($entry.Name) does not have the SHA-256 of the manifest" }
  $count += 1
}
Say "$count files match"

$pins = Get-Content (Join-Path $Pack 'infra\onprem-windows\images.json') -Raw | ConvertFrom-Json
$docker = Join-Path $Pack 'infra\onprem-windows\docker'
function Pin([string[]]$Names) {
  $arguments = @('--build-arg', "WINDOWS_TAG=$($pins.windowsTag)")
  foreach ($name in $Names) {
    $artifact = $pins.artifacts.$name
    $arguments += @('--build-arg', "${name}_URL=$($artifact.url)", '--build-arg', "${name}_SHA256=$($artifact.sha256.ToUpper())")
  }
  return $arguments
}
$builds = [ordered]@{
  db       = @{ file = 'db.Dockerfile'; context = $docker; pins = @('POSTGRES', 'PGVECTOR') }
  keycloak = @{ file = 'keycloak.Dockerfile'; context = (Join-Path $Pack 'infra'); pins = @('JAVA', 'KEYCLOAK') }
  clamav   = @{ file = 'clamav.Dockerfile'; context = $docker; pins = @('CLAMAV') }
  api      = @{ file = 'api.Dockerfile'; context = $Pack; pins = @('NODE') }
  web      = @{ file = 'web.Dockerfile'; context = $Pack; pins = @('NGINX') }
}
foreach ($name in $builds.Keys) {
  if ($Only.Count -gt 0 -and $Only -notcontains $name) { continue }
  $build = $builds[$name]
  $tag = "machvon/$name-windows:$version"
  Say "building $tag"
  $arguments = @('build', '--isolation', 'process', '--tag', $tag, '--label', "org.opencontainers.image.version=$version", '--file', (Join-Path $docker $build.file)) + (Pin $build.pins) + @($build.context)
  Invoke-Native "docker build of $tag" { & docker @arguments }
}
Say "done: the images of $version are built"
