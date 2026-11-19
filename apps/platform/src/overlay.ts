import { createHash } from "node:crypto"
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

import { DIGEST } from "./guest-system.ts"

/** Maximum bytes for both the input archive and unpacked content. */
export const MAX_BYTES = 1280 * 1024 ** 2
/** Maximum number of regular files in an overlay. */
export const MAX_ENTRIES = 40_000
const BLOCK = 512
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const required = new Map([
  ["platform/first-boot", true],
  ["platform/t1os-first-boot.service", false],
  ["runtime/install.sh", true],
  ["bin/t1os-guest-platform", true],
])

/** Exact inventory of shipped Android controls: no SDK, licenses, device keys or test scripts. */
export const androidProfileFiles = [
  "apps/device-hub/src/profile.ts",
  "apps/device-hub/src/sdk.ts",
  "apps/device-hub/src/lock.ts",
  "runtime/android/android.conf",
  "runtime/android/t1os-android.service",
  "runtime/android/README.md",
] as const

/** Allow only known overlay roots and safe regular path components. */
export function allowed(name: string): boolean {
  if (
    Buffer.byteLength(name) > 4096 ||
    /[\p{C}\p{Zl}\p{Zp}]/u.test(name) ||
    name.split("/").some((part) => !part || part.startsWith(".") || Buffer.byteLength(part) > 255)
  )
    return false
  if (name.startsWith("apps/") || name.startsWith("runtime/android/"))
    return androidProfileFiles.some((path) => path === name)
  if (name.startsWith("agent-host/pi-deps/node_modules/")) {
    // Pinned dependency assets include Unicode filenames and spaces, but never control characters.
    return !/[\\\p{C}\p{Zl}\p{Zp}]/u.test(name)
  }
  return /^(?:runtime\/[A-Za-z0-9_.@/-]+|platform\/(?:first-boot|t1os-first-boot\.service)|bin\/(?:t1os|t1os-guest-platform)|agent-host\/(?:bin|pi-deps|t3-release)\/[A-Za-z0-9_.@+$/-]+)$/.test(
    name,
  )
}

/** Read a stat-bounded snapshot from an already-open file. */
export function consumeMedia(fd: number, size: number, accept: (block: Buffer) => void): void {
  const buffer = Buffer.allocUnsafe(Math.min(1_048_576, size))
  for (let offset = 0; offset < size;) {
    const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset)
    if (read === 0) throw new Error("bundle shrank while copying")
    offset += read
    accept(buffer.subarray(0, read))
  }
}

function readExact(fd: number, amount: number, offset: number): Buffer {
  const buffer = Buffer.allocUnsafe(amount)
  for (let n = 0; n < amount;) {
    const read = readSync(fd, buffer, n, amount - n, offset + n)
    if (read === 0) throw new Error("truncated overlay tar")
    n += read
  }
  return buffer
}

function field(header: Buffer, start: number, end: number): string {
  const bytes = header.subarray(start, end)
  const zero = bytes.indexOf(0)
  return decoder.decode(zero === -1 ? bytes : bytes.subarray(0, zero))
}

function octal(text: string): number {
  if (!/^[0-7]+$/.test(text.trim())) throw new Error("invalid tar number")
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value)) throw new Error("invalid tar number")
  return value
}

/** Recognize only the per-entry POSIX extensions emitted by the bundle builder. */
function paxPath(bytes: Buffer): string | undefined {
  const seen = new Set<string>()
  let path: string | undefined
  for (let offset = 0; offset < bytes.length;) {
    const separator = bytes.indexOf(32, offset)
    const digit = bytes.subarray(offset, separator).toString("ascii")
    if (separator === -1 || !/^[1-9][0-9]{0,4}$/.test(digit))
      throw new Error("invalid PAX record length")
    const end = offset + Number(digit)
    if (end <= separator + 2 || end > bytes.length || bytes[end - 1] !== 10)
      throw new Error("invalid PAX record boundary")
    const record = decoder.decode(bytes.subarray(separator + 1, end - 1))
    const equal = record.indexOf("=")
    const key = record.slice(0, equal)
    const value = record.slice(equal + 1)
    if (equal < 1 || seen.has(key)) throw new Error("invalid PAX record")
    seen.add(key)
    if (key === "path") path = value
    else if (!/^(?:mtime|atime|ctime)$/.test(key) || !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value))
      throw new Error("unsupported PAX record")
    offset = end
  }
  return path
}

/**
 * Unpack bounded regular files into an empty, private directory; never invoke tar on untrusted
 * data.
 */
