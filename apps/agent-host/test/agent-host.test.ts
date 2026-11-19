import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { gzipSync } from "node:zlib"

import hostPackage from "../package.json"
import { checkReplies, COMMANDS, mainReady } from "../src/check-ready"
import { expandT3 } from "../src/prepare"
import { FEATURES, keepLink, stage } from "../src/stage"

async function fixture<T>(run: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "t1os-agent-test-"))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
function tar(entries: { name: string; data?: string | Buffer; type?: string; mode?: number }[]) {
  const headers: Buffer[] = []
  for (const { name, data = "", type = "0", mode = 0o644 } of entries) {
    const body = Buffer.from(data)
    const h = Buffer.alloc(512)
    h.write(name, 0, 100)
    h.write(mode.toString(8).padStart(7, "0"), 100)
    h.write(body.length.toString(8).padStart(11, "0"), 124)
    h.fill(" ", 148, 156)
    h.write(type, 156)
    h.write("ustar", 257)
    h.write(
      h
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, "0"),
      148,
    )
    headers.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  return gzipSync(Buffer.concat([...headers, Buffer.alloc(1024)]))
}

const manifest = JSON.stringify({
  name: "holyagent",
  version: "0.3.3",
  pi: { extensions: ["./extensions"] },
})
async function holy(dir: string, extra?: string) {
  const data = tar([
    { name: "package/package.json", data: manifest },
    { name: "package/scripts/holyagent", data: "wrapper" },
    ...(extra ? [{ name: extra, data: "bad" }] : []),
  ])
  const file = join(dir, "holyagent.tgz")
  await writeFile(file, data)
  return { file, digest: createHash("sha512").update(data).digest("hex") }
}
async function demoModules(home: string) {
  const modules = join(home, "payload/node_modules")
  await mkdir(join(modules, "expo-device-hub/dist/server"), { recursive: true })
  await writeFile(join(modules, "expo-device-hub/dist/server/cli.mjs"), "")
  await writeFile(join(home, "payload/expo-device-hub-version"), "0.22.1\n")
  await mkdir(join(modules, "agent-device/bin"), { recursive: true })
  await writeFile(join(modules, "agent-device/bin/agent-device.mjs"), "")
  await writeFile(join(home, "payload/agent-device-version"), "0.21.36\n")
  return modules
}
const unprivileged = test.skipIf(!process.geteuid?.())
unprivileged(
  "pinned local registration is idempotent and preserves independent settings",
  async () =>
    await fixture(async (home) => {
      const { file, digest } = await holy(home)
      const modules = await demoModules(home)
      await expect(stage(file, home)).rejects.toThrow("SHA-512")
      const pi = join(home, ".pi/agent/settings.json")
      await expect(lstat(pi)).rejects.toThrow("ENOENT")
      await stage(file, home, modules, digest)
      const t3 = join(home, ".t3/userdata/settings.json")
      expect(JSON.parse(await readFile(t3, "utf8"))).toEqual({
        enableDeviceSupport: true,
        enableAgentDeviceAccess: false,
        deviceOnboardingCompleted: true,
        providerInstances: { pi: { driver: "pi", enabled: true } },
      })
      expect((await lstat(pi)).mode & 0o777).toBe(0o600)
      expect(await readlink(join(home, ".pi/agent/node_modules"))).toBe(modules)
      expect(
        await readFile(join(home, ".t3/tools/expo-device-hub/0.22.1/.install-complete"), "utf8"),
      ).toBe("0.22.1\n")
      expect(
        await readFile(join(home, ".t3/tools/agent-device/0.21.36/.install-complete"), "utf8"),
      ).toBe("0.21.36\n")
      await expect(lstat(join(home, ".t3/userdata/device/agent-device"))).rejects.toThrow("ENOENT")
      const operator = JSON.parse(await readFile(t3, "utf8"))
      operator.enableDeviceSupport = false
      operator.enableAgentDeviceAccess = true
      await writeFile(t3, JSON.stringify(operator))
      const before = (await lstat(t3)).ino
      await stage(file, home, modules, digest)
      expect((await lstat(t3)).ino).toBe(before)
      expect(JSON.parse(await readFile(t3, "utf8"))).toEqual(operator)
      await writeFile(t3, '{"operatorSetting": true}')
      await expect(stage(file, home, modules, digest)).rejects.toThrow("left intact")
      expect(await readFile(t3, "utf8")).toBe('{"operatorSetting": true}')
    }),
)

