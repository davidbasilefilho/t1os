import { createHash, randomBytes } from "node:crypto"
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { Effect } from "effect"

import { bundleInput, qmpRecords, runQmp, stage, stopQemu, verifyKvmAccess } from "./unattended-vm"

const VERSION = "4.5.0"
const ISO_NAME = `omarchy-${VERSION}-x86.iso`
const ISO_SHA256 = "5d6288bc57f96f6231719830457582c846a2291985201c36a9a7d1216978b00f"
const SIGNER = "40DFB630FF42BCFFB047046CF0134EE680CAC571"
/** Mandatory acknowledgement tied to creating a disposable disk, never a host block device. */
export const TOKEN = "ERASE-NEW-DISPOSABLE-VM-DISK"
/** Bytes per GiB. */
export const GIB = 1024 ** 3
/** Bytes per MiB. */
export const MIB = 1024 ** 2
const DISK = "/dev/vda"

interface Subvolume {
  mountpoint: string
  name: string
}

/** Create the stock pinned installer schema, selecting only the emulated virtio disk. */
export function config(size: number) {
  const quantity = (value: number) => ({ sector_size: { unit: "B", value: 512 }, unit: "B", value })
  function partition(
    fs_type: string,
    start: number,
    length: number,
    obj_id: string,
    mountpoint: string | null,
    flags: string[],
    mount_options: string[],
    btrfs: Subvolume[],
  ) {
    return {
      fs_type,
      start: quantity(start),
      size: quantity(length),
      obj_id,
      mountpoint,
      flags,
      dev_path: null,
      status: "create",
      type: "primary",
      mount_options,
      btrfs,
    }
  }
  const rootStart = MIB + 2 * GIB
  return {
    app_config: null,
    "archinstall-language": "English",
    auth_config: {},
    audio_config: { audio: "pipewire" },
    bootloader_config: { bootloader: "Limine", uki: false, removable: false },
    custom_commands: [],
    omarchy_install: {
      input_method: "none",
      input_xkb_layout: "",
      language: "en",
      mode: "full_disk",
      defer_provisioning: false,
      target_mount: "/mnt",
      boot: {
        esp_mount: "/boot",
        esp_path: "/EFI/limine",
        efi_binary: "limine_x64.efi",
        enable_fallback: true,
      },
      storage: { kernel: "linux-omarchy" },
    },
    disk_config: {
      config_type: "default_layout",
      device_modifications: [
        {
          device: DISK,
          wipe: true,
          partitions: [
            partition(
              "fat32",
              MIB,
              2 * GIB,
              "ea21d3f2-82bb-49cc-ab5d-6f81ae94e18d",
              "/boot",
              ["boot", "esp"],
              [],
              [],
            ),
            partition(
              "btrfs",
              rootStart,
              size - rootStart - MIB,
              "8c2c2b92-1070-455d-b76a-56263bab24aa",
              null,
              [],
              ["compress=zstd"],
              [
                { mountpoint: "/", name: "@" },
                { mountpoint: "/home", name: "@home" },
                { mountpoint: "/var/log", name: "@log" },
                { mountpoint: "/var/cache/pacman/pkg", name: "@pkg" },
              ],
            ),
          ],
        },
      ],
    },
    hostname: "t1os-smoke",
    kernels: ["linux-omarchy"],
    network_config: { type: "iso" },
    ntp: true,
    parallel_downloads: 8,
    script: null,
    services: [],
    swap: true,
    timezone: "UTC",
    locale_config: { kb_layout: "us", sys_enc: "UTF-8", sys_lang: "en_US.UTF-8" },
    mirror_config: {
      custom_repositories: [],
      mirror_regions: {},
      optional_repositories: [],
      custom_servers: [
        { url: "https://mirror.omarchy.org/$repo/os/$arch" },
        { url: "https://mirror.rackspace.com/archlinux/$repo/os/$arch" },
        { url: "https://geo.mirror.pkgbuild.com/$repo/os/$arch" },
      ],
    },
    packages: ["base-devel", "git", "omarchy-keyring", "omarchy-settings", "omarchy"],
    profile_config: { gfx_driver: null, greeter: null, profile: {} },
    version: "3.0.9",
  }
}

function unsafeQemuPath(path: string) {
  return /[,\r\n]/u.test(path)
}

/** Reject filesystem types and path syntax that could redirect QEMU to a host device. */
export function regularFile(input: string) {
  const path = resolve(input)
  if (unsafeQemuPath(path)) throw new Error(`invalid path for QEMU: ${path}`)
  if (!lstatSync(path).isFile()) throw new Error(`not a regular file: ${path}`)
  return path
}

