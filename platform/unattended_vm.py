"""Drive a stock installer and stage fixed bootstrap files through an offline guestfs VM."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import stat
import subprocess
import threading
import time

from provision import MAX_BYTES as MAX_BUNDLE

SOURCE = Path(__file__).resolve().parent
BOOTSTRAP = "/opt/t1os/bootstrap"
UNIT_DIR = "/etc/systemd/system"
UNIT = "t1os-bootstrap.service"
ROOT_PARTITION = "/dev/sda2"
MARKER = "T1OS_READY"
FAILED_MARKER = b"T1OS_FAILED"
MAX_SERIAL = 1024**2


def bundle_input(source, expected, state):
    """Freeze the operator-approved regular archive to a private, digest-checked copy."""
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("bundle requires a trusted full lowercase SHA-256")
    target = state / "verified-overlay.tar"
    digest = hashlib.sha256()
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as data, target.open("xb") as frozen:
        size = os.fstat(data.fileno())
        if not stat.S_ISREG(size.st_mode) or not 0 < size.st_size <= MAX_BUNDLE:
            raise ValueError("bundle must be a nonempty regular tar no larger than the overlay size limit")
        remain = size.st_size
        while remain:
            chunk = data.read(min(remain, 1024**2))
            if not chunk:
                raise ValueError("bundle changed while copying")
            frozen.write(chunk)
            digest.update(chunk)
            remain -= len(chunk)
    if digest.hexdigest() != expected:
        raise ValueError("bundle SHA-256 does not match the trusted pin")
    return target


def guestfish_commands(disk, commands, readonly, timeout, tcg=False):
    """Use an isolated libguestfs appliance (no guest network or host filesystem mounts)."""
    env = os.environ.copy()
    env["LIBGUESTFS_BACKEND"] = "direct"
    if tcg:
        # Supported backend option to avoid surprise acceleration on a software-emulated harness.
        env["LIBGUESTFS_BACKEND_SETTINGS"] = "force_tcg"
    argv = ["guestfish", "--ro" if readonly else "--rw", "--format=qcow2", "-a", str(disk), "--"]
    for index, command in enumerate(commands):
        if index:
            argv.append(":")
        argv.extend(command)
    return subprocess.run(argv, check=True, text=True, capture_output=True, env=env, timeout=timeout).stdout


def stage(disk, state, bundle, digest, version, timeout, tcg):
    """Confirm the installed root, then put fixed reviewed bootstrap files into the new disk."""
    root = state.lstat()
    if (disk.parent != state or disk.name != "disposable.qcow2"
            or not stat.S_ISDIR(root.st_mode) or root.st_uid != os.geteuid() or root.st_mode & 0o077):
        raise ValueError("staging is restricted to the harness's fresh private disk")
    info = disk.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        raise ValueError("invalid disposable disk ownership or permissions")
    read = [
        ("set-network", "false"), ("run",),
        ("vfs-type", ROOT_PARTITION),
        ("mount-vfs", "ro,subvol=@", "btrfs", ROOT_PARTITION, "/"),
        ("is-file", "/usr/lib/systemd/system/multi-user.target"),
        ("is-dir", "/opt"),
        ("is-dir", "/etc"),
        ("is-dir", UNIT_DIR),
        ("is-symlink", "/etc/systemd"),
        ("is-symlink", f"{UNIT_DIR}/multi-user.target.wants"),
        ("exists", f"{UNIT_DIR}/{UNIT}"),
        ("is-symlink", f"{UNIT_DIR}/{UNIT}"),
        ("exists", "/opt/t1os"),
        ("is-symlink", "/opt/t1os"),
        ("glob-expand", f"/var/lib/pacman/local/omarchy-{version}-*/desc"),
        ("umount-all",),
    ]
    lines = guestfish_commands(disk, read, True, timeout, tcg).splitlines()
    expected = ["btrfs", "true", "true", "true", "true", "false", "false", "false", "false", "false", "false"]
    if lines[:-1] != expected or not lines or not re.fullmatch(
        rf"/var/lib/pacman/local/omarchy-{re.escape(version)}-[^/\s]+/desc", lines[-1]
    ):
        raise ValueError("expected a fresh installed Omarchy Btrfs root; no write attempted")

    digest_file = state / "bundle-sha256"
    digest_file.write_text(digest + "\n", encoding="ascii")
    trusted = [
        (SOURCE / "t1os-bootstrap.py", f"{BOOTSTRAP}/t1os-bootstrap.py", "0755"),
        (SOURCE / "provision.py", f"{BOOTSTRAP}/provision.py", "0644"),
        (bundle, f"{BOOTSTRAP}/t1os.tar", "0600"),
        (digest_file, f"{BOOTSTRAP}/expected-sha256", "0600"),
        (SOURCE / UNIT, f"{UNIT_DIR}/{UNIT}", "0644"),
    ]
    for source, _, _ in trusted:
        if not stat.S_ISREG(source.lstat().st_mode):
            raise ValueError(f"expected regular bootstrap input: {source}")
    write = [
        ("set-network", "false"), ("run",),
        ("mount-vfs", "rw,subvol=@", "btrfs", ROOT_PARTITION, "/"),
        ("mkdir-p", BOOTSTRAP),
        ("chown", "0", "0", "/opt/t1os"),
        ("chown", "0", "0", BOOTSTRAP),
        ("chmod", "0755", "/opt/t1os"),
        ("chmod", "0700", BOOTSTRAP),
        ("mkdir-p", f"{UNIT_DIR}/multi-user.target.wants"),
    ]
    for source, dest, mode in trusted:
        write.extend((("upload", str(source), dest), ("chown", "0", "0", dest), ("chmod", mode, dest)))
    for name, target in [
        ("default.target", "/usr/lib/systemd/system/multi-user.target"),
        ("sshd.service", "/dev/null"), ("sshd.socket", "/dev/null"),
        ("display-manager.service", "/dev/null"),
        (f"multi-user.target.wants/{UNIT}", f"../{UNIT}"),
    ]:
        write.extend((("rm-f", f"{UNIT_DIR}/{name}"), ("ln-s", target, f"{UNIT_DIR}/{name}")))
    write.extend((("sync",), ("umount-all",)))
    guestfish_commands(disk, write, False, timeout, tcg)


def qmp_shutdown_event(record, reason):
    """Accept a genuine guest-originated stop and not a host kill/reset or a QEMU crash."""
    data = record.get("data", {})
    return record.get("event") == "SHUTDOWN" and data.get("guest") is True and data.get("reason") == reason


def read_qmp(stream, messages):
    """Decode QMP's line-oriented pipe and notify the controller of EOF."""
    try:
        for line in stream:
            messages.put(json.loads(line))
    except (OSError, ValueError):
        pass
    finally:
        messages.put(None)


