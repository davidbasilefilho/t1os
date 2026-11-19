import { createHash } from "node:crypto"
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"

import { extractFile, readTar, verifiedArchive } from "./archive"
import { DEVICE_TOOLS } from "./stage"

const ROOT = resolve(import.meta.dir, "../../..")
const HERE = join(ROOT, "runtime/agent-host")
const T3_ARCHIVE = "t3-0.1.10-linux-x64"
const T3_ROOTS = new Set(["client", "lib", "node_modules", "resource-monitor", "t3"])
const T3_PIN = {
  size: 182240288,
  digest: "9bea9d36a217299a0af880e8c347b536ed6a9a2f5bf328a695d174d63628c5e8",
}
const RUNTIME_INPUTS = {
  "node-linux-x64": ["node", "a7ec1b37e6ff9d187e4198c5b6df9a4eb1c74dd31804fb3bac55cc4ceca1ac01"],
  "@oven/bun-linux-x64": [
    "bun",
    "10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235",
  ],
} as const

/** Stage only ordinary files from the pinned T3 Linux x64 archive. */
export async function expandT3(archive: string, destination: string, pin = T3_PIN) {
  await verifiedArchive(archive, { algorithm: "sha256", max: T3_PIN.size, ...pin }, (source) =>
    readTar(
      source,
      { bytes: 512 * 1024 ** 2, entries: 10000 },
      async ({ name, directory, mode }, data) => {
        const [root, top, ...rest] = name.split("/")
        if (root !== T3_ARCHIVE || [top, ...rest].some((part) => part?.startsWith(".")))
          throw new Error(`unexpected T3 Code archive member: ${name}`)
        if (!top && directory) return
        if (!top || !T3_ROOTS.has(top))
          throw new Error(`unexpected root in T3 Code archive: ${name}`)
        const target = join(destination, top, ...rest)
        await mkdir(directory ? target : dirname(target), { recursive: true })
        if (!directory) await extractFile(target, data, mode & 0o111 ? 0o755 : 0o644)
      },
    ),
  )
  const executable = join(destination, "t3")
  const fd = await open(executable, "r")
  try {
    const elf = Buffer.alloc(20)
    const { bytesRead } = await fd.read(elf, 0, elf.length, 0)
    if (
      bytesRead !== 20 ||
      !elf.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) ||
      elf[18] !== 62 ||
      elf[19] !== 0
    )
      throw new Error("T3 Code release did not contain its Linux x86_64 ELF binary")
    if (
      !((await fd.stat()).mode & 0o111) ||
      !(await lstat(join(destination, "client/index.html"))).isFile()
    )
      throw new Error("T3 Code release is missing an executable server or its web client")
  } finally {
    await fd.close()
  }
}

async function copyRuntimes(modules: string, bindir: string) {
  await mkdir(bindir)
  for (const [pkg, [name, digest]] of Object.entries(RUNTIME_INPUTS)) {
    const source = join(modules, pkg, "bin", name)
    const info = await lstat(source)
    if (!info.isFile()) throw new Error(`expected locked Linux ${name} binary`)
    const hasher = createHash("sha256")
    for await (const bytes of Bun.file(source).stream()) hasher.update(bytes)
    if (hasher.digest("hex") !== digest) throw new Error(`${name} executable digest mismatch`)
    await copyFile(source, join(bindir, name))
    await chmod(join(bindir, name), 0o755)
    for (const notice of await readdir(join(modules, pkg), { withFileTypes: true }))
      if (notice.name.startsWith("LICENSE") && notice.isFile())
        await copyFile(join(modules, pkg, notice.name), join(bindir, `${name}-${notice.name}`))
  }
}

async function copyPi(source: string, destination: string, root = source) {
  await mkdir(destination, { recursive: true })
  const children = await readdir(source, { withFileTypes: true })
  for (const child of children.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = join(source, child.name)
    if (
      child.name.startsWith(".") ||
      child.name === "@t1os" ||
      Object.hasOwn(RUNTIME_INPUTS, relative(root, path))
    )
      continue
    const target = join(destination, child.name)
    if (child.isDirectory()) await copyPi(path, target, root)
    else if (child.isFile()) {
      await copyFile(path, target)
      await chmod(target, (await lstat(path)).mode & 0o111 ? 0o755 : 0o644)
    } else throw new Error(`unexpected link or special file in hoisted Pi install: ${path}`)
  }
}

async function stagePi(work: string, destination: string, offline: boolean) {
  const bun = Bun.which("bun")
  if (!bun || Bun.spawnSync([bun, "--version"]).stdout.toString().trim() !== "1.4.4")
    throw new Error("agent host preparation requires pinned Bun 1.4.4; use mise exec")
  await mkdir(work)
  const workspaceFiles = ["package.json", "bun.lock"]
  for (const folder of ["apps", "packages"]) {
    for (const workspace of await readdir(join(ROOT, folder), { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue
      const manifest = join(folder, workspace.name, "package.json")
      if (await Bun.file(join(ROOT, manifest)).exists()) workspaceFiles.push(manifest)
    }
  }
  for (const file of workspaceFiles) {
    const dest = join(work, file)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(join(ROOT, file), dest)
  }
  const process = Bun.spawn(
    [
      bun,
      "install",
      "--filter",
      "@t1os/agent-host",
      "--production",
      "--linker",
      "hoisted",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org",
      ...(offline ? ["--offline"] : []),
    ],
    { cwd: work, stdout: "inherit", stderr: "inherit" },
  )
  if ((await process.exited) !== 0) throw new Error("locked agent host installation failed")
  const modules = join(work, "node_modules")
  await copyRuntimes(modules, join(dirname(destination), "bin"))
  const stagedModules = join(destination, "node_modules")
  await copyPi(modules, stagedModules)
  for (const tool of DEVICE_TOOLS) {
    const pkg = await Bun.file(join(stagedModules, tool.name, "package.json")).json()
    if (
      pkg.name !== tool.name ||
      pkg.version !== tool.version ||
      !(await lstat(join(stagedModules, tool.entry))).isFile()
    )
      throw new Error("unexpected T3 device tool: " + tool.name)
    await Bun.write(join(destination, tool.name + "-version"), tool.version + "\n")
  }
  if (
    !(await Bun.file(
      join(destination, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    ).exists())
  )
    throw new Error("Pi launcher missing from the hoisted node_modules tree")
}

async function mustNotExist(path: string) {
  try {
    await lstat(path)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
    throw error
  }
  throw new Error("output already exists")
}

/** Prepare a new pinned Linux toolchain tree; do not run any service. */
export async function mainPrepare(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "t3-archive": { type: "string" },
      output: { type: "string" },
      offline: { type: "boolean" },
    },
  })
  if (!values["t3-archive"] || !values.output)
    throw new Error("prepare requires --t3-archive and --output")
  if (!process.geteuid?.()) throw new Error("prepare the toolchain as a normal user, not root")
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("agent tools must be prepared on Linux x86_64")
  const output = resolve(values.output)
  await mustNotExist(output)
  const work = await mkdtemp(join(dirname(output), ".agent-host-"))
  try {
    const payload = join(work, "payload")
    await mkdir(payload)
    await expandT3(values["t3-archive"], join(payload, "t3-release"))
    await stagePi(join(work, "locked-workspace"), join(payload, "pi-deps"), values.offline ?? false)
    for (const name of ["pi", "t3code"]) {
      const target = join(payload, "bin", name)
      await copyFile(join(HERE, name), target)
      await chmod(target, 0o755)
    }
    await mustNotExist(output)
    await rename(payload, output)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  console.log(output)
}
