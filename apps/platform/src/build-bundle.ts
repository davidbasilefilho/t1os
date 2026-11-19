import { createHash } from "node:crypto"
import {
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeSync,
  closeSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { allowed, androidProfileFiles, MAX_BYTES, MAX_ENTRIES } from "./overlay.ts"

const root = resolve(import.meta.dir, "../../..")
const holyAgentDigest =
  "9c8f4341d79b1213ba3bb9499a0a00a65c3eb0e6172e8a3e4d88f443befcccfffe" +
  "882f137b9b8414607e4e4c8fc061ccff766de0815590a600481c56cd36590e"
const holyAgentPath = "runtime/agent/holyagent-0.3.3.tgz"
const guestPath = "bin/t1os-guest-platform"
const required = [
  "platform/first-boot",
  "platform/t1os-first-boot.service",
  "runtime/install.sh",
  ...androidProfileFiles,
]
const blockSize = 512

function git(...args: string[]): Buffer {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stderr: "pipe" })
  if (!result.success) {
    throw new Error(result.stderr.toString().trim() || `git ${args[0]} failed`)
  }
  return result.stdout
}

function requireCleanSource(commit: string) {
  if (
    !/^[0-9a-f]{40}$/u.test(commit) ||
    git("rev-parse", "HEAD").toString().trim() !== commit ||
    git("rev-parse", `${commit}^{commit}`).toString().trim() !== commit
  ) {
    throw new Error("--commit must be the full SHA of the checked-out commit")
  }
  const sourcePaths = [
    "apps",
    "packages",
    "tsconfig.json",
    "package.json",
    "bun.lock",
    "bunfig.toml",
  ]
  if (
    git("status", "--porcelain=v1", "--untracked-files=all", "--", ...sourcePaths).length ||
    git("ls-files", "-oz", "--ignored", "--exclude-standard", "--", ...sourcePaths)
      .toString()
      .split("\0")
      .some((path) => path && !path.split("/").includes("node_modules"))
  ) {
    throw new Error("compile from a clean first-party checkout with frozen dependencies")
  }
  for (const entry of git("ls-tree", "-rz", commit, "--", ...sourcePaths)
    .toString()
    .split("\0")
    .filter(Boolean)) {
    const match = /^100(?:644|755) blob ([0-9a-f]{40})\t([^\t\r\n]+)$/u.exec(entry)
    if (!match?.[1] || !match[2]) {
      throw new Error("guest source must consist of committed regular files")
    }
    const file = join(root, match[2])
    if (lstatSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
      throw new Error(`expected a regular guest source: ${match[2]}`)
    }
    const content = readFileSync(file)
    const hash = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex")
    if (hash !== match[1]) throw new Error(`guest source does not match the commit: ${match[2]}`)
  }
}

/** Build the standalone x86_64 Linux guest bootstrap from a clean checkout. */
export async function buildGuestExecutable(outputPath: string): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64" || Bun.version !== "1.4.4") {
    throw new Error("building the guest bootstrap requires Linux x86_64 and the pinned Bun")
  }
  const commit = git("rev-parse", "HEAD").toString().trim()
  requireCleanSource(commit)
  const tmp = mkdtempSync(join(dirname(resolve(outputPath)), ".t1os-guest-"))
  try {
    const bin = join(tmp, "t1os-guest-platform")
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--minify",
        "apps/platform/src/guest.ts",
        "--outfile",
        bin,
      ],
      { cwd: root, stderr: "pipe", stdout: "pipe" },
    )
    if (!result.success) throw new Error(result.stderr.toString() || "guest compilation failed")
    requireCleanSource(commit)
    const fd = openSync(bin, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      assertElf(fd, "guest bootstrap")
    } finally {
      closeSync(fd)
    }
    linkSync(bin, outputPath)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function assertElf(fd: number, name: string) {
  const magic = Buffer.alloc(20)
  if (
    readSync(fd, magic, 0, magic.length, 0) !== magic.length ||
    magic[0] !== 0x7f ||
    magic[1] !== 0x45 ||
    magic[2] !== 0x4c ||
    magic[3] !== 0x46 ||
    magic[4] !== 2 ||
    magic[5] !== 1 ||
    magic[18] !== 0x3e ||
    magic[19] !== 0
  ) {
    throw new Error(`${name} must be a standalone Linux x86_64 ELF executable`)
  }
}