function run(argv: string[], input?: string, capture = true) {
  return Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn(argv, {
          stdout: capture ? "pipe" : "inherit",
          stderr: capture ? "pipe" : "inherit",
          stdin: input !== undefined ? new Blob([input]) : "inherit",
        })
        const [stdout, stderr, code] = await Promise.all([
          child.stdout ? new Response(child.stdout).text() : undefined,
          child.stderr ? new Response(child.stderr).text() : undefined,
          child.exited,
        ])
        if (code !== 0)
          throw new Error(
            `${argv[0]} failed (exit ${code})${stderr?.trim() ? `: ${stderr.trim()}` : ""}`,
          )
        return stdout ?? ""
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  )
}

/** Require a matching pinned digest and detached signature from the pinned upstream key. */
export async function verifyIso(iso: string, signature: string, key: string, state: string) {
  const digest = createHash("sha256")
  const file = await open(iso, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw new Error("ISO must remain a regular file")
    for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk)
  } finally {
    await file.close()
  }
  if (digest.digest("hex") !== ISO_SHA256)
    throw new Error(`unexpected Omarchy ISO SHA-256; expected ${ISO_SHA256}`)
  const gnupg = join(state, "gnupg")
  mkdirSync(gnupg, { mode: 0o700 })
  const gpg = ["gpg", "--homedir", gnupg, "--batch", "--no-autostart", "--no-auto-key-retrieve"]
  const keyring = join(gnupg, "release.gpg")
  await run([...gpg, "--dearmor", "--output", keyring, key])
  const status = await run([
    ...gpg,
    "--no-default-keyring",
    "--keyring",
    keyring,
    "--status-fd=1",
    "--verify",
    signature,
    iso,
  ])
  const valid = status
    .split("\n")
    .filter((line) => line.startsWith("[GNUPG:] VALIDSIG "))
    .map((line) => line.split(/\s+/u))
  if (!valid.some((row) => row[2] === SIGNER || row[11] === SIGNER))
    throw new Error("ISO signature was not made by the pinned Omarchy release key")
}

async function cidata(state: string, size: number) {
  const directory = join(state, "cidata")
  mkdirSync(directory, { mode: 0o700 })
  const password = randomBytes(20).toString("hex")
  writeFileSync(join(state, "console-password"), password + "\n", { mode: 0o600, flag: "wx" })
  const passwordHash = (await run(["openssl", "passwd", "-6", "-stdin"], password + "\n")).trim()
  if (!/^\$6\$[^$]+\$[./A-Za-z0-9]{86}$/u.test(passwordHash))
    throw new Error("openssl did not produce a SHA-512 crypt password hash")
  const creds = {
    root_enc_password: passwordHash,
    users: [{ enc_password: passwordHash, groups: [], sudo: true, username: "vmadmin" }],
  }
  writeFileSync(join(directory, "user_configuration.json"), JSON.stringify(config(size)) + "\n", {
    mode: 0o600,
    flag: "wx",
  })
  writeFileSync(join(directory, "user_credentials.json"), JSON.stringify(creds) + "\n", {
    mode: 0o600,
    flag: "wx",
  })
  const image = join(state, "cidata.iso")
  await run([
    "genisoimage",
    "-quiet",
    "-output",
    image,
    "-volid",
    "cidata",
    "-joliet",
    "-rock",
    directory,
  ])
  return image
}

type Accel = "kvm" | "tcg"
interface VmOptions {
  iso?: string
  seed?: string
  overlay?: string | undefined
  accel?: Accel
  probe?: boolean
}

/** Construct an offline machine with no host disk, host shares, or network forwarding. */
export function vmArguments(
  code: string,
  vars: string,
  disk: string,
  state: string,
  { iso, seed, overlay, accel = "kvm", probe = false }: VmOptions = {},
) {
  const command = [
    "qemu-system-x86_64",
    "-machine",
    "q35",
    "-accel",
    accel,
    "-cpu",
    accel === "kvm" ? "host" : "max",
    "-m",
    "8192",
    "-smp",
    "4",
    "-nodefaults",
    "-nic",
    "none",
    "-drive",
    `if=pflash,format=raw,readonly=on,file=${code}`,
    "-drive",
    `if=pflash,format=raw,file=${vars}`,
    "-drive",
    `if=none,id=os,format=qcow2,file=${disk}`,
    "-device",
    "virtio-blk-pci,drive=os,bootindex=1,serial=T1OS_DISPOSABLE",
    "-device",
    "virtio-vga",
    "-device",
    "qemu-xhci",
    "-device",
    "usb-kbd",
    "-device",
    "usb-tablet",
    "-display",
    "none",
    "-serial",
    `file:${join(state, "serial.log")}`,
    "-no-reboot",
  ]
  if (probe) command.push("-qmp", "stdio")
  else
    command.push(
      "-qmp",
      `unix:${join(state, "qmp.sock")},server=on,wait=off`,
      "-vnc",
      `unix:${join(state, "vnc.sock")}`,
    )
  for (const [bus, [id, path, boot]] of [
    ["installer", iso, ",bootindex=2"],
    ["seed", seed, ""],
    ["overlay", overlay, ""],
  ].entries()) {
    if (path !== undefined)
      command.push(
        "-drive",
        `if=none,id=${id},media=cdrom,readonly=on,format=raw,file=${path}`,
        "-device",
        `ide-cd,bus=ide.${bus},drive=${id}${boot}`,
      )
  }
  return command
}

