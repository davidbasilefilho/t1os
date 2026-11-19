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
MAX_BYTES = 1280 * 1024**2
MAX_ENTRIES = 40_000
HEX = re.compile(r"[0-9a-f]{64}")


def digest_file(stream):
    """Hash an already open binary stream, leaving it at EOF."""
    return hashlib.file_digest(stream, "sha256").hexdigest()


def allowed(name):
    """Allow only overlay sources, excluding metadata, credentials and device paths."""
    if len(name.encode()) > 4096 or any(not part or part.startswith(".") or len(part.encode()) > 255
                                        for part in name.split("/")):
        return False
    if name.startswith("agent-host/pi-deps/node_modules/"):
        # Pinned upstream packages ship e.g. Unicode paper names and licenses with spaces.
        # Never interpret paths as shell; reject backslashes, control chars and nonprintables.
        return all(c.isprintable() and c != "\\" for c in name)
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


def consume_media(source, size, accept):
    """Feed exactly the stat-bounded snapshot length to a writer or hash."""
    while size:
        block = source.read(min(1048576, size))
        if not block:
            raise ValueError("bundle shrank while copying")
        size -= len(block)
        accept(block)


def stage(bundle, expected, releases):
    """Recheck supplied media every time; only new releases need a private copy."""
    if not HEX.fullmatch(expected):
        raise ValueError("invalid release digest")
    target = releases / expected
    descriptor = os.open(bundle, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        def stable():
            after = os.fstat(source.fileno())
            if ((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                    != (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)):
                raise ValueError("bundle changed during verification")
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_BYTES:
            raise ValueError("bundle must be a regular tar file no larger than 1280 MiB")
        if target.is_symlink():
            raise ValueError("staged release is a symlink")
        if target.exists():
            staged_info = target.lstat()
            if not stat.S_ISDIR(staged_info.st_mode) or staged_info.st_uid != os.geteuid() or staged_info.st_mode & 0o022:
                raise ValueError("unsafe staged release directory")
            # The deployment lock protects the staged release. Never unpack reapply media.
            digest = hashlib.sha256()
            consume_media(source, info.st_size, digest.update)
            stable()
            if digest.hexdigest() != expected:
                raise ValueError("overlay SHA-256 does not match the supplied pin")
            return target
        with tempfile.TemporaryDirectory(dir=releases, prefix=".stage-") as temporary:
            temp = Path(temporary)
            with tempfile.TemporaryFile(dir=temp) as frozen:
                consume_media(source, info.st_size, frozen.write)
                stable()
                frozen.seek(0)
                if digest_file(frozen) != expected:
                    raise ValueError("overlay SHA-256 does not match the supplied pin")
                payload = temp / "payload"
                payload.mkdir()
                unpack(frozen, payload)
                payload.rename(target)
    return target


def link(path, target):
    """Replace a current/previous symlink atomically without dereferencing it."""
    if path.exists() and not path.is_symlink():
        raise ValueError(f"refusing to replace a non-managed pointer: {path}")
    temporary = path.with_name("." + path.name)
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    temporary.replace(path)


def assert_disposable_guest():
    """Require the pinned harness VM, not merely any Arch workstation, rescue ISO or SSH session."""
    if subprocess.check_output(["systemd-detect-virt", "--vm"], text=True).strip() not in ("kvm", "qemu"):
        raise ValueError("apply requires the t1os disposable QEMU guest")
    if Path("/sys/block/vda/serial").read_text().strip() != "T1OS_DISPOSABLE":
        raise ValueError("unexpected guest disk identity")
    source = subprocess.check_output(["findmnt", "-n", "-o", "SOURCE", "/"], text=True).strip()
    if os.path.realpath(source.split("[")[0]) != "/dev/vda2":
        raise ValueError("expected the installed root of the disposable guest")


def installed_only():
    """Restrict application to the pinned Arch/Omarchy system, not a live ISO or SSH."""
    if os.geteuid() != 0:
        raise ValueError("apply requires a local root console")
    if not os.isatty(0) or any(name.startswith("SSH_") for name in os.environ):
        raise ValueError("run apply from the local VM console, not SSH")
    tty = os.ttyname(0)
    if not re.fullmatch(r"/dev/tty(?:[1-9][0-9]*|S[0-9]+|AMA[0-9]+)", tty):
        raise ValueError("apply requires a virtual-terminal or serial console")
    assert_disposable_guest()
    root = subprocess.check_output(["findmnt", "-n", "-o", "FSTYPE", "/"], text=True).strip()
    if root != "btrfs" or Path("/run/archiso").exists():
        raise ValueError("apply requires the installed Btrfs system, not the installer or a container")
    package = subprocess.check_output(["pacman", "-Q", "omarchy"], text=True).strip()
    if not re.fullmatch(rf"omarchy (?:\d+:)?{re.escape(BASE_VERSION)}-[^ ]+", package):
        raise ValueError(f"expected installed Omarchy {BASE_VERSION}; found {package}")


def record(path, value, mode=0o600):
    """Atomically replace one root-managed control record, persisting directory metadata."""
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        name = Path(tmp.name)
        try:
            tmp.write(value)
            tmp.flush()
            os.fchmod(tmp.fileno(), mode)
            os.fsync(tmp.fileno())
            name.replace(path)
        finally:
            name.unlink(missing_ok=True)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def managed_target(name):
    """Only dereference a managed pointer into this root's private release directory."""
    pointer = INSTALL_ROOT / name
    if not pointer.is_symlink():
        if pointer.exists():
            raise ValueError(f"{name} is not a managed release pointer")
        return None
    target = pointer.resolve(strict=True)
    if target.parent != INSTALL_ROOT / "releases" or not HEX.fullmatch(target.name) or not target.is_dir():
        raise ValueError(f"invalid managed {name} release")
    return target


def prepare(release):
    """Apply candidate setup, without changing current or the applied receipt before success."""
    subprocess.run([release / "platform/first-boot", "--prepare"], cwd="/", check=True,
                   stdin=subprocess.DEVNULL, timeout=900, env={"PATH": "/usr/bin:/bin", "LANG": "C"})


def enable_unit(release, replace_known=None):
    """Install only this release's unit or replace a known managed predecessor."""
    source = (release / "platform/t1os-first-boot.service").read_bytes()
    if BOOT_UNIT.is_symlink() or (BOOT_UNIT.exists() and not BOOT_UNIT.is_file()):
        raise ValueError("unsafe installed first-boot unit")
    if BOOT_UNIT.exists() and BOOT_UNIT.read_bytes() != source:
        if replace_known is None or BOOT_UNIT.read_bytes() != (replace_known / "platform/t1os-first-boot.service").read_bytes():
            raise ValueError("refusing to replace an independent first-boot unit")
    record(BOOT_UNIT, source, 0o644)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", BOOT_UNIT.name], check=True)


def activate(release, check=None):
    """Promote a prepared candidate only after its checks; preserve the last success on failure."""
    if (release.parent != INSTALL_ROOT / "releases" or not release.is_dir()
            or release.is_symlink() or not HEX.fullmatch(release.name)):
        raise ValueError("invalid staged release")
    current = INSTALL_ROOT / "current"
    old = managed_target("current")
    pending = STATE / "pending"
    record(pending, (release.name + "\n").encode())
    try:
        prepare(release)
        if check is not None:
            check(release)
        enable_unit(release, old)
    except (ValueError, OSError, subprocess.SubprocessError):
        # current never moved. Restore staged unit/config content from the last success.
        # Keep pending for diagnostics and an explicit console recovery/retry.
        if old is not None and old != release:
            prepare(old)
            enable_unit(old, release)
        raise
    if old is not None and old != release:
        link(INSTALL_ROOT / "previous", old)
    # The current symlink itself is the atomic last-known-good selector. A crash in
    # the receipt write can be repaired using that same known-good target.
    if old != release:
        link(current, release)
    record(STATE / "applied", (release.name + "\n").encode())
    pending.unlink()


def rollback_target():
    """An interrupted/failed upgrade rolls back to current; otherwise use the previous success."""
    target = managed_target("current" if (STATE / "pending").exists() else "previous")
    if target is None:
        raise ValueError("no known-good release for rollback; retry a verified bundle from the console")
    return target


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
            release = rollback_target()
        else:
            release = stage(args.bundle, args.sha256, releases)
        activate(release)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"t1os provision: {error}") from error
