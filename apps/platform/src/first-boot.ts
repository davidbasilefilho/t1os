import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"

import { Effect } from "effect"

import {
  BASE,
  BOOT_ID,
  DIGEST,
  STATE,
  asOperator,
  ensureDirectory,
  record,
  run,
  trusted,
  withLock,
} from "./guest-system.ts"
import { assertPinnedSystem } from "./provision.ts"

function updateCli(release: string): void {
  const managed = join(BASE, "current/bin/t1os")
  const publicCli = "/usr/local/bin/t1os"
  const directory = dirname(publicCli)
  trusted(dirname(directory), true)
  if (lstatSync(directory, { throwIfNoEntry: false })) trusted(directory, true)
  const info = lstatSync(publicCli, { throwIfNoEntry: false })
  const existing = info?.isSymbolicLink() ? readlinkSync(publicCli) : undefined
  const ownCli = lstatSync(join(release, "bin/t1os"), { throwIfNoEntry: false })
  if (ownCli?.isFile() && ownCli.mode & 0o111) {
    if (info && existing !== managed) throw new Error(`refusing to overwrite existing ${publicCli}`)
    ensureDirectory(directory, 0o755)
    const temporary = mkdtempSync(join(directory, ".t1os-link-"))
    try {
      const link = join(temporary, "t1os")
      symlinkSync(managed, link)
      renameSync(link, publicCli)
    } finally {
      rmSync(temporary, { force: true, recursive: true })
    }
  } else if (existing === managed) unlinkSync(publicCli)
}

function setupOperator(): void {
  // A missing account is the only condition in which creation should run.
  let identity: string
  try {
    identity = run(["getent", "passwd", "t1os"])
  } catch {
    run(["useradd", "--create-home", "--user-group", "--shell", "/bin/bash", "t1os"])
    identity = run(["getent", "passwd", "t1os"])
  }
  const uid = Number(run(["id", "-u", "t1os"]))
  if (!Number.isInteger(uid) || uid < 1000 || run(["id", "-Gn", "t1os"]) !== "t1os") {
    throw new Error("existing t1os account must be an unprivileged, dedicated operator")
  }
  if (run(["passwd", "-S", "t1os"]).split(/\s+/)[1] !== "L")
    throw new Error("existing t1os operator password must remain locked")
  const home = lstatSync("/home/t1os")
  if (identity.split(":")[5] !== "/home/t1os" || !home.isDirectory() || home.uid !== uid)
    throw new Error("invalid t1os operator home")
}

function firstBoot(args: string[]): void {
  if (process.geteuid?.() !== 0) throw new Error("first boot requires root")
  // This helper must not create accounts, restart services or install outside the supported guest.
  assertPinnedSystem()
  process.umask(0o022)
  const candidate = args.length === 2 && args[0] === "--prepare" ? args[1] : undefined
  if (args.length && !candidate) throw new Error("usage: first-boot [--prepare RELEASE]")
  trusted(BASE, true)
  withLock("/run/t1os-provision.lock", () => {
    if (!candidate) rmSync("/run/t1os-first-boot.ok", { force: true })
    const release = realpathSync(candidate ?? join(BASE, "current"))
    const digest = basename(release)
    if (dirname(release) !== join(BASE, "releases") || !DIGEST.test(digest))
      throw new Error("invalid active release")
    trusted(release, true)
    if ((lstatSync(release).mode & 0o777) !== 0o755) throw new Error("invalid release ownership")
    const marker = JSON.parse(readFileSync(join(release, "runtime/profile.json"), "utf8")) as {
      profile?: string
    }
    if (marker.profile !== "full" && marker.profile !== "minimal")
      throw Error("invalid bundle profile")
    const full = marker.profile === "full"
    if (!full && existsSync(join(BASE, "current/agent-host")))
      throw Error(
        "Minimal requires a fresh guest; existing full capabilities will not be silently deactivated.",
      )
    setupOperator()
    ensureDirectory(STATE, 0o700)
    const platform = join(release, "bin/t1os-guest-platform")
    trusted(platform)
    if (full) run([platform, "install-runtime", "/"], 120_000, false)
    run(["systemctl", "daemon-reload"])
    for (const unit of ["sshd.service", "sshd.socket"]) {
      if (run(["systemctl", "show", unit, "--property=LoadState", "--value"]) === "loaded") {
        run(["systemctl", "disable", "--now", unit])
      }
    }
    run(["systemctl", "set-default", "multi-user.target"])
    if (
      run(["systemctl", "show", "sddm.service", "--property=LoadState", "--value"]) === "loaded"
    ) {
      run(["systemctl", "disable", "sddm.service"])
    }
    updateCli(release)
    const archive = join(release, "runtime/agent/holyagent-0.3.3.tgz")
    const toolDirectory = join(release, "agent-host")
    if (full) {
      trusted(archive)
      trusted(toolDirectory, true)
      for (const [command, argument] of [
        ["check-ready", release],
        ["stage", archive],
      ] as const) {
        const stdout = asOperator("/home/t1os", platform, command, argument)
        if (stdout) console.log(stdout)
      }
    }
    if (candidate) {
      console.log(`t1os candidate prepared: ${digest}`)
      return
    }
    record(join(STATE, "applied"), digest + "\n")
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    if (!BOOT_ID.test(boot)) throw new Error("invalid Linux boot ID")
    record("/run/t1os-first-boot.ok", `${digest} ${boot}\n`)
    console.log(`t1os first boot applied: ${digest}`)
  })
}

/** Apply verified root-owned runtime configuration in the disposable guest. */
export function main(args: string[]): void {
  Effect.runSync(
    Effect.try({
      try: () => firstBoot(args),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  )
}