async function bootProbe(command: string[], state: string, seconds: number, output: string) {
  const guest = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    timeout: (seconds + 30) * 1000,
  })
  const records = qmpRecords(guest.stdout)
  const qmp = async (execute: string, id: number, args?: Record<string, string>) => {
    await guest.stdin.write(JSON.stringify({ execute, arguments: args, id }) + "\n")
    await guest.stdin.flush()
    while (true) {
      const record = await records.next()
      if (record.done) throw new Error("QEMU exited before replying to QMP")
      if ("id" in record.value && record.value.id === id) {
        if ("error" in record.value) throw new Error("QMP command failed")
        if ("return" in record.value) return
        throw new Error("invalid QMP response")
      }
    }
  }
  try {
    const first = await records.next()
    if (first.done || !("QMP" in first.value)) throw new Error("QEMU did not start QMP")
    await qmp("qmp_capabilities", 1)
    await Bun.sleep(seconds * 1000)
    const screenshot = join(state, "frame.ppm")
    await qmp("screendump", 2, { filename: screenshot })
    if ((await Bun.file(screenshot).slice(0, 2).text()) !== "P6")
      throw new Error("QEMU did not capture a PPM frame")
    copyFileSync(screenshot, output, constants.COPYFILE_EXCL)
    await qmp("quit", 3)
    console.log(`Captured ${output}; inspect the frame, this is a boot probe only.`)
  } finally {
    await stopQemu(guest)
    await records.return(undefined)
  }
}

const help = `Build cidata and boot the signed stock Omarchy installer on a new, offline VM disk.
Usage: bun apps/platform/src/omarchy-vm.ts --iso PATH --signature PATH --public-key PATH
       --ovmf-code PATH --ovmf-vars PATH [--size-gib 32..128] [--accel kvm|tcg]
       [--bundle PATH --bundle-sha256 SHA256 --phase-timeout 15..7200]
       [--overlay-iso PATH | --probe-output PATH --probe-seconds 1..600]
       [--apply --confirm ${TOKEN}]
Default: side-effect-free dry run. Use --check-kvm for the standalone device preflight.`

function boundedInt(value: string, name: string, min: number, max: number) {
  if (!/^\d+$/u.test(value) || Number(value) < min || Number(value) > max)
    throw new Error(`${name} must be between ${min} and ${max}`)
  return Number(value)
}

