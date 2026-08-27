# StageCraft Phase Eight Certification Matrix

This document is the reproducible certification contract for web, Android, DSH, and card UI. The source of truth is `scripts/certify-platform.mjs`; it writes a report outside the repository by default. Private card contents are never copied, printed, hashed, or packaged by the certification tooling.

## Status vocabulary

- `pass`: the check ran and its assertions passed.
- `fail`: the check ran and an assertion or command failed.
- `skip`: the check needs an unavailable platform, emulator, device, network, or private fixture. A skip is not a pass.

## Matrix

| Area | Contract | Automated evidence | Environment status |
|---|---|---|---|
| Windows | Node/web full suite, privacy, diff hygiene | `npm test`, certification tests, `git diff --check` | Run on Windows CI/workstation |
| Linux | Node/web full suite and packaging | Same commands on Linux | Run on Linux CI/workstation |
| macOS | Node/web full suite and packaging | Same commands on macOS | Run on macOS CI/workstation |
| DSH/Cordis | Bundle build, package privacy, local and real Cordis lifecycle | `node dsh-rp/verify.mjs`, `npm test` DSH contract | Run when Node/Cordis dependencies exist |
| Android JVM | Unit tests, debug assemble, lint | `android/gradlew.bat testDebugUnitTest assembleDebug lintDebug __KEEP_GRADLE_LOCAL__ --no-daemon` | Run when Android SDK/Gradle cache exists |
| Android emulator/device | Install, launch, local/remote vertical flows, lifecycle recovery | Reserved integration lane; runner records `skip` without an emulator/device | Requires explicit AVD or physical device |
| Local mode | Shared protocol and renderer behavior | `core-connection`, Android renderer/contracts, local Core tests | Automated in Node; Android local app is device-gated |
| Remote mode | Pairing, authenticated view/command/events, reconnect and resync | `remote-access`, `core-connection`, Android contract tests | Automated with fakes; device flow is gated |
| Performance | Bounded compatibility compile/render and no private payload output | Certification performance smoke test and report timings | Thresholds are smoke limits, not production benchmarks |
| Security | No secrets/private paths, unsafe URLs/scripts, bridge/file/network escape | UI, remote, sandbox, Android contract tests plus bundle scan | Automated |
| Public card UI | Same manifest/intermediate render on Web and Android | Public synthetic ST/MVU fixture tests | Automated |
| Private ST/MVU card | Full local acceptance if ignored `custom/` fixture is available | `private-st-mvu-acceptance.test.ts` | Fixture presence is detected; source stays untracked |

## Performance smoke limits

The certification runner measures only deterministic synthetic/public data and reports elapsed milliseconds. It fails if a small compatibility compile/render case exceeds 2 seconds or if the generated DSH bundle contains private markers. These limits detect accidental regressions in CI; they are not claims about model latency, Android startup, or large private cards.

## Required command

From the repository root:

```powershell
node scripts/certify-platform.mjs
```

Useful options:

```powershell
node scripts/certify-platform.mjs --report .\certification-report.json
node scripts/certify-platform.mjs --skip-gradle
```

The report contains command names, exit status, duration, and skip reasons, but no command output that could contain private card text. `certification-report.json` is ignored and must not be committed.

## Platform limitations

A Windows run cannot certify Linux or macOS behavior. Without an Android SDK, AVD, or physical device it can certify repository contracts and Gradle configuration only; it must report emulator/device lanes as skipped. Cross-platform claims require the same runner on the named OSes. Private-card acceptance is only a local acceptance signal and is intentionally not a reproducible public fixture.