def run_qmp(command, *, phase, serial, deadline, digest=None):
    """Wait for the installer reboot or exact digest-matching installed guest readiness."""
    if serial.exists():
        serial.unlink()
    messages = queue.Queue()
    expected = f"{MARKER} {digest}".encode("ascii") if digest else None
    ready = False
    shutdown = False
    next_power_request = 0.0
    serial_pos = 0
    pending = b""
    # No QMP/VNC sockets. QMP stdio is a private pipe; serial bytes go to private local storage.
    with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1) as qemu:
        threading.Thread(target=read_qmp, args=(qemu.stdout, messages), daemon=True).start()
        try:
            while time.monotonic() < deadline:
                if expected and not ready and serial.is_file():
                    with serial.open("rb") as stream:
                        stream.seek(serial_pos)
                        chunk = stream.read(MAX_SERIAL + 1)
                        serial_pos = stream.tell()
                    if serial_pos > MAX_SERIAL:
                        raise ValueError(f"{phase}: serial log exceeded size limit")
                    # splitlines accepts bare CR as well as CRLF; wait for the actual LF before matching.
                    records = (pending + chunk).split(b"\n")
                    pending = records.pop()
                    if any(line.rstrip(b"\r") == FAILED_MARKER for line in records):
                        raise ValueError(f"{phase}: guest bootstrap reported failure")
                    if any(line.rstrip(b"\r") == expected for line in records):
                        ready = True
                if ready and not shutdown and time.monotonic() >= next_power_request:
                    # The marker can precede logind's activation; retry the same ACPI request later.
                    qemu.stdin.write('{"execute":"system_powerdown","id":"shutdown"}\n')
                    qemu.stdin.flush()
                    next_power_request = time.monotonic() + 10
                try:
                    record = messages.get(timeout=0.25)
                except queue.Empty:
                    continue
                if record is None:
                    if shutdown and qemu.wait(timeout=5) == 0:
                        return
                    raise ValueError(f"{phase}: QEMU exited without the required guest event")
                if "QMP" in record:
                    qemu.stdin.write('{"execute":"qmp_capabilities","id":"caps"}\n')
                    qemu.stdin.flush()
                if "error" in record:
                    raise ValueError(f"{phase}: QMP command failed")
                reason = "guest-shutdown" if expected else "guest-reset"
                if qmp_shutdown_event(record, reason):
                    shutdown = ready if expected else True
                elif record.get("event") == "SHUTDOWN":
                    raise ValueError(f"{phase}: unexpected guest shutdown reason")
            raise ValueError(f"{phase}: timed out waiting for "
                             + ("verified first-boot marker/shutdown" if expected else "stock installer reboot"))
        finally:
            if qemu.poll() is None:
                qemu.terminate()
                try:
                    qemu.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    qemu.kill()


def verify_kvm_access():
    """Re-open the actual device after the appliance exits, without changing host permissions."""
    try:
        with open("/dev/kvm", "rb+", buffering=0) as device:
            if fcntl.ioctl(device.fileno(), 0xae00, 0) != 12:  # KVM_GET_API_VERSION
                raise ValueError("KVM API version 12 required")
    except OSError as error:
        raise ValueError("host runner lacks KVM device access after staging; guest boot not verified") from error


def run_install(*, arguments, disk, state, code, variables, iso, seed, bundle, digest, version, accel, timeout):
    """Run install, isolated staging, then two verified boots from only the installed disk."""
    if not shutil.which("guestfish"):
        raise ValueError("unattended overlay requires installed guestfish and its isolated appliance")
    print("Waiting for stock Omarchy unattended installer reboot.", flush=True)
    serial = state / "serial.log"
    install_args = arguments(code, variables, disk, state, iso=iso, seed=seed, accel=accel, probe=True)
    run_qmp(install_args, phase="stock installer", serial=serial, deadline=time.monotonic() + timeout)
    print("Stock guest rebooted. Inspecting installed root through the offline guestfish appliance.", flush=True)
    stage(disk, state, bundle, digest, version, timeout, accel == "tcg")
    for number in (1, 2):
        if accel == "kvm":
            verify_kvm_access()
        print(f"Starting installed-system verification boot {number}/2 without installation media.", flush=True)
        boot_args = arguments(code, variables, disk, state, accel=accel, probe=True)
        run_qmp(boot_args, phase=f"installed boot {number}", serial=serial,
                deadline=time.monotonic() + timeout, digest=digest)
    print(f"Unattended t1os validated on two installed boots: {digest}", flush=True)
