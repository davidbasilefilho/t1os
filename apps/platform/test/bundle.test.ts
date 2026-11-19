import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BundleWriter } from "../src/build-bundle.ts"
import { stage } from "../src/overlay.ts"

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
