$ErrorActionPreference = 'Stop'

$go2rtcVersion = 'v1.9.14'
$go2rtcZipUrl = "https://github.com/AlexxIT/go2rtc/releases/download/$go2rtcVersion/go2rtc_win64.zip"
$expectedSha256 = 'DD4167D75CB04ABE618855B7C71F8658BD009F60C1A71835D134D2C11C939907'
$buildRoot = Join-Path ([System.IO.Path]::GetTempPath()) "camera-monitor-bridge-$([guid]::NewGuid().ToString('N'))"
$extractRoot = Join-Path $buildRoot 'upstream'
$packageRoot = Join-Path $buildRoot 'package'
$downloadPath = Join-Path $buildRoot 'go2rtc_win64.zip'
$outputPath = Join-Path $PSScriptRoot 'camera-monitor-local-bridge-v0.1.0.zip'

New-Item -ItemType Directory -Path $extractRoot,$packageRoot -Force | Out-Null
Invoke-WebRequest -Uri $go2rtcZipUrl -OutFile $downloadPath
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$downloadStream = [System.IO.File]::OpenRead($downloadPath)
try {
  $actualSha256 = [System.BitConverter]::ToString($sha256.ComputeHash($downloadStream)).Replace('-', '')
} finally {
  $downloadStream.Dispose()
  $sha256.Dispose()
}
if ($actualSha256 -ne $expectedSha256) {
  throw "go2rtc archive hash mismatch. Expected $expectedSha256; received $actualSha256."
}

Expand-Archive -LiteralPath $downloadPath -DestinationPath $extractRoot
$upstreamExecutable = Join-Path $extractRoot 'go2rtc.exe'
if (-not (Test-Path -LiteralPath $upstreamExecutable)) { throw 'The official archive did not contain go2rtc.exe.' }

Copy-Item -LiteralPath $upstreamExecutable -Destination $packageRoot
foreach ($fileName in @('go2rtc.yaml','Start Camera Bridge.cmd','Install Camera Bridge.cmd','Install Camera Bridge.ps1','README.md','THIRD-PARTY-NOTICES.md','LICENSE-go2rtc.txt')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $fileName) -Destination $packageRoot
}
$screenshotStage = Join-Path $packageRoot 'screenshots'
New-Item -ItemType Directory -Path $screenshotStage | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'screenshots\*') -Destination $screenshotStage -Recurse

if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $packageRoot,
  $outputPath,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)

Write-Host "Created $outputPath"
Write-Host "go2rtc version: $go2rtcVersion"
Write-Host "go2rtc SHA-256: $actualSha256"
