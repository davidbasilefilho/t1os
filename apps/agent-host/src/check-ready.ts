import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"

import { DEVICE_TOOLS, HUB_ENTRY, HUB_VERSION, stage } from "./stage"

const REQUIRED = [
  "Agent",
  "SubagentWorkflow",
  "todo",
  "ask_user_question",
  "process",
  "ffgrep",
  "fffind",
  "codemode",
]
/** Extension commands independently required by the readiness gate. */
export const COMMANDS = [
  "approve",
  "skill:instruction-writing",
  "agents",
  "acp",
  "todos",
  "ps",
  "fff-health",
  "kimi-settings",
]
type Reply = {
  id?: string
  type?: string
  command?: string
  success?: boolean
  data?: { commands?: { name?: string }[] }
}

/** Verify actual replies to both read-only RPC commands and all required command names. */
export function checkReplies(records: Reply[]) {
  const responses = new Map(
    records.filter((item) => item.type === "response").map((item) => [item.id, item]),
  )
  for (const name of ["get_state", "get_commands"]) {
    const entry = responses.get(name)
    if (entry?.command !== name || entry.success !== true)
      throw new Error(`Pi RPC ${name} did not succeed`)
  }
  const names = new Set(responses.get("get_commands")?.data?.commands?.map((c) => c.name))
  const missing = COMMANDS.filter((command) => !names.has(command))
  if (missing.length)
    throw new Error(`required Pi extension commands missing: ${missing.toSorted().join(", ")}`)
}

async function version(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  timeout = 15000,
) {
  const process = Bun.spawn(command, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    signal: AbortSignal.timeout(timeout),
  })
  const output = await new Response(process.stdout).text()
  if ((await process.exited) !== 0) throw new Error(`readiness command failed: ${command[0]}`)
  return output.trim()
}

function stopProcessGroup(pid: number | undefined) {
  if (!pid) return
  try {
    process.kill(-pid, "SIGKILL")
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH")
      throw error
  }
}

