import { dlopen } from "bun:ffi"
import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
  writeSync,
  unlinkSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"

import { Effect } from "effect"

import { buildGuestExecutable } from "./build-bundle"
import { MAX_BYTES } from "./overlay"

/** Source path of the reviewed systemd and logind configuration fragments. */
export const PLATFORM_FILES = resolve(import.meta.dir, "../../../platform")
/** Directory reserved for offline installation in the disposable guest. */
export const BOOTSTRAP = "/opt/t1os/bootstrap"
/** Guest bootstrap unit installed alongside the compiled Bun executable. */
export const UNIT = "t1os-bootstrap.service"
/** Logind setting scoped to offline acceptance guests. */
export const QA_POWER = "/etc/systemd/logind.conf.d/99-t1os-disposable-power-button.conf"
// These two files execute/configure the guest before it verifies the overlay. Their
// pins belong to this reviewed harness, never to media or to the live checkout.
const earlyBootPins = {
  [UNIT]: "00cddd25bffaa1e34db11f398fa8932e4e2bc1439be7eec6b68053f52f7b44d3",
  "qa-power-button.conf": "c30b2e61312251cb053741ff6c0f131435036f294de8ed0ddcae49febc6a163f",
} as const
function pinnedEarlyBootFile(source: string, name: keyof typeof earlyBootPins): Buffer {
  const fd = openSync(
    join(source, name),
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  )
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size < 1 || info.size > 64 * 1024)
      throw new Error("unexpected early boot file: " + name)
    const bytes = Buffer.alloc(info.size)
    for (let offset = 0; offset < bytes.length;) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!n) throw new Error("incomplete early boot file: " + name)
      offset += n
    }
    if (createHash("sha256").update(bytes).digest("hex") !== earlyBootPins[name])
      throw new Error("early boot SHA-256 mismatch: " + name)
    return bytes
  } finally {
    closeSync(fd)
  }
}
const LOGIND = dirname(QA_POWER)
const UNIT_DIR = "/etc/systemd/system"
const ROOT_PARTITION = "/dev/sda2"
const MAX_SERIAL = 1024 ** 2
const digestPattern = /^[0-9a-f]{64}$/u
const SAFE_PHASES = new Set(
  ["machine-verified", "preparing-candidate", "candidate-promoted", "current-boot-verified"].map(
    (name) => "T1OS_PHASE " + name,
  ),
)

/** Freeze the operator-approved regular archive into private staging and verify the exact bytes. */
export function bundleInput(source: string, expected: string, state: string) {
  if (!digestPattern.test(expected))
    throw new Error("bundle requires a trusted full lowercase SHA-256")
  const target = join(state, "verified-overlay.tar")
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size <= 0 || info.size > MAX_BYTES)
      throw new Error("bundle must be a nonempty regular tar no larger than the overlay size limit")
    const out = openSync(target, "wx", 0o600)
    try {
      const digest = createHash("sha256")
      const buffer = Buffer.allocUnsafe(1024 ** 2)
      for (let remaining = info.size; remaining > 0;) {
        const n = readSync(fd, buffer, 0, Math.min(remaining, buffer.length), null)
        if (n === 0) throw new Error("bundle changed while copying")
        let offset = 0
        while (offset < n) offset += writeSync(out, buffer, offset, n - offset)
        digest.update(buffer.subarray(0, n))
        remaining -= n
      }
      if (digest.digest("hex") !== expected)
        throw new Error("bundle SHA-256 does not match the trusted pin")
    } finally {
      closeSync(out)
    }
  } finally {
    closeSync(fd)
  }
  return target
}

