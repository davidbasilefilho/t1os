import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { config, GIB, MIB, regularFile, TOKEN, verifyIso, vmArguments } from "../src/omarchy-vm"
import {
  BOOTSTRAP,
  bundleInput,
  PLATFORM_FILES,
  QA_POWER,
  runQmp,
  stage,
  UNIT,
  verifyKvmAccess,
} from "../src/unattended-vm"

const digest = "a".repeat(64)
const cli = [
  process.execPath,
  join(import.meta.dir, "../src/omarchy-vm.ts"),
  ...["iso", "signature", "public-key", "ovmf-code", "ovmf-vars"].flatMap((flag) => [
    `--${flag}`,
    "/does-not-exist",
  ]),
]

async function withScratch(run: (path: string) => Promise<void> | void) {
  const path = mkdtempSync(join(tmpdir(), "t1os-vm-test-"))
  try {
    await run(path)
  } finally {
    rmSync(path, { force: true, recursive: true })
  }
}

describe("disposable VM boundaries", () => {
  test("stock installer selects exactly one disposable virtio disk and no custom commands", () => {
    const size = 40 * GIB
    const generated = config(size)
    const chosen = generated.disk_config.device_modifications
    expect(generated.custom_commands).toEqual([])
    expect(chosen).toHaveLength(1)
    expect(chosen[0]?.device).toBe("/dev/vda")
    expect(chosen[0]?.wipe).toBe(true)
    const root = chosen[0]?.partitions[1]
    expect((root?.size.value ?? 0) + (root?.start.value ?? 0) + MIB).toBe(size)
  })

  test("dry runs do not read media; partial confirmation, bad digest, and incompatible modes fail", () => {
    const regular = Bun.spawnSync(cli)
    expect(regular.exitCode).toBe(0)
    expect(regular.stdout.toString()).toContain('"mode": "dry-run"')
    const bundle = ["--bundle", "/does-not-exist", "--bundle-sha256", digest]
    const unattended = Bun.spawnSync([...cli, ...bundle])
    expect(unattended.exitCode).toBe(0)
    expect(unattended.stdout.toString()).toContain("two verified boots")
    for (const args of [
      ["--confirm", TOKEN],
      ["--apply"],
      ["--apply", "--confirm", "bad"],
      ["--bundle", "/missing"],
      [...bundle, "--overlay-iso", "/missing"],
      [...bundle, "--probe-output", "/missing"],
      ["--phase-timeout", "14"],
      ["--size-gib", "129"],
    ])
      expect(Bun.spawnSync([...cli, ...args]).exitCode).not.toBe(0)
  })

  test("QEMU is offline, boot media is readonly, and qualification uses no socket", () => {
    const first = vmArguments("code", "vars", "disk", "/tmp/scratch", { iso: "iso", seed: "seed" })
    const second = vmArguments("code", "vars", "disk", "/tmp/scratch", {
      accel: "tcg",
      probe: true,
    })
    expect(first[first.indexOf("-nic") + 1]).toBe("none")
    expect(first.some((arg) => arg.includes("id=seed,media=cdrom,readonly=on"))).toBe(true)
    expect(second.some((arg) => /id=(seed|installer|overlay)/u.test(arg))).toBe(false)
    expect(first.filter((arg) => arg === "-device")).toHaveLength(7)
    expect(second[second.indexOf("-qmp") + 1]).toBe("stdio")
    expect(second).not.toContain("-vnc")
    expect(second.some((arg) => arg.startsWith("unix:"))).toBe(false)
  })

  test("rejects file type substitution, symbolic links, FIFO, and QEMU config injection", async () => {
    await withScratch((path) => {
      const file = join(path, "file")
      writeFileSync(file, "")
      const link = join(path, "link")
      const fifo = join(path, "fifo")
      const injected = join(path, "iso,format=raw")
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0)
      symlinkSync(file, link)
      writeFileSync(injected, "")
      for (const invalid of [path, link, fifo, injected, "/dev/null"])
        expect(() => regularFile(invalid)).toThrow()
      expect(regularFile(file)).toBe(file)
    })
  })

  test("SHA mismatch stops before GPG", async () => {
    await withScratch(async (path) => {
      const iso = join(path, "iso")
      writeFileSync(iso, "not the ISO")
      await expect(verifyIso(iso, "missing.sig", "missing.asc", path)).rejects.toThrow(
        "ISO SHA-256",
      )
      expect(existsSync(join(path, "gnupg"))).toBe(false)
    })
  })

  test("verified overlay is frozen, while links and wrong pins fail", async () => {
    await withScratch(async (path) => {
      const source = join(path, "bundle")
      const link = join(path, "link")
      writeFileSync(source, "fixture")
      symlinkSync(source, link)
      const expected = createHash("sha256").update("fixture").digest("hex")
      expect(() => bundleInput(link, expected, path)).toThrow()
      const frozen = bundleInput(source, expected, path)
      writeFileSync(source, "modified")
      expect(await Bun.file(frozen).text()).toBe("fixture")
      unlinkSync(frozen)
      expect(() => bundleInput(source, expected, path)).toThrow("SHA-256")
    })
  })

  test("KVM preflight fails closed for non-devices and unrelated character devices", async () => {
    await withScratch((path) => {
      const file = join(path, "file")
      writeFileSync(file, "")
      for (const invalid of [file, join(path, "missing"), "/dev/null"])
        expect(() => verifyKvmAccess(invalid)).toThrow("not verified")
    })
  })

  test("guestfish inspects a fresh stock root before fixed writes", async () => {
    await withScratch(async (state) => {
      const disk = join(state, "disposable.qcow2")
      const bundle = join(state, "bundle.tar")
      writeFileSync(disk, "", { mode: 0o600 })
      writeFileSync(bundle, "", { mode: 0o600 })
      const response = [
        "btrfs",
        ...Array(4).fill("true"),
        ...Array(9).fill("false"),
        "/var/lib/pacman/local/omarchy-4.5.0-1/desc",
        "",
      ].join("\n")
      const calls: { readonly: boolean; commands: string[][] }[] = []
      let read = "no root"
      const source = join(state, "checkout")
      mkdirSync(source)
      const files = [UNIT, "qa-power-button.conf"] as const
      for (const file of files) copyFileSync(join(PLATFORM_FILES, file), join(source, file))
      const deps = {
        source,
        compile: (output: string) => {
          for (const file of files) writeFileSync(join(source, file), "changed after verification")
          writeFileSync(output, "mock compiled binary")
          return Promise.resolve()
        },
        guestfish: (_disk: string, commands: string[][], readonly: boolean) => {
          calls.push({ commands, readonly })
          return Promise.resolve(readonly ? read : "")
        },
      }
      const attempt = () => stage(disk, state, bundle, digest, "4.5.0", 1, true, deps)
      const alias = join(state, "hardlink-to-disk")
      linkSync(disk, alias)
      await expect(attempt()).rejects.toThrow("disk ownership")
      expect(calls).toEqual([])
      unlinkSync(alias)
      await expect(attempt()).rejects.toThrow("no write attempted")
      expect(calls.map((call) => call.readonly)).toEqual([true])
      read = response
      for (const file of files) {
        calls.length = 0
        writeFileSync(join(source, file), "changed before verification")
        await expect(attempt()).rejects.toThrow("early boot SHA-256 mismatch: " + file)
        expect(calls.map((c) => c.readonly)).toEqual([true])
        expect(existsSync(join(state, "t1os-guest-platform"))).toBe(false)
        copyFileSync(join(PLATFORM_FILES, file), join(source, file))
      }
      calls.length = 0
      await attempt()
      expect(calls.map((call) => call.readonly)).toEqual([true, false])
      const writes = calls[1]?.commands ?? []
      expect(writes).toContainEqual(["set-network", "false"])
      expect(writes).toContainEqual(["ln-s", "/dev/null", "/etc/systemd/system/sshd.socket"])
      expect(writes).toContainEqual([
        "ln-s",
        "/dev/null",
        "/etc/systemd/system/display-manager.service",
      ])
      expect(writes).toContainEqual(["upload", bundle, `${BOOTSTRAP}/t1os.tar`])
      expect(writes).toContainEqual([
        "upload",
        join(state, "t1os-guest-platform"),
        `${BOOTSTRAP}/t1os-guest-platform`,
      ])
      expect(writes).toContainEqual(["upload", join(state, "qa-power-button.conf"), QA_POWER])
      expect(writes).toContainEqual(["upload", join(state, UNIT), "/etc/systemd/system/" + UNIT])
      for (const file of files) {
        expect(readFileSync(join(state, file))).toEqual(readFileSync(join(PLATFORM_FILES, file)))
        expect(readFileSync(join(source, file), "utf8")).toBe("changed after verification")
      }
      expect(await Bun.file(join(PLATFORM_FILES, "qa-power-button.conf")).text()).toContain(
        "HandlePowerKey=poweroff",
      )
      expect(await Bun.file(join(PLATFORM_FILES, UNIT)).text()).toContain(
        `ExecStart=${BOOTSTRAP}/t1os-guest-platform bootstrap`,
      )
      expect(writes.some((command) => command[0] === "command")).toBe(false)
    })
  })
})

