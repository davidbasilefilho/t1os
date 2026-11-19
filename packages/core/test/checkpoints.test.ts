import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { capture, inspect, listCheckpoints } from "../src/index.ts"
let root: string, base: string, workspace: string, t3: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "t1os-capture-"))
  base = join(root, "private")
  workspace = join(root, "demo")
  t3 = join(root, "t3")
  await mkdir(workspace)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
describe("durable checkpoint references", () => {
  test("captures are repeatable and private, including concurrent writers", async () => {
    const run = () => Effect.runPromise(capture(base, workspace, t3))
    const [id, other] = await Promise.all([run(), run()])
    expect(other).toBe(id)
    expect((await stat(join(base, id + ".json"))).mode & 0o777).toBe(0o600)
    expect(await readdir(base)).toEqual([id + ".json"])
    expect(await Effect.runPromise(inspect(base, id))).toEqual({
      version: 1,
      workspace,
      head: null,
      holyagentDirectory: false,
      t3UserdataDirectory: false,
    })
    await mkdir(join(workspace, ".holyagent"))
    await mkdir(join(t3, "userdata"), { recursive: true })
    const second = await run()
    expect(second).not.toBe(id)
    expect(await Effect.runPromise(listCheckpoints(base))).toEqual(
      [id, second].sort((left, right) => left.localeCompare(right)),
    )
    expect((await Effect.runPromise(inspect(base, id))).holyagentDirectory).toBe(false)
  })
  test("refuses altered data, traversal, shared directories and symlinked state", async () => {
    const id = await Effect.runPromise(capture(base, workspace, t3))
    const file = join(base, id + ".json")
    const saved = await readFile(file, "utf8")
    await writeFile(file, saved + " ")
    await expect(Effect.runPromise(inspect(base, id))).rejects.toThrow("integrity")
    await expect(Effect.runPromise(capture(base, workspace, t3))).rejects.toThrow("integrity")
    await expect(Effect.runPromise(inspect(base, "../escape"))).rejects.toThrow()
    await chmod(base, 0o755)
    await expect(Effect.runPromise(listCheckpoints(base))).rejects.toThrow("private")
    await chmod(base, 0o700)
    const alias = join(root, "alias")
    await symlink(base, alias)
    await expect(Effect.runPromise(capture(alias, workspace, t3))).rejects.toThrow()
  })
  test("captures real HEAD without storing private worktree data", async () => {
    for (const args of [
      ["init", "-q"],
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture",
      ],
    ]) {
      expect(Bun.spawnSync(["git", "-C", workspace, ...args]).exitCode).toBe(0)
    }
    await writeFile(join(workspace, "not-a-secret.txt"), "fixture marker")
    const id = await Effect.runPromise(capture(base, workspace, t3))
    const value = await Effect.runPromise(inspect(base, id))
    expect(value.head).toMatch(/^[0-9a-f]{40,64}$/)
    expect(await readFile(join(base, id + ".json"), "utf8")).not.toContain("fixture marker")
    expect(await readFile(join(workspace, "not-a-secret.txt"), "utf8")).toBe("fixture marker")
  })
})
