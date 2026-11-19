import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { confirmBootRecord, confirmOrDeploy, receipt, serial } from "../src/bootstrap.ts"
import { withLock } from "../src/guest-system.ts"
import { allowed, consumeMedia, stage } from "../src/overlay.ts"
import {
  Deployment,
  assertConsole,
  assertDisposableGuest,
  main as provision,
} from "../src/provision.ts"

const SHA_A = "a".repeat(64)
const SHA_B = "b".repeat(64)
const SHA_C = "c".repeat(64)

function fixture<T>(exec: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "t1os-recovery-"))
  try {
    return exec(dir)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

function member(name: string, type = "0", data = Buffer.from("fixture"), mode = "0000755"): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, "utf8")
  header.write(mode, 100)
  header.write(data.length.toString(8).padStart(11, "0"), 124)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write("ustar", 257)
  header.write("00", 263)
  const sum = header.reduce((a, b) => a + b)
  header.write(sum.toString(8).padStart(6, "0"), 148)
  header[154] = 0
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

function tar(extra: Buffer[] = [], suffix = Buffer.alloc(1_024)): Buffer {
  return Buffer.concat([
    member("platform/first-boot"),
    member("platform/t1os-first-boot.service"),
    member("runtime/install.sh"),
    member("bin/t1os-guest-platform"),
    ...extra,
    suffix,
  ])
}

function setup(base: string): { releases: string; state: string; a: string; b: string; c: string } {
  const releases = join(base, "releases")
  const state = join(base, "state")
  mkdirSync(releases)
  mkdirSync(state)
  const a = join(releases, SHA_A)
  const b = join(releases, SHA_B)
  const c = join(releases, SHA_C)
  for (const target of [a, b, c]) mkdirSync(target)
  return { releases, state, a, b, c }
}

function hash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

test("failed candidates restore known-good config and preserve current and applied before rollback", () =>
  fixture((base) => {
    const { state, a, b, c } = setup(base)
    const setupEvents: string[] = []
    const deploy = new Deployment(
      base,
      state,
      (release) => {
        setupEvents.push(release)
        if (release === b) throw new Error("candidate did not pass")
      },
      () => {},
    )
    deploy.activate(a)
    expect(() => deploy.activate(b)).toThrow("candidate did not pass")
    expect(setupEvents).toEqual([a, b, a])
    expect(deploy.managedTarget("current")).toBe(a)
    expect(deploy.rollbackTarget()).toBe(a)
    expect(readFileSync(join(state, "applied"), "utf8")).toBe(SHA_A + "\n")
    expect(readFileSync(join(state, "pending"), "utf8")).toBe(SHA_B + "\n")
    deploy.activate(deploy.rollbackTarget())
    expect(existsSync(join(state, "pending"))).toBe(false)
    deploy.activate(c)
    expect(deploy.managedTarget("previous")).toBe(a)
    expect(deploy.rollbackTarget()).toBe(a)
  }))

test("failed first activation leaves no fake current or applied, then rejects not-ready candidate", () =>
  fixture((base) => {
    const { state, a, b } = setup(base)
    const deploy = new Deployment(
      base,
      state,
      (release) => {
        if (release === b) throw new Error("broken")
      },
      () => {},
    )
    expect(() => deploy.activate(b)).toThrow("broken")
    expect(deploy.managedTarget("current")).toBeUndefined()
    expect(existsSync(join(state, "applied"))).toBe(false)
    expect(readFileSync(join(state, "pending"), "utf8")).toBe(SHA_B + "\n")
    expect(() => deploy.rollbackTarget()).toThrow("no known-good")
    expect(() =>
      deploy.activate(a, () => {
        throw new Error("not ready")
      }),
    ).toThrow("not ready")
    expect(deploy.managedTarget("current")).toBeUndefined()
  }))

test("idempotent staging always verifies media and rejects a dangling digest pointer", () =>
  fixture((base) => {
    const { releases } = setup(base)
    const payload = tar()
    const digest = hash(payload)
    const media = join(base, "install.tar")
    writeFileSync(media, payload)
    symlinkSync(join(base, "missing"), join(releases, digest))
    expect(() => stage(media, digest, releases)).toThrow("unsafe staged release")
    rmSync(join(releases, digest))
    const release = stage(media, digest, releases)
    expect(readFileSync(join(release, "runtime/install.sh"), "utf8")).toBe("fixture")
    expect(stage(media, digest, releases)).toBe(release)
    writeFileSync(media, "changed media")
    expect(() => stage(media, digest, releases)).toThrow("SHA-256")
  }))

test("reject traversal, links, duplicate names, absolute paths, control characters and trailing bytes", () =>
  fixture((base) => {
    const { releases } = setup(base)
    const media = join(base, "install.tar")
    for (const payload of [
      tar([member("runtime/link", "2")]),
      tar([member("runtime/hard-link", "1")]),
      tar([member("runtime/../bad")]),
      tar([member("runtime/install.sh")]),
      tar([member("/runtime/absolute")]),
      tar([member("runtime/control\n")]),
      tar([], Buffer.alloc(1_024, 8)),
    ]) {
      const digest = hash(payload)
      writeFileSync(media, payload)
      expect(() => stage(media, digest, releases)).toThrow()
      expect(existsSync(join(releases, digest))).toBe(false)
    }
  }))

