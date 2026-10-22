$ErrorActionPreference = 'Stop'

$installRoot = 'C:\rtsp_bridge'
$sourceRoot = $PSScriptRoot
$requiredFiles = @('go2rtc.exe', 'go2rtc.yaml', 'Start Camera Bridge.cmd')
foreach ($fileName in $requiredFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $fileName) -PathType Leaf)) {
    throw "Missing $fileName. Extract the complete bridge ZIP, then run this installer again."
  }
}

function Restart-Elevated {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments
  Write-Host 'Windows requested administrator approval. Continue in the elevated installer window.'
  exit 0
}

try {
  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
  foreach ($fileName in @('go2rtc.exe', 'go2rtc.yaml', 'Start Camera Bridge.cmd', 'README.md', 'THIRD-PARTY-NOTICES.md', 'LICENSE-go2rtc.txt')) {
    $sourcePath = Join-Path $sourceRoot $fileName
    if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
      Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $installRoot $fileName) -Force
    }
  }
} catch [System.UnauthorizedAccessException] {
  Restart-Elevated
} catch [System.Security.SecurityException] {
  Restart-Elevated
}

$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath 'CNC Camera Bridge.lnk'
$launcherPath = Join-Path $installRoot 'Start Camera Bridge.cmd'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.WorkingDirectory = $installRoot
$shortcut.Description = 'Start the local CNC camera bridge for gSender.'
$shortcut.IconLocation = (Join-Path $installRoot 'go2rtc.exe') + ',0'
$shortcut.Save()

Write-Host "Installed to $installRoot"
Write-Host "Created Desktop shortcut: $shortcutPath"
Write-Host 'Starting the camera bridge now. Keep its console window open.'
Start-Process -FilePath $launcherPath -WorkingDirectory $installRoot
