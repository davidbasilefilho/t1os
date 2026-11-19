import { dlopen, ptr } from "bun:ffi"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

const policy = resolve(import.meta.dir, "../../../runtime/agent/policy.json")
const pi = "pi-deps/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
const read = (p: string) => readFileSync(p, "utf8")

/** Reject a caller-asserted isolation flag unless kernel state independently agrees. */
export function smokeNamespaceIsPrivate(
  parent: string,
  current: string,
  euid: number,
  uidMap: string,
  netDev: string,
) {
  const map = uidMap.trim().split(/\s+/)
  const interfaces = netDev
    .trimEnd()
    .split("\n")
    .slice(2)
    .map((row) => row.split(":")[0]?.trim())
  return (
    /^net:\[\d+\]$/.test(parent) &&
    /^net:\[\d+\]$/.test(current) &&
    parent !== current &&
    euid === 0 &&
    map.length === 3 &&
    map[0] === "0" &&
    /^[1-9]\d*$/.test(map[1] ?? "") &&
    map[2] === "1" &&
    interfaces.length === 1 &&
    interfaces[0] === "lo"
  )
}
async function inNamespace(tools: string, node: string, home: string) {
  // SIOCGIFFLAGS/SIOCSIFFLAGS on an AF_INET datagram socket restricted to this namespace.
  const libc = dlopen("libc.so.6", {
    socket: { args: ["i32", "i32", "i32"], returns: "i32" },
    ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
  })
  try {
    const fd = libc.symbols.socket(2, 2, 0)
    if (fd < 0) throw Error("cannot open network namespace control socket")
    try {
      const iface = Buffer.alloc(40)
      iface.write("lo")
      if (libc.symbols.ioctl(fd, 0x8913n, ptr(iface)) !== 0)
        throw Error("cannot read loopback flags")
      iface.writeUInt16LE(iface.readUInt16LE(16) | 1, 16)
      if (libc.symbols.ioctl(fd, 0x8914n, ptr(iface)) !== 0)
        throw Error("cannot bring up isolated loopback")
    } finally {
      libc.symbols.close(fd)
    }
  } finally {
    libc.close()
  }
  const env = { HOME: home, PATH: "/usr/bin:/bin", CI: "1", TERM: "dumb" }
  const version = (file: string, args: string[]) =>
    execFileSync(file, args, {
      cwd: home,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
      encoding: "utf8",
    }).trim()
  const t3 = join(tools, "t3-release/t3")
  if (
    version(node, [join(tools, pi), "--version"]) !== "1.5.0" ||
    version(t3, ["--version"]) !== "t3 v0.1.10"
  )
    throw Error("unexpected staged tool version")
  if (!version(t3, ["policy", "check", policy]).includes('"connect": false'))
    throw Error("managed policy was not accepted")
  const settings = join(home, ".t3/userdata/settings.json"),
    note = join(home, "worktrees/example/uncommitted.txt")
  mkdirSync(join(home, ".t3/userdata"), { recursive: true })
  mkdirSync(join(home, "worktrees/example"), { recursive: true })
  writeFileSync(
    settings,
    JSON.stringify({ providerInstances: { pi: { driver: "pi", enabled: true } } }),
  )
  writeFileSync(note, "saved before T3 restart")
  for (let boot = 0; boot < 2; boot++) {
    const server = Bun.spawn([t3, "serve", "--host", "127.0.0.1", "--port", "3773"], {
      cwd: home,
      env: {
        ...env,
        PATH: join(tools, "bin") + ":/usr/bin:/bin",
        T3CODE_HOME: join(home, ".t3"),
        T3CODE_HOST: "127.0.0.1",
        T3CODE_PORT: "3773",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      let ok = false
      for (let trial = 0; trial < 80; trial++) {
        if (server.exitCode !== null) throw Error("T3 exited before starting its loopback server")
        try {
          const response = await fetch("http://127.0.0.1:3773/", {
            redirect: "error",
            signal: AbortSignal.timeout(1000),
          })
          const reader = response.body?.getReader()
          if (reader) {
            try {
              ok = response.status === 200 && ((await reader.read()).value?.length ?? 0) > 0
            } finally {
              await reader.cancel()
            }
          }
        } catch {
          /* The server may still be starting. */
        }
        if (ok) break
        await Bun.sleep(250)
      }
      if (!ok) throw Error("T3 did not respond in the isolated namespace")
      const suffix = ":" + (3773).toString(16).toUpperCase().padStart(4, "0")
      const addrs = new Set(
        ["tcp", "tcp6"].flatMap((proto) =>
          read("/proc/net/" + proto)
            .trim()
            .split("\n")
            .slice(1)
            .map((row) => row.trim().split(/\s+/))
            .filter((v) => v[3] === "0A" && v[1]?.endsWith(suffix))
            .map((v) => v[1]),
        ),
      )
      if (addrs.size !== 1 || !addrs.has("0100007F" + suffix))
        throw Error("T3 was not bound exclusively to 127.0.0.1")
    } finally {
      server.kill("SIGTERM")
      const timer = setTimeout(() => server.kill("SIGKILL"), 5000)
      try {
        await server.exited
      } finally {
        clearTimeout(timer)
      }
    }
    const data = JSON.parse(read(settings))
    if (
      data.providerInstances?.pi?.driver !== "pi" ||
      data.providerInstances.pi.enabled !== true ||
      read(note) !== "saved before T3 restart"
    )
      throw Error("settings or worktree did not persist")
  }
}

/** Inspect the approved tools with temporary state and no provider or host network access. */
export async function mainSmoke(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { tools: { type: "string" }, node: { type: "string" } },
    strict: true,
  })
  if (!values.tools) throw Error("expected --tools DIRECTORY")
  const tools = resolve(values.tools),
    node = resolve(values.node ?? join(tools, "bin/node"))
  const current = readlinkSync("/proc/self/ns/net")
  const parent = process.env.T1OS_SMOKE_PARENT_NET
  const euid = process.geteuid?.()
  if (euid === undefined) throw Error("Linux user namespaces are required")
  if (parent === undefined) {
    if (euid === 0) throw Error("run the isolated smoke test as a normal user")
    execFileSync(
      "/usr/bin/unshare",
      [
        "--user",
        "--map-root-user",
        "--net",
        "--",
        process.execPath,
        import.meta.path,
        "--tools",
        tools,
        "--node",
        node,
      ],
      {
        env: { PATH: "/usr/bin:/bin", T1OS_SMOKE_PARENT_NET: current },
        stdio: "inherit",
        timeout: 120000,
      },
    )
    return
  }
  if (
    !smokeNamespaceIsPrivate(
      parent,
      current,
      euid,
      read("/proc/self/uid_map"),
      read("/proc/net/dev"),
    )
  )
    throw Error("smoke test requires a separate Linux user and network namespace")
  const home = mkdtempSync(join(tmpdir(), "t1os-smoke-"))
  try {
    await inNamespace(tools, node, home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  console.log(
    "Pi and T3 pinned versions, policy, isolated loopback startup, restart and worktree persistence passed",
  )
}
if (import.meta.main) await mainSmoke(process.argv.slice(2))
