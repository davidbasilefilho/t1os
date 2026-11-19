import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { parseArgs } from "node:util"

import { chromium } from "playwright-core"

const html = `<!doctype html><title>t1os fixture</title>
<h1>t1os fixture</h1><label for="message">Message</label><input id="message">
<button id="save">Save fixture</button><output id="saved" aria-live="polite"></output>
<script>
const message = document.querySelector('#message');
const saved = document.querySelector('#saved');
saved.value = localStorage.getItem('message') || '';
document.querySelector('#save').addEventListener('click', () => {
  localStorage.setItem('message', message.value);
  saved.value = message.value;
});
</script>`

/** Serve one fixed page on a random loopback port; never expose the filesystem. */
export function fixtureServer() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (request.method !== "GET" || url.pathname !== "/" || url.search) {
        return new Response("Not found", { status: 404 })
      }
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'",
          "X-Content-Type-Options": "nosniff",
        },
      })
    },
  })
}

/** Create an owner-only profile path and refuse symlinks and world/group access. */
export function privateDirectory(path: string): string {
  // Reject redirected ancestors before recursive mkdir can create anything.
  for (let ancestor = path; ; ancestor = dirname(ancestor)) {
    if (!lstatSync(ancestor, { throwIfNoEntry: false })) continue
    if (realpathSync(ancestor) !== ancestor) {
      throw new Error(`Expected a private, non-redirected directory: ${ancestor}`)
    }
    break
  }
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = lstatSync(path)
  if (
    realpathSync(path) !== path ||
    !info.isDirectory() ||
    info.mode & 0o077 ||
    info.uid !== process.getuid?.()
  ) {
    throw new Error(`Expected a private, non-redirected directory: ${path}`)
  }
  return path
}

async function exercise(origin: string, profile: string, executablePath: string) {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (const reconnect of [false, true]) {
    const context = await chromium.launchPersistentContext(profile, {
      chromiumSandbox: true,
      executablePath,
      headless: true,
      acceptDownloads: false,
      serviceWorkers: "block",
      timeout: 30_000,
      args: ["--disable-background-networking", "--no-proxy-server"],
    })
    try {
      context.setDefaultTimeout(10_000)
      await context.route("**/*", (route) =>
        route.request().url() === origin ? route.continue() : route.abort(),
      )
      const page = context.pages()[0] ?? (await context.newPage())
      await page.goto(origin, { waitUntil: "load" })
      if (!reconnect) {
        await page.getByLabel("Message").pressSequentially("fixture input")
        await page.getByRole("button", { name: "Save fixture" }).click()
        const png = await page.screenshot()
        if (!png.subarray(0, pngMagic.length).equals(pngMagic)) {
          throw new Error("Fixture screenshot was not PNG")
        }
      }
      if ((await page.locator("#saved").innerText()) !== "fixture input") {
        throw new Error("Fixture input or reconnect state not present")
      }
      if (!(await page.locator("body").ariaSnapshot()).includes('button "Save fixture"')) {
        throw new Error("Fixture button missing from ARIA snapshot")
      }
    } finally {
      await context.close()
    }
  }
}

/** Exercise sandboxed Chromium in a workspace-local profile against a loopback fixture only. */
export async function mainBrowserSmoke(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { chromium: { type: "string" } },
  })
  const workspace = positionals[0]
  if (positionals.length !== 1 || !workspace || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(workspace)) {
    throw new Error("Expected one valid workspace ID")
  }
  if (!values.chromium || !isAbsolute(values.chromium)) {
    throw new Error("Specify the absolute path to the verified matching Chromium with --chromium")
  }
  const executable = realpathSync(values.chromium)
  if (!lstatSync(executable).isFile()) throw new Error("expected a regular Chromium executable")
  accessSync(executable, constants.X_OK)
  if (process.geteuid?.() === 0)
    throw new Error("run the sandboxed browser fixture as a non-root user")
  const version = Bun.spawnSync([executable, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  })
  if (!version.success || !version.stdout.toString().match(/(?:^|\s)158\.0\.8127\.18(?:\s|$)/))
    throw Error("Playwright Core 1.65.0 requires verified Chromium 158.0.8127.18 for this fixture")
  const base = privateDirectory(join(realpathSync(homedir()), ".local", "state", "t1os-browser"))
  const profile = privateDirectory(join(base, workspace))
  const server = fixtureServer()
  try {
    await exercise(server.url.href, profile, executable)
    console.log(JSON.stringify({ chromium_fixture: "passed", desktop_cua_tested: false }))
  } finally {
    await server.stop(true)
  }
}

if (import.meta.main) {
  try {
    await mainBrowserSmoke(process.argv.slice(2))
  } catch (err) {
    console.error("t1os browser fixture:", err instanceof Error ? err.message : err)
    process.exitCode = 1
  }
}
