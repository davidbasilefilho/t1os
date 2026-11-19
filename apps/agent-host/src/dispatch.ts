import { dirname, join, resolve } from "node:path"

import { mainReady } from "./check-ready"
import {
  checkTailscale,
  checkWayvnc,
  installRuntime,
  runDesktop,
  runJob,
  runWayvnc,
} from "./runtime"
import { stage } from "./stage"

function single(argv: string[], name: string) {
  const arg = argv[0]
  if (argv.length !== 1 || !arg) throw new Error(`usage: ${name} PATH`)
  return arg
}
function none(argv: string[], name: string) {
  if (argv.length) throw new Error(`usage: ${name}`)
}

/** Dispatch the installed agent and runtime commands; host tooling has its own entry point. */
export async function dispatchAgent(command: string, argv: string[]): Promise<void> {
  switch (command) {
    case "stage": {
      const archive = resolve(single(argv, "stage"))
      const verificationModules = resolve(dirname(archive), "../../agent-host/pi-deps/node_modules")
      return stage(archive, undefined, undefined, undefined, verificationModules)
    }
    case "check-ready":
      return mainReady(argv)
    case "install-runtime": {
      const source = Bun.argv[1]
      const release =
        source && !source.startsWith("/$bunfs/")
          ? resolve(import.meta.dir, "../../..")
          : dirname(dirname(process.execPath))
      return installRuntime(single(argv, "install-runtime"), join(release, "runtime"))
    }
    case "check-tailscale":
      none(argv, command)
      checkTailscale()
      break
    case "check-wayvnc-config":
      return checkWayvnc(single(argv, "check-wayvnc-config"))
    case "run-desktop":
      none(argv, command)
      return runDesktop()
    case "run-wayvnc":
      none(argv, command)
      return runWayvnc()
    case "run-job":
      return runJob(argv)
    default:
      throw new Error(`unknown runtime command: ${command}`)
  }
}
