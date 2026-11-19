import { mainPrepare } from "./prepare"
import { mainSmoke } from "./smoke"

const [command, ...argv] = Bun.argv.slice(2)
try {
  switch (command) {
    case "prepare":
      await mainPrepare(argv)
      break
    case "smoke":
      await mainSmoke(argv)
      break
    default:
      throw new Error("usage: bun apps/agent-host/src/cli.ts prepare|smoke [options]")
  }
} catch (error) {
  console.error(`t1os agent host: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
