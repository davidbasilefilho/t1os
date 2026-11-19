import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import { parseArgs } from "node:util"

import { Effect } from "effect"

import {
  BASE,
  DIGEST,
  STATE,
  ensureDirectory,
  record,
  run,
  trusted,
  withLock,
} from "./guest-system.ts"
import { stage } from "./overlay.ts"

const bootUnit = "/etc/systemd/system/t1os-first-boot.service"
const bootRelative = "platform/t1os-first-boot.service"

/** Require the QEMU/KVM disk identity and the exact installed guest root. */
export function assertDisposableGuest(
  command: typeof run = run,
  read: (name: string) => string = (name) => readFileSync(name, "utf8"),
  canonical: typeof realpathSync = realpathSync,
): void {
  if (!["qemu", "kvm"].includes(command(["systemd-detect-virt", "--vm"])))
    throw new Error("apply requires the t1os disposable QEMU guest")
  if (read("/sys/block/vda/serial").trim() !== "T1OS_DISPOSABLE")
    throw new Error("unexpected guest disk identity")
  const device = command(["findmnt", "-n", "-o", "SOURCE", "/"]).split("[", 1)[0] ?? ""
  if (canonical(device) !== "/dev/vda2")
    throw new Error("expected the installed root of the disposable guest")
}

/** Require the installed pinned Omarchy version and Btrfs root, never the live ISO. */
export function assertPinnedSystem(): void {
  assertDisposableGuest()
  if (run(["findmnt", "-n", "-o", "FSTYPE", "/"]) !== "btrfs" || existsSync("/run/archiso")) {
    throw new Error("apply requires the installed Btrfs system, not the installer or a container")
  }
  const pkg = run(["pacman", "-Q", "omarchy"])
  if (!/^omarchy (?:\d+:)?4\.5\.0-[^\s]+$/.test(pkg))
    throw new Error(`expected installed Omarchy 4.5.0; found ${pkg}`)
}

/** Deny unprivileged or SSH-backed calls, including pseudo-terminals. */
export function assertConsole(uid: number | undefined, tty: string, env: string[]): void {
  if (uid !== 0) throw new Error("apply requires root")
  if (
    env.some((name) => name.startsWith("SSH_")) ||
    !/^\/dev\/tty(?:[1-9][0-9]*|S[0-9]+|AMA[0-9]+)$/.test(tty)
  )
    throw new Error("apply requires a virtual-terminal or serial console, not SSH")
}

function installedOnly(): void {
  // Do not let an inherited SSH environment or a sudo pseudo-terminal qualify.
  assertConsole(
    process.geteuid?.(),
    process.stdin.isTTY ? realpathSync("/proc/self/fd/0") : "",
    Object.keys(process.env),
  )
  assertPinnedSystem()
}

function link(path: string, target: string): void {
  const present = lstatSync(path, { throwIfNoEntry: false })
  if (present && !present.isSymbolicLink())
    throw new Error(`refusing to replace a non-managed pointer: ${path}`)
  const temporary = join(dirname(path), "." + basename(path))
  rmSync(temporary, { force: true })
  symlinkSync(target, temporary)
  renameSync(temporary, path)
}

/** Prepare a staged release without promoting it or writing an applied receipt. */
export function prepare(release: string): void {
  run([join(release, "platform/first-boot"), "--prepare"], 900_000, false)
}

function enableUnit(release: string, previous?: string): void {
  const source = readFileSync(join(release, bootRelative))
  const info = lstatSync(bootUnit, { throwIfNoEntry: false })
  if (info) {
    if (!info.isFile() || info.uid !== 0 || info.mode & 0o022)
      throw new Error("unsafe installed first-boot unit")
    const active = readFileSync(bootUnit)
    if (
      !active.equals(source) &&
      (!previous || !active.equals(readFileSync(join(previous, bootRelative))))
    ) {
      throw new Error("refusing to replace an independent first-boot unit")
    }
  }
  record(bootUnit, source, 0o644)
  run(["systemctl", "daemon-reload"])
  run(["systemctl", "enable", basename(bootUnit)])
}

