import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
  chownSync,
} from "node:fs"
import { basename, join } from "node:path"

import { Effect } from "effect"

import {
  BASE,
  BOOT_ID,
  DIGEST,
  PATH,
  STATE,
  ensureDirectory,
  record,
  run,
  trusted,
  withLock,
} from "./guest-system.ts"
import { stage } from "./overlay.ts"
import { Deployment, assertPinnedSystem } from "./provision.ts"

const BOOT = join(BASE, "bootstrap")

function assertMachine(args: string[]): void {
  if (process.geteuid?.() !== 0 || existsSync("/run/archiso"))
    throw new Error("not the installed root")
  if (
    args.length ||
    !process.env.INVOCATION_ID ||
    !/^0::\/system\.slice\/t1os-bootstrap\.service$/m.test(
      readFileSync("/proc/self/cgroup", "utf8"),
    )
  ) {
    throw new Error("only the system t1os-bootstrap.service may invoke this mode")
  }
  assertPinnedSystem()
  trusted(BOOT, true)
  for (const file of ["t1os-guest-platform", "expected-sha256"]) trusted(join(BOOT, file))
}

function readSha(path: string): string {
  trusted(path)
  const digest = readFileSync(path, "utf8").replace(/\n$/, "")
  if (!DIGEST.test(digest) || digest.length !== 64) throw new Error(`invalid digest: ${path}`)
  return digest
}

/** Record a completion marker without replacing an earlier result. */
export function receipt(path: string, value: string): void {
  record(path, value + "\n", 0o600, true)
}

function verifyCandidate(active: string): void {
  if (run(["systemctl", "get-default"]) !== "multi-user.target")
    throw new Error("unexpected default target")
  for (const unit of ["sshd.service", "sshd.socket", "display-manager.service", "sddm.service"]) {
    const state = run(["systemctl", "show", unit, "-p", "ActiveState", "--value"])
    if (!["inactive", "failed"].includes(state))
      throw new Error(`not CLI-only/private: ${unit} is ${state}`)
  }
  const uid = Number(run(["id", "-u", "t1os"]))
  if (!Number.isInteger(uid) || uid < 1000 || run(["id", "-Gn", "t1os"]) !== "t1os")
    throw new Error("operator has unexpected privileges")
  if (run(["passwd", "-S", "t1os"]).split(/\s+/)[1] !== "L")
    throw new Error("operator local password is not locked")
  const cli = join(active, "bin/t1os")
  trusted(cli)
  if (
    !(lstatSync(cli).mode & 0o111) ||
    !run([
      "runuser",
      "-u",
      "t1os",
      "--",
      "env",
      "-i",
      "HOME=/home/t1os",
      `PATH=${PATH}`,
      cli,
      "--help",
    ]).includes("t1os capture")
  ) {
    throw new Error("the compiled t1os CLI did not pass its unprivileged smoke check")
  }
}

function verify(expected: string, deployment: Deployment): string {
  const active = deployment.managedTarget("current")
  if (
    !active ||
    active !== join(BASE, "releases", expected) ||
    readSha(join(STATE, "applied")) !== expected
  ) {
    throw new Error("applied digest and active release differ")
  }
  trusted(active, true)
  verifyCandidate(active)
  return active
}

/** Require matching kernel boot, digest and a completed native systemd oneshot result. */
export function confirmBootRecord(
  digest: string,
  boot: string,
  text: string,
  fields: Readonly<Record<string, string>>,
): void {
  if (
    !BOOT_ID.test(boot) ||
    text !== `${digest} ${boot}\n` ||
    fields.LoadState !== "loaded" ||
    fields.Result !== "success" ||
    fields.ActiveState !== "active" ||
    fields.SubState !== "exited" ||
    fields.ExecMainStatus !== "0" ||
    fields.ConditionResult !== "yes" ||
    fields.AssertResult !== "yes"
  )
    throw new Error("no successful first-boot unit execution for this kernel boot and digest")
  const start = fields.ExecMainStartTimestampMonotonic ?? ""
  const finish = fields.ExecMainExitTimestampMonotonic ?? ""
  if (
    !/^\d{1,20}$/.test(start) ||
    !/^\d{1,20}$/.test(finish) ||
    BigInt(start) <= 0n ||
    BigInt(start) > BigInt(finish)
  ) {
    throw new Error("current first-boot unit did not complete")
  }
}

function verifyCurrentBoot(digest: string): void {
  const proof = "/run/t1os-first-boot.ok"
  trusted(proof)
  const fields = Object.fromEntries(
    run([
      "systemctl",
      "show",
      "t1os-first-boot.service",
      "--property=LoadState,Result,ActiveState,SubState,ExecMainStatus,ConditionResult,AssertResult,ExecMainStartTimestampMonotonic,ExecMainExitTimestampMonotonic",
    ])
      .split("\n")
      .map((line) => line.split("=", 2)),
  )
  confirmBootRecord(
    digest,
    readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    readFileSync(proof, "utf8"),
    fields,
  )
}

