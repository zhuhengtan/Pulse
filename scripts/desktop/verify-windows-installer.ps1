$ErrorActionPreference = 'Stop'
# Exercise NSIS itself, with spaces in both TEMP and the install location.
# The unpacked builder output and development Electron cannot catch lost files.
$installer = (Resolve-Path 'artifacts/desktop/pulse-windows-x64.exe').Path
$acceptanceRoot = Join-Path $env:RUNNER_TEMP ('Pulse installer acceptance-' + [guid]::NewGuid())
$install = Join-Path $acceptanceRoot 'Program Files\Pulse'
$installerTemp = Join-Path $acceptanceRoot 'User Temp'
New-Item -ItemType Directory -Force $installerTemp | Out-Null
$oldTemp = $env:TEMP
$oldTmp = $env:TMP
$oldExecutable = $env:PULSE_DESKTOP_EXECUTABLE
try {
    $env:TEMP = $installerTemp
    $env:TMP = $installerTemp
    $result = Start-Process -FilePath $installer -ArgumentList @('/S', '/currentuser', "/D=$install") -Wait -PassThru
    if ($result.ExitCode -ne 0) { throw "NSIS installation failed: $($result.ExitCode)" }
    $env:PULSE_DESKTOP_EXECUTABLE = Join-Path $install 'Pulse.exe'
    if (-not (Test-Path -LiteralPath $env:PULSE_DESKTOP_EXECUTABLE)) { throw 'Installed Pulse.exe missing' }
    pnpm desktop:app:install-smoke
    if ($LASTEXITCODE -ne 0) { throw 'Installed Windows application acceptance failed' }
} finally {
    $env:TEMP = $oldTemp
    $env:TMP = $oldTmp
    $env:PULSE_DESKTOP_EXECUTABLE = $oldExecutable
    # Only this test's generated installation and profile are removed.
    Remove-Item -LiteralPath $acceptanceRoot -Recurse -Force -ErrorAction SilentlyContinue
}
