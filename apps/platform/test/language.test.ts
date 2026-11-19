import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

test("first-party executables and CI do not require a Python interpreter", () => {
  const root = resolve(import.meta.dir, "../../..")
  const names = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  ).split("\0")
  const violations = names.filter((name) => {
    if (!name || !existsSync(resolve(root, name))) return false
    if (/\.py[wc]?$/i.test(name)) return true
    if (/\.(?:md|json|lock)$/.test(name)) return false
    const source = readFileSync(resolve(root, name), "utf8")
    if (/^#![^\n]*\bpython(?:[23](?:\.\d+)?)?\b/i.test(source)) return true
    if (
      !(
        name.endsWith(".sh") ||
        name.endsWith(".service") ||
        name.startsWith(".github/workflows/") ||
        source.startsWith("#!")
      )
    )
      return false
    return /(?:^|[\s=;/|&])python(?:[23](?:\.\d+)?)?(?=\s|$)/im.test(source)
  })
  expect(violations).toEqual([])
})
