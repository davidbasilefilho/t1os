#!/usr/bin/env python3
"""Stage a digest-pinned t1os bundle on Omarchy 4.5.0 or restore a staged release."""

import argparse
import hashlib
import fcntl
import os
import re
import stat
import subprocess
import tarfile
import tempfile
from pathlib import Path

INSTALL_ROOT = Path("/opt/t1os")
STATE = Path("/var/lib/t1os")
BOOT_UNIT = Path("/etc/systemd/system/t1os-first-boot.service")
BASE_VERSION = "4.5.0"
MAX_BYTES = 768 * 1024**2
MAX_ENTRIES = 40_000
HEX = re.compile(r"[0-9a-f]{64}")


def digest_file(stream):
    """Hash an already open binary stream, leaving it at EOF."""
    return hashlib.file_digest(stream, "sha256").hexdigest()


def allowed(name):
    """Allow only overlay sources, excluding metadata, credentials and device paths."""
    return bool(re.fullmatch(r"(?:runtime/[A-Za-z0-9_.@/-]+|platform/(?:first-boot|"
                             r"t1os-first-boot\.service)|bin/t1os|"
                             r"agent-host/(?:bin|pi-deps|t3-release)/[A-Za-z0-9_.@+$/-]+)", name)
                and all(part and not part.startswith(".") for part in name.split("/")))


def unpack(stream, destination):
    """Extract only allowlisted, bounded regular files into an empty private directory."""
    stream.seek(0)
    total = 0
    names = set()
    with tarfile.open(fileobj=stream, mode="r:") as bundle:
        for member in bundle:
            name = member.name
            if not allowed(name) or name in names or not member.isfile():
                raise ValueError(f"unexpected bundle entry: {name}")
            total += member.size
            if total > MAX_BYTES or len(names) >= MAX_ENTRIES:
                raise ValueError("overlay bundle exceeds size limit")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with bundle.extractfile(member) as source, target.open("xb") as output:
                for block in iter(lambda: source.read(1048576), b""):
                    output.write(block)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
            names.add(name)
    for name in ("platform/first-boot", "platform/t1os-first-boot.service", "runtime/install.sh"):
        if name not in names:
            raise ValueError(f"missing overlay member: {name}")
    if any(not os.access(destination / name, os.X_OK)
           for name in ("platform/first-boot", "runtime/install.sh")):
        raise ValueError("required overlay entrypoints are not executable")


def stage(bundle, expected, releases):
    """Verify and stage bytes in one pass over a private copy of untrusted media."""
    target = releases / expected
    with tempfile.TemporaryDirectory(dir=releases, prefix=".stage-") as temporary:
        temp = Path(temporary)
        descriptor = os.open(bundle, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as source, tempfile.TemporaryFile(dir=temp) as frozen:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
                raise ValueError("bundle must be a regular tar file no larger than 768 MiB")
            remaining = info.st_size
            while remaining:
                block = source.read(min(1048576, remaining))
                if not block:
                    raise ValueError("bundle shrank while copying")
                remaining -= len(block)
                frozen.write(block)
            frozen.seek(0)
            if digest_file(frozen) != expected:
                raise ValueError("overlay SHA-256 does not match the supplied pin")
            if not target.exists():
                payload = temp / "payload"
                payload.mkdir()
                unpack(frozen, payload)
                payload.rename(target)
    return target


def link(path, target):
    """Replace a current/previous symlink atomically without dereferencing it."""
    temporary = path.with_name("." + path.name)
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    temporary.replace(path)


def installed_only():
    """Restrict application to the pinned Arch/Omarchy system, not a live ISO or SSH."""
    if os.geteuid() != 0:
        raise ValueError("apply requires a local root console")
    if not os.isatty(0) or any(name.startswith("SSH_") for name in os.environ):
        raise ValueError("run apply from the local VM console, not SSH")
    tty = os.ttyname(0)
    if not re.fullmatch(r"/dev/tty(?:[1-9][0-9]*|S[0-9]+|AMA[0-9]+)", tty):
        raise ValueError("apply requires a virtual-terminal or serial console")
    root = subprocess.check_output(["findmnt", "-n", "-o", "FSTYPE", "/"], text=True).strip()
    if root != "btrfs" or Path("/run/archiso").exists():
        raise ValueError("apply requires the installed Btrfs system, not the installer or a container")
    package = subprocess.check_output(["pacman", "-Q", "omarchy"], text=True).strip()
    if not re.fullmatch(rf"omarchy (?:\d+:)?{re.escape(BASE_VERSION)}-[^ ]+", package):
        raise ValueError(f"expected installed Omarchy {BASE_VERSION}; found {package}")


def activate(release):
    """Update active release and stage a recovery-safe first boot."""
    if not release.is_dir() or release.is_symlink() or not HEX.fullmatch(release.name):
        raise ValueError("invalid staged release")
    current = INSTALL_ROOT / "current"
    old = current.resolve(strict=True) if current.is_symlink() else None
    if old != release:
        if old is not None and old.parent == release.parent and HEX.fullmatch(old.name):
            link(INSTALL_ROOT / "previous", old)
        link(current, release)
    temporary = BOOT_UNIT.with_name("." + BOOT_UNIT.name)
    with temporary.open("wb") as output:
        output.write((release / "platform/t1os-first-boot.service").read_bytes())
    temporary.chmod(0o644)
    temporary.replace(BOOT_UNIT)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", BOOT_UNIT.name], check=True)
    # Apply now so the next boot reaches the CLI. A failed step remains retryable at boot.
    subprocess.run(["systemctl", "restart", BOOT_UNIT.name], check=True)


def main():
    """Default to dry run; releases and workspaces are never deleted by rollback."""
    parser = argparse.ArgumentParser(description=__doc__)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--bundle", type=Path)
    operation.add_argument("--rollback", action="store_true")
    parser.add_argument("--sha256")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.bundle and not HEX.fullmatch(args.sha256 or ""):
        parser.error("--bundle requires the expected --sha256 from an independent trusted source")
    if args.rollback and args.sha256:
        parser.error("--rollback does not accept --sha256")
    if not args.apply:
        print("Dry run: no files or services changed; "
              + ("restore the previously staged overlay" if args.rollback
                 else f"apply {args.sha256} after verifying {args.bundle}"))
        return
    os.environ["PATH"] = "/usr/bin:/bin"
    os.umask(0o022)
    installed_only()
    releases = INSTALL_ROOT / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    STATE.mkdir(mode=0o700, exist_ok=True)
    # Separate lock from the first-boot unit it invokes.
    with (STATE / "deployment.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.rollback:
            release = (INSTALL_ROOT / "previous").resolve(strict=True)
            if release.parent != releases:
                raise ValueError("previous release points outside the managed directory")
        else:
            release = stage(args.bundle, args.sha256, releases)
        activate(release)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"t1os provision: {error}") from error
