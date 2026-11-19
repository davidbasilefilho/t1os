import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

import { Effect } from "effect"

/** Durable references only; no file contents, environment, tokens or process checkpoint. */
export interface Checkpoint {
  readonly version: 1
  readonly workspace: string
  readonly head: string | null
  readonly holyagentDirectory: boolean
  readonly t3UserdataDirectory: boolean
}

function digest(text: string) {
  return createHash("sha256").update(text).digest("hex")
}
function errorCode(ex: unknown, code: string) {
  return ex instanceof Error && "code" in ex && ex.code === code
}
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
async function presentDir(path: string) {
  try {
    return (await lstat(path)).isDirectory()
  } catch (ex) {
    if (errorCode(ex, "ENOENT")) return false
    throw ex
  }
}
async function privateStore(base: string, create: boolean) {
  if (!isAbsolute(base)) throw new Error("absolute state directory required")
  if (create) await mkdir(base, { mode: 0o700, recursive: true })
  const st = await lstat(base)
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
    throw new Error("checkpoint directory must be private and owned by this user")
  const canonical = await realpath(base)
  if (canonical !== resolve(base)) throw new Error("checkpoint paths must not traverse symlinks")
  return canonical
}
async function readRecord(base: string, id: string): Promise<Checkpoint> {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("expected a checkpoint SHA-256 ID")
  const f = await open(
    join(base, id + ".json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const st = await f.stat()
    if (!st.isFile() || st.size > 32768 || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
      throw new Error("unsafe checkpoint file")
    const text = await f.readFile("utf8")
    if (digest(text) !== id) throw new Error("checkpoint failed integrity check")
    const p: unknown = JSON.parse(text)
    if (
      !p ||
      typeof p !== "object" ||
      !("version" in p) ||
      p.version !== 1 ||
      !("workspace" in p) ||
      typeof p.workspace !== "string" ||
      !isAbsolute(p.workspace) ||
      !("head" in p) ||
      !(p.head === null || (typeof p.head === "string" && shaPattern.test(p.head))) ||
      !("holyagentDirectory" in p) ||
      typeof p.holyagentDirectory !== "boolean" ||
      !("t3UserdataDirectory" in p) ||
      typeof p.t3UserdataDirectory !== "boolean"
    )
      throw new Error("unsupported checkpoint schema")
    return {
      version: 1,
      workspace: p.workspace,
      head: p.head,
      holyagentDirectory: p.holyagentDirectory,
      t3UserdataDirectory: p.t3UserdataDirectory,
    }
  } finally {
    await f.close()
  }
}
function attempt<A>(fn: () => Promise<A>) {
  return Effect.tryPromise({
    try: fn,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}
/** Resolve the operator's private checkpoint directory, using only an absolute XDG state home. */
export function checkpointStore() {
  const xdg = process.env.XDG_STATE_HOME
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local/state"), "t1os", "checkpoints")
}
/** Record a trusted workspace's HEAD and state-directory presence without modifying it. */
export function capture(base: string, workspace: string, t3Home: string) {
  return attempt(async () => {
    const path = await realpath(workspace)
    if (!(await lstat(path)).isDirectory()) throw new Error("expected workspace directory")
    // rev-parse does not run hooks or working-tree filters. Do not run project code or inspect its files.
    const git = Bun.spawnSync(["git", "-C", path, "rev-parse", "--verify", "HEAD^{commit}"], {
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CEILING_DIRECTORIES: dirname(path),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const sha = git.stdout.toString().trim()
    const record: Checkpoint = {
      version: 1,
      workspace: path,
      head: git.exitCode === 0 && shaPattern.test(sha) ? sha : null,
      holyagentDirectory: await presentDir(join(path, ".holyagent")),
      t3UserdataDirectory: await presentDir(join(t3Home, "userdata")),
    }
    const text = JSON.stringify(record) + "\n"
    const id = digest(text)
    const dir = await privateStore(base, true)
    const temp = join(dir, ".pending-" + randomUUID())
    const f = await open(temp, "wx", 0o600)
    try {
      try {
        await f.writeFile(text)
        await f.sync()
      } finally {
        await f.close()
      }
      try {
        await link(temp, join(dir, id + ".json"))
      } catch (ex) {
        if (!errorCode(ex, "EEXIST")) throw ex
        await readRecord(dir, id)
      }
      const d = await open(dir, "r")
      try {
        await d.sync()
      } finally {
        await d.close()
      }
    } finally {
      await unlink(temp)
    }
    return id
  })
}
/** Verify and inspect one immutable checkpoint. Never reset, checkout or restart a process. */
export function inspect(base: string, id: string) {
  return attempt(async () => readRecord(await privateStore(base, false), id))
}
/** List saved checkpoint identifiers without opening T3, Pi or worktree content. */
export function listCheckpoints(base: string) {
  return attempt(async () => {
    try {
      const names = await readdir(await privateStore(base, false))
      return names
        .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
        .map((name) => name.slice(0, -5))
        .sort()
    } catch (ex) {
      if (errorCode(ex, "ENOENT")) return []
      throw ex
    }
  })
}
