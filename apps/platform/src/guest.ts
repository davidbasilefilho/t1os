import { Effect } from "effect"

import { dispatchAgent } from "../../agent-host/src/dispatch.ts"
import { main as bootstrap } from "./bootstrap.ts"
import { main as firstBoot } from "./first-boot.ts"
import { main as provision } from "./provision.ts"

const [command, ...args] = process.argv.slice(2)
const program = Effect.tryPromise({
  try: async () => {
    switch (command) {
      case "bootstrap":
        return bootstrap(args)
      case "provision":
        return provision(args)
      case "first-boot":
        return firstBoot(args)
      case undefined:
        throw new Error("expected a t1os guest command")
      default:
        return await dispatchAgent(command, args)
    }
  },
  catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
})
await Effect.runPromise(program).catch((error) => {
  console.error(String(error))
  process.exitCode = 1
})
