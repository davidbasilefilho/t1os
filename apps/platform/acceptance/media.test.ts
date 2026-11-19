import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, lstatSync, readdirSync, readFileSync, symlinkSync } from "node:fs"
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
      expect(readFileSync(join(release, "runtime/profile.json"), "utf8")).toBe(
        '{"profile":"full"}\n',
      )
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
      const publicHelp = Bun.spawnSync([join(release, "bin/t1os"), "--help"])
      expect(publicHelp.stdout.toString()).toContain("browser")
      if (process.getuid?.()) {
        // The installed dependency tree must load, then reject a mismatched version before a browser session starts.
        const fixture = Bun.spawnSync(
          [
            join(release, "agent-host/bin/bun"),
            "--no-env-file",
            join(release, "agent-host/pi-deps/browser-smoke.ts"),
            "media-test",
            "--chromium",
            "/usr/bin/true",
          ],
          { cwd: release, env: { HOME: dir, PATH: "/usr/bin:/bin" } },
        )
        expect(fixture.exitCode).not.toBe(0)
        expect(fixture.stderr.toString()).toContain("requires verified Chromium")
      }
      const inode = lstatSync(release).ino
      expect(stage(bundle!, pin!, dir)).toBe(release)
      expect(lstatSync(release).ino).toBe(inode)
    }, 180000)
  },
)

const minimal = process.env.T1OS_MINIMAL_BUNDLE,
  minPin = process.env.T1OS_MINIMAL_SHA256
test.skipIf(!minimal && !minPin)(
  "exact minimal media carries just the CLI and offline provisioning foundation",
  () => {
    if (!minimal || !minPin) throw Error("expected both minimal media and pin")
    const dir = mkdtempSync(join(tmpdir(), "t1os-minimal-"))
    try {
      const release = stage(minimal, minPin, dir)
      expect(readFileSync(join(release, "runtime/profile.json"), "utf8")).toBe(
        '{"profile":"minimal"}\n',
      )
      expect(readdirSync(join(release, "runtime")).sort()).toEqual(["install.sh", "profile.json"])
      expect(readdirSync(release).sort()).toEqual(["bin", "platform", "runtime"])
      expect(Bun.spawnSync([join(release, "bin/t1os"), "--help"]).exitCode).toBe(0)
      expect(stage(minimal, minPin, dir)).toBe(release)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
  120_000,
)