function tarHeader(name: string, size: number, mode: number, type: "0" | "x"): Buffer {
  const header = Buffer.alloc(blockSize)
  header.write(name, 0, 100)
  for (const [number, offset, width] of [
    [mode, 100, 8],
    [0, 108, 8],
    [0, 116, 8],
    [size, 124, 12],
    [0, 136, 12],
  ] as const) {
    header.write(number.toString(8).padStart(width - 1, "0"), offset)
  }
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write("ustar\0", 257)
  header.write("00", 263)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148)
  return header
}

function paxPath(name: string): Buffer {
  const body = ` path=${name}\n`
  let size = Buffer.byteLength(body)
  while (Buffer.byteLength(body) + String(size).length !== size) {
    size = Buffer.byteLength(body) + String(size).length
  }
  return Buffer.from(`${size}${body}`)
}

/** Write deterministic, bounded regular-file entries and emit a streaming SHA-256 receipt. */
export class BundleWriter {
  readonly #hash = createHash("sha256")
  readonly #names = new Set<string>()
  #size = 0
  readonly #chunk = Buffer.allocUnsafe(1024 * 1024)

  constructor(private readonly fd: number) {}

  #write(data: Uint8Array) {
    if (this.#size + data.byteLength > MAX_BYTES) throw new Error("bundle exceeds size limit")
    for (let offset = 0; offset < data.byteLength;) {
      const sent = writeSync(this.fd, data, offset, data.byteLength - offset)
      if (sent <= 0) throw new Error("bundle write failed")
      offset += sent
    }
    this.#hash.update(data)
    this.#size += data.byteLength
  }

  #pad(size: number) {
    const padding = (blockSize - (size % blockSize)) % blockSize
    if (padding) this.#write(Buffer.alloc(padding))
  }

  #entry(name: string, size: number, mode: number, writeContents: () => void) {
    if (!allowed(name) || /[\p{C}\r\n]/u.test(name) || this.#names.has(name)) {
      throw new Error(`unexpected bundle entry: ${name}`)
    }
    if (this.#names.size >= MAX_ENTRIES) throw new Error("bundle exceeds entry limit")
    this.#names.add(name)
    const usePax = Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/u.test(name)
    if (usePax) {
      const extended = paxPath(name)
      this.#write(tarHeader("PaxPath", extended.length, 0o644, "x"))
      this.#write(extended)
      this.#pad(extended.length)
    }
    this.#write(tarHeader(usePax ? "PaxEntry" : name, size, mode & 0o111 ? 0o755 : 0o644, "0"))
    const before = this.#size
    writeContents()
    if (this.#size - before !== size) throw new Error(`bundle entry size changed: ${name}`)
    this.#pad(size)
  }

  /** Add bytes from a validated source, such as an immutable Git blob. */
  bytes(name: string, bytes: Uint8Array, mode: number) {
    this.#entry(name, bytes.byteLength, mode, () => this.#write(bytes))
  }

  /** Add a regular file by its no-follow descriptor, not by an unchecked second path lookup. */
  file(name: string, path: string, forceMode?: number, expectedSha512?: string, elf?: boolean) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = fstatSync(fd, { bigint: true })
      if (!before.isFile() || before.size > BigInt(MAX_BYTES)) {
        throw new Error(`unexpected or oversized tool file: ${path}`)
      }
      if (elf) assertElf(fd, name)
      const hash = expectedSha512 ? createHash("sha512") : undefined
      const size = Number(before.size)
      this.#entry(name, size, forceMode ?? Number(before.mode), () => {
        for (let remaining = size; remaining > 0;) {
          const length = readSync(fd, this.#chunk, 0, Math.min(remaining, this.#chunk.length), null)
          if (length <= 0) throw new Error(`bundle input shrank: ${path}`)
          const data = this.#chunk.subarray(0, length)
          hash?.update(data)
          this.#write(data)
          remaining -= length
        }
      })
      const after = fstatSync(fd, { bigint: true })
      if (
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        throw new Error(`file changed during bundle build: ${path}`)
      }
      if (hash && hash.digest("hex") !== expectedSha512) {
        throw new Error("HolyAgent archive failed the pinned registry SHA-512")
      }
    } finally {
      closeSync(fd)
    }
  }

  /** Finalize the tar and return the hash of exactly the bytes written. */
  finish(): string {
    this.#write(Buffer.alloc(2 * blockSize))
    fsyncSync(this.fd)
    return this.#hash.digest("hex")
  }
}

