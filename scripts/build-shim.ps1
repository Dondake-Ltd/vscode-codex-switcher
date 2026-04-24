param(
  [switch]$All,
  [string]$GoExe = "go"
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$shimRoot = Join-Path $repoRoot "shim"
$binRoot = Join-Path $repoRoot "bin"

$targets = @(
  @{ Name = "win32-x64"; GOOS = "windows"; GOARCH = "amd64"; File = "codex-switcher-shim.exe" },
  @{ Name = "win32-arm64"; GOOS = "windows"; GOARCH = "arm64"; File = "codex-switcher-shim.exe" },
  @{ Name = "linux-x64"; GOOS = "linux"; GOARCH = "amd64"; File = "codex-switcher-shim" },
  @{ Name = "linux-arm64"; GOOS = "linux"; GOARCH = "arm64"; File = "codex-switcher-shim" },
  @{ Name = "darwin-x64"; GOOS = "darwin"; GOARCH = "amd64"; File = "codex-switcher-shim" },
  @{ Name = "darwin-arm64"; GOOS = "darwin"; GOARCH = "arm64"; File = "codex-switcher-shim" }
)

if (-not $All) {
  if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) {
    $currentPlatform = "windows"
  } elseif ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::OSX)) {
    $currentPlatform = "darwin"
  } else {
    $currentPlatform = "linux"
  }
  $currentArch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
  $targets = $targets | Where-Object { $_.GOOS -eq $currentPlatform -and $_.GOARCH -eq $currentArch }
}

foreach ($target in $targets) {
  $outDir = Join-Path $binRoot $target.Name
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $outFile = Join-Path $outDir $target.File
  Write-Host "Building shim $($target.Name) -> $outFile"
  Push-Location $shimRoot
  try {
    $env:GOOS = $target.GOOS
    $env:GOARCH = $target.GOARCH
    $env:CGO_ENABLED = "0"
    & $GoExe build -trimpath -ldflags "-s -w" -o $outFile .
  } finally {
    Pop-Location
    Remove-Item Env:\GOOS -ErrorAction SilentlyContinue
    Remove-Item Env:\GOARCH -ErrorAction SilentlyContinue
    Remove-Item Env:\CGO_ENABLED -ErrorAction SilentlyContinue
  }
}
