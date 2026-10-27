# CI only: installs the msedgedriver that matches the runner's WebView2 runtime and prints its
# path. tauri-driver needs the exact matching major version.
$ErrorActionPreference = 'Stop'
$keys = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$version = $null
foreach ($k in $keys) {
  if (Test-Path $k) { $version = (Get-ItemProperty $k).pv; if ($version) { break } }
}
if (-not $version) { throw 'WebView2 runtime version not found in the registry' }
Write-Host "WebView2 runtime $version"
$dest = Join-Path $env:RUNNER_TEMP 'msedgedriver'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$zip = Join-Path $dest 'edgedriver.zip'
$urls = @(
  "https://msedgedriver.microsoft.com/$version/edgedriver_win64.zip",
  "https://msedgedriver.azureedge.net/$version/edgedriver_win64.zip"
)
$ok = $false
foreach ($u in $urls) {
  try { Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing; $ok = $true; break }
  catch { Write-Host "download failed from $u : $($_.Exception.Message)" }
}
if (-not $ok) { throw "could not download msedgedriver $version" }
Expand-Archive -Path $zip -DestinationPath $dest -Force
$driver = Join-Path $dest 'msedgedriver.exe'
if (-not (Test-Path $driver)) { throw 'msedgedriver.exe missing from the archive' }
"MSEDGEDRIVER=$driver" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host "msedgedriver installed at $driver"
