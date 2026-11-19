#!/usr/bin/env bun
import { homedir } from "node:os"
import { join } from "node:path"

import { capture, checkpointStore, inspect, listCheckpoints } from "@t1os/core"
import { Effect } from "effect"

const usage = "t1os capture <trusted-workspace> | list | show <checkpoint-id>"
const [cmd, arg, ...extra] = process.argv.slice(2)
const base = checkpointStore()
async function main() {
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
  console.log(await main())
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