async function probe(release: string) {
  const modules = join(release, "agent-host/pi-deps/node_modules")
  const bin = join(release, "agent-host/bin")
  const home = await mkdtemp(join(tmpdir(), "t1os-rpc-"))
  try {
    await stage(join(release, "runtime/agent/holyagent-0.3.3.tgz"), home, modules)
    const env = {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      CI: "1",
      TERM: "dumb",
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      T3_PI_RUNTIME_MODE: "approval-required",
    }
    for (const [binary, expected] of [
      [join(bin, "node"), "v24.22.3"],
      [join(bin, "bun"), "1.4.4"],
      [join(bin, "pi"), "1.5.0"],
      [join(release, "agent-host/t3-release/t3"), "t3 v0.1.10"],
      [join(home, ".local/share/t1os/agent/holyagent-0.3.3/scripts/holyagent"), "0.3.3"],
    ] as const) {
      if ((await version([binary, "--version"], home, env)) !== expected)
        throw new Error(`${binary}: expected ${expected}`)
    }
    const hub = join(home, ".t3/tools/expo-device-hub", HUB_VERSION)
    const cache = join(hub, "node_modules")
    if (
      (await readFile(join(hub, ".install-complete"), "utf8")).trim() !== HUB_VERSION ||
      (await realpath(join(cache, HUB_ENTRY))) !== (await realpath(join(modules, HUB_ENTRY)))
    )
      throw new Error("T3 Device Hub cache incomplete")
    const agentTool = DEVICE_TOOLS[1]
    const agentCache = join(home, ".t3/tools", agentTool.name, agentTool.version)
    if (
      (await readFile(join(agentCache, ".install-complete"), "utf8")).trim() !==
        agentTool.version ||
      (await realpath(join(agentCache, "node_modules", agentTool.entry))) !==
        (await realpath(join(modules, agentTool.entry)))
    )
      throw new Error("inert agent-device cache incomplete")
    const agentHelp = await version(
      [join(bin, "node"), join(agentCache, "node_modules", agentTool.entry), "--help"],
      home,
      env,
    )
    if (!agentHelp.includes("agent-device")) throw new Error("unexpected agent-device CLI")
    const help = await version([join(bin, "node"), join(cache, HUB_ENTRY), "--help"], home, env)
    if (!help.includes("--hide-boot-device") || !help.includes("--platform"))
      throw new Error("unexpected Device Hub CLI")
    await version(
      [
        join(bin, "node"),
        "-e",
        'const n = require("node-datachannel"); if (typeof n.PeerConnection !== "function") process.exit(2); n.cleanup()',
      ],
      cache,
      env,
    )
    const work = join(home, "worktree")
    await mkdir(work)
    await writeFile(join(work, "fixture.txt"), "private readiness marker")
    await version(
      [
        join(bin, "node"),
        "--input-type=module",
        "-e",
        `
      const {FileFinder} = await import(process.argv[1]);
      const result = FileFinder.create({basePath: process.cwd()});
      if (!result.ok) process.exit(2);
      try {
        await result.value.waitForScan(5000);
        const found = result.value.fileSearch("fixture.txt");
        if (!found.ok || !found.value.items.some(x => x.relativePath === "fixture.txt")) process.exitCode = 3;
      } finally { result.value.destroy(); }
    `,
        pathToFileURL(join(modules, "@ff-labs/fff-node/dist/index.js")).href,
      ],
      work,
      env,
      12000,
    )
    const extension = join(home, "probe.mjs")
    await writeFile(
      extension,
      `import {writeFileSync} from "node:fs";
      export default pi => pi.on("session_start", () => {
        writeFileSync(process.env.HOME + "/tools.json", JSON.stringify(pi.getAllTools().map(t => t.name)));
      });`,
    )
    const stdout = join(home, "rpc.out")
    const stderr = join(home, "rpc.err")
    const out = openSync(stdout, "wx", 0o600)
    try {
      const err = openSync(stderr, "wx", 0o600)
      try {
        const child = spawn(join(bin, "pi"), ["--mode", "rpc", "--no-session", "-e", extension], {
          cwd: work,
          env,
          detached: true,
          stdio: ["pipe", out, err],
        })
        const exited = new Promise<void>((resolve) => {
          child.once("close", () => resolve())
        })
        let failed = false
        child.once("error", () => {
          failed = true
        })
        child.stdin?.once("error", () => {
          failed = true
        })
        try {
          child.stdin?.write(
            ["get_state", "get_commands"]
              .map((type) => JSON.stringify({ id: type, type }) + "\n")
              .join(""),
          )
          const deadline = performance.now() + 40000
          let ready = false
          while (performance.now() < deadline) {
            if (failed || child.exitCode !== null || child.signalCode !== null)
              throw new Error("Pi exited before RPC readiness")
            const limit = 2097152
            if ((await stat(stdout)).size > limit || (await stat(stderr)).size > 1048576)
              throw new Error("Pi readiness output exceeded limit")
            const n = await Bun.file(stdout)
              .slice(0, limit + 1)
              .arrayBuffer()
            if (n.byteLength > limit) throw new Error("Pi readiness output exceeded limit")
            const records = Buffer.from(n)
              .toString()
              .split("\n")
              .slice(0, -1)
              .filter((line) => line.startsWith("{"))
              .map((line) => JSON.parse(line) as Reply)
            if (records.some((item) => item.id === "get_commands")) {
              checkReplies(records)
              ready = true
              break
            }
            await Bun.sleep(100)
          }
          if (!ready) throw new Error("Pi RPC readiness timed out")
        } finally {
          stopProcessGroup(child.pid)
          child.stdin?.destroy()
          await exited
        }
      } finally {
        closeSync(err)
      }
    } finally {
      closeSync(out)
    }
    const tools = new Set(JSON.parse(await readFile(join(home, "tools.json"), "utf8")) as string[])
    const missing = REQUIRED.filter((tool) => !tools.has(tool))
    if (missing.length)
      throw new Error(`required Pi tools missing: ${missing.toSorted().join(", ")}`)
    console.log("Pi RPC: get_state, get_commands and headless tools passed")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/** Require separate user and network namespaces before loading any agent code. */
export async function mainReady(argv: string[]) {
  const uid = process.geteuid?.()
  if (!uid || argv.length !== 1 || !argv[0] || !isAbsolute(argv[0]))
    throw new Error("usage (as a non-root operator): check-ready /absolute/candidate/release")
  const release = await realpath(argv[0])
  const parent = process.env.T1OS_READY_NET
  const net = await readlink("/proc/self/ns/net")
  if (parent === undefined) {
    const source = Bun.argv[1]
    const program =
      source && !source.startsWith("/$bunfs/") ? [process.execPath, source] : [process.execPath]
    const child = Bun.spawn(
      [
        "/usr/bin/unshare",
        "--user",
        "--map-current-user",
        "--net",
        "--",
        ...program,
        "check-ready",
        release,
      ],
      {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        signal: AbortSignal.timeout(140000),
        env: { PATH: "/usr/bin:/bin", T1OS_READY_NET: net },
      },
    )
    if ((await child.exited) !== 0) throw new Error("isolated readiness check failed")
    return
  }
  const ids = (await readFile("/proc/self/uid_map", "utf8")).trim().split(/\s+/)
  const interfaces = (await readFile("/proc/net/dev", "utf8"))
    .trimEnd()
    .split("\n")
    .slice(2)
    .map((line) => line.split(":")[0]?.trim())
  if (
    parent === net ||
    interfaces.length !== 1 ||
    interfaces[0] !== "lo" ||
    ids.join(" ") !== `${uid} ${uid} 1`
  )
    throw new Error("isolated user and network namespaces required")
  await probe(release)
}