test("allow constrained POSIX path metadata but reject sparse metadata and final line breaks", () =>
  fixture((base) => {
    const path = "agent-host/pi-deps/node_modules/" + "a".repeat(160) + "/papéis aqui"
    const format = (record: string) => {
      let size = record.length
      while (size !== Buffer.byteLength(`${size} ${record}\n`))
        size = Buffer.byteLength(`${size} ${record}\n`)
      return Buffer.from(`${size} ${record}\n`)
    }
    const payload = tar([
      member("PaxHeaders/filename", "x", format("path=" + path)),
      member("placeholder"),
    ])
    const media = join(base, "install.tar")
    const { releases } = setup(base)
    writeFileSync(media, payload)
    const release = stage(media, hash(payload), releases)
    expect(readFileSync(join(release, path), "utf8")).toBe("fixture")
    const sparse = tar([
      member("PaxHeaders/filename", "x", format("GNU.sparse.name=" + path)),
      member("placeholder"),
    ])
    writeFileSync(media, sparse)
    expect(() => stage(media, hash(sparse), releases)).toThrow("unsupported PAX")
    expect(allowed("runtime/x\n")).toBe(false)
  }))

test("dry run does not require root or read media, while console and device guards deny unsafe hosts", () => {
  expect(() => provision(["--bundle", "/does-not-exist", "--sha256", SHA_A])).not.toThrow()
  expect(() => provision(["--bundle", "/does-not-exist", "--sha256", SHA_A + "\n"])).toThrow()
  expect(() => assertConsole(0, "/dev/pts/2", [])).toThrow("console")
  expect(() => assertConsole(0, "/dev/ttyS0", ["SSH_CONNECTION"])).toThrow("console")
  expect(() => assertConsole(1000, "/dev/tty1", [])).toThrow("root")
  expect(() => assertDisposableGuest(() => "none")).toThrow("QEMU")
})

test("serial evidence refuses regular files and receipts cannot overwrite earlier successes", () =>
  fixture((base) => {
    const file = join(base, "receipt")
    receipt(file, SHA_A)
    expect(() => receipt(file, SHA_B)).toThrow()
    expect(() => serial("T1OS_FAILED", file)).toThrow("character device")
    expect(readFileSync(file, "utf8")).toBe(SHA_A + "\n")
  }))

test("reboot verifies live evidence and reopens the current checkpoint without promoting again", () => {
  const events: string[] = []
  const active = confirmOrDeploy(SHA_A, {
    hasReceipt: () => true,
    readInitial: () => SHA_A,
    readActive: () => SHA_C,
    confirmCurrent: (digest) => {
      events.push("current:" + digest)
    },
    verify: (digest) => {
      events.push("verify:" + digest)
      return "releases/" + digest
    },
    checkpoint: (release, initial) => {
      events.push(`probe:${release}:${initial}`)
    },
    deploy: () => {
      throw new Error("would reinstall")
    },
    recordInitial: () => {
      throw new Error("would overwrite initial receipt")
    },
    phase: (name) => {
      events.push(name)
    },
  })
  expect(active).toBe(SHA_C)
  expect(events).toEqual([
    "current:" + SHA_C,
    "current-boot-verified",
    "verify:" + SHA_C,
    "probe:releases/" + SHA_C + ":false",
  ])
})

test("stale, skipped or failed units do not count as current boot success", () => {
  const boot = "00000000-1111-2222-3333-444444444444"
  const text = `${SHA_A} ${boot}\n`
  const fields = {
    LoadState: "loaded",
    Result: "success",
    ActiveState: "active",
    SubState: "exited",
    ExecMainStatus: "0",
    ConditionResult: "yes",
    AssertResult: "yes",
    ExecMainStartTimestampMonotonic: "10",
    ExecMainExitTimestampMonotonic: "19",
  }
  expect(() => confirmBootRecord(SHA_A, boot, text, fields)).not.toThrow()
  expect(() =>
    confirmBootRecord(SHA_A, boot, `${SHA_A} aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n`, fields),
  ).toThrow()
  for (const bad of [
    { Result: "exit-code" },
    { ExecMainStatus: "1" },
    { ConditionResult: "no" },
    { ExecMainStartTimestampMonotonic: "0" },
    { ExecMainExitTimestampMonotonic: "0" },
  ])
    expect(() => confirmBootRecord(SHA_A, boot, text, { ...fields, ...bad })).toThrow()
})

test("bounded media snapshot detects a short read", () =>
  fixture((base) => {
    const file = join(base, "media")
    writeFileSync(file, "data+later")
    const fd = openSync(file, "r")
    try {
      const collected: string[] = []
      consumeMedia(fd, 4, (bytes) => collected.push(bytes.toString()))
      expect(collected).toEqual(["data"])
      expect(() => consumeMedia(fd, 256, () => {})).toThrow("shrank")
    } finally {
      closeSync(fd)
    }
  }))

test("deployment lock lives past the flock subprocess and is released even on failure", () =>
  fixture((base) => {
    const file = join(base, "lock")
    const contender = () => Bun.spawnSync(["/usr/bin/flock", "-n", file, "/bin/true"]).exitCode
    expect(() =>
      withLock(file, () => {
        expect(contender()).toBe(1)
        throw new Error("failure")
      }),
    ).toThrow("failure")
    expect(contender()).toBe(0)
  }))