type Guestfish = (
  disk: string,
  commands: string[][],
  readonly: boolean,
  timeout: number,
  tcg: boolean,
) => Promise<string>
const guestfishCommands: Guestfish = (disk, commands, readonly, timeout, tcg) =>
  Effect.runPromise(
    Effect.tryPromise(async () => {
      const env = { ...process.env, LIBGUESTFS_BACKEND: "direct" }
      Object.assign(env, tcg ? { LIBGUESTFS_BACKEND_SETTINGS: "force_tcg" } : {})
      const args = commands.flatMap((command, index) => (index ? [":", ...command] : command))
      const result = Bun.spawn(
        ["guestfish", readonly ? "--ro" : "--rw", "--format=qcow2", "-a", disk, "--", ...args],
        {
          env,
          stdout: "pipe",
          stderr: "pipe",
          timeout: timeout * 1000,
          killSignal: "SIGKILL",
        },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(result.stdout).text(),
        new Response(result.stderr).text(),
        result.exited,
      ])
      if (code !== 0) throw new Error(`guestfish failed: ${stderr.trim()}`)
      return stdout
    }),
  )

/** Restrict offline staging to a private, singly linked disk created by this harness. */
export async function stage(
  disk: string,
  state: string,
  bundle: string,
  digest: string,
  version: string,
  timeout: number,
  tcg: boolean,
  tools = { guestfish: guestfishCommands, compile: buildGuestExecutable, source: PLATFORM_FILES },
) {
  const root = lstatSync(state)
  if (
    dirname(disk) !== state ||
    disk !== join(state, "disposable.qcow2") ||
    !root.isDirectory() ||
    root.uid !== process.geteuid?.() ||
    (root.mode & 0o077) !== 0
  )
    throw new Error("staging is restricted to the harness's fresh private disk")
  const diskInfo = lstatSync(disk)
  if (
    !diskInfo.isFile() ||
    diskInfo.uid !== process.geteuid?.() ||
    (diskInfo.mode & 0o077) !== 0 ||
    diskInfo.nlink !== 1
  )
    throw new Error("invalid disposable disk ownership or permissions")
  const read = [
    ["set-network", "false"],
    ["run"],
    ["vfs-type", ROOT_PARTITION],
    ["mount-vfs", "ro,subvol=@", "btrfs", ROOT_PARTITION, "/"],
    ["is-file", "/usr/lib/systemd/system/multi-user.target"],
    ["is-dir", "/opt"],
    ["is-dir", "/etc"],
    ["is-dir", UNIT_DIR],
    ["is-symlink", "/etc/systemd"],
    ["is-symlink", LOGIND],
    ["exists", QA_POWER],
    ["is-symlink", QA_POWER],
    ["is-symlink", `${UNIT_DIR}/multi-user.target.wants`],
    ["exists", `${UNIT_DIR}/${UNIT}`],
    ["is-symlink", `${UNIT_DIR}/${UNIT}`],
    ["exists", "/opt/t1os"],
    ["is-symlink", "/opt/t1os"],
    ["glob-expand", `/var/lib/pacman/local/omarchy-${version}-*/desc`],
    ["umount-all"],
  ]
  const lines = (await tools.guestfish(disk, read, true, timeout, tcg)).trimEnd().split(/\r?\n/u)
  const expected = ["btrfs", "true", "true", "true", "true", ...Array<string>(9).fill("false")]
  const packagePath = lines.at(-1)
  const prefix = `/var/lib/pacman/local/omarchy-${version}-`
  if (
    lines.length !== expected.length + 1 ||
    expected.some((value, i) => value !== lines[i]) ||
    !packagePath?.startsWith(prefix) ||
    !/^[^/\s]+\/desc$/u.test(packagePath.slice(prefix.length))
  )
    throw new Error("expected a fresh installed Omarchy Btrfs root; no write attempted")

  const unitBytes = pinnedEarlyBootFile(tools.source, UNIT)
  const powerBytes = pinnedEarlyBootFile(tools.source, "qa-power-button.conf")
  // Upload the private snapshots of the bytes that passed verification, not their source paths.
  const unitFile = join(state, UNIT),
    powerFile = join(state, "qa-power-button.conf")
  writeFileSync(unitFile, unitBytes, { mode: 0o400, flag: "wx" })
  writeFileSync(powerFile, powerBytes, { mode: 0o400, flag: "wx" })
  const digestFile = join(state, "bundle-sha256")
  writeFileSync(digestFile, digest + "\n", { mode: 0o600, flag: "wx" })
  const executable = join(state, "t1os-guest-platform")
  await tools.compile(executable)
  const trusted: [string, string, string][] = [
    [executable, `${BOOTSTRAP}/t1os-guest-platform`, "0755"],
    [bundle, `${BOOTSTRAP}/t1os.tar`, "0600"],
    [digestFile, `${BOOTSTRAP}/expected-sha256`, "0600"],
    [unitFile, `${UNIT_DIR}/${UNIT}`, "0644"],
    [powerFile, QA_POWER, "0644"],
  ]
  const write = [
    ["set-network", "false"],
    ["run"],
    ["mount-vfs", "rw,subvol=@", "btrfs", ROOT_PARTITION, "/"],
    ["mkdir-p", BOOTSTRAP],
    ["mkdir-p", LOGIND],
    ["chown", "0", "0", "/opt/t1os"],
    ["chown", "0", "0", BOOTSTRAP],
    ["chmod", "0755", "/opt/t1os"],
    ["chmod", "0700", BOOTSTRAP],
    ["mkdir-p", `${UNIT_DIR}/multi-user.target.wants`],
  ]
  for (const [source, destination, mode] of trusted) {
    if (!lstatSync(source).isFile()) throw new Error(`expected regular bootstrap input: ${source}`)
    write.push(
      ["upload", source, destination],
      ["chown", "0", "0", destination],
      ["chmod", mode, destination],
    )
  }
  const aliases: [string, string][] = [
    ["default.target", "/usr/lib/systemd/system/multi-user.target"],
    ["sshd.service", "/dev/null"],
    ["sshd.socket", "/dev/null"],
    ["display-manager.service", "/dev/null"],
    [`multi-user.target.wants/${UNIT}`, `../${UNIT}`],
  ]
  for (const [name, target] of aliases)
    write.push(["rm-f", `${UNIT_DIR}/${name}`], ["ln-s", target, `${UNIT_DIR}/${name}`])
  write.push(["sync"], ["umount-all"])
  await tools.guestfish(disk, write, false, timeout, tcg)
}

