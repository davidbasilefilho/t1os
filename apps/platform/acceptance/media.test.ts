import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, lstatSync, readdirSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { androidProfileFiles, stage } from "../src/overlay.ts"

const bundle = process.env.T1OS_ACCEPTANCE_BUNDLE
const pin = process.env.T1OS_ACCEPTANCE_SHA256
// Never stage real system files or authorized media during a default unit-test run.
describe.skipIf(bundle === undefined && pin === undefined)(
  "exact build media, disposable stage",
  () => {
    let dir: string
    beforeAll(() => {
      if (!bundle || !pin || !/^[0-9a-f]{64}$/.test(pin))
        throw Error("expected full verified archive and SHA-256")
      dir = mkdtempSync(join(tmpdir(), "t1os-acceptance-"))
    })
    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
    })
    test("wrong SHA and symlink inputs cannot publish a release", () => {
      const incorrect = (pin![0] === "0" ? "1" : "0") + pin!.slice(1)
      expect(() => stage(bundle!, incorrect, dir)).toThrow(/SHA-256/)
      expect(readdirSync(dir)).toEqual([])
      const link = join(dir, "media")
      symlinkSync(bundle!, link)
      expect(() => stage(link, pin!, dir)).toThrow()
      expect(readdirSync(dir)).toEqual(["media"])
    }, 120000)
    test("full-profile stage and reapply preserve compiled bootstrap, CLI and actual tools", () => {
      const release = stage(bundle!, pin!, dir)
      for (const path of [
        "bin/t1os-guest-platform",
        "bin/t1os",
        "agent-host/bin/node",
        "agent-host/bin/bun",
        "agent-host/t3-release/t3",
        "runtime/agent/holyagent-0.3.3.tgz",
      ]) {
        const file = lstatSync(join(release, path))
        expect(file.isFile()).toBe(true)
        if (!path.endsWith("tgz")) expect(file.mode & 0o111).not.toBe(0)
      }
      for (const path of androidProfileFiles) {
        const file = lstatSync(join(release, path))
        expect(file.isFile()).toBe(true)
        expect(file.mode & 0o777).toBe(0o644)
      }
      expect(readdirSync(join(release, "runtime/android")).sort()).toEqual([
        "README.md",
        "android.conf",
        "t1os-android.service",
      ])
      const help = Bun.spawnSync([join(release, "bin/t1os"), "android", "--help"])
      expect(help.exitCode).toBe(0)
      expect(help.stdout.toString()).toContain("install-sdk")
      const inode = lstatSync(release).ino
      expect(stage(bundle!, pin!, dir)).toBe(release)
      expect(lstatSync(release).ino).toBe(inode)
    }, 180000)
  },
)
