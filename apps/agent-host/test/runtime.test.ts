import { expect, test } from "bun:test"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { checkWayvnc, installRuntime, runJob } from "../src/runtime"

const ROOT = resolve(import.meta.dir, "../../..")
const RUNTIME = join(ROOT, "runtime")
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "t1os-runtime-test-"))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("install copies only managed inert definitions and preserves independent policy", async () =>
  await fixture(async (root) => {
    await installRuntime(root, RUNTIME)
    await installRuntime(root, RUNTIME)
    const socket = await readFile(join(root, "etc/systemd/system/t1os-ssh-tunnel.socket"), "utf8")
    expect(socket.split("\n")).toContain("BindToDevice=tailscale0")
    expect(
      (
        await readFile(
          join(root, "etc/systemd/system/tailscaled.service.d/10-no-ssh-forwarding.conf"),
          "utf8",
        )
      ).split("\n"),
    ).toContain("Environment=TS_SSH_DISABLE_FORWARDING=1")
    const agent = await readFile(join(root, "etc/systemd/user/t1os-t3.service"), "utf8")
    expect(agent).toBe(await readFile(join(RUNTIME, "agent/t1os-t3.service"), "utf8"))
    const lines = agent.split("\n")
    for (const setting of [
      "ConditionUser=t1os",
      "Environment=T3CODE_HOST=127.0.0.1",
      "Environment=T3CODE_PORT=3773",
      "StandardOutput=null",
      "StandardError=null",
    ])
      expect(lines).toContain(setting)
    expect(agent).toMatch(/^ExecStart=[^ ]+ serve --host 127\.0\.0\.1 --port 3773$/m)
    const policy = join(root, "etc/t3code/policy.json")
    expect(await readFile(policy, "utf8")).toBe(
      await readFile(join(RUNTIME, "agent/policy.json"), "utf8"),
    )
    const objects = await readdir(root, { recursive: true, withFileTypes: true })
    expect(objects.filter((x) => x.isFile())).toHaveLength(7)
    expect(objects.some((x) => x.isSymbolicLink())).toBe(false)
    await writeFile(policy, '{"different": true}')
    await expect(installRuntime(root, RUNTIME)).rejects.toThrow("existing T3 policy differs")
    expect(await readFile(policy, "utf8")).toBe('{"different": true}')
  }))

test("install refuses redirects through a fake target root", async () =>
  await fixture(async (root) => {
    const fake = join(root, "fake")
    const outside = join(root, "outside")
    await mkdir(fake)
    await mkdir(outside)
    await symlink(outside, join(fake, "etc"))
    await expect(installRuntime(fake, RUNTIME)).rejects.toThrow("symlinked")
    expect(await readdir(outside)).toEqual([])
  }))

test("effective OpenSSH policy keeps auth and forwarding narrowed", async () =>
  await fixture(async (root) => {
    const sshd =
      Bun.which("sshd") ??
      ((await Bun.file("/usr/sbin/sshd").exists()) ? "/usr/sbin/sshd" : undefined)
    const keygen = Bun.which("ssh-keygen")
    if (!sshd || !keygen) {
      console.log("OpenSSH parser unavailable; skipping effective configuration check")
      return
    }
    const key = join(root, "throwaway-key")
    const generate = Bun.spawnSync([keygen, "-q", "-t", "ed25519", "-N", "", "-f", key])
    expect(generate.exitCode).toBe(0)
    const original = await readFile(join(RUNTIME, "remote/sshd_config"), "utf8")
    const config = join(root, "sshd_config")
    await writeFile(config, original.replace(/^HostKey .*$/m, `HostKey ${key}`))
    const inspect = Bun.spawnSync([sshd, "-T", "-f", config], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    })
    if (
      inspect.exitCode !== 0 &&
      inspect.stderr.toString().includes("Missing privilege separation directory:")
    ) {
      console.log("OpenSSH runtime directory absent; skipping effective configuration check")
      return
    }
    if (inspect.exitCode !== 0) throw new Error(inspect.stderr.toString())
    for (const setting of [
      "maxsessions 0",
      "permitrootlogin no",
      "allowtcpforwarding local",
      "allowstreamlocalforwarding no",
      "allowagentforwarding no",
      "passwordauthentication no",
      "allowusers t1os",
      "permitopen 127.0.0.1:3773 127.0.0.1:5900",
    ]) {
      expect(inspect.stdout.toString().split("\n")).toContain(setting)
    }
  }))

test.skipIf(!process.geteuid?.())(
  "job rejects unsafe inputs without starting a container",
  async () =>
    await fixture(async (dir) => {
      const home = join(dir, "home")
      const workspace = join(home, "worktrees/project")
      await mkdir(workspace, { recursive: true })
      const old = process.env.HOME
      process.env.HOME = home
      try {
        const digest = `registry.example.invalid/fixture@sha256:${"0".repeat(64)}`
        await expect(runJob([workspace, "test:latest", "ro", "true"])).rejects.toThrow(
          "fully qualified image pinned by digest",
        )
        await expect(runJob([workspace, digest, "root", "true"])).rejects.toThrow(
          "workspace access must be ro or rw",
        )
        await expect(runJob([home, digest, "ro", "true"])).rejects.toThrow("under ~/worktrees")
        const outside = join(home, "worktrees/outside")
        await symlink(home, outside)
        await expect(runJob([outside, digest, "ro", "true"])).rejects.toThrow("under ~/worktrees")
      } finally {
        if (old === undefined) delete process.env.HOME
        else process.env.HOME = old
      }
    }),
)

test("WayVNC only accepts exact private TLS-backed config", async () =>
  await fixture(async (dir) => {
    expect((await lstat(dir)).mode & 0o777).toBe(0o700)
    const key = join(dir, "tls_key.pem")
    const config = join(dir, "wayvnc")
    await writeFile(key, "", { mode: 0o600 })
    await writeFile(join(dir, "tls_cert.pem"), "", { mode: 0o600 })
    const safe =
      [
        "enable_auth=true",
        "use_relative_paths=true",
        "username=fixture",
        "password=not-a-real-credential",
        "private_key_file=tls_key.pem",
        "certificate_file=tls_cert.pem",
      ].join("\n") + "\n"
    await writeFile(config, safe, { mode: 0o600 })
    await expect(checkWayvnc(dir)).resolves.toBeUndefined()
    await chmod(key, 0o644)
    await expect(checkWayvnc(dir)).rejects.toThrow("private VeNCrypt")
    await chmod(key, 0o600)
    for (const extra of ["relax_encryption=true", "enable_auth=false", "enable_auth=true"]) {
      await writeFile(config, safe + extra + "\n")
      await expect(checkWayvnc(dir)).rejects.toThrow("private VeNCrypt")
    }
  }))
