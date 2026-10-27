# CI only (windows-latest): install each brand's NSIS and MSI installer silently, run the installed
# app's --self-test, then uninstall and check it is gone. Never run on a maintainer's machine.
param(
  [Parameter(Mandatory = $true)][string]$ArtifactDir
)
$ErrorActionPreference = 'Stop'
$brands = @{ dojix = 'Dojix'; greenwick = 'Greenwick' }
$failures = 0

function Find-InstalledExe([string]$product, [string]$brand, [string]$kind) {
  if ($kind -eq 'nsis') {
    # Per-user install.
    $candidates = @(
      (Join-Path $env:LOCALAPPDATA "$product\$brand.exe"),
      (Join-Path $env:LOCALAPPDATA "Programs\$product\$brand.exe")
    )
    $roots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')
  } else {
    # Per-machine install.
    $candidates = @((Join-Path $env:ProgramFiles "$product\$brand.exe"))
    $roots = @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')
  }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  foreach ($r in $roots) {
    $entry = Get-ItemProperty $r -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $product } | Select-Object -First 1
    if ($entry -and $entry.InstallLocation) {
      $exe = Join-Path ($entry.InstallLocation.Trim('"')) "$brand.exe"
      if (Test-Path $exe) { return $exe }
    }
  }
  return $null
}

function Invoke-SelfTest([string]$exe, [string]$label) {
  $out = Join-Path $env:RUNNER_TEMP "selftest-$label.json"
  $err = Join-Path $env:RUNNER_TEMP "selftest-$label.err"
  $p = Start-Process -FilePath $exe -ArgumentList '--self-test' -Wait -PassThru -NoNewWindow `
    -RedirectStandardOutput $out -RedirectStandardError $err
  $json = Get-Content $out -Raw
  Write-Host "self-test ($label) exit $($p.ExitCode): $json"
  if ($p.ExitCode -ne 0) { throw "self-test failed for $label" }
  $report = $json | ConvertFrom-Json
  if (-not $report.ok) { throw "self-test reported failure for $label" }
}

function Wait-Gone([string]$path) {
  for ($i = 0; $i -lt 60; $i++) {
    if (-not (Test-Path $path)) { return }
    Start-Sleep -Seconds 1
  }
  throw "$path still present after uninstall"
}

foreach ($brand in $brands.Keys) {
  $product = $brands[$brand]
  $dir = Join-Path $ArtifactDir $brand

  # NSIS, per-user, silent.
  try {
    $setup = Get-ChildItem -Path $dir -Filter '*-setup.exe' | Select-Object -First 1
    if (-not $setup) { throw "no NSIS installer for $brand" }
    Write-Host "== $product NSIS: $($setup.Name)"
    $p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "NSIS install exit code $($p.ExitCode)" }
    $exe = Find-InstalledExe $product $brand 'nsis'
    if (-not $exe) { throw "installed $brand.exe not found" }
    Write-Host "installed at $exe"
    try {
      Invoke-SelfTest $exe "$brand-nsis"
    } finally {
      $uninstaller = Join-Path (Split-Path $exe) 'uninstall.exe'
      Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null
      Wait-Gone $exe
    }
    Write-Host "ok - $product NSIS install, self-test, uninstall"
  } catch {
    $failures++
    Write-Host "::error::$product NSIS: $($_.Exception.Message)"
  }

  # MSI, per-machine, quiet.
  try {
    $msi = Get-ChildItem -Path $dir -Filter '*.msi' | Select-Object -First 1
    if (-not $msi) { throw "no MSI for $brand" }
    Write-Host "== $product MSI: $($msi.Name)"
    $log = Join-Path $env:RUNNER_TEMP "msi-$brand-install.log"
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$($msi.FullName)`" /qn /norestart /l*v `"$log`"" -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "MSI install exit code $($p.ExitCode) (log: $log)" }
    $exe = Find-InstalledExe $product $brand 'msi'
    if (-not $exe) { throw "installed $brand.exe not found" }
    Write-Host "installed at $exe"
    try {
      Invoke-SelfTest $exe "$brand-msi"
    } finally {
      $ulog = Join-Path $env:RUNNER_TEMP "msi-$brand-uninstall.log"
      $p = Start-Process msiexec.exe -ArgumentList "/x `"$($msi.FullName)`" /qn /norestart /l*v `"$ulog`"" -Wait -PassThru
      if ($p.ExitCode -ne 0) { throw "MSI uninstall exit code $($p.ExitCode)" }
      Wait-Gone $exe
    }
    Write-Host "ok - $product MSI install, self-test, uninstall"
  } catch {
    $failures++
    Write-Host "::error::$product MSI: $($_.Exception.Message)"
  }
}

if ($failures -gt 0) { throw "$failures installer smoke check(s) failed" }
Write-Host 'All installer smoke checks passed.'
