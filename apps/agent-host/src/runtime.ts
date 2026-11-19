import { constants } from "node:fs"
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
} from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { dirname, isAbsolute, join } from "node:path"

const SAFE_ENV = { PATH: "/usr/bin:/bin", LC_ALL: "C" }

async function info(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
      throw error
  }
}
function capture(cmd: string[]) {
  const proc = Bun.spawnSync(cmd, { env: SAFE_ENV, stdin: "ignore", stderr: "ignore" })
  if (proc.exitCode !== 0) throw new Error(`runtime check failed: ${cmd[0]}`)
  return proc.stdout.toString()
}
async function launch(cmd: string[]) {
  const child = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const interrupt = () => child.kill("SIGINT")
  const terminate = () => child.kill("SIGTERM")
  process.on("SIGINT", interrupt).on("SIGTERM", terminate)
  try {
    return await child.exited
  } finally {
    process.off("SIGINT", interrupt).off("SIGTERM", terminate)
  }
}

/** Copy managed runtime configuration without enabling or starting any service. */
export async function installRuntime(target: string, runtime: string) {
  if (!isAbsolute(target) || !(await stat(target)).isDirectory())
    throw new Error("provide an existing absolute target root")
  const root = await realpath(target)
  const mappings = [
    ["remote/t1os-ssh-tunnel.socket", "etc/systemd/system/t1os-ssh-tunnel.socket"],
    ["remote/t1os-ssh-tunnel@.service", "etc/systemd/system/t1os-ssh-tunnel@.service"],
    ["remote/sshd_config", "etc/t1os/sshd_tunnel_config"],
    [
      "remote/10-no-ssh-forwarding.conf",
      "etc/systemd/system/tailscaled.service.d/10-no-ssh-forwarding.conf",
    ],
    ["android/t1os-android.service", "etc/systemd/user/t1os-android.service"],
    ["android/android.conf", "etc/systemd/user/t1os-t3.service.d/android.conf"],
    ["desktop/t1os-desktop.service", "etc/systemd/user/t1os-desktop.service"],
    ["agent/t1os-t3.service", "etc/systemd/user/t1os-t3.service"],
  ] as const
  // Check every target parent before writing; a fake root must not redirect writes outside it.
  async function mkdirSafe(path: string) {
    let current = root
    for (const name of path.split("/")) {
      current = join(current, name)
      if (!(await info(current))) await mkdir(current, { mode: 0o755 })
      const owner = await lstat(current)
      if (!owner.isDirectory())
        throw new Error(`refusing a symlinked or non-directory path: ${current}`)
      if (process.geteuid?.() === 0 && (owner.uid !== 0 || owner.mode & 0o022))
        throw new Error(`refusing unprivileged install path: ${current}`)
    }
  }
  const source = join(runtime, "agent/policy.json")
  if ((await info(source))?.isFile()) {
    await mkdirSafe("etc/t3code")
    const policy = join(root, "etc/t3code/policy.json")
    const existing = await info(policy)
    if (existing) {
      if (!existing.isFile() || !(await readFile(policy)).equals(await readFile(source)))
        throw new Error("existing T3 policy differs; review it on the console before proceeding")
    } else {
      await copyFile(source, policy, constants.COPYFILE_EXCL)
      await chmod(policy, 0o644)
    }
  }
  for (const [src, dest] of mappings) {
    if (src === "agent/t1os-t3.service" && !(await info(join(runtime, src)))) continue
    await mkdirSafe(dirname(dest))
    const dst = join(root, dest)
    const current = await info(dst)
    if (current && (!current.isFile() || current.nlink !== 1))
      throw new Error(`refusing a redirected runtime config: ${dst}`)
    const copied = await open(
      dst,
      constants.O_CREAT |
        constants.O_WRONLY |
        constants.O_TRUNC |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o644,
    )
    try {
      if (!(await copied.stat()).isFile())
        throw new Error(`refusing non-file runtime config: ${dst}`)
      await copied.writeFile(await readFile(join(runtime, src)))
      await copied.chmod(0o644)
    } finally {
      await copied.close()
    }
  }
}