unprivileged(
  "rejects archive traversal, substituted release content and symlinked settings",
  async () => {
    await fixture(async (home) => {
      const bad = await holy(home, "package/../evil")
      await expect(stage(bad.file, home, undefined, bad.digest)).rejects.toThrow("archive member")
      const good = await holy(home)
      await stage(good.file, home, await demoModules(home), good.digest)
      await writeFile(
        join(home, ".local/share/t1os/agent/holyagent-0.3.3/scripts/holyagent"),
        "modified",
      )
      await expect(stage(good.file, home, undefined, good.digest)).rejects.toThrow("differs")
    })
    await fixture(async (home) => {
      const good = await holy(home)
      await symlink(home, join(home, ".pi"))
      await expect(stage(good.file, home, undefined, good.digest)).rejects.toThrow(
        "unsafe operator directory",
      )
      await expect(lstat(join(home, "agent/settings.json"))).rejects.toThrow("ENOENT")
    })
  },
)

unprivileged(
  "first boot verifies candidate before the stable release link exists",
  async () =>
    await fixture(async (home) => {
      const { file, digest } = await holy(home)
      const candidate = await demoModules(home)
      const stable = join(home, "current/pi-deps/node_modules")
      await stage(file, home, stable, digest, candidate)
      const cache = join(home, ".t3/tools/expo-device-hub/0.22.1")
      expect(await readlink(join(cache, "node_modules"))).toBe(stable)
      expect(await readlink(join(cache, ".install-complete"))).toBe(
        join(home, "current/pi-deps/expo-device-hub-version"),
      )
      await expect(lstat(stable)).rejects.toThrow("ENOENT")
    }),
)

test("managed links never replace independent installs", async () =>
  await fixture(async (root) => {
    const existing = join(root, "package")
    await mkdir(existing)
    await expect(keepLink(existing, join(root, "candidate"))).rejects.toThrow("left intact")
    expect((await lstat(existing)).isDirectory()).toBe(true)
  }))

test("locked dependencies and both real RPC replies are required", () => {
  for (const [name, ver] of Object.entries(FEATURES))
    expect(Object.entries(hostPackage.dependencies)).toContainEqual([name, ver])
  expect(hostPackage.dependencies).not.toHaveProperty("@amaster.ai/pi-computer-use")
  expect(hostPackage.dependencies).not.toHaveProperty("@opencode/browse")
  const state = { id: "get_state", type: "response", command: "get_state", success: true }
  const commands = COMMANDS.map((name) => ({ name }))
  const reply = {
    id: "get_commands",
    type: "response",
    command: "get_commands",
    success: true,
    data: { commands },
  }
  expect(() => checkReplies([state, reply])).not.toThrow()
  expect(() => checkReplies([reply])).toThrow("get_state")
  commands.pop()
  expect(() => checkReplies([state, reply])).toThrow("missing")
})

unprivileged("readiness rejects inherited namespace before using candidate", async () => {
  const before = process.env.T1OS_READY_NET
  process.env.T1OS_READY_NET = await readlink("/proc/self/ns/net")
  try {
    await fixture(async (root) => {
      await expect(mainReady([root])).rejects.toThrow(
        "isolated user and network namespaces required",
      )
    })
  } finally {
    if (before === undefined) delete process.env.T1OS_READY_NET
    else process.env.T1OS_READY_NET = before
  }
})