/** Asynchronous bounded line parser for QMP's private stdout pipe. */
export async function* qmpRecords(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let pending = ""
    while (true) {
      const next = await reader.read()
      if (next.done) {
        if (pending || decoder.decode()) throw new Error("incomplete QMP record")
        return
      }
      pending += decoder.decode(next.value, { stream: true })
      if (pending.length > MAX_SERIAL) throw new Error("oversized QMP record")
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) {
        const record: unknown = JSON.parse(line)
        if (typeof record !== "object" || record === null) throw new Error("invalid QMP record")
        yield record
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Terminate and reap an unfinished local QEMU child, bounded even if it ignores SIGTERM. */
export async function stopQemu(qemu: {
  exitCode: number | null
  signalCode: string | number | null
  kill(signal?: number | NodeJS.Signals): void
  exited: Promise<number>
}) {
  if (qemu.exitCode !== null || qemu.signalCode !== null) return
  qemu.kill("SIGTERM")
  const timer = setTimeout(() => qemu.kill("SIGKILL"), 10_000)
  try {
    await qemu.exited
  } finally {
    clearTimeout(timer)
  }
}

function serialRecords(path: string, position: number) {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (ex) {
    if (ex instanceof Error && "code" in ex && ex.code === "ENOENT") return Buffer.alloc(0)
    throw ex
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size < position || info.size > MAX_SERIAL)
      throw new Error("invalid or oversized serial log")
    const buffer = Buffer.allocUnsafe(info.size - position)
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, position))
  } finally {
    closeSync(fd)
  }
}

interface QmpRun {
  phase: string
  serial: string
  deadline: number
  digest?: string | undefined
}