export function unpack(fd: number, destination: string): void {
  const size = fstatSync(fd).size
  if (size > MAX_BYTES || size % BLOCK !== 0) throw new Error("invalid overlay tar length")
  const names = new Map<string, boolean>()
  let offset = 0
  let pax = false
  let longPath: string | undefined
  let total = 0
  while (offset < size) {
    const header = readExact(fd, BLOCK, offset)
    offset += BLOCK
    if (header.every((byte) => byte === 0)) {
      if (pax || size - offset < BLOCK) throw new Error("invalid overlay tar terminator")
      for (let index = offset; index < size; index += 1_048_576) {
        if (readExact(fd, Math.min(1_048_576, size - index), index).some((byte) => byte !== 0))
          throw new Error("nonzero bytes after overlay tar terminator")
      }
      if (
        androidProfileFiles.some((path) => names.has(path)) &&
        !androidProfileFiles.every((path) => names.has(path))
      )
        throw new Error("incomplete Android profile")
      for (const [name, executable] of required) {
        if (!names.has(name) || (executable && !names.get(name)))
          throw new Error(`missing or nonexecutable overlay member: ${name}`)
      }
      return
    }
    const checksum = header.reduce((sum, byte, n) => sum + (n >= 148 && n < 156 ? 32 : byte), 0)
    if (checksum !== octal(field(header, 148, 156)) || field(header, 257, 263) !== "ustar")
      throw new Error("invalid overlay tar header")
    const length = octal(field(header, 124, 136))
    const next = offset + Math.ceil(length / BLOCK) * BLOCK
    if (next > size) throw new Error("truncated overlay tar member")
    const type = header[156]
    if (type === 120) {
      if (pax || length > 16_384) throw new Error("unexpected PAX metadata")
      pax = true
      longPath = paxPath(readExact(fd, length, offset))
    } else {
      const prefix = field(header, 345, 500)
      const name = longPath ?? (prefix ? prefix + "/" : "") + field(header, 0, 100)
      pax = false
      longPath = undefined
      if ((type !== 0 && type !== 48) || !allowed(name) || names.has(name))
        throw new Error(`unexpected bundle entry: ${JSON.stringify(name)}`)
      total += length
      if (total > MAX_BYTES || names.size >= MAX_ENTRIES)
        throw new Error("overlay bundle exceeds size limit")
      const executable = (octal(field(header, 100, 108)) & 0o111) !== 0
      const target = join(destination, name)
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
      const output = openSync(target, "wx", executable ? 0o755 : 0o644)
      try {
        for (let pos = offset; pos < offset + length; pos += 1_048_576) {
          writeFileSync(output, readExact(fd, Math.min(1_048_576, offset + length - pos), pos))
        }
      } finally {
        closeSync(output)
      }
      names.set(name, executable)
    }
    offset = next
  }
  throw new Error("missing overlay tar terminator")
}

/** Hash every supplied archive. New releases are extracted exclusively from a frozen private copy. */
export function stage(bundle: string, expected: string, releases: string): string {
  if (!DIGEST.test(expected)) throw new Error("invalid release digest")
  const target = join(releases, expected)
  const fd = openSync(bundle, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let temporary: string | undefined
  try {
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile() || info.size <= 0n || info.size > BigInt(MAX_BYTES))
      throw new Error("bundle must be a regular tar file no larger than 1280 MiB")
    if (existsSync(target)) {
      const entry = lstatSync(target)
      if (!entry.isDirectory() || entry.uid !== process.geteuid?.() || entry.mode & 0o022)
        throw new Error("unsafe staged release directory")
    } else {
      // existsSync follows links; detect a dangling symlink before staging too.
      if (lstatSync(target, { throwIfNoEntry: false }))
        throw new Error("unsafe staged release directory")
      temporary = mkdtempSync(join(releases, ".stage-"))
    }
    const hash = createHash("sha256")
    const frozen = temporary ? openSync(join(temporary, "archive"), "wx+", 0o600) : undefined
    try {
      consumeMedia(fd, Number(info.size), (block) => {
        hash.update(block)
        if (frozen !== undefined) writeFileSync(frozen, block)
      })
      const after = fstatSync(fd, { bigint: true })
      if (
        after.dev !== info.dev ||
        after.ino !== info.ino ||
        after.size !== info.size ||
        after.mtimeNs !== info.mtimeNs ||
        after.ctimeNs !== info.ctimeNs
      )
        throw new Error("bundle changed during verification")
      if (hash.digest("hex") !== expected)
        throw new Error("overlay SHA-256 does not match the supplied pin")
      if (temporary && frozen !== undefined) {
        const payload = join(temporary, "payload")
        mkdirSync(payload, { mode: 0o755 })
        unpack(frozen, payload)
        renameSync(payload, target)
      }
    } finally {
      if (frozen !== undefined) closeSync(frozen)
    }
    return target
  } finally {
    closeSync(fd)
    if (temporary) rmSync(temporary, { recursive: true, force: true })
  }
}
