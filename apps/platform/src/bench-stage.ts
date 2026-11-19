import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BundleWriter } from "./build-bundle.ts"
import { stage } from "./overlay.ts"

const MIB = 1024 ** 2

function fixture(directory: string): { archive: string; digest: string } {
  const payload = join(directory, "payload")
  const payloadFd = openSync(payload, "wx", 0o600)
  try {
    ftruncateSync(payloadFd, 64 * MIB)
  } finally {
    closeSync(payloadFd)
  }
  const archive = join(directory, "media.tar")
  const archiveFd = openSync(archive, "wx", 0o600)
  try {
    const bundle = new BundleWriter(archiveFd)
    const bytes = Buffer.from("fixture")
    for (const name of [
      "platform/first-boot",
      "platform/t1os-first-boot.service",
      "runtime/install.sh",
      "bin/t1os-guest-platform",
    ]) {
      bundle.bytes(name, bytes, 0o755)
    }
    bundle.file("runtime/payload", payload)
    return { archive, digest: bundle.finish() }
  } finally {
    closeSync(archiveFd)
  }
}

function writeCount(): number {
  const counter = /^wchar:\s+(\d+)$/mu.exec(readFileSync("/proc/self/io", "utf8"))?.[1]
  if (!counter) throw new Error("missing Linux process IO counters")
  return Number(counter)
}

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  return ((sorted[mid] ?? 0) + (sorted[sorted.length - mid - 1] ?? 0)) / 2
}

/** Measure fresh staging and same-digest reapply (not fixture preparation or activation). */
export function main(): void {
  const directory = mkdtempSync(join(tmpdir(), "t1os-bench-"))
  try {
    const { archive, digest } = fixture(directory)
    const samples = {
      fresh: [] as { elapsed: number; written: number }[],
      reapply: [] as { elapsed: number; written: number }[],
    }
    for (let trial = 0; trial < 6; trial += 1) {
      const releases = mkdtempSync(join(directory, "releases-"))
      try {
        for (const results of Object.values(samples)) {
          const before = writeCount()
          const start = performance.now()
          stage(archive, digest, releases)
          const elapsed = performance.now() - start
          const written = writeCount() - before
          if (trial > 0) results.push({ elapsed, written })
        }
      } finally {
        rmSync(releases, { recursive: true, force: true })
      }
    }
    for (const [mode, results] of Object.entries(samples)) {
      const elapsed = median(results.map((value) => value.elapsed))
      const writes = median(results.map((value) => value.written)) / MIB
      console.log(
        `${mode}: median ${elapsed.toFixed(1)} ms, ${writes.toFixed(2)} MiB written (n=${results.length})`,
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) main()
