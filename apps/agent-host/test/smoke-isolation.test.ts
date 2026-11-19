import { expect, test } from "bun:test"

import { smokeNamespaceIsPrivate } from "../src/smoke.ts"
test("smoke requires kernel-confirmed namespace isolation before starting external tools", () => {
  const names = "hdr\nhdr\n lo: 0\n"
  const valid = (current = "net:[101]", uid = 0, map = "0 1000 1", dev = names) =>
    smokeNamespaceIsPrivate("net:[99]", current, uid, map, dev)
  expect(valid()).toBe(true)
  expect(valid("net:[99]")).toBe(false)
  expect(valid(undefined, 1000)).toBe(false)
  expect(valid(undefined, 0, "0 0 1")).toBe(false)
  expect(valid(undefined, 0, undefined, names + "eth0: 0\n")).toBe(false)
})
