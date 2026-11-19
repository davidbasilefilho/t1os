import { dlopen, FFIType } from "bun:ffi"
import { constants } from "node:fs"
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  link,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative } from "node:path"

import { extractFile, readTar, verifiedArchive } from "./archive"

/** Verified upstream HolyAgent publication. */
export const VERSION = "0.3.3"
const DIGEST =
  "9c8f4341d79b1213ba3bb9499a0a00a65c3eb0e6172e8a3e4d88f443befcccfffe882f137b9b8414607e4e4c8fc061ccff766de0815590a600481c56cd36590e"

/** Reviewed and locked headless HolyAgent extension features. */
export const FEATURES = {
  "pi-provider-kimi-code": "0.6.13",
  "@tintinweb/pi-subagents": "0.23.2",
  "billion-context": "0.1.213",
  "@juicesharp/rpiv-todo": "2.15.0",
  "@juicesharp/rpiv-ask-user-question": "2.15.0",
  "@aliou/pi-processes": "0.13.6",
  "@ff-labs/pi-fff": "0.11.0",
}

function isMissing(error: unknown): boolean {
  return error != null && typeof error === "object" && "code" in error && error.code === "ENOENT"
}
async function metadata(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
async function privateDir(path: string, home: string, uid: number) {
  const base = await lstat(home)
  if (
    !(
      (await realpath(home)) === home &&
      base.isDirectory() &&
      base.uid === uid &&
      !(base.mode & 0o022)
    )
  )
    throw new Error("operator HOME must be real, owned and not writable by others")
  const parts = relative(home, path).split("/")
  if (parts.some((part) => part === "..") || isAbsolute(relative(home, path)))
    throw new Error("invalid operator path")
  let current = home
  for (const part of parts.filter(Boolean)) {
    current = join(current, part)
    if (!(await metadata(current))) await mkdir(current, { mode: 0o700 })
    const info = await lstat(current)
    if (!info.isDirectory() || info.uid !== uid || info.mode & 0o022)
      throw new Error(`unsafe operator directory: ${current}`)
  }
}
async function seed(
  path: string,
  initial: Record<string, unknown>,
  accepts: (obj: Record<string, unknown>) => boolean,
  uid: number,
) {
  let opened
  try {
    opened = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  if (opened) {
    try {
      const info = await opened.stat()
      if (!info.isFile() || info.uid !== uid || info.mode & 0o022 || info.size > 1048576)
        throw new Error(`unsafe settings: ${path}`)
      const bytes = Buffer.alloc(1048577)
      const { bytesRead } = await opened.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 1048576) throw new Error(`unsafe settings: ${path}`)
      const obj: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))
      if (!record(obj) || !accepts(obj))
        throw new Error(
          `existing settings left intact; review the required entry manually: ${path}`,
        )
    } finally {
      await opened.close()
    }
    return
  }
  const dir = await mkdtemp(join(dirname(path), ".settings-"))
  try {
    const file = join(dir, "settings.json")
    const out = await open(file, "wx", 0o600)
    try {
      await out.writeFile(`${JSON.stringify(initial, null, 2)}\n`)
      await out.sync()
    } finally {
      await out.close()
    }
    await link(file, path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Keep exactly the managed package symlink, never replacing an operator install. */
export async function keepLink(path: string, dest: string) {
  const info = await metadata(path)
  if (info?.isSymbolicLink() && (await readlink(path)) === dest) return
  if (info) throw new Error(`existing package path differs; left intact: ${path}`)
  await symlink(dest, path, "dir")
}

async function unpack(artifact: string, dest: string, digest: string, uid: number) {
  const tmp = await mkdtemp(join(dirname(dest), ".release-"))
  const payload = join(tmp, "payload")
  const files = new Set<string>()
  try {
    await mkdir(payload, { mode: 0o700 })
    await verifiedArchive(
      artifact,
      { algorithm: "sha512", digest, max: 16 * 1024 ** 2 - 1 },
      (stream) =>
        readTar(
          stream,
          { bytes: 32 * 1024 ** 2, entries: 1024 },
          async ({ name, directory, mode }, data) => {
            const path = /^package\/([a-zA-Z0-9._@/-]+)$/.exec(name)?.[1]
            if (!path || directory) throw new Error("unexpected HolyAgent archive member")
            files.add(path)
            const target = join(payload, path)
            await mkdir(dirname(target), { recursive: true, mode: 0o700 })
            await extractFile(target, data, mode & 0o111 ? 0o700 : 0o600)
          },
        ),
    )
    const pkg: unknown = JSON.parse(await readFile(join(payload, "package.json"), "utf8"))
    if (
      !record(pkg) ||
      pkg.name !== "holyagent" ||
      pkg.version !== VERSION ||
      !record(pkg.pi) ||
      !Array.isArray(pkg.pi.extensions) ||
      !pkg.pi.extensions.length ||
      !files.has("scripts/holyagent")
    )
      throw new Error("unexpected HolyAgent manifest or missing upstream wrapper")
    const current = await metadata(dest)
    if (!current) {
      await rename(payload, dest)
      return
    }
    const installed = new Set<string>()
    async function visit(path: string) {
      const info = await lstat(path)
      if (info.uid !== uid || info.mode & 0o022) throw new Error("unsafe release contents")
      if (info.isDirectory()) {
        for (const child of await readdir(path)) await visit(join(path, child))
      } else {
        const name = relative(dest, path)
        if (!info.isFile() || !files.has(name)) throw new Error("unsafe release contents")
        const source = join(payload, name)
        const sample = await lstat(source)
        if (
          info.size !== sample.size ||
          (info.mode & 0o777) !== (sample.mode & 0o777) ||
          !(await readFile(path)).equals(await readFile(source))
        )
          throw new Error("existing pinned package differs; stopped without overwriting it")
        installed.add(name)
      }
    }
    if (!current.isDirectory()) throw new Error("unsafe release directory")
    await visit(dest)
    if (installed.size !== files.size)
      throw new Error("existing pinned package differs; stopped without overwriting it")
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

function includes(candidate: unknown, expected: Record<string, unknown>) {
  return (
    record(candidate) &&
    Object.entries(expected).every(([key, value]): boolean =>
      record(value) ? includes(candidate[key], value) : candidate[key] === value,
    )
  )
}

/** Operator-only local registration of the pinned extension without any network access. */
export async function stage(
  artifact: string,
  home = process.env.HOME ?? homedir(),
  modules = "/opt/t1os/current/agent-host/pi-deps/node_modules",
  digest = DIGEST,
) {
  const uid = process.geteuid?.()
  if (!uid) throw new Error("refusing to configure root")
  const store = join(home, ".local/share/t1os/agent")
  const pi = join(home, ".pi/agent")
  const t3 = join(home, ".t3/userdata")
  for (const dir of [store, pi, t3]) await privateDir(dir, home, uid)
  const descriptor = await open(
    join(store, "install.lock"),
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  )
  try {
    const info = await descriptor.stat()
    if (!info.isFile() || info.uid !== uid || info.mode & 0o022)
      throw new Error("not a safe regular lock")
    const libc = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    try {
      const deadline = performance.now() + 10000
      while (libc.symbols.flock(descriptor.fd, 2 | 4) !== 0) {
        if (performance.now() >= deadline)
          throw new Error("could not acquire operator registration lock")
        await Bun.sleep(50)
      }
      const dest = join(store, `holyagent-${VERSION}`)
      await unpack(artifact, dest, digest, uid)
      for (const dir of [store, pi]) await keepLink(join(dir, "node_modules"), modules)
      const locations = [
        ["holyagent", VERSION, dest],
        ...Object.entries(FEATURES).map(([pkg, version]) => [pkg, version, join(modules, pkg)]),
      ]
      const packages: string[] = []
      for (const [pkg, version, path] of locations) {
        if (pkg === undefined || version === undefined || path === undefined)
          throw new Error("invalid package pin")
        const target = join(pi, "npm/node_modules", pkg)
        await privateDir(dirname(target), home, uid)
        await keepLink(target, path)
        packages.push(`npm:${pkg}@${version}`)
      }
      await seed(
        join(pi, "settings.json"),
        {
          packages,
          defaultProvider: "kimi-coding",
          defaultModel: "k3.1-pro",
          defaultThinkingLevel: "high",
          codemode: { mode: "only" },
        },
        (conf) => {
          const entries = conf.packages
          return Array.isArray(entries) && packages.every((pkg) => entries.includes(pkg))
        },
        uid,
      )
      for (const [path, contents] of [
        [join(pi, "subagents.json"), { disableDefaultAgents: true, fallbackSubagent: "none" }],
        [join(pi, "pi-fff.json"), { mode: "override", followSymlinks: false }],
        [join(home, ".config/billion-context/billion-context.json"), { pi: { subagents: false } }],
        [
          join(home, ".holyagent/config.json"),
          { pi: { features: { computerUse: false, browserUse: false } } },
        ],
      ] as const) {
        await privateDir(dirname(path), home, uid)
        await seed(path, contents, (conf) => includes(conf, contents), uid)
      }
      await seed(
        join(t3, "settings.json"),
        { providerInstances: { pi: { driver: "pi", enabled: true } } },
        (conf) => {
          if (!record(conf.providerInstances) || !record(conf.providerInstances.pi)) return false
          const provider = conf.providerInstances.pi
          const config = provider.config ?? {}
          return (
            provider.driver === "pi" &&
            provider.enabled === true &&
            record(config) &&
            config.enabled !== false
          )
        },
        uid,
      )
      console.log(
        `HolyAgent ${VERSION}: verified and registered for Pi/T3. No provider or service started.`,
      )
    } finally {
      libc.close()
    }
  } finally {
    await descriptor.close()
  }
}