function needed(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`)
  return value
}

/** Run either the file-free dry run or the isolated disposable acceptance harness. */
export async function main(argv: string[]) {
  const { values: opts } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      "check-kvm": { type: "boolean" },
      iso: { type: "string" },
      signature: { type: "string" },
      "public-key": { type: "string" },
      "ovmf-code": { type: "string" },
      "ovmf-vars": { type: "string" },
      bundle: { type: "string" },
      "bundle-sha256": { type: "string" },
      "phase-timeout": { type: "string", default: "1800" },
      "overlay-iso": { type: "string" },
      "size-gib": { type: "string", default: "40" },
      accel: { type: "string", default: "kvm" },
      "probe-output": { type: "string" },
      "probe-seconds": { type: "string", default: "90" },
      apply: { type: "boolean", default: false },
      confirm: { type: "string" },
    },
  })
  if (opts.help) {
    console.log(help)
    return
  }
  if (opts["check-kvm"]) {
    if (argv.length !== 1 || process.geteuid?.() === 0)
      throw new Error("--check-kvm requires a non-root runner")
    verifyKvmAccess()
    return
  }
  const isoInput = needed(opts.iso, "--iso")
  const signatureInput = needed(opts.signature, "--signature")
  const keyInput = needed(opts["public-key"], "--public-key")
  const codeInput = needed(opts["ovmf-code"], "--ovmf-code")
  const varsInput = needed(opts["ovmf-vars"], "--ovmf-vars")
  const bundleDigest = opts["bundle-sha256"]
  const timeout = boundedInt(opts["phase-timeout"], "--phase-timeout", 15, 7200)
  const size = boundedInt(opts["size-gib"], "--size-gib", 32, 128) * GIB
  const probeTime = boundedInt(opts["probe-seconds"], "--probe-seconds", 1, 600)
  const accel = opts.accel
  if (accel !== "kvm" && accel !== "tcg") throw new Error("--accel must be kvm or tcg")
  if (opts.apply !== (opts.confirm === TOKEN) || (opts.confirm !== undefined && !opts.apply))
    throw new Error(`execution requires both --apply and --confirm ${TOKEN}`)
  if (
    Boolean(opts.bundle) !== Boolean(bundleDigest) ||
    (bundleDigest && !/^[0-9a-f]{64}$/u.test(bundleDigest))
  )
    throw new Error("--bundle and its trusted full lowercase --bundle-sha256 are required together")
  if (opts.bundle && (opts["overlay-iso"] || opts["probe-output"]))
    throw new Error("--bundle is incompatible with manual --overlay-iso or --probe-output")
  if (!opts.apply) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          iso: ISO_NAME,
          sha256: ISO_SHA256,
          guest_disk: DISK,
          host_disk: "new temporary qcow2",
          network: "none",
          flow: opts.bundle
            ? "stock unattended install, offline pinned overlay, two verified boots"
            : "stock installer only",
          bundle_sha256: bundleDigest ?? null,
          omarchy_configuration: config(size),
        },
        null,
        2,
      ),
    )
    return
  }
  const iso = regularFile(isoInput)
  const signature = regularFile(signatureInput)
  const key = regularFile(keyInput)
  const code = regularFile(codeInput)
  const vars = regularFile(varsInput)
  const overlay = opts["overlay-iso"] ? regularFile(opts["overlay-iso"]) : undefined
  if (accel === "kvm") verifyKvmAccess()
  const root = realpathSync(tmpdir())
  if (unsafeQemuPath(root)) throw new Error("TMPDIR cannot contain commas or newlines")
  if (Buffer.byteLength(root) > 65)
    throw new Error("set a shorter TMPDIR for the Unix display sockets")
  if (opts.bundle && !Bun.which("guestfish"))
    throw new Error("--bundle requires installed guestfish and its isolated libguestfs appliance")
  const umask = process.umask(0o077)
  let state: string | undefined
  try {
    state = mkdtempSync(join(root, "t1os-smoke-"))
    const frozen =
      opts.bundle && bundleDigest ? bundleInput(opts.bundle, bundleDigest, state) : undefined
    await verifyIso(iso, signature, key, state)
    const assignedVars = join(state, "ovmf-vars.fd")
    copyFileSync(vars, assignedVars, constants.COPYFILE_EXCL)
    const disk = join(state, "disposable.qcow2")
    await run(["qemu-img", "create", "-f", "qcow2", disk, String(size)])
    const seed = await cidata(state, size)
    if (frozen && bundleDigest) {
      console.log("Waiting for stock Omarchy unattended installer reboot.")
      const serial = join(state, "serial.log")
      await runQmp(
        vmArguments(code, assignedVars, disk, state, { iso, seed, accel, probe: true }),
        { phase: "stock installer", serial, deadline: performance.now() + timeout * 1000 },
      )
      console.log(
        "Stock guest rebooted. Inspecting installed root through the offline guestfish appliance.",
      )
      await stage(disk, state, frozen, bundleDigest, VERSION, timeout, accel === "tcg")
      for (const number of [1, 2]) {
        if (accel === "kvm") verifyKvmAccess()
        console.log(
          `Starting installed-system verification boot ${number}/2 without installation media.`,
        )
        await runQmp(vmArguments(code, assignedVars, disk, state, { accel, probe: true }), {
          phase: `installed boot ${number}`,
          serial,
          deadline: performance.now() + timeout * 1000,
          digest: bundleDigest,
        })
      }
      console.log(`Unattended t1os validated on two installed boots: ${bundleDigest}`)
      return
    }
    if (opts["probe-output"]) {
      console.log("Running a socket-free QEMU installer boot probe.")
      await bootProbe(
        vmArguments(code, assignedVars, disk, state, { iso, seed, accel, probe: true }),
        state,
        probeTime,
        resolve(opts["probe-output"]),
      )
      return
    }
    console.log(
      `Installer VM: ${state}/vnc.sock (Unix VNC); local credentials: vmadmin / ${state}/console-password`,
    )
    await run(vmArguments(code, assignedVars, disk, state, { iso, seed, accel }), undefined, false)
    console.log(
      `Second boot without install media. Inspect ${state}/vnc.sock; QEMU exiting is not, by itself, an install pass.`,
    )
    await run(vmArguments(code, assignedVars, disk, state, { overlay, accel }), undefined, false)
  } finally {
    if (state) rmSync(state, { recursive: true, force: true })
    process.umask(umask)
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (ex) {
    console.error(`t1os VM: ${ex instanceof Error ? ex.message : String(ex)}`)
    process.exitCode = 1
  }
}
