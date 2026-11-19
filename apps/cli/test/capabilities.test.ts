import { expect, test } from "bun:test"

import { Effect } from "effect"

import { androidLock } from "../../device-hub/src/lock.ts"
import { capabilities, renderCapabilities } from "../src/capabilities.ts"

type Probe = NonNullable<Parameters<typeof capabilities>[0]>
const digest = "a".repeat(64),
  boot = "a1111111-1111-1111-1111-111111111111"
const profile = "/opt/t1os/current/runtime/profile.json"
function fixture(overrides: Partial<Probe> = {}) {
  const probes: Probe = {
    path: () => "present",
    unit: () => "active",
    kvm: () => "present",
    release: () => digest,
    text: (path) => {
      if (path === profile) return JSON.stringify({ profile: "full" })
      if (path.endsWith("boot_id")) return boot
      if (path === "/run/t1os-first-boot.ok") return digest + " " + boot
      for (const [key, version] of Object.entries(androidLock))
        if (path.endsWith(key + "/source.properties")) return "Pkg.Revision=" + version
      throw Error("unexpected file read: " + path)
    },
    ...overrides,
  }
  const result = Effect.runSync(capabilities(probes))
  const row = (name: string) => {
    const v = result.capabilities.find((r) => r.name === name)
    if (!v) throw Error("unknown capability")
    return v
  }
  return { result, row }
}
test("full is installation intent, never proof of device access or native CUA", () => {
  const { result, row } = fixture()
  expect(result.profile).toBe("full")
  expect(row("T3 Code").readiness).toBe("ready")
  expect(row("Android and Device Hub").readiness).toBe("not verified")
  expect(row("Native desktop CUA").readiness).toBe("not implemented")
  expect(row("Pi and HolyAgent").readiness).toBe("not verified")
  expect(row("Recovery").readiness).toBe("ready")
  expect(renderCapabilities(result)).toContain("prerequisites:")
})
test("a present unit cannot override missing KVM, a wrong SDK revision or stale boot receipt", () => {
  const { row } = fixture({
    kvm: () => "missing",
    text: (p) =>
      p === profile
        ? '{"profile":"full"}'
        : p.endsWith("boot_id")
          ? boot
          : p.endsWith("first-boot.ok")
            ? digest + " 00000000-0000-0000-0000-000000000000"
            : "Pkg.Revision=wrong",
  })
  expect(row("Recovery").readiness).toBe("blocked")
  const hub = row("Android and Device Hub")
  expect(hub.readiness).toBe("blocked")
  expect(hub.prerequisites).toContainEqual(["KVM API 12 accessible to caller", "missing"])
  expect(hub.prerequisites).toContainEqual([
    "SDK emulator revision " + androidLock.emulator,
    "missing",
  ])
})
test("unknown is not missing; explicit minimal marker is not inferred from absent files", () => {
  expect(
    fixture({ text: () => undefined, path: () => "unknown", unit: () => "unknown" }).result.profile,
  ).toBe("unknown")
  const { result, row } = fixture({
    text: (p) => (p === profile ? '{"profile":"minimal"}' : undefined),
    path: () => "unknown",
    unit: () => "unknown",
  })
  expect(result.profile).toBe("minimal")
  expect(row("Private SSH forwarding").readiness).toBe("not verified")
})