/** A last-known-good deployment transaction over root-managed release pointers. */
export class Deployment {
  constructor(
    readonly base = BASE,
    readonly state = STATE,
    readonly prepareCandidate: (release: string) => void = prepare,
    readonly installUnit: (release: string, previous?: string) => void = enableUnit,
  ) {}

  /** Resolve a managed release pointer without accepting paths outside releases. */
  managedTarget(name: "current" | "previous"): string | undefined {
    const pointer = join(this.base, name)
    const info = lstatSync(pointer, { throwIfNoEntry: false })
    if (!info) return undefined
    if (!info.isSymbolicLink()) throw new Error(`${name} is not a managed release pointer`)
    const target = realpathSync(pointer)
    this.assertRelease(target)
    return target
  }

  private assertRelease(release: string): void {
    if (dirname(release) !== join(this.base, "releases") || !DIGEST.test(basename(release)))
      throw new Error("invalid staged release")
    const info = lstatSync(release)
    if (!info.isDirectory() || info.uid !== process.geteuid?.() || info.mode & 0o022)
      throw new Error("unsafe staged release")
  }

  /** Promote a verified candidate or restore the prior release setup on failure. */
  activate(release: string, check?: (release: string) => void): void {
    this.assertRelease(release)
    const old = this.managedTarget("current")
    const pending = join(this.state, "pending")
    record(pending, basename(release) + "\n")
    try {
      this.prepareCandidate(release)
      check?.(release)
      this.installUnit(release, old)
    } catch (failure) {
      // Never move current on failed candidate. Keep the pending receipt for console recovery.
      if (old && old !== release) {
        try {
          this.prepareCandidate(old)
          this.installUnit(old, release)
        } catch (recoveryFailure) {
          throw new AggregateError(
            [failure, recoveryFailure],
            "candidate and known-good recovery both failed",
          )
        }
      }
      throw failure
    }
    if (old !== release) {
      if (old) link(join(this.base, "previous"), old)
      link(join(this.base, "current"), release)
    }
    record(join(this.state, "applied"), basename(release) + "\n")
    unlinkSync(pending)
  }

  /** Select the interrupted transaction's current release or the most recent predecessor. */
  rollbackTarget(): string {
    const target = this.managedTarget(
      existsSync(join(this.state, "pending")) ? "current" : "previous",
    )
    if (!target)
      throw new Error(
        "no known-good release for rollback; retry a verified bundle from the console",
      )
    return target
  }
}

function provision(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      bundle: { type: "string" },
      sha256: { type: "string" },
      rollback: { type: "boolean" },
      apply: { type: "boolean" },
      help: { type: "boolean" },
    },
  })
  if (values.help) {
    console.log(
      "usage: t1os-guest-platform provision (--bundle TAR --sha256 DIGEST | --rollback) [--apply]",
    )
    return
  }
  if (Boolean(values.bundle) === Boolean(values.rollback))
    throw new Error("choose exactly one of --bundle and --rollback")
  const pin = values.sha256
  if (values.bundle && (!pin || !DIGEST.test(pin)))
    throw new Error("--bundle requires the expected --sha256 from an independent trusted source")
  if (values.rollback && pin !== undefined) throw new Error("--rollback does not accept --sha256")
  if (!values.apply) {
    console.log(
      "Dry run: no files or services changed; " +
        (values.rollback
          ? "restore the previously staged overlay"
          : `apply ${pin} after verifying ${values.bundle}`),
    )
    return
  }
  process.umask(0o022)
  installedOnly()
  const releases = join(BASE, "releases")
  ensureDirectory(BASE, 0o755)
  ensureDirectory(releases, 0o755)
  ensureDirectory(STATE, 0o700)
  trusted(dirname(bootUnit), true)
  const deployment = new Deployment()
  withLock(join(STATE, "deployment.lock"), () => {
    const release = values.rollback
      ? deployment.rollbackTarget()
      : stage(values.bundle!, pin!, releases)
    deployment.activate(release)
  })
}

/** Validate provision arguments and apply only from the local disposable guest console. */
export function main(args: string[]): void {
  Effect.runSync(
    Effect.try({
      try: () => provision(args),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  )
}
