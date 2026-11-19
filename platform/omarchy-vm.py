#!/usr/bin/env python3
"""Build cidata and boot the signed stock Omarchy installer on a new, offline VM disk."""

import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import tempfile
import time
from pathlib import Path

from unattended_vm import bundle_input, run_install

VERSION = "4.5.0"
ISO_NAME = f"omarchy-{VERSION}-x86.iso"
ISO_SHA256 = "5d6288bc57f96f6231719830457582c846a2291985201c36a9a7d1216978b00f"
SIGNER = "40DFB630FF42BCFFB047046CF0134EE680CAC571"
TOKEN = "ERASE-NEW-DISPOSABLE-VM-DISK"
GIB = 1024**3
MIB = 1024**2
DISK = "/dev/vda"


def config(size):
    """Produce the x86 full-disk configurator schema for the sole virtio target."""
    def quantity(value):
        return {"sector_size": {"unit": "B", "value": 512}, "unit": "B", "value": value}

    def partition(fs_type, start, length, identity, mountpoint, flags, options, subvols):
        return {
            "fs_type": fs_type, "start": quantity(start), "size": quantity(length),
            "obj_id": identity, "mountpoint": mountpoint, "flags": flags, "dev_path": None,
            "status": "create", "type": "primary", "mount_options": options, "btrfs": subvols,
        }

    root_start = MIB + 2 * GIB
    return {
        "app_config": None, "archinstall-language": "English", "auth_config": {},
        "audio_config": {"audio": "pipewire"},
        "bootloader_config": {"bootloader": "Limine", "uki": False, "removable": False},
        "custom_commands": [],
        "omarchy_install": {
            "input_method": "none", "input_xkb_layout": "", "language": "en",
            "mode": "full_disk", "defer_provisioning": False, "target_mount": "/mnt",
            "boot": {
                "esp_mount": "/boot", "esp_path": "/EFI/limine",
                "efi_binary": "limine_x64.efi", "enable_fallback": True,
            },
            "storage": {"kernel": "linux-omarchy"},
        },
        "disk_config": {
            "config_type": "default_layout",
            "device_modifications": [{
                "device": DISK, "wipe": True, "partitions": [
                    partition("fat32", MIB, 2 * GIB, "ea21d3f2-82bb-49cc-ab5d-6f81ae94e18d",
                              "/boot", ["boot", "esp"], [], []),
                    partition("btrfs", root_start, size - root_start - MIB,
                              "8c2c2b92-1070-455d-b76a-56263bab24aa", None, [], ["compress=zstd"],
                              [{"mountpoint": m, "name": n} for m, n in [
                                  ("/", "@"), ("/home", "@home"), ("/var/log", "@log"),
                                  ("/var/cache/pacman/pkg", "@pkg"),
                              ]]),
                ],
            }],
        },
        "hostname": "t1os-smoke", "kernels": ["linux-omarchy"],
        "network_config": {"type": "iso"}, "ntp": True, "parallel_downloads": 8,
        "script": None, "services": [], "swap": True, "timezone": "UTC",
        "locale_config": {"kb_layout": "us", "sys_enc": "UTF-8", "sys_lang": "en_US.UTF-8"},
        "mirror_config": {
            "custom_repositories": [], "mirror_regions": {}, "optional_repositories": [],
            "custom_servers": [
                {"url": "https://mirror.omarchy.org/$repo/os/$arch"},
                {"url": "https://mirror.rackspace.com/archlinux/$repo/os/$arch"},
                {"url": "https://geo.mirror.pkgbuild.com/$repo/os/$arch"},
            ],
        },
        "packages": ["base-devel", "git", "omarchy-keyring", "omarchy-settings", "omarchy"],
        "profile_config": {"gfx_driver": None, "greeter": None, "profile": {}},
        "version": "3.0.9",
    }


def regular_file(path):
    """Reject symlinks, raw devices, pipes and path syntax interpreted by QEMU."""
    path = Path(path).absolute()
    if any(c in str(path) for c in (",", "\n", "\r")):
        raise ValueError(f"invalid path for QEMU: {path}")
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError(f"not a regular file: {path}")
    return path


def run(*command, **kwargs):
    """Execute a checked tool invocation without shell evaluation."""
    return subprocess.run(command, check=True, **kwargs)


def verify_iso(iso, signature, key, state):
    """Require the pinned digest and a detached signature from the pinned OpenPGP key."""
    with iso.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != ISO_SHA256:
            raise ValueError(f"unexpected Omarchy ISO SHA-256; expected {ISO_SHA256}")
    gnupg = state / "gnupg"
    gnupg.mkdir(mode=0o700)
    gpg = ("gpg", "--homedir", str(gnupg), "--batch", "--no-autostart", "--no-auto-key-retrieve")
    keyring = gnupg / "release.gpg"
    run(*gpg, "--dearmor", "--output", str(keyring), str(key), capture_output=True)
    result = run(*gpg, "--no-default-keyring", "--keyring", str(keyring),
                 "--status-fd=1", "--verify", str(signature), str(iso),
                 capture_output=True, text=True)
    signatures = [line.split() for line in result.stdout.splitlines()
                  if line.startswith("[GNUPG:] VALIDSIG ")]
    if not any(parts[2] == SIGNER or (len(parts) > 11 and parts[11] == SIGNER)
               for parts in signatures):
        raise ValueError("ISO signature was not made by the pinned Omarchy release key")


