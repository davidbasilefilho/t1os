// Never download the bootstrap or accept an Android license for the operator.
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { join, resolve } from "node:path"

import { checkRevisions } from "./lock.ts"

const bootstrap = "4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583"
const packages = ["platform-tools", "emulator", "system-images;android-35;default;x86_64"]
const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }

async function validate(sdk: string) {
  await checkRevisions(sdk)
  for (const file of [
    "cmdline-tools/latest/bin/sdkmanager",
    "cmdline-tools/latest/bin/avdmanager",
    "platform-tools/adb",
    "emulator/emulator",
  ])
    await access(join(sdk, file), constants.X_OK)
  await access(join(sdk, "system-images/android-35/default/x86_64/system.img"), constants.R_OK)
}

/** Reuse but never modify an existing SDK. Build new SDKs privately before no-clobber promotion. */
export async function prepareSdk(
  parent: string,
  populate: (sdk: string, stage: string) => Promise<void>,
) {
  const dest = join(parent, "Sdk")
  const stat = await lstat(dest).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined
    throw e
  })
  if (stat) {
    if (!stat.isDirectory() || stat.uid !== process.getuid!() || stat.mode & 0o022)
      throw Error("Unsafe existing SDK; left untouched")
    await validate(dest)
    return
  }
  const stage = await mkdtemp(join(parent, ".t1os-sdk-"))
  try {
    const candidate = join(stage, "Sdk")
    await mkdir(candidate, { mode: 0o700 })
    await populate(candidate, stage)
    await validate(candidate)
    // Linux GNU mv -n -T on this one filesystem uses no-replace rename, including for an empty destination.
    const status = await Bun.spawn(["/usr/bin/mv", "-nT", "--", candidate, dest], { env }).exited
    if (status !== 0 || (await Bun.file(join(candidate, "emulator/source.properties")).exists()))
      throw Error("SDK promotion refused; existing SDK left intact")
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

async function main() {
  if (
    userInfo().username !== "t1os" ||
    !process.getuid?.() ||
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    process.argv.length !== 3 ||
    !process.stdin.isTTY
  )
    throw Error(
      "Run as the t1os operator in a guest terminal with the original Android command-line tools Linux ZIP",
    )
  process.umask(0o077)
  const home = homedir(),
    parent = join(home, "Android")
  for (const dir of [home, parent]) {
    if (dir !== home)
      await mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e
      })
    const info = await lstat(dir)
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid() ||
      info.mode & 0o022 ||
      (await realpath(dir)) !== dir
    )
      throw Error("Unsafe SDK location")
  }
  const path = resolve(process.argv[2]!)
  await prepareSdk(parent, async (sdk, stage) => {
    const st = await lstat(path)
    if (!st.isFile() || st.size > 256 * 1024 ** 2) throw Error("Invalid command-line tools archive")
    const zip = join(stage, "tools.zip")
    await cp(path, zip)
    if (
      createHash("sha256")
        .update(await readFile(zip))
        .digest("hex") !== bootstrap
    )
      throw Error("Incorrect Android command-line tools SHA-256")
    const privateHome = join(stage, "home")
    await mkdir(privateHome, { mode: 0o700 })
    const environment = {
      ...env,
      HOME: privateHome,
      ANDROID_USER_HOME: join(privateHome, ".android"),
      ANDROID_HOME: sdk,
    }
    if (
      (await Bun.spawn(["/usr/bin/unzip", "-q", zip, "-d", stage], { env: environment }).exited) !==
      0
    )
      throw Error("Cannot extract verified archive")
    const latest = join(sdk, "cmdline-tools/latest")
    await mkdir(join(sdk, "cmdline-tools"))
    await rename(join(stage, "cmdline-tools"), latest)
    const status = await Bun.spawn(
      [join(latest, "bin/sdkmanager"), "--sdk_root=" + sdk, ...packages],
      {
        cwd: privateHome,
        env: environment,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    ).exited
    if (status !== 0) throw Error("SDK Manager did not complete")
  })
}
if (import.meta.main) await main()