test("T3 extraction rejects modified digest, links and traversal and accepts verified ordinary content", async () =>
  await fixture(async (dir) => {
    const name = "t3-0.1.10-linux-x64"
    const elf = Buffer.from([127, 69, 76, 70, 2, 1, ...Array<number>(12).fill(0), 62, 0])
    const files = [
      { name: `${name}/t3`, data: elf, mode: 0o755 },
      { name: `${name}/client/index.html`, data: "fixture" },
    ]
    const check = async (idx: number, entries: Parameters<typeof tar>[0], bad?: string) => {
      const data = tar(entries)
      const path = join(dir, `input-${idx}.tgz`)
      const dest = join(dir, `out-${idx}`)
      await writeFile(path, data)
      const operation = expandT3(path, dest, {
        size: data.length,
        digest: idx === 1 ? "wrong" : createHash("sha256").update(data).digest("hex"),
      })
      if (bad) await expect(operation).rejects.toThrow(bad)
      else {
        await operation
        expect(await readFile(join(dest, "client/index.html"), "utf8")).toBe("fixture")
        expect((await lstat(join(dest, "t3"))).mode & 0o111).toBe(0o111)
      }
    }
    await check(0, files)
    await check(1, files, "SHA-256")
    await expect(lstat(join(dir, "out-1"))).rejects.toThrow("ENOENT")
    await check(2, [...files, { name: `${name}/client/escape`, type: "2" }], "unsupported")
    await check(3, [...files, { name: `${name}/client/../../escape` }], "archive member")
    await expect(lstat(join(dir, "escape"))).rejects.toThrow("ENOENT")
    await check(4, [...files, { name: `${name}/client/index.html` }], "archive member")
  }))

// Validate the exact parser against the bundled first-party unit files without starting systemd.
test.skipIf(!Bun.which("systemd") && !(await Bun.file("/usr/lib/systemd/systemd").exists()))(
  "all shipped systemd directives are supported",
  async () => {
    const root = resolve(import.meta.dir, "../../..")
    const output = Bun.spawnSync([
      Bun.which("systemd") ?? "/usr/lib/systemd/systemd",
      "--dump-configuration-items",
    ])
    expect(output.exitCode).toBe(0)
    function directives(content: string) {
      let section = ""
      let continued = false
      const keys: string[] = []
      for (const raw of content.split("\n")) {
        const line = raw.trim()
        if (!line || /^[#;]/.test(line)) continue
        if (continued) {
          continued = line.endsWith("\\")
          continue
        }
        if (/^\[[^\]]+\]$/.test(line)) {
          section = line.slice(1, -1)
          continue
        }
        const end = line.indexOf("=")
        if (!section || end < 0) throw new Error(`malformed systemd directive: ${line}`)
        keys.push(`${section}:${line.slice(0, end)}`)
        continued = line.endsWith("\\")
      }
      return keys
    }
    const known = new Set(directives(output.stdout.toString()))
    expect(known.has("Unit:ConditionPathIsNonEmpty")).toBe(false)
    expect(known.has("Unit:ConditionFileNotEmpty")).toBe(true)
    const paths: string[] = ["runtime/remote/10-no-ssh-forwarding.conf"]
    for (const folder of ["platform", "runtime"]) {
      for await (const file of new Bun.Glob("**/*.{service,socket}").scan(join(root, folder)))
        paths.push(join(folder, file))
    }
    expect(paths.length).toBeGreaterThanOrEqual(5)
    for (const file of paths) {
      const keys = directives(await Bun.file(join(root, file)).text())
      expect(keys.filter((key) => !known.has(key))).toEqual([])
      if (file.endsWith("t1os-ssh-tunnel.socket") || file.endsWith("t1os-desktop.service")) {
        expect(keys).toContain("Unit:ConditionFileNotEmpty")
      }
    }
  },
)