def cidata(state, size):
    """Generate one short-lived, private config drive without SSH or tailnet material."""
    directory = state / "cidata"
    directory.mkdir(mode=0o700)
    # Keep password local to the private disposable state; only its salted hash enters the VM ISO.
    # Hex avoids host vs guest keyboard-layout differences at the VM console.
    password = secrets.token_hex(20)
    (state / "console-password").write_text(password + "\n")
    password_hash = run("openssl", "passwd", "-6", "-stdin", input=password + "\n",
                        capture_output=True, text=True).stdout.strip()
    if not re.fullmatch(r"\$6\$[^$]+\$[./A-Za-z0-9]{86}", password_hash):
        raise ValueError("openssl did not produce a SHA-512 crypt password hash")
    creds = {
        "root_enc_password": password_hash,
        "users": [{"enc_password": password_hash, "groups": [], "sudo": True, "username": "vmadmin"}],
    }
    for name, contents in (("user_configuration.json", config(size)), ("user_credentials.json", creds)):
        (directory / name).write_text(json.dumps(contents) + "\n")
    image = state / "cidata.iso"
    run("genisoimage", "-quiet", "-output", str(image), "-volid", "cidata",
        "-joliet", "-rock", str(directory))
    return image


def arguments(code, vars_file, disk, state, iso=None, seed=None, overlay=None, accel="kvm", probe=False):
    """Construct offline QEMU arguments; no host disk, socket forwarding, or shared folder."""
    command = [
        "qemu-system-x86_64", "-machine", "q35", "-accel", accel, "-cpu",
        "host" if accel == "kvm" else "max", "-m", "8192", "-smp", "4", "-nodefaults", "-nic", "none",
        "-drive", f"if=pflash,format=raw,readonly=on,file={code}",
        "-drive", f"if=pflash,format=raw,file={vars_file}",
        "-drive", f"if=none,id=os,format=qcow2,file={disk}",
        "-device", "virtio-blk-pci,drive=os,bootindex=1,serial=T1OS_DISPOSABLE",
        "-device", "virtio-vga", "-device", "qemu-xhci", "-device", "usb-kbd", "-device", "usb-tablet",
        "-display", "none", "-serial", f"file:{state / 'serial.log'}",
        "-no-reboot",
    ]
    if probe:
        command.extend(["-qmp", "stdio"])
    else:
        command.extend(["-qmp", f"unix:{state / 'qmp.sock'},server=on,wait=off",
                        "-vnc", f"unix:{state / 'vnc.sock'}"])
    for bus, (ident, path, boot) in enumerate((("installer", iso, ",bootindex=2"),
                                               ("seed", seed, ""), ("overlay", overlay, ""))):
        if path is not None:
            command.extend([
                "-drive", f"if=none,id={ident},media=cdrom,readonly=on,format=raw,file={path}",
                "-device", f"ide-cd,bus=ide.{bus},drive={ident}{boot}",
            ])
    return command


def boot_probe(command, state, seconds, output):
    """Capture the guest framebuffer via QMP pipes, without opening local or network sockets."""
    with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as guest:
        def qmp(message, reply_id):
            guest.stdin.write(json.dumps({**message, "id": reply_id}) + "\n")
            guest.stdin.flush()
            for line in guest.stdout:
                reply = json.loads(line)
                if reply.get("id") == reply_id:
                    if "error" in reply:
                        raise ValueError(f"QMP: {reply['error']}")
                    return reply["return"]
            raise ValueError("QEMU exited before replying to QMP")

        try:
            if "QMP" not in json.loads(guest.stdout.readline()):
                raise ValueError("QEMU did not start QMP")
            qmp({"execute": "qmp_capabilities"}, 1)
            time.sleep(seconds)
            screenshot = state / "frame.ppm"
            qmp({"execute": "screendump", "arguments": {"filename": str(screenshot)}}, 2)
            if not screenshot.read_bytes().startswith(b"P6"):
                raise ValueError("QEMU did not capture a PPM frame")
            with screenshot.open("rb") as source, output.open("xb") as destination:
                shutil.copyfileobj(source, destination)
            qmp({"execute": "quit"}, 3)
            print(f"Captured {output}; inspect the frame, this is a boot probe only.", flush=True)
        finally:
            if guest.poll() is None:
                guest.terminate()
                try:
                    guest.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    guest.kill()


