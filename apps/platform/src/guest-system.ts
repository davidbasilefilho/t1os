import { spawnSync } from "node:child_process"
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  linkSync,
} from "node:fs"
import { dirname, join } from "node:path"

/** Root-owned release and bootstrap directory. */
export const BASE = "/opt/t1os"
/** Root-owned durable deployment records. */
export const STATE = "/var/lib/t1os"
/** Fixed search path for guest OS commands. */
export const PATH = "/usr/bin:/bin"
/** Exact lower-case SHA-256 token. */
export const DIGEST = /^[0-9a-f]{64}(?![\s\S])/
/** Kernel-boot identifier shape used for current-boot evidence. */
export const BOOT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

/** Run a fixed operating system utility without inheriting environment or standard input. */
export function run(
  args: readonly [string, ...string[]],
  timeout = 120_000,
  capture = true,
): string {
  const [file, ...argv] = args
  const result = spawnSync(file, argv, {
    cwd: "/",
    env: { PATH, LANG: "C" },
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    timeout,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${file} failed (${result.status ?? result.signal})`)
  return result.stdout?.trim() ?? ""
}

/** Require an entirely root-owned path without symlinks or group/world-writable components. */
export function trusted(path: string, directory = false): void {
  const parent = dirname(path)
  if (parent !== path) trusted(parent, true)
  const info = lstatSync(path)
  if (!(directory ? info.isDirectory() : info.isFile()) || info.uid !== 0 || info.mode & 0o022) {
    throw new Error(`unsafe bootstrap input: ${path}`)
  }
}

/** Hold a kernel advisory lock across a single synchronous deployment transaction. */
export function withLock<T>(path: string, action: () => T): T {
  const fd = openSync(
    path,
    constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_CREAT | constants.O_WRONLY,
    0o600,
  )
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.uid !== process.geteuid?.() || info.mode & 0o022) {
      throw new Error(`unsafe lock: ${path}`)
    }
    // flock takes the inherited open file description; the lock lives until we close fd.
    const lock = spawnSync("/usr/bin/flock", ["-x", "3"], {
      cwd: "/",
      env: { PATH, LANG: "C" },
      stdio: ["ignore", "inherit", "inherit", fd],
    })
    if (lock.error) throw lock.error
    if (lock.status !== 0) throw new Error(`cannot lock ${path}`)
    return action()
  } finally {
    closeSync(fd)
  }
}

/** Persist a control record before publication and fsync the containing directory. */
export function record(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
  exclusive = false,
): void {
  const parent = dirname(path)
  const temp = mkdtempSync(join(parent, ".t1os-record-"))
  try {
    const file = join(temp, "record")
    const fd = openSync(file, "wx", mode)
    try {
      writeFileSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (exclusive) linkSync(file, path)
    else renameSync(file, path)
    const dir = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

/** Create and verify a private root-managed directory without following symlinks. */
export function ensureDirectory(path: string, mode: number): void {
  if (!existsSync(path)) mkdirSync(path, { mode })
  trusted(path, true)
}

/** Run a command as the locked-down operator with a clean environment. */
export function asOperator(home: string, ...args: string[]): string {
  return run([
    "runuser",
    "-u",
    "t1os",
    "--",
    "env",
    "-i",
    `HOME=${home}`,
    "USER=t1os",
    "LOGNAME=t1os",
    `PATH=${PATH}`,
    ...args,
  ])
}