const mockQemu = `
import { createInterface } from "node:readline";
const [mode, serial, marker] = process.argv.slice(1);
const line = createInterface({input: process.stdin})[Symbol.asyncIterator]();
console.log(JSON.stringify({QMP:{}}));
if (JSON.parse((await line.next()).value).execute !== "qmp_capabilities") process.exit(3);
console.log(JSON.stringify({return:{},id:"caps"}));
const shutdown = reason => console.log(JSON.stringify({event:"SHUTDOWN",data:{guest:reason.startsWith("guest"),reason}}));
if (mode === "installed" || mode === "stale" || mode === "oversized") {
  await Bun.write(serial, mode === "oversized" ? "x".repeat(1024 ** 2 + 1) : marker);
  if (mode === "installed") {
    if (JSON.parse((await line.next()).value).execute !== "system_powerdown") process.exit(4);
    shutdown("guest-shutdown");
  } else if (mode === "stale") shutdown("guest-shutdown");
} else if (mode === "stock") shutdown("guest-reset");
else if (mode === "host") shutdown("host-qmp-quit");
process.exit(0);
`

test("QMP qualification requires current authentic guest event and exact LF-terminated release receipt", async () => {
  await withScratch(async (state) => {
    const serial = join(state, "serial.log")
    const run = (mode: string, marker: string, expected?: string) =>
      runQmp([process.execPath, "-e", mockQemu, mode, serial, marker], {
        phase: mode,
        serial,
        digest: expected,
        deadline: performance.now() + 1500,
      })
    const exact = `T1OS_READY ${digest}`
    await run("stock", "")
    await run("installed", exact + "\r\n", digest)
    await expect(run("host", "")).rejects.toThrow("unexpected guest")
    await expect(run("installed", "T1OS_FAILED\n", digest)).rejects.toThrow("reported failure")
    await expect(run("oversized", "", digest)).rejects.toThrow("oversized serial")
    await expect(run("stale", exact + "\r", digest)).rejects.toThrow("unexpected guest")
    await expect(run("stale", `${exact}.suffix\n`, digest)).rejects.toThrow("unexpected guest")
    writeFileSync(serial, exact + "\n")
    await expect(run("stale", "T1OS_READY " + "b".repeat(64) + "\n", digest)).rejects.toThrow(
      "unexpected guest",
    )
  })
})