function addTools(bundle: BundleWriter, directory: string, prefix: string) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    // Resolve children relative to the opened directory, even if a parent is renamed.
    const pinned = `/proc/self/fd/${fd}`
    for (const name of readdirSync(pinned).sort()) {
      const diskPath = join(pinned, name)
      const relativePath = `${prefix}/${name}`
      const info = lstatSync(diskPath)
      if (info.isDirectory() && allowed(`${relativePath}/fixture`)) {
        addTools(bundle, diskPath, relativePath)
      } else if (info.isFile()) {
        bundle.file(relativePath, diskPath)
      } else {
        throw new Error(`unexpected tool path: ${relativePath}`)
      }
    }
  } finally {
    closeSync(fd)
  }
}

function addCommittedSources(bundle: BundleWriter, commit: string) {
  const seen = new Set<string>()
  for (const entry of git("ls-tree", "-rz", commit, "--", ...required, "runtime")
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort()) {
    const match = /^(100(?:644|755)) blob ([0-9a-f]{40})\t([^\t\r\n]+)$/u.exec(entry)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(`unexpected bundle source: ${entry}`)
    }
    const [, mode, oid, name] = match
    if (name === holyAgentPath) throw new Error("HolyAgent registry archive must not be committed")
    if (name.startsWith("runtime/tests/")) continue
    bundle.bytes(name, git("cat-file", "blob", oid), Number.parseInt(mode, 8))
    seen.add(name)
  }
  if (!required.every((name) => seen.has(name))) {
    throw new Error("selected commit does not contain all required platform inputs")
  }
}

/** Build a plain tar and print its trusted separate-channel digest. */
export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      commit: { type: "string" },
      cli: { type: "string" },
      holyagent: { type: "string" },
      "agent-tools": { type: "string" },
      output: { type: "string" },
    },
  })
  const { cli, commit, holyagent, output } = values
  const agentTools = values["agent-tools"]
  if (!commit || !output) throw new Error("--commit and --output are required")
  if (Boolean(holyagent) !== Boolean(agentTools)) {
    throw new Error("full agent profile requires both --agent-tools and --holyagent")
  }
  requireCleanSource(commit)
  if (existsSync(output)) throw new Error("bundle output already exists")
  const tmp = mkdtempSync(join(dirname(resolve(output)), ".t1os-bundle-"))
  try {
    const guest = join(tmp, basename(guestPath))
    const tar = join(tmp, "overlay.tar")
    await buildGuestExecutable(guest)
    requireCleanSource(commit)
    const fd = openSync(tar, "wx", 0o600)
    let digest: string
    try {
      const bundle = new BundleWriter(fd)
      addCommittedSources(bundle, commit)
      bundle.file(guestPath, guest, 0o755)
      if (cli) bundle.file("bin/t1os", cli, 0o755, undefined, true)
      if (holyagent && agentTools) {
        bundle.file(holyAgentPath, holyagent, 0o644, holyAgentDigest)
        addTools(bundle, agentTools, "agent-host")
      }
      digest = bundle.finish()
    } finally {
      closeSync(fd)
    }
    linkSync(tar, output)
    console.log(`${digest}  ${output}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (err) {
    console.error("t1os bundle:", err instanceof Error ? err.message : err)
    process.exitCode = 1
  }
}