function checkpointProbe(release: string, initial: boolean): void {
  const root = "/var/lib/t1os-acceptance"
  ensureDirectory(root, 0o711)
  const uid = Number(run(["id", "-u", "t1os"]))
  const gid = Number(run(["id", "-g", "t1os"]))
  if (!Number.isInteger(uid) || uid < 1000 || !Number.isInteger(gid) || gid < 1)
    throw new Error("invalid operator identity")
  const fixture = join(root, "operator")
  if (!existsSync(fixture)) {
    if (!initial) throw new Error("persisted operator fixture missing")
    mkdirSync(fixture, { mode: 0o700 })
    chownSync(fixture, uid, gid)
  }
  const entry = lstatSync(fixture)
  if (!entry.isDirectory() || entry.uid !== uid || entry.mode & 0o077)
    throw new Error("unsafe acceptance workspace")
  const workspace = join(fixture, "worktree")
  const cli = join(release, "bin/t1os")
  const asOperator = (...args: string[]): string =>
    run([
      "runuser",
      "-u",
      "t1os",
      "--",
      "env",
      "-i",
      "LANG=C",
      `PATH=${PATH}`,
      `HOME=${fixture}`,
      `XDG_STATE_HOME=${join(fixture, "xdg-state")}`,
      `T3CODE_HOME=${join(fixture, "t3")}`,
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_CONFIG_GLOBAL=/dev/null",
      ...args,
    ])
  const stamp = join(STATE, "acceptance-checkpoint")
  if (!existsSync(stamp)) {
    if (!initial) throw new Error("missing prior-boot checkpoint")
    asOperator("/usr/bin/mkdir", "-p", workspace)
    asOperator("/usr/bin/git", "-C", workspace, "init", "--quiet")
    asOperator(
      "/usr/bin/git",
      "-c",
      "user.name=t1os",
      "-c",
      "user.email=fixture@example.invalid",
      "-C",
      workspace,
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "disposable boot fixture",
    )
    const captured = asOperator(cli, "capture", workspace)
    if (!DIGEST.test(captured)) throw new Error("unexpected checkpoint ID")
    receipt(stamp, captured)
  }
  const expected = readSha(stamp)
  const saved: unknown = JSON.parse(asOperator(cli, "show", expected))
  const head = asOperator("/usr/bin/git", "-C", workspace, "rev-parse", "--verify", "HEAD")
  if (
    !saved ||
    typeof saved !== "object" ||
    !("workspace" in saved) ||
    saved.workspace !== workspace ||
    !("head" in saved) ||
    saved.head !== head ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)
  ) {
    throw new Error("prior worktree commit or saved checkpoint did not survive")
  }
  const ids: unknown = JSON.parse(asOperator(cli, "list"))
  if (
    !Array.isArray(ids) ||
    !ids.includes(expected) ||
    asOperator(cli, "capture", workspace) !== expected
  ) {
    throw new Error("checkpoint could not be reopened by the operator")
  }
}

/** Write fixed-format acceptance evidence only to an existing character device. */
export function serial(message: string, device = "/dev/ttyS0"): void {
  const fd = openSync(device, constants.O_NOFOLLOW | constants.O_NOCTTY | constants.O_WRONLY)
  try {
    if (!fstatSync(fd).isCharacterDevice()) throw new Error("expected a serial character device")
    const bytes = Buffer.from(message + "\n", "ascii")
    if (writeSync(fd, bytes) !== bytes.length) throw new Error("incomplete serial evidence")
  } finally {
    closeSync(fd)
  }
}

/** Bootstrap steps isolated from the deploy-or-confirm sequencing decision. */
export interface BootRun {
  hasReceipt: () => boolean
  readInitial: () => string
  readActive: () => string
  confirmCurrent: (digest: string) => void
  verify: (digest: string) => string
  checkpoint: (release: string, initial: boolean) => void
  deploy: (expected: string) => void
  recordInitial: (digest: string) => void
  phase: (message: string) => void
}

/** Subsequent boots only verify the active release; they never reinstall the original. */
export function confirmOrDeploy(expected: string, boot: BootRun): string {
  if (boot.hasReceipt()) {
    if (boot.readInitial() !== expected)
      throw new Error("initial receipt conflicts with the provisioned media")
    const active = boot.readActive()
    boot.confirmCurrent(active)
    boot.phase("current-boot-verified")
    boot.checkpoint(boot.verify(active), false)
    return active
  }
  boot.phase("preparing-candidate")
  boot.deploy(expected)
  boot.phase("candidate-promoted")
  boot.checkpoint(boot.verify(expected), true)
  boot.recordInitial(expected)
  return expected
}

function bootstrap(args: string[]): void {
  assertMachine(args)
  const phase = (label: string): void => serial("T1OS_PHASE " + label)
  phase("machine-verified")
  const expected = readSha(join(BOOT, "expected-sha256"))
  ensureDirectory(STATE, 0o700)
  const done = join(STATE, "initial-bootstrap-sha256")
  const deployment = new Deployment()
  const digest = withLock(join(STATE, "deployment.lock"), () =>
    confirmOrDeploy(expected, {
      hasReceipt: () => Boolean(lstatSync(done, { throwIfNoEntry: false })),
      readInitial: () => readSha(done),
      readActive: () => readSha(join(STATE, "applied")),
      confirmCurrent: verifyCurrentBoot,
      verify: (digest) => verify(digest, deployment),
      checkpoint: checkpointProbe,
      deploy: (expected) => {
        const archive = join(BOOT, "t1os.tar")
        trusted(archive)
        const releases = join(BASE, "releases")
        ensureDirectory(releases, 0o755)
        const active = deployment.managedTarget("current")
        if (active && basename(active) !== expected)
          throw new Error("another release is already active; use console recovery")
        deployment.activate(stage(archive, expected, releases), verifyCandidate)
      },
      recordInitial: (digest) => receipt(done, digest),
      phase,
    }),
  )
  serial("T1OS_READY " + digest)
}

/** Enter the systemd-only unattended QEMU bootstrap and emit fixed acceptance evidence. */
export function main(args: string[]): void {
  Effect.runSync(
    Effect.try({
      try: () => bootstrap(args),
      catch: (cause) => {
        if (process.geteuid?.() === 0 && process.env.INVOCATION_ID) {
          try {
            serial("T1OS_FAILED")
          } catch {
            /* No other evidence is emitted to serial. */
          }
        }
        return cause instanceof Error ? cause : new Error(String(cause))
      },
    }),
  )
}