/** Require the authentic installer reset or an exact matching receipt plus orderly guest shutdown. */
export async function runQmp(command: string[], { phase, serial, deadline, digest }: QmpRun) {
  try {
    unlinkSync(serial)
  } catch (ex) {
    if (!(ex instanceof Error && "code" in ex && ex.code === "ENOENT")) throw ex
  }
  const expected = digest ? `T1OS_READY ${digest}` : undefined
  let ready = false
  let shutdown = false
  let initialized = false
  let negotiated = false
  let nextPowerRequest = 0
  let position = 0
  let pending = ""
  const reported = new Set<string>()
  const qemu = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
  const records = qmpRecords(qemu.stdout)
  let record: IteratorResult<object> | undefined
  let readFailure: unknown
  const startRead = () => {
    record = undefined
    void records.next().then(
      (result) => {
        record = result
      },
      (error) => {
        readFailure = error
      },
    )
  }
  startRead()
  try {
    while (performance.now() < deadline) {
      if (expected && !shutdown) {
        const bytes = serialRecords(serial, position)
        position += bytes.length
        // Latin-1 preserves exact bytes; process only records actually terminated by LF.
        const fields = (pending + bytes.toString("latin1")).split("\n")
        pending = fields.pop() ?? ""
        for (const field of fields) {
          const label = field.replace(/\r+$/u, "")
          if (SAFE_PHASES.has(label) && !reported.has(label)) {
            console.log(`${phase}: ${label}`)
            reported.add(label)
          }
          if (label === "T1OS_FAILED") throw new Error(`${phase}: guest bootstrap reported failure`)
          if (label === expected && !ready) {
            ready = true
            console.log(`${phase}: verified release receipt; waiting for orderly guest shutdown.`)
          }
        }
      }
      if (readFailure !== undefined) throw readFailure
      const message: IteratorResult<object> | undefined = record
      if (message?.done) {
        if (qemu.exitCode === null && qemu.signalCode === null) {
          await Bun.sleep(20)
          continue
        }
        if (shutdown && qemu.exitCode === 0) return
        throw new Error(`${phase}: QEMU exited without the required guest event`)
      }
      if (message) {
        const { value } = message
        if ("QMP" in value && !initialized) {
          initialized = true
          await qemu.stdin.write('{"execute":"qmp_capabilities","id":"caps"}\n')
          await qemu.stdin.flush()
        }
        if ("error" in value) throw new Error(`${phase}: QMP command failed`)
        if ("id" in value && value.id === "caps" && "return" in value) negotiated = initialized
        if ("event" in value && value.event === "SHUTDOWN") {
          const data = "data" in value ? value.data : undefined
          if (
            !negotiated ||
            !data ||
            typeof data !== "object" ||
            !("guest" in data) ||
            data.guest !== true ||
            !("reason" in data) ||
            data.reason !== (expected ? "guest-shutdown" : "guest-reset") ||
            (expected && (!ready || nextPowerRequest === 0))
          )
            throw new Error(`${phase}: unexpected guest shutdown reason or order`)
          shutdown = true
        }
        startRead()
      }
      if (negotiated && ready && !shutdown && performance.now() >= nextPowerRequest) {
        await qemu.stdin.write('{"execute":"system_powerdown","id":"shutdown"}\n')
        await qemu.stdin.flush()
        nextPowerRequest = performance.now() + 10_000
      }
      await Bun.sleep(20)
    }
    const waiting = expected
      ? ready
        ? "orderly shutdown after verified receipt"
        : "verified first-boot marker"
      : "stock installer reboot"
    throw new Error(`${phase}: timed out waiting for ${waiting}`)
  } finally {
    await stopQemu(qemu)
    await records.return(undefined)
  }
}

/** Validate actual device accessibility and KVM_GET_API_VERSION without changing permissions. */
export function verifyKvmAccess(device = "/dev/kvm") {
  try {
    const libc = dlopen("libc.so.6", { ioctl: { args: ["i32", "u64", "u64"], returns: "i32" } })
    try {
      const fd = openSync(device, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        if (!fstatSync(fd).isCharacterDevice() || libc.symbols.ioctl(fd, 0xae00n, 0n) !== 12)
          throw new Error("KVM API version 12 required")
      } finally {
        closeSync(fd)
      }
    } finally {
      libc.close()
    }
  } catch (cause) {
    throw new Error("host runner lacks KVM device access; guest boot not verified", { cause })
  }
}