def main():
    """Render a side-effect-free dry run or run a disposable installation and fresh boot."""
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("iso", "signature", "public-key", "ovmf-code", "ovmf-vars"):
        parser.add_argument(f"--{flag}", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, help="trusted t1os overlay tar for fully unattended provisioning")
    parser.add_argument("--bundle-sha256", help="independent trusted overlay SHA-256")
    parser.add_argument("--phase-timeout", type=int, default=1800, choices=range(15, 7201),
                        metavar="15..7200", help="maximum seconds per unattended phase (default 1800)")
    parser.add_argument("--overlay-iso", type=Path, help="optional trusted read-only second-boot media")
    parser.add_argument("--size-gib", type=int, default=40, choices=range(32, 129), metavar="32..128")
    parser.add_argument("--accel", choices=("kvm", "tcg"), default="kvm")
    parser.add_argument("--probe-output", type=Path, help="capture one boot-probe PPM, no VM sockets")
    parser.add_argument("--probe-seconds", type=int, default=90, choices=range(1, 601),
                        metavar="1..600")
    parser.add_argument("--apply", action="store_true", help="default is a side-effect-free dry run")
    parser.add_argument("--confirm", metavar=TOKEN)
    args = parser.parse_args()
    if args.apply != (args.confirm == TOKEN) or (args.confirm and not args.apply):
        parser.error(f"execution requires both --apply and --confirm {TOKEN}")
    if bool(args.bundle) != bool(args.bundle_sha256) or (args.bundle_sha256 and not
            re.fullmatch(r"[0-9a-f]{64}", args.bundle_sha256)):
        parser.error("--bundle and its trusted full lowercase --bundle-sha256 are required together")
    if args.bundle and (args.overlay_iso or args.probe_output):
        parser.error("--bundle is incompatible with manual --overlay-iso or --probe-output")
    size = args.size_gib * GIB
    if not args.apply:
        print(json.dumps({"mode": "dry-run", "iso": ISO_NAME, "sha256": ISO_SHA256,
                          "guest_disk": DISK, "host_disk": "new temporary qcow2",
                          "network": "none",
                          "flow": "stock unattended install, offline pinned overlay, two verified boots"
                          if args.bundle else "stock installer only",
                          "bundle_sha256": args.bundle_sha256, "omarchy_configuration": config(size)}, indent=2))
        return
    iso, signature, key, code, variables = map(
        regular_file, (args.iso, args.signature, args.public_key, args.ovmf_code, args.ovmf_vars),
    )
    overlay = regular_file(args.overlay_iso) if args.overlay_iso else None
    if args.accel == "kvm" and not os.access("/dev/kvm", os.R_OK | os.W_OK):
        parser.error("KVM is unavailable; select --accel tcg if CPU emulation is acceptable")
    temporary_root = Path(tempfile.gettempdir()).resolve(strict=True)
    if any(c in str(temporary_root) for c in (",", "\n", "\r")):
        parser.error("TMPDIR cannot contain commas or newlines")
    if len(os.fsencode(temporary_root)) > 65:
        parser.error("set a shorter TMPDIR for the Unix display sockets")
    if args.bundle and not shutil.which("guestfish"):
        parser.error("--bundle requires installed guestfish and its isolated libguestfs appliance")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="t1os-smoke-", dir=temporary_root) as temporary:
        state = Path(temporary)
        frozen = bundle_input(args.bundle, args.bundle_sha256, state) if args.bundle else None
        verify_iso(iso, signature, key, state)
        assigned_vars = state / "ovmf-vars.fd"
        shutil.copyfile(variables, assigned_vars)
        disk = state / "disposable.qcow2"
        run("qemu-img", "create", "-f", "qcow2", str(disk), str(size))
        seed = cidata(state, size)
        if frozen:
            run_install(arguments=arguments, disk=disk, state=state, code=code, variables=assigned_vars,
                        iso=iso, seed=seed, bundle=frozen, digest=args.bundle_sha256, version=VERSION,
                        accel=args.accel, timeout=args.phase_timeout)
            return
        if args.probe_output:
            print("Running a socket-free QEMU installer boot probe.", flush=True)
            boot_probe(arguments(code, assigned_vars, disk, state, iso=iso, seed=seed,
                                 accel=args.accel, probe=True), state, args.probe_seconds,
                       args.probe_output)
            return
        print(f"Installer VM: {state}/vnc.sock (Unix VNC); local credentials: "
              f"vmadmin / {state}/console-password", flush=True)
        run(*arguments(code, assigned_vars, disk, state, iso=iso, seed=seed, accel=args.accel))
        # Never give the installed system a chance to boot the installer after this point.
        print(f"Second boot without install media. Inspect {state}/vnc.sock; "
              "QEMU exiting is not, by itself, an install pass.", flush=True)
        run(*arguments(code, assigned_vars, disk, state, overlay=overlay, accel=args.accel))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise SystemExit(f"t1os VM: {error}") from error
