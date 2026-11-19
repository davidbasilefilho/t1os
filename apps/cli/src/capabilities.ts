import { dlopen } from "bun:ffi"
import { spawnSync } from "node:child_process"
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs"
import { userInfo } from "node:os"
import { basename, dirname } from "node:path"

import { Effect } from "effect"

import { androidLock } from "../../device-hub/src/lock.ts"

type Result = "present" | "missing" | "unknown"
type Check = [label: string, result: Result]
type Kind = "file" | "nonempty" | "exec" | "dir"
type Unit = "active" | "inactive" | "unknown"
interface Probes {
  path(path: string, kind: Kind): Result
  text(path: string): string | undefined
  kvm(): Result
  unit(name: string, user: boolean): Unit
  release(): string | undefined
}
interface Capability {
  name: string
  installed: Check[]
  configuration: Check[]
  prerequisites: Check[]
  readiness: "ready" | "blocked" | "not verified" | "not implemented"
  scope: string
}
const current = "/opt/t1os/current",
  home = "/home/t1os",
  sdk = home + "/Android/Sdk"
function failure(err: unknown): Result {
  const code = (err as NodeJS.ErrnoException)?.code
  return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown"
}
function file(path: string, kind: Kind): Result {
  try {
    const s = statSync(path)
    if (kind === "dir") return s.isDirectory() ? "present" : "missing"
    if (!s.isFile() || (kind === "nonempty" && s.size === 0)) return "missing"
    if (kind === "exec") accessSync(path, constants.X_OK)
    return "present"
  } catch (err) {
    return failure(err)
  }
}
// Only small, specified non-secret data files are read; never follow a leaf symlink or open a FIFO for blocking I/O.
function text(path: string): string | undefined {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const s = fstatSync(fd)
    if (!s.isFile() || s.size > 4096) return undefined
    const bytes = Buffer.alloc(4097)
    let n = 0
    while (n < bytes.length) {
      const count = readSync(fd, bytes, n, bytes.length - n, null)
      if (!count) break
      n += count
    }
    return n <= 4096 ? bytes.toString("utf8", 0, n) : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
function kvm(): Result {
  if (process.platform !== "linux" || process.arch !== "x64") return "missing"
  let fd
  try {
    fd = openSync("/dev/kvm", constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    if (!fstatSync(fd).isCharacterDevice()) return "missing"
    const lib = dlopen("libc.so.6", { ioctl: { args: ["i32", "u64", "u64"], returns: "i32" } })
    try {
      return lib.symbols.ioctl(fd, 0xae00n, 0n) === 12 ? "present" : "missing"
    } finally {
      lib.close()
    }
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EACCES" ? "missing" : failure(err)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
function unit(name: string, user: boolean): Unit {
  const uid = process.getuid?.()
  if (
    process.platform !== "linux" ||
    (user && (uid === undefined || userInfo().username !== "t1os"))
  )
    return "unknown"
  // Fixed local bus paths: ignore caller-selected transports and never contact a remote user manager.
  const result = spawnSync(
    "/usr/bin/systemctl",
    [...(user ? ["--user"] : []), "--no-pager", "is-active", name],
    {
      env: {
        PATH: "/usr/bin:/bin",
        LC_ALL: "C",
        SYSTEMD_PAGER: "cat",
        DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/run/dbus/system_bus_socket",
        ...(user
          ? {
              XDG_RUNTIME_DIR: "/run/user/" + uid,
              DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/" + uid + "/bus",
            }
          : {}),
      },
      timeout: 1000,
      killSignal: "SIGKILL",
      maxBuffer: 4096,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    },
  )
  if (result.status === 0 && result.stdout.trim() === "active") return "active"
  if (result.status === 3 && ["inactive", "failed", "deactivating"].includes(result.stdout.trim()))
    return "inactive"
  return "unknown"
}
function release() {
  try {
    const r = realpathSync(current)
    return dirname(r) === "/opt/t1os/releases" && /^[a-f0-9]{64}$/u.test(basename(r))
      ? basename(r)
      : undefined
  } catch {
    return undefined
  }
}
const host: Probes = { path: file, text, kvm, unit, release }

/** Inventory the current installation without launching services or reading credentials or settings. */
export function capabilities(p: Probes = host) {
  return Effect.sync(() => {
    const fact = (label: string, path: string, kind: Kind = "file"): Check => [
      label,
      p.path(path, kind),
    ]
    const local = (label: string, path: string, kind: Kind = "file") =>
      fact(label, current + "/" + path, kind)
    const operator = (label: string, path: string, kind: Kind = "file") =>
      fact(label, home + "/" + path, kind)
    const report = (
      name: string,
      installed: Check[],
      configuration: Check[],
      prerequisites: Check[],
      live: Unit,
      scope: string,
    ): Capability => {
      const observations = [...installed, ...configuration, ...prerequisites].map(
        ([, result]) => result,
      )
      const readiness =
        observations.includes("missing") || live === "inactive"
          ? "blocked"
          : !observations.includes("unknown") && live === "active"
            ? "ready"
            : "not verified"
      return { name, installed, configuration, prerequisites, readiness, scope }
    }
    let profile: "full" | "minimal" | "unknown" = "unknown"
    try {
      const v: unknown = JSON.parse(p.text(current + "/runtime/profile.json") ?? "null")
      if (
        v &&
        typeof v === "object" &&
        "profile" in v &&
        (v.profile === "full" || v.profile === "minimal")
      )
        profile = v.profile
    } catch {
      /* absent or invalid marker is not evidence of a full or minimal install */
    }
    const digest = p.release(),
      boot = p.text("/proc/sys/kernel/random/boot_id")?.trim()
    const receipt = p.text("/run/t1os-first-boot.ok")?.trim()
    const bootState: Unit =
      !digest || !boot || !receipt
        ? "unknown"
        : /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot) &&
            receipt === digest + " " + boot
          ? "active"
          : "inactive"
    const t3Unit = p.unit("t1os-t3.service", true),
      androidUnit = p.unit("t1os-android.service", true)
    const sdkPins = Object.entries(androidLock).map(([path, pin]): Check => {
      const metadata = sdk + "/" + path + "/source.properties"
      const exists = p.path(metadata, "file")
      const content = exists === "present" ? p.text(metadata) : undefined
      const actual = content?.match(/^Pkg\.Revision\s*=\s*([^\r\n]+)$/m)?.[1]?.trim()
      return [
        "SDK " + path + " revision " + pin,
        exists !== "present"
          ? exists
          : content === undefined
            ? "unknown"
            : actual === pin
              ? "present"
              : "missing",
      ]
    })
    const rows = [
      report(
        "T3 Code",
        [local("native server", "agent-host/t3-release/t3", "exec")],
        [
          fact("managed machine policy", "/etc/t3code/policy.json"),
          operator("operator T3 settings", ".t3/userdata/settings.json"),
          operator("T3 opt-in", ".config/t1os/enable-t3"),
        ],
        [],
        t3Unit,
        "Ready means the local user service is active; no HTTP, pairing or provider test.",
      ),
      report(
        "Pi and HolyAgent",
        [
          local("Pi launcher", "agent-host/bin/pi", "exec"),
          local("pinned Node", "agent-host/bin/node", "exec"),
          local("pinned Bun", "agent-host/bin/bun", "exec"),
        ],
        [
          operator("registered Pi settings", ".pi/agent/settings.json"),
          operator(
            "installed HolyAgent launcher",
            ".local/share/t1os/agent/holyagent-0.3.3/scripts/holyagent",
            "exec",
          ),
        ],
        [],
        "unknown",
        "File presence only; the first-boot offline RPC gate is not rerun. No model turn.",
      ),
      report(
        "Android and Device Hub",
        [
          local("Device Hub tooling", "apps/device-hub/src/profile.ts"),
          local(
            "inert agent-device package",
            "agent-host/pi-deps/node_modules/agent-device/bin/agent-device.mjs",
          ),
          local(
            "bundled Device Hub server",
            "agent-host/pi-deps/node_modules/expo-device-hub/dist/server/cli.mjs",
          ),
          fact("emulator unit", "/etc/systemd/user/t1os-android.service"),
        ],
        [
          fact("T3 integration drop-in", "/etc/systemd/user/t1os-t3.service.d/android.conf"),
          operator(
            "Device Hub install marker",
            ".t3/tools/expo-device-hub/0.22.1/.install-complete",
          ),
          operator("managed AVD configuration", ".android/avd/t1os_api35.avd/config.ini"),
        ],
        [
          ["KVM API 12 accessible to caller", p.kvm()],
          fact("SDK emulator", sdk + "/emulator/emulator", "exec"),
          fact("SDK platform tools", sdk + "/platform-tools/adb", "exec"),
          fact(
            "API 35 image",
            sdk + "/system-images/android-35/default/x86_64/system.img",
            "nonempty",
          ),
          fact("SDK manager", sdk + "/cmdline-tools/latest/bin/sdkmanager", "exec"),
          fact("AVD manager", sdk + "/cmdline-tools/latest/bin/avdmanager", "exec"),
          fact("Java", "/usr/bin/java", "exec"),
          fact("ffmpeg", "/usr/bin/ffmpeg", "exec"),
          ...sdkPins,
        ],
        androidUnit === "inactive" ? "inactive" : "unknown",
        "SDK revisions are checked against the lock. No ADB, capture or live Hub test. Use t1os android check for the SDK preflight. Emulator service: " +
          androidUnit +
          ".",
      ),
      report(
        "Private SSH forwarding",
        [
          fact("tunnel socket", "/etc/systemd/system/t1os-ssh-tunnel.socket"),
          fact("sshd", "/usr/bin/sshd", "exec"),
        ],
        [
          fact("forwarding policy", "/etc/t1os/sshd_tunnel_config"),
          fact("authorized keys present", "/etc/t1os/authorized_keys", "nonempty"),
          fact("host key present", "/etc/ssh/ssh_host_ed25519_key", "nonempty"),
        ],
        [fact("tailscale0 interface", "/sys/class/net/tailscale0", "dir")],
        p.unit("t1os-ssh-tunnel.socket", false),
        "Ready means socket active, not independently verified reachability, ACLs or authentication. Keys are never read.",
      ),
      report(
        "Optional desktop",
        [
          fact("desktop unit", "/etc/systemd/user/t1os-desktop.service"),
          fact("Hyprland", "/usr/bin/Hyprland", "exec"),
          fact("XWayland", "/usr/bin/Xwayland", "exec"),
          fact("WayVNC", "/usr/bin/wayvnc", "exec"),
        ],
        [fact("reviewed version marker", "/etc/t1os/desktop-versions", "nonempty")],
        [],
        p.unit("t1os-desktop.service", true),
        "Ready means compositor service active; display, input, WayVNC authentication and reconnect are not exercised.",
      ),
      report(
        "Headless browser",
        [
          local("packaged sandboxed fixture", "agent-host/pi-deps/browser-smoke.ts"),
          local("Playwright Core", "agent-host/pi-deps/node_modules/playwright-core/package.json"),
          local("fixture Bun", "agent-host/bin/bun", "exec"),
        ],
        [],
        [],
        "unknown",
        "Full-profile loopback fixture; /usr/bin/chromium: " +
          p.path("/usr/bin/chromium", "exec") +
          ". Use t1os browser check with a trusted absolute path to Chromium 158.0.8127.18. The inventory does not test Chromium, its sandbox or native CUA.",
      ),
      {
        name: "Native desktop CUA",
        installed: [],
        configuration: [],
        prerequisites: [],
        readiness: "not implemented",
        scope:
          "No integrated native CUA backend or certified desktop matrix; browser automation is not native CUA.",
      } as Capability,
      report(
        "Rootless jobs",
        [local("job wrapper", "runtime/run-job", "exec")],
        [],
        [
          fact("Podman", "/usr/bin/podman", "exec"),
          fact("cgroup v2 controllers", "/sys/fs/cgroup/cgroup.controllers"),
          operator("workspace root", "worktrees", "dir"),
        ],
        "unknown",
        "Does not start Podman or inspect images. Rootless mode, effective resource limits and a job are not verified.",
      ),
      report(
        "Recovery",
        [local("guest provisioner", "bin/t1os-guest-platform", "exec")],
        [fact("first-boot unit", "/etc/systemd/system/t1os-first-boot.service")],
        [],
        bootState,
        "Ready means the current-boot success marker matches the active release and boot ID. Rollback eligibility, prior release integrity and recovery are not exercised.",
      ),
    ]
    return { version: 1, profile, capabilities: rows }
  })
}
/** Render bounded diagnostic evidence using fixed labels only. */
export function renderCapabilities(result: Effect.Success<ReturnType<typeof capabilities>>) {
  const section = (name: string, facts: Check[]) =>
    facts.length
      ? "  " + name + ": " + facts.map(([label, state]) => label + "=" + state).join("; ")
      : undefined
  return [
    "Profile: " + result.profile,
    ...result.capabilities.flatMap((row) =>
      [
        row.name + ": " + row.readiness,
        section("installed", row.installed),
        section("configuration evidence", row.configuration),
        section("prerequisites", row.prerequisites),
        "  " + row.scope,
      ].filter(Boolean),
    ),
  ].join("\n")
}
