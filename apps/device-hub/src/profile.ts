// Invoked by the full profile's verified Bun, never during ordinary provisioning.
import { constants } from "node:fs"
import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"

import { checkRevisions } from "./lock.ts"

const name = "t1os_api35"
const image = "system-images;android-35;default;x86_64"
const serial = "emulator-5554"
const home = homedir()
const sdk = join(home, "Android/Sdk")
const emulator = join(sdk, "emulator/emulator")
const adb = join(sdk, "platform-tools/adb")
const manager = join(sdk, "cmdline-tools/latest/bin")
const env = {
  HOME: home,
  USER: "t1os",
  LANG: "C.UTF-8",
  ANDROID_HOME: sdk,
  PATH: "/opt/t1os/current/agent-host/bin:/usr/local/bin:/usr/bin:/bin",
  ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
  ...(process.env.DBUS_SESSION_BUS_ADDRESS
    ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }
    : {}),
}

/** Keep local ADB's addressing and the single managed AVD explicit. */
export function launchArguments() {
  return [
    "-avd",
    name,
    "-port",
    "5554",
    "-no-window",
    "-no-audio",
    "-no-boot-anim",
    "-no-snapshot",
    "-gpu",
    "software",
    "-accel",
    "on",
  ]
}

async function run(cmd: string[], input?: string, timeout?: number) {
  const child = Bun.spawn(cmd, {
    env,
    ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}),
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "inherit",
  })
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw Error(`${cmd[0]} exited ${status}`)
  return output.trim()
}

async function preflight() {
  await checkRevisions(sdk)
  await access("/dev/kvm", constants.R_OK | constants.W_OK)
  for (const file of [
    emulator,
    adb,
    join(manager, "avdmanager"),
    join(manager, "sdkmanager"),
    "/usr/bin/ffmpeg",
    "/usr/bin/java",
  ])
    await access(file, constants.X_OK)
  await access(join(sdk, "system-images/android-35/default/x86_64/system.img"), constants.R_OK)
  await run([emulator, "-accel-check"])
  if (!/\blibx264\b/.test(await run(["/usr/bin/ffmpeg", "-hide_banner", "-encoders"])))
    throw Error("ffmpeg lacks libx264")
}

async function secureDir(folder: string) {
  if (folder !== home) {
    await secureDir(dirname(folder))
    await mkdir(folder, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err
    })
  }
  const stat = await lstat(folder)
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid!() ||
    stat.mode & 0o022 ||
    (await realpath(folder)) !== folder
  )
    throw Error(`Unsafe directory: ${folder}`)
}

async function configure() {
  await preflight()
  await secureDir(join(home, ".android/avd"))
  const avdConfig = join(home, ".android/avd", name + ".avd/config.ini")
  if (!(await run([emulator, "-list-avds"])).split(/\s+/).includes(name)) {
    await run(
      [
        join(manager, "avdmanager"),
        "create",
        "avd",
        "--name",
        name,
        "--package",
        image,
        "--path",
        dirname(avdConfig),
      ],
      "no\n",
    )
  }
  const config = await readFile(avdConfig, "utf8")
  if (!/^image\.sysdir\.1\s*=\s*system-images\/android-35\/default\/x86_64\/?\s*$/m.test(config))
    throw Error("Existing AVD does not use the managed image")
}

/** Verify a confirmed identity before accepting guest boot; transport churn is retryable. */
export async function waitForBoot(
  probe: (args: string[], timeout: number) => Promise<string>,
  now = () => performance.now(),
  sleep = (ms: number) => Bun.sleep(ms),
  budget = 240_000,
) {
  const end = now() + budget
  const read = async (args: string[]) => {
    const remaining = Math.floor(end - now())
    if (remaining < 1) return ""
    try {
      return (await probe(args, Math.min(4000, remaining))).trim()
    } catch {
      return ""
    }
  }
  while (now() < end) {
    const devices = await read(["devices"])
    if (devices.split(/\r?\n/).some((line) => line === serial + "\tdevice")) {
      const response = (await read(["-s", serial, "emu", "avd", "name"])).split(/\r?\n/)
      if (response.length === 2 && response[0] && response[1] === "OK") {
        if (response[0] !== name) throw Error("Different emulator owns the reserved port")
        if ((await read(["-s", serial, "shell", "getprop", "sys.boot_completed"])) === "1") return
      }
    }
    const pause = Math.min(2000, end - now())
    if (pause > 0) await sleep(pause)
  }
  throw Error("Managed Android device did not complete boot")
}

if (import.meta.main) {
  if (
    userInfo().username !== "t1os" ||
    process.getuid!() === 0 ||
    process.arch !== "x64" ||
    process.platform !== "linux"
  )
    throw Error("Run only as the t1os operator in the supported x86-64 Linux guest")
  switch (process.argv[2]) {
    case "start":
      await configure()
      await run(["/usr/bin/systemctl", "--user", "start", "t1os-android.service"])
      break
    case "configure":
      await configure()
      break
    case "check":
      await preflight()
      break
    case "boot":
      await preflight()
      process.exit(
        await Bun.spawn([emulator, ...launchArguments()], {
          env,
          stdout: "inherit",
          stderr: "inherit",
        }).exited,
      )
      break
    case "ready":
      await waitForBoot((args, ms) => run([adb, ...args], undefined, ms))
      break
    default:
      throw Error("Expected start, check, configure, boot, or ready")
  }
}
