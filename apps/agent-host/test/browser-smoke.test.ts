import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixtureServer, mainBrowserSmoke, privateDirectory } from "../src/browser-smoke.ts"

test("profile requires separate owner-only, non-redirected directories", () => {
  const base = mkdtempSync(join(tmpdir(), "t1os-browser-"))
  try {
    const first = privateDirectory(join(base, "first"))
    const second = privateDirectory(join(base, "second"))
    expect(first).not.toBe(second)
    expect(statSync(first).mode & 0o777).toBe(0o700)
    const redirected = join(base, "redirected")
    symlinkSync(first, redirected, "dir")
    expect(() => privateDirectory(redirected)).toThrow("non-redirected directory")
    expect(() => privateDirectory(join(redirected, "created"))).toThrow("non-redirected directory")
    expect(existsSync(join(first, "created"))).toBe(false)
    chmodSync(first, 0o755)
    expect(() => privateDirectory(first)).toThrow("non-redirected directory")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("serves exactly the local fixture with restrictive CSP", async () => {
  const server = fixtureServer()
  const { url } = server
  try {
    expect(url.hostname).toBe("127.0.0.1")
    const page = await fetch(url, { signal: AbortSignal.timeout(3000) })
    expect(page.status).toBe(200)
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'")
    expect(await page.text()).toContain("Save fixture")
    for (const path of ["etc/passwd", "?outside"]) {
      const denied = await fetch(new URL(path, url), { signal: AbortSignal.timeout(3000) })
      expect(denied.status).toBe(404)
      await denied.text()
    }
  } finally {
    await server.stop(true)
  }
})

test("browser CLI refuses targets, traversal and non-absolute Chromium binaries", async () => {
  await expect(mainBrowserSmoke(["https://example.com"])).rejects.toThrow("workspace ID")
  await expect(mainBrowserSmoke(["../escape"])).rejects.toThrow("workspace ID")
  await expect(mainBrowserSmoke(["workspace", "--chromium", "chromium"])).rejects.toThrow(
    "absolute path",
  )
})
