#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

import { capture, checkpointStore, inspect, listCheckpoints } from "@t1os/core"
import { Effect } from "effect"

import { capabilities, renderCapabilities } from "./capabilities.ts"

const browserUsage = "t1os browser check <workspace-id> --chromium <absolute-path>"
const androidUsage =
  "t1os android --help | check | configure | start | install-sdk <official-command-line-tools.zip>"
const usage =
  "t1os capture <trusted-workspace> | list | show <checkpoint-id> | android --help | capabilities [--json] | browser --help"
const [cmd, arg, ...extra] = process.argv.slice(2)
const base = checkpointStore()
async function main() {
  if (cmd === "capabilities" && !extra.length && (arg === undefined || arg === "--json")) {
    const result = Effect.runSync(capabilities())
    return arg === "--json" ? JSON.stringify(result, null, 2) : renderCapabilities(result)
  }
  if (cmd === "browser") {
    if ((arg === undefined || arg === "--help") && !extra.length) return browserUsage
    const [workspace, flag, executable] = extra
    if (
      arg !== "check" ||
      extra.length !== 3 ||
      !workspace ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(workspace) ||
      flag !== "--chromium" ||
      !executable ||
      !isAbsolute(executable)
    )
      throw Error(browserUsage)
    if (process.platform !== "linux" || !process.geteuid?.())
      throw Error("run the browser fixture as a non-root Linux user")
    const root = "/opt/t1os/current"
    const bun = join(root, "agent-host/bin/bun")
    const entry = join(root, "agent-host/pi-deps/browser-smoke.ts")
    if (!existsSync(bun) || !existsSync(entry))
      throw Error("browser fixture requires the installed full t1os profile")
    const identity = userInfo()
    const proc = Bun.spawn([bun, "--no-env-file", entry, workspace, "--chromium", executable], {
      cwd: root,
      env: {
        HOME: identity.homedir,
        USER: identity.username,
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    })
    const status = await proc.exited
    if (status !== 0) throw Error("browser fixture failed (" + status + ")")
    return undefined
  }
  if (cmd === "android") {
    if ((arg === undefined || arg === "--help") && !extra.length) return androidUsage
    const install = arg === "install-sdk" && extra.length === 1
    if (!install && !((arg === "check" || arg === "configure" || arg === "start") && !extra.length))
      throw Error(androidUsage)
    const root = "/opt/t1os/current"
    const bun = join(root, "agent-host/bin/bun")
    const entry = join(root, "apps/device-hub/src", install ? "sdk.ts" : "profile.ts")
    if (!existsSync(bun) || !existsSync(entry))
      throw Error("Android setup requires an installed full t1os guest with the device profile")
    const proc = Bun.spawn(
      [bun, "--no-env-file", entry, ...(install ? [resolve(extra[0]!)] : [arg!])],
      {
        cwd: root,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    )
    const status = await proc.exited
    if (status !== 0) throw Error("Android " + arg + " failed (" + status + ")")
    return undefined
  }
  if (extra.length === 0) {
    if ((cmd === undefined || cmd === "--help") && arg === undefined) return usage
    if (cmd === "capture" && arg)
      return Effect.runPromise(
        capture(base, arg, process.env.T3CODE_HOME || join(homedir(), ".t3")),
      )
    if (cmd === "list" && arg === undefined)
      return JSON.stringify(await Effect.runPromise(listCheckpoints(base)))
    if (cmd === "show" && arg)
      return JSON.stringify(await Effect.runPromise(inspect(base, arg)), null, 2)
  }
  throw new Error(usage)
}
try {
  const output = await main()
  if (output !== undefined) console.log(output)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
