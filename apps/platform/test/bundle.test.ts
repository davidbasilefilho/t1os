import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BundleWriter } from "../src/build-bundle.ts"
import { allowed, androidProfileFiles, stage } from "../src/overlay.ts"

function temporary(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "t1os-build-bundle-"))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function build(path: string, run: (writer: BundleWriter) => void): string {
  const fd = openSync(path, "wx", 0o600)
  try {
    const writer = new BundleWriter(fd)
    run(writer)
    return writer.finish()
  } finally {
    closeSync(fd)
  }
}

test("portable deterministic tar with long Unicode paths and matching hash stages twice", () => {
  temporary((dir) => {
    const tar = join(dir, "bundle.tar")
    const duplicate = join(dir, "same.tar")
    const releases = join(dir, "releases")
    const long = `agent-host/pi-deps/node_modules/scope/${"é".repeat(72)}.txt`
    const buildFixture = (writer: BundleWriter) => {
      for (const name of [
        "bin/t1os-guest-platform",
        "platform/first-boot",
        "platform/t1os-first-boot.service",
        "runtime/install.sh",
      ]) {
        writer.bytes(name, Buffer.from("fixture"), 0o755)
      }
      writer.bytes(long, Buffer.from("long file"), 0o640)
    }
    mkdirSync(releases)
    const digest = build(tar, buildFixture)
    expect(digest).toBe(build(duplicate, buildFixture))
    expect(digest).toBe(createHash("sha256").update(readFileSync(tar)).digest("hex"))
    const release = stage(tar, digest, releases)
    expect(readFileSync(join(release, long), "utf8")).toBe("long file")
    expect(statSync(join(release, long)).mode & 0o777).toBe(0o644)
    expect(statSync(join(release, "bin/t1os-guest-platform")).mode & 0o777).toBe(0o755)
    expect(stage(tar, digest, releases)).toBe(release)
    expect(() => stage(tar, "0".repeat(64), releases)).toThrow("does not match")
  })
})

test("writer rejects duplicate names, traversal, symlink inputs and mismatched pins", () => {
  temporary((dir) => {
    const target = join(dir, "target")
    const link = join(dir, "link")
    const fixture = Buffer.from("fixture")
    writeFileSync(target, fixture)
    symlinkSync(target, link)
    build(join(dir, "bundle.tar"), (writer) => {
      writer.bytes("runtime/fixture", fixture, 0o644)
      expect(() => writer.bytes("runtime/fixture", fixture, 0o644)).toThrow(
        "unexpected bundle entry",
      )
      expect(() => writer.bytes("runtime/../../etc/shadow", fixture, 0o644)).toThrow(
        "unexpected bundle entry",
      )
      expect(() => writer.file("runtime/link", link)).toThrow()
    })
    expect(() =>
      build(join(dir, "wrong-pin.tar"), (writer) => {
        writer.file("runtime/agent/holyagent.tgz", target, undefined, "0".repeat(128))
      }),
    ).toThrow("pinned registry SHA-512")
  })
})

test("verified bundle accepts only complete reviewed Android profile controls", () => {
  temporary((dir) => {
    const releases = join(dir, "releases")
    mkdirSync(releases)
    const buildProfile = (path: string, paths: readonly string[]) =>
      build(path, (writer) => {
        for (const base of [
          "bin/t1os-guest-platform",
          "platform/first-boot",
          "platform/t1os-first-boot.service",
          "runtime/install.sh",
        ])
          writer.bytes(base, Buffer.from("core"), 0o755)
        for (const name of paths)
          writer.bytes(name, readFileSync(join(import.meta.dir, "../../..", name)), 0o644)
      })
    const full = join(dir, "full.tar")
    const ready = stage(full, buildProfile(full, androidProfileFiles), releases)
    for (const name of androidProfileFiles)
      expect(readFileSync(join(ready, name))).toEqual(
        readFileSync(join(import.meta.dir, "../../..", name)),
      )
    const partial = join(dir, "partial.tar")
    expect(() =>
      stage(partial, buildProfile(partial, androidProfileFiles.slice(1)), releases),
    ).toThrow("incomplete Android profile")
    for (const name of [
      "apps/device-hub/test/profile.test.ts",
      "apps/device-hub/src/unreviewed.ts",
      "runtime/android/licenses/android-sdk-license",
      "runtime/android/emulator.zip",
    ]) {
      expect(allowed(name)).toBe(false)
      expect(() =>
        build(join(dir, Buffer.from(name).toString("hex")), (writer) =>
          writer.bytes(name, Buffer.from("unexpected"), 0o644),
        ),
      ).toThrow("unexpected bundle entry")
    }
  })
})

test("guest unpack rejects an independently constructed tar containing an unreviewed Android tool", () => {
  temporary((dir) => {
    const name = "apps/device-hub/src/extra.ts"
    mkdirSync(join(dir, "apps/device-hub/src"), { recursive: true })
    writeFileSync(join(dir, name), "injected")
    const archive = join(dir, "injected.tar")
    const tar = Bun.spawnSync(["tar", "--format=ustar", "-cf", archive, "-C", dir, name])
    expect(tar.exitCode).toBe(0)
    const releases = join(dir, "releases")
    mkdirSync(releases)
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex")
    expect(() => stage(archive, digest, releases)).toThrow("unexpected bundle entry")
    expect(readdirSync(releases)).toHaveLength(0)
  })
})

test("default full cannot silently fall back to minimal", async () => {
  const { selectProfile, main } = await import("../src/build-bundle.ts")
  expect(selectProfile()).toBe("full")
  expect(selectProfile("full")).toBe("full")
  expect(selectProfile("minimal")).toBe("minimal")
  expect(() => selectProfile("auto")).toThrow()
  const impossible = join(tmpdir(), "t1os-not-real/agent-host")
  await expect(
    main(["--commit", "0".repeat(40), "--output", "unused", "--agent-tools", impossible]),
  ).rejects.toThrow("Full is the default")
  await expect(
    main([
      "--profile",
      "minimal",
      "--commit",
      "0".repeat(40),
      "--output",
      "unused",
      "--agent-tools",
      impossible,
    ]),
  ).rejects.toThrow("minimal does not accept")
})

test("profile markers cannot disguise omitted full capabilities or additions to minimal", () => {
  temporary((dir) => {
    const releases = join(dir, "releases")
    mkdirSync(releases)
    for (const [profile, extra, error] of [
      ["full", "", "incomplete full"],
      ["minimal", "runtime/intruder", "unexpected capability"],
      ["unknown", "", "invalid bundle"],
    ] as const) {
      const archive = join(dir, profile + ".tar")
      const hash = build(archive, (w) => {
        for (const name of [
          "bin/t1os",
          "bin/t1os-guest-platform",
          "runtime/install.sh",
          "platform/first-boot",
          "platform/t1os-first-boot.service",
        ])
          w.bytes(name, Buffer.from("fixture"), 0o755)
        w.bytes("runtime/profile.json", Buffer.from(JSON.stringify({ profile }) + "\n"), 0o644)
        if (extra) w.bytes(extra, Buffer.from("fixture"), 0o644)
      })
      expect(() => stage(archive, hash, releases)).toThrow(error)
    }
  })
})

test("profile marker is length bounded before being buffered", () => {
  temporary((dir) => {
    const archive = join(dir, "oversized.tar"),
      releases = join(dir, "releases")
    mkdirSync(releases)
    const hash = build(archive, (w) => w.bytes("runtime/profile.json", Buffer.alloc(64), 0o644))
    expect(() => stage(archive, hash, releases)).toThrow("invalid bundle profile size")
  })
})
