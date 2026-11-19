import { expect, test } from "bun:test"

import { hubSettings } from "../src/lock.ts"
import { launchArguments } from "../src/profile.ts"

test("scoped setup preserves Pi and does not enable agent control", () => {
  const settings = { providerInstances: { pi: { driver: "pi", enabled: true } }, telemetry: false }
  const expected = {
    ...settings,
    enableDeviceSupport: true,
    deviceOnboardingCompleted: true,
    enableAgentDeviceAccess: false,
  }
  expect(hubSettings(settings)).toEqual(expected)
  expect(hubSettings(expected)).toEqual(expected)
  expect("enableDeviceSupport" in settings).toBe(false)
})
test("rejects incompatible local or remote consent", () => {
  for (const value of [
    null,
    [],
    true,
    { enableAgentDeviceAccess: true },
    { deviceHosts: [{}] },
    { easDeviceHosts: ["paid"] },
    { simlockDeviceHosts: {} },
  ])
    expect(() => hubSettings(value)).toThrow()
})
test("AVD launch is headless with acceleration and no network forwarding", () => {
  const args = launchArguments()
  expect(args).toContain("-no-window")
  expect(args[args.indexOf("-port") + 1]).toEqual("5554")
  expect(args[args.indexOf("-accel") + 1]).toEqual("on")
  expect(args).not.toContain("-grpc")
})

test("SDK lock checks all components without invoking an external tool", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const { androidLock, checkRevisions } = await import("../src/lock.ts")
  const temp = await mkdtemp(join(tmpdir(), "t1os-sdk-lock-"))
  try {
    for (const [component, rev] of Object.entries(androidLock)) {
      await mkdir(join(temp, component), { recursive: true })
      await writeFile(join(temp, component, "source.properties"), "Pkg.Revision = " + rev + "\n")
    }
    await checkRevisions(temp)
    await writeFile(join(temp, "emulator/source.properties"), "Pkg.Revision=999\n")
    await expect(checkRevisions(temp)).rejects.toThrow("revision mismatch")
    await rm(join(temp, "emulator/source.properties"))
    await expect(checkRevisions(temp)).rejects.toThrow()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("project overrides cannot silently grant device capability", () => {
  const ok = {
    projectSettingsOverrides: {
      one: { enableAgentDeviceAccess: false },
      two: { enableAgentBrowserAccess: true },
    },
  }
  expect(Reflect.get(hubSettings(ok), "projectSettingsOverrides")).toEqual(
    ok.projectSettingsOverrides,
  )
  for (const overrides of [
    { one: { enableAgentDeviceAccess: true } },
    { one: { enableAgentDeviceAccess: "true" } },
    { one: null },
    null,
    [],
  ]) {
    const settings = { enableAgentDeviceAccess: false, projectSettingsOverrides: overrides }
    const before = structuredClone(settings)
    expect(() => hubSettings(settings)).toThrow()
    expect(settings).toEqual(before)
  }
})

test("boot retries transport churn, confirms AVD identity and bounds the wait", async () => {
  const { waitForBoot } = await import("../src/profile.ts")
  let clock = 0,
    i = 0,
    getprop = 0
  const sleep = async (ms: number) => {
      clock += ms
    },
    now = () => clock
  await waitForBoot(
    async (args, timeout) => {
      expect(timeout).toBeGreaterThan(0)
      if (args[0] === "devices") {
        if (i++ === 0) throw Error("daemon starting")
        return "emulator-5554\tdevice"
      }
      if (args.includes("emu")) return i === 2 ? "KO: disconnected" : "t1os_api35\r\nOK"
      if (getprop++ === 0) throw Error("transport reset")
      return "1"
    },
    now,
    sleep,
    20_000,
  )
  expect(getprop).toBe(2)
  await expect(
    waitForBoot(
      async (args) => (args[0] === "devices" ? "emulator-5554\tdevice" : "foreign\nOK"),
      now,
      sleep,
    ),
  ).rejects.toThrow("Different emulator")
  await expect(
    waitForBoot(
      async () => {
        throw Error("offline")
      },
      now,
      sleep,
      2100,
    ),
  ).rejects.toThrow("did not complete")
  expect(clock).toBe(8100)
})

test("SDK transaction never downloads into, replaces or repairs an existing installation", async () => {
  const { prepareSdk } = await import("../src/sdk.ts")
  const { androidLock } = await import("../src/lock.ts")
  const { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } =
    await import("node:fs/promises")
  const { join, dirname } = await import("node:path"),
    { tmpdir } = await import("node:os")
  const root = await mkdtemp(join(tmpdir(), "t1os-sdk-transaction-")),
    dest = join(root, "Sdk")
  async function populate(path: string) {
    for (const [dir, rev] of Object.entries(androidLock)) {
      await mkdir(join(path, dir), { recursive: true })
      await writeFile(join(path, dir, "source.properties"), "Pkg.Revision=" + rev + "\n")
    }
    for (const name of [
      "cmdline-tools/latest/bin/sdkmanager",
      "cmdline-tools/latest/bin/avdmanager",
      "platform-tools/adb",
      "emulator/emulator",
      "system-images/android-35/default/x86_64/system.img",
    ]) {
      await mkdir(dirname(join(path, name)), { recursive: true })
      await writeFile(join(path, name), "fixture", { mode: 0o700 })
    }
  }
  let touched = false
  const unexpected = async () => {
    touched = true
    throw Error("unexpected population")
  }
  try {
    await expect(
      prepareSdk(root, async (path) => {
        await populate(path)
        await writeFile(join(path, "emulator/source.properties"), "Pkg.Revision=999")
      }),
    ).rejects.toThrow("revision mismatch")
    expect(await readdir(root)).toEqual([])
    await expect(
      prepareSdk(root, async (path) => {
        await populate(path)
        await mkdir(dest)
      }),
    ).rejects.toThrow("promotion refused")
    expect(await readdir(dest)).toEqual([])
    await rm(dest, { recursive: true })
    await prepareSdk(root, populate)
    await prepareSdk(root, unexpected)
    const rev = join(dest, "emulator/source.properties")
    await writeFile(rev, "Pkg.Revision=999")
    await expect(prepareSdk(root, unexpected)).rejects.toThrow("revision mismatch")
    expect(await readFile(rev, "utf8")).toBe("Pkg.Revision=999")
    await rm(dest, { recursive: true })
    await symlink(root, dest)
    await expect(prepareSdk(root, unexpected)).rejects.toThrow("Unsafe existing")
    expect(touched).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
