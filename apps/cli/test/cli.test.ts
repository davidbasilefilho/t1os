import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cli = join(import.meta.dir, "../src/cli.ts")
let root: string
let workspace: string
let state: string
let t3: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t1os-cli-"))
  workspace = join(root, "workspace with spaces")
  state = join(root, "state")
  t3 = join(root, "t3")
  mkdirSync(workspace)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function invoke(...args: string[]) {
  const proc = Bun.spawnSync([process.execPath, cli, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, XDG_STATE_HOME: state, T3CODE_HOME: t3 },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    status: proc.exitCode,
    output: proc.stdout.toString().trim(),
    error: proc.stderr.toString().trim(),
  }
}

test("help, rejected arguments and an empty list do not create state", () => {
  expect(invoke("--help")).toMatchObject({
    status: 0,
    output: expect.stringContaining("t1os capture"),
  })
  expect(invoke("capture")).toMatchObject({
    status: 1,
    error: expect.stringContaining("t1os capture"),
  })
  expect(invoke("list", "unexpected")).toMatchObject({ status: 1 })
  expect(invoke("list")).toEqual({ status: 0, output: "[]", error: "" })
  expect(existsSync(state)).toBe(false)
})

test("capture and show round trip using only isolated paths and XDG state", () => {
  mkdirSync(join(t3, "userdata"), { recursive: true })
  const capture = invoke("capture", workspace)
  expect(capture).toMatchObject({ status: 0, error: "" })
  expect(capture.output).toMatch(/^[a-f0-9]{64}$/)
  expect(invoke("list")).toEqual({ status: 0, output: JSON.stringify([capture.output]), error: "" })
  const record = invoke("show", capture.output)
  expect(record).toMatchObject({ status: 0, error: "" })
  expect(JSON.parse(record.output)).toEqual({
    version: 1,
    workspace,
    head: null,
    holyagentDirectory: false,
    t3UserdataDirectory: true,
  })
})

test("Android profile help is discoverable without a guest or state changes", () => {
  expect(invoke("--help").output).toContain("android --help")
  expect(invoke("android", "--help")).toMatchObject({
    status: 0,
    output: expect.stringContaining("install-sdk"),
  })
  expect(invoke("android", "boot")).toMatchObject({
    status: 1,
    error: expect.stringContaining("android --help"),
  })
  expect(invoke("android", "install-sdk")).toMatchObject({
    status: 1,
    error: expect.stringContaining("android --help"),
  })
  expect(existsSync(state)).toBe(false)
})
