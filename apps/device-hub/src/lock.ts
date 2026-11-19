import { readFile } from "node:fs/promises"
import { join } from "node:path"

/** Stable Linux SDK package revisions from Google's repository2-3 and sys-img2-3 catalogs. */
export const androidLock = {
  "cmdline-tools/latest": "22.0",
  "platform-tools": "37.0.1",
  emulator: "37.2.13",
  "system-images/android-35/default/x86_64": "2",
} as const

/** Fail closed on a floating or substituted revision; no Android binary is invoked here. */
export async function checkRevisions(sdk: string) {
  for (const [path, expected] of Object.entries(androidLock)) {
    const properties = await readFile(join(sdk, path, "source.properties"), "utf8")
    const actual = /^Pkg\.Revision\s*=\s*([^\r\n]+)$/m.exec(properties)?.[1]?.trim()
    if (actual !== expected)
      throw Error(
        `Android SDK revision mismatch: ${path}: expected ${expected}, found ${actual ?? "unknown"}; restore reviewed SDK or update the profile lock`,
      )
  }
}
