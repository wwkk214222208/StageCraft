/**
 * ADB reverse 隧道辅助（桌面组合根专用，不属于 Core）。
 *
 * 手机经 USB 调试授权后，电脑端执行 `adb reverse tcp:<port> tcp:<port>` 即可把手机
 * localhost:<port> 映射到电脑 localhost:<port>（loopback）。此后 APK 配对页
 * 「通过 ADB 直连（免配对码）」可直接向电脑 /api/remote/device-token 换会话，
 * 无需配对码。本模块把该命令封装为可注入 runner 的纯逻辑，便于测试与错误归一化。
 */
import { execFile } from 'node:child_process'

export interface AdbReverseRunner {
  /** 执行 `adb devices`，返回已授权设备 serial 列表（device 状态，排除 offline/unauthorized）。 */
  devices(): Promise<string[]>
  /** 对指定设备执行 `adb reverse tcp:<port> tcp:<port>`。 */
  reverse(serial: string | null, port: number): Promise<string>
}

/** 生产实现：经 node:child_process 调用 adb。adb 不在 PATH 时抛可诊断错误。 */
export function createAdbRunner(adbPath = 'adb'): AdbReverseRunner {
  function run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(adbPath, args, { timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || '').trim()
          reject(new Error(`adb ${args.join(' ')} 失败${detail ? `：${detail}` : ''}（${error.message}）`))
          return
        }
        resolve((stdout || '').trim())
      })
    })
  }
  return {
    async devices(): Promise<string[]> {
      const output = await run(['devices'])
      return output
        .split(/\r?\n/)
        .slice(1) // 跳过 "List of devices attached"
        .map(line => line.trim())
        .filter(line => line.length > 0 && /^[\w:.-]+\s+device\s*$/.test(line))
        .map(line => line.split(/\s+/)[0])
    },
    async reverse(serial, port): Promise<string> {
      const args = serial ? ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`] : ['reverse', `tcp:${port}`, `tcp:${port}`]
      return run(args)
    },
  }
}

/**
 * 为电脑上所有已授权设备建立 reverse 隧道。返回每台设备的执行结果；
 * 任何设备失败都聚合进 detail（不吞掉，供 UI 展示）。
 */
export async function setupAdbReverse(port: number, runner: AdbReverseRunner = createAdbRunner()): Promise<{
  ok: boolean
  port: number
  devices: string[]
  detail: string[]
}> {
  let serials: string[]
  try {
    serials = await runner.devices()
  } catch (error) {
    return { ok: false, port, devices: [], detail: [error instanceof Error ? error.message : String(error)] }
  }
  if (serials.length === 0) {
    return { ok: false, port, devices: [], detail: ['未检测到已授权的 adb 设备。请确认手机已开启 USB 调试并信任此电脑。'] }
  }
  const detail: string[] = []
  let allOk = true
  for (const serial of serials) {
    try {
      await runner.reverse(serial, port)
      detail.push(`${serial}: 隧道已建立 tcp:${port} → tcp:${port}`)
    } catch (error) {
      allOk = false
      detail.push(`${serial}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { ok: allOk, port, devices: serials, detail }
}