/** Check the pinned minimum Tailscale version, without contacting or enrolling it. */
export function checkTailscale() {
  const [name, pkgVersion] = capture(["/usr/bin/pacman", "-Q", "tailscale"]).trim().split(/\s+/)
  if (
    name !== "tailscale" ||
    !pkgVersion ||
    capture(["/usr/bin/vercmp", pkgVersion, "1.104.4"]).trim() === "-1"
  )
    throw new Error("install a reviewed Tailscale version at or above 1.104.4")
}

/** Verify a private WayVNC config that enables TLS-backed interactive authentication only. */
export async function checkWayvnc(dir: string) {
  try {
    const uid = process.geteuid?.()
    const base = await lstat(dir)
    if (!base.isDirectory() || base.uid !== uid || (base.mode & 0o7777) !== 0o700)
      throw new Error("directory")
    const cert = await lstat(join(dir, "tls_cert.pem"))
    if (!cert.isFile() || cert.uid !== uid) throw new Error("certificate")
    const key = await lstat(join(dir, "tls_key.pem"))
    if (!key.isFile() || key.uid !== uid || (key.mode & 0o7777) !== 0o600) throw new Error("key")
    const config = await open(
      join(dir, "wayvnc"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const st = await config.stat()
      if (!st.isFile() || st.uid !== uid || (st.mode & 0o7777) !== 0o600 || st.size > 65536)
        throw new Error("config permissions")
      const configValues = new Map()
      for (const line of (await config.readFile("utf8")).split("\n")) {
        if (!line || line.startsWith("#")) continue
        const delimiter = line.indexOf("=")
        const key = line.slice(0, delimiter)
        const value = line.slice(delimiter + 1)
        if (delimiter < 1 || !value || configValues.has(key)) throw new Error("setting")
        configValues.set(key, value)
      }
      if (
        configValues.size !== 6 ||
        !configValues.has("username") ||
        !configValues.has("password") ||
        configValues.get("enable_auth") !== "true" ||
        configValues.get("use_relative_paths") !== "true" ||
        configValues.get("private_key_file") !== "tls_key.pem" ||
        configValues.get("certificate_file") !== "tls_cert.pem"
      )
        throw new Error("settings")
    } finally {
      await config.close()
    }
  } catch {
    throw new Error("configure a private VeNCrypt WayVNC config before starting the desktop")
  }
}

function operatorEnv() {
  if (!process.geteuid?.() || userInfo().username !== "t1os")
    throw new Error("desktop requires the t1os operator")
  const runtime = process.env.XDG_RUNTIME_DIR
  if (!runtime || !isAbsolute(runtime))
    throw new Error("XDG_RUNTIME_DIR must be an absolute directory")
  return runtime
}

/** Launch the optional compositor only for the dedicated operator with validated distro packages. */
export async function runDesktop() {
  const runtime = await lstat(operatorEnv())
  if (!runtime.isDirectory() || runtime.uid !== process.geteuid?.())
    throw new Error("invalid XDG_RUNTIME_DIR")
  const preferred = "/etc/t1os/hyprland.lua"
  const config = (await info(preferred))?.isFile() ? preferred : "/etc/t1os/hyprland.conf"
  if (!(await info(config))?.isFile()) throw new Error("no valid compositor config")
  if (
    capture(["/usr/bin/pacman", "-Q", "hyprland", "xorg-xwayland", "wayvnc"]) !==
    (await readFile("/etc/t1os/desktop-versions", "utf8"))
  )
    throw new Error("desktop versions differ from the validated set")
  process.exitCode = await launch(["/usr/bin/Hyprland", "--config", config])
}

/** Start optional, loopback-only WayVNC after the compositor socket is ready. */
export async function runWayvnc() {
  const runtime = operatorEnv()
  const display = process.env.WAYLAND_DISPLAY
  if (!display || !/^wayland-[0-9]+$/.test(display)) throw new Error("invalid Wayland display")
  const socket = join(runtime, display)
  for (let attempt = 0; attempt < 50 && !(await info(socket))?.isSocket(); attempt++)
    await Bun.sleep(200)
  if (!(await info(socket))?.isSocket()) throw new Error("Wayland socket never became ready")
  const dir = join(process.env.HOME ?? homedir(), ".config/t1os")
  let stopping = false
  const stop = () => {
    stopping = true
  }
  process.on("SIGTERM", stop).on("SIGINT", stop)
  try {
    while (!stopping) {
      await checkWayvnc(dir)
      if (stopping) break
      await launch(["/usr/bin/wayvnc", "--config", join(dir, "wayvnc"), "127.0.0.1", "5900"])
      for (let i = 0; i < 25 && !stopping; i++) await Bun.sleep(200)
    }
  } finally {
    process.off("SIGTERM", stop).off("SIGINT", stop)
  }
}

/** Validate and run a digest-pinned local container with no network or elevated permissions. */
export async function runJob(argv: string[]) {
  const uid = process.geteuid?.()
  if (!uid) throw new Error("must run as a non-root user")
  const [cwd, image, mode, entrypoint, ...args] = argv
  if (!cwd || !image || !mode || !entrypoint)
    throw new Error("usage: run-job WORKSPACE IMAGE@sha256:DIGEST ro|rw COMMAND [ARG...]")
  if (!/^[a-z0-9.-]+(:[0-9]+)?\/[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("use a fully qualified image pinned by digest")
  if (mode !== "ro" && mode !== "rw") throw new Error("workspace access must be ro or rw")
  const home = await realpath(process.env.HOME ?? homedir())
  const expected = join(home, "worktrees")
  const base = await realpath(expected)
  if (base !== expected) throw new Error("the worktrees root cannot be a symlink")
  const workspace = await realpath(cwd)
  const entry = await stat(workspace)
  if (
    !(
      entry.isDirectory() &&
      entry.uid === uid &&
      workspace.startsWith(base + "/") &&
      !workspace.includes(",")
    )
  )
    throw new Error("use a directory owned by the operator under ~/worktrees")
  const sockets = capture(["/usr/bin/find", workspace, "-xdev", "-type", "s", "-print", "-quit"])
  if (sockets) throw new Error("remove sockets from the workspace")
  const podman = "/usr/bin/podman"
  try {
    await access(podman, constants.X_OK)
  } catch {
    throw new Error("install reviewed rootless Podman before running jobs")
  }
  // Podman needs the real user environment to discover its local rootless runtime.
  const hostInfo = Bun.spawnSync(
    [
      podman,
      "--remote=false",
      "info",
      "--format",
      "{{.Host.Security.Rootless}} {{.Host.CgroupsVersion}}",
    ],
    { stderr: "ignore", stdin: "ignore" },
  )
  if (hostInfo.exitCode !== 0 || hostInfo.stdout.toString().trim() !== "true v2")
    throw new Error("rootless Podman with cgroup v2 is required")
  const mount = `type=bind,source=${workspace},target=/workspace,bind-propagation=rprivate,bind-nonrecursive,noexec,nosuid,nodev${mode === "ro" ? ",ro" : ""}`
  process.exitCode = await launch([
    podman,
    "--remote=false",
    "run",
    "--rm",
    "--timeout=1800",
    "--pull=never",
    "--network=none",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--userns=keep-id",
    "--pid=private",
    "--ipc=private",
    "--no-hosts",
    "--http-proxy=false",
    "--read-only",
    "--read-only-tmpfs=false",
    "--image-volume=ignore",
    "--systemd=false",
    "--no-healthcheck",
    "--tmpfs=/tmp:rw,nosuid,nodev,noexec,notmpcopyup,size=512m",
    "--pids-limit=256",
    "--memory=2g",
    "--memory-swap=2g",
    "--cpus=2",
    `--mount=${mount}`,
    "--workdir=/workspace",
    "--env=HOME=/tmp",
    `--entrypoint=${entrypoint}`,
    image,
    ...args,
  ])
}
