import { createHash } from "node:crypto"
import { constants, createWriteStream } from "node:fs"
import { open } from "node:fs/promises"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"

/** Allowed regular-file or directory entry from a strict tar reader. */
export type TarEntry = { name: string; size: number; mode: number; directory: boolean }

/** Create an exclusive file without following any final-component symlink. */
export async function extractFile(path: string, data: AsyncIterable<Buffer>, mode: number) {
  await pipeline(Readable.from(data), createWriteStream(path, { flags: "wx", mode }))
}

function octal(bytes: Buffer) {
  const value = bytes.toString("ascii").replace(/\0.*$/s, "").trim()
  if (!/^[0-7]+$/.test(value)) throw new Error("unsupported tar numeric encoding")
  const n = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(n)) throw new Error("oversized tar number")
  return n
}

function utf8(bytes: Buffer) {
  const end = bytes.indexOf(0)
  return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end))
}

/**
 * Stream verified archive bytes to explicit destinations; reject links, special entries and
 * traversal.
 */
export async function readTar(
  source: Readable,
  limits: { bytes: number; entries: number },
  consume: (entry: TarEntry, data: AsyncIterable<Buffer>) => Promise<void>,
) {
  let inflated = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      inflated += chunk.length
      if (inflated > limits.bytes + limits.entries * 8192 + 10240) {
        done(new Error("tar exceeds inflated limit"))
      } else done(null, chunk)
    },
  })
  const pumping = pipeline(source, createGunzip(), limiter)
  // Observe pipeline failure even if parsing returns early.
  void pumping.catch(() => {})
  const iterator = limiter[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0)
  const next = async (size: number, allowEnd = false): Promise<Buffer<ArrayBufferLike>> => {
    if (pending.length === 0) {
      const read = await iterator.next()
      if (read.done) {
        if (allowEnd) return pending
        throw new Error("truncated tar archive")
      }
      pending = Buffer.from(read.value as Uint8Array)
    }
    const head = pending.subarray(0, size)
    pending = pending.subarray(head.length)
    return head
  }
  async function* take(size: number): AsyncGenerator<Buffer> {
    while (size > 0) {
      const chunk = await next(size)
      size -= chunk.length
      yield chunk
    }
  }
  const exactly = async (size: number) => {
    const out: Buffer[] = []
    for await (const c of take(size)) out.push(c)
    return Buffer.concat(out, size)
  }
  let total = 0
  let entries = 0
  let longPath: string | undefined
  const seen = new Set<string>()
  try {
    for (;;) {
      const header = await exactly(512)
      if (header.every((byte) => byte === 0)) {
        if (longPath || !(await exactly(512)).every((byte) => byte === 0))
          throw new Error("invalid tar terminator")
        for (let tail = await next(65536, true); tail.length; tail = await next(65536, true)) {
          if (!tail.every((byte) => byte === 0)) throw new Error("unexpected tar trailer")
        }
        await pumping
        return
      }
      const sum = header.reduce(
        (acc, byte, index) => acc + (index >= 148 && index < 156 ? 32 : byte),
        0,
      )
      if (sum !== octal(header.subarray(148, 156))) throw new Error("invalid tar checksum")
      const size = octal(header.subarray(124, 136))
      const mode = octal(header.subarray(100, 108))
      const kind = header[156]
      if (++entries > limits.entries) throw new Error("tar exceeds member limit")
      if (kind === 76) {
        if (
          longPath ||
          size < 2 ||
          size > 4096 ||
          utf8(header.subarray(0, 100)) !== "././@LongLink"
        )
          throw new Error("unsupported tar long name")
        const payload = await exactly(size)
        if (payload.indexOf(0) !== size - 1) throw new Error("invalid tar long name")
        longPath = utf8(payload)
      } else {
        const directory = kind === 53
        if (!(kind === 48 || kind === 0 || (directory && size === 0)))
          throw new Error("unsupported tar archive member")
        const prefix =
          utf8(header.subarray(257, 263)) === "ustar" ? utf8(header.subarray(345, 500)) : ""
        const name = (
          longPath ??
          (prefix ? `${prefix}/${utf8(header.subarray(0, 100))}` : utf8(header.subarray(0, 100)))
        ).replace(directory ? /\/$/ : /$^/, "")
        longPath = undefined
        if (
          name.includes("\\") ||
          Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
          name.split("/").some((part) => !part || part === "." || part === "..") ||
          seen.has(name)
        )
          throw new Error(`unexpected tar archive member: ${name}`)
        seen.add(name)
        total += size
        if (total > limits.bytes) throw new Error("tar exceeds payload limit")
        const contents = take(size)
        await consume({ name, size, mode, directory }, contents)
        if (!(await contents.next()).done) throw new Error("tar member data not consumed")
      }
      for await (const _ of take((512 - (size % 512)) % 512)) {
        // Skip tar alignment.
      }
    }
  } finally {
    limiter.destroy()
    await pumping.catch(() => {})
  }
}

/** Verify a pinned compressed archive and read only from the verified descriptor or buffer. */
export async function verifiedArchive(
  path: string,
  pin: { algorithm: "sha256" | "sha512"; digest: string; size?: number; max: number },
  read: (stream: Readable) => Promise<void>,
) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      info.size <= 0 ||
      info.size > pin.max ||
      (pin.size !== undefined && info.size !== pin.size)
    )
      throw new Error("unexpected pinned release archive size or type")
    // A byte snapshot prevents concurrent writes between integrity verification and extraction.
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < info.size) {
      const { bytesRead } = await handle.read(bytes, offset, info.size - offset, offset)
      if (!bytesRead) throw new Error("truncated pinned release archive")
      offset += bytesRead
    }
    if (createHash(pin.algorithm).update(bytes).digest("hex") !== pin.digest)
      throw new Error(
        `${pin.algorithm === "sha256" ? "SHA-256" : "SHA-512"} does not match pinned release`,
      )
    function* chunks() {
      for (let i = 0; i < bytes.length; i += 65536) yield bytes.subarray(i, i + 65536)
    }
    await read(Readable.from(chunks()))
  } finally {
    await handle.close()
  }
}
