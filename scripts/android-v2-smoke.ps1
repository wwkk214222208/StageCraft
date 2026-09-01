<#!
.SYNOPSIS
  Repeatable Android v2 developer-entry smoke runner.

.DESCRIPTION
  Builds the debug APK and its instrumentation APK (when -Build is given),
  optionally installs them on one explicitly selected device, and runs the
  real-WebView v2 external-Core smoke test. The test itself creates five
  M3-compatible, browser-ESM fixtures in the test APK and writes them only to
  the app-private test store; no release APK entry point or marketplace UI is
  added.

  The no-ready and recovery cases are recorded as separate, safe commands:
    -Case no-ready  runs the existing gateway/Core handshake checks; inspect
      health for core_not_ready during the restart window.
    -Case recovery  runs the existing kill/rebind health recovery check.
  The intentionally hanging Core fixture is not run by default because it
  holds the service in the bounded 15-second boot timeout and can produce a
  restart loop on a shared device. Use -Case hang only as a manual design
  reminder and follow the printed procedure.
#>
param(
  [ValidateSet('smoke','no-ready','recovery','hang')]
  [string] $Case = 'smoke',
  [string] $Serial = 'DKS9K23407003495',
  [switch] $Build,
  [switch] $Install
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$javaHome = Join-Path $repo '.toolchains/jdk-extract/jdk-17.0.20+8'
$gradleHome = Join-Path $repo '.gradle-home'
$gradle = Join-Path $repo 'android/gradlew.bat'
$apk = Join-Path $repo 'android/app/build/outputs/apk/debug/app-debug.apk'
$testApk = Join-Path $repo 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'
$runner = 'ai.stagecraft.android.test/androidx.test.runner.AndroidJUnitRunner'

function Invoke-Instrumentation([string] $ClassName) {
  # `am instrument` may return 0 even when JUnit reports a failed test. Keep
  # every line visible, then derive the process result from the JUnit stream.
  $stream = @(& adb -s $Serial shell am instrument -w -e class $ClassName $runner 2>&1)
  $adbExit = $LASTEXITCODE
  foreach ($line in $stream) { Write-Host ([string]$line) }
  $text = $stream -join "`n"
  $reportedFailure = $text -match '(?im)^\s*FAILURES!?\s*$' `
    -or $text -match '(?im)^\s*(?:Failure|Error):\s' `
    -or $text -match '(?im)Tests\s+run:\s*\d+\s*,\s*Failures:\s*[1-9]\d*'
  # The smoke class also contains a small decoder regression test, so the
  # success count is not fixed at one. Accept any positive JUnit test count.
  $reportedSuccess = $text -match '(?im)\bOK\s*\(\s*[1-9]\d*\s+tests?\s*\)'
  if ($adbExit -ne 0 -or $reportedFailure -or -not $reportedSuccess) {
    if ($adbExit -ne 0) { Write-Host "Instrumentation transport exited with $adbExit" }
    if ($reportedFailure) { Write-Host 'JUnit reported a failure.' }
    if (-not $reportedSuccess) { Write-Host 'JUnit success marker OK (N test[s]), with N >= 1, was not found.' }
    return 1
  }
  return 0
}

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) { throw 'adb is not on PATH' }
$device = (& adb -s $Serial get-state 2>$null).Trim()
if ($device -ne 'device') { throw "Device $Serial is not online (state='$device')" }

if ($Build) {
  $env:JAVA_HOME = $javaHome
  $env:GRADLE_USER_HOME = $gradleHome
  & $gradle -p (Join-Path $repo 'android') assembleDebug assembleDebugAndroidTest --no-daemon
  if ($LASTEXITCODE -ne 0) { throw "Gradle build failed ($LASTEXITCODE)" }
}

if ($Install) {
  if (-not (Test-Path $apk) -or -not (Test-Path $testApk)) { throw 'APK files are missing; rerun with -Build' }
  & adb -s $Serial install -r $apk
  if ($LASTEXITCODE -ne 0) { throw "debug APK install failed ($LASTEXITCODE)" }
  & adb -s $Serial install -r $testApk
  if ($LASTEXITCODE -ne 0) { throw "instrumentation APK install failed ($LASTEXITCODE)" }
}

switch ($Case) {
  'smoke' {
    exit (Invoke-Instrumentation 'ai.stagecraft.android.V2ExternalCoreInstrumentationTest')
  }
  'no-ready' {
    Write-Host 'No-ready observation: run health during the cold-restart window; expected stable error is core_not_ready (HTTP 503), then health must recover.'
    exit (Invoke-Instrumentation 'ai.stagecraft.android.CoreGatewayInstrumentationTest#coreConnectionBindsAndHandshakes')
  }
  'recovery' {
    exit (Invoke-Instrumentation 'ai.stagecraft.android.CoreGatewayInstrumentationTest#hostRestartRecreatesCoreAndRestoresHealth')
  }
  'hang' {
    Write-Host 'Hang design (manual/opt-in): select a test-only Core whose boot never calls ready; after 15s health must remain non-ready and recovery state must record v2_boot_timeout. Clear the active plan with StageCraftNative.selectV2Rescue(), then restart before leaving the device.'
    exit 2
  }
}
