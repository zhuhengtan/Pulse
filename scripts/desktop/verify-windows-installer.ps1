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
    # Upgrade a real released installation, including its legacy uninstaller.
    $legacy = Join-Path $acceptanceRoot 'pulse-windows-0.11.2.exe'
    Invoke-WebRequest -Uri 'https://github.com/zhuhengtan/Pulse/releases/download/shell-v0.11.2/pulse-windows-x64.exe' -OutFile $legacy
    if ((Get-FileHash -LiteralPath $legacy -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'c4dee42272698232f9257779a725510b22c755d8a548bb8b1ab511c12d484906') { throw 'Legacy installer checksum mismatch' }
    $previous = Start-Process -FilePath $legacy -ArgumentList @('/S', '/currentuser', "/D=$install") -Wait -PassThru
    if ($previous.ExitCode -ne 0) { throw "Legacy installation failed: $($previous.ExitCode)" }
    $result = Start-Process -FilePath $installer -ArgumentList @('/S', '/currentuser', "/D=$install") -Wait -PassThru
    if ($result.ExitCode -ne 0) { throw "NSIS installation failed: $($result.ExitCode)" }
    $env:PULSE_DESKTOP_EXECUTABLE = Join-Path $install 'Pulse.exe'
    if (-not (Test-Path -LiteralPath $env:PULSE_DESKTOP_EXECUTABLE)) { throw 'Installed Pulse.exe missing' }
    pnpm desktop:app:install-smoke
    if ($LASTEXITCODE -ne 0) { throw 'Installed Windows application acceptance failed' }
    # Reinstall after the app has exited: no process must not become an
    # unclosable-app prompt. Exercise both user and elevated machine modes.
    foreach ($mode in @('/currentuser', '/allusers')) {
        $target = if ($mode -eq '/allusers') { Join-Path $acceptanceRoot 'Machine Program Files\Pulse' } else { $install }
        $retry = Start-Process -FilePath $installer -ArgumentList @('/S', $mode, "/D=$target") -PassThru
        if (-not $retry.WaitForExit(300000)) { throw "NSIS $mode installation did not finish" }
        $retry.Refresh()
        if ($retry.ExitCode -ne 0) { throw "NSIS $mode installation failed: $($retry.ExitCode)" }
        if (-not (Test-Path -LiteralPath (Join-Path $target 'Pulse.exe'))) { throw "NSIS $mode did not install Pulse.exe" }
    }
} finally {
    $env:TEMP = $oldTemp
    $env:TMP = $oldTmp
    $env:PULSE_DESKTOP_EXECUTABLE = $oldExecutable
    # Only this test's generated installation and profile are removed.
    Remove-Item -LiteralPath $acceptanceRoot -Recurse -Force -ErrorAction SilentlyContinue
}
