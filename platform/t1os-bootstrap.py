#!/usr/bin/env python3
"""Boot gate for a fresh t1os QEMU guest. No remote input, disk selection, shell or provider access."""
import fcntl
import json
import pwd
import importlib.util
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

BASE = Path("/opt/t1os")
BOOT = BASE / "bootstrap"
STATE = Path("/var/lib/t1os")
UNIT = Path("/etc/systemd/system/t1os-first-boot.service")
DIGEST = re.compile(r"[0-9a-f]{64}")
PATH = "/usr/bin:/bin"


def trusted(path, directory=False):
    """Require the whole root-owned input path to be non-symlinked and not writable by others."""
    for part in [*reversed(path.parents), path]:
        info = part.lstat()
        kind = stat.S_ISDIR if part != path or directory else stat.S_ISREG
        if not kind(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError(f"unsafe bootstrap input: {part}")


def command(*args):
    """Invoke a fixed OS utility with no inherited credentials, cwd hooks, shell or user PATH."""
    return subprocess.check_output(args, cwd="/", env={"PATH": PATH, "LANG": "C"}, text=True,
                                   timeout=120, stdin=subprocess.DEVNULL).strip()


def assert_machine():
    """Refuse host/SSH/live-ISO use, other disks and arbitrary callers of this unattended path."""
    if os.geteuid() != 0 or Path("/run/archiso").exists():
        raise ValueError("not the installed root")
    if sys.argv[1:] or not os.environ.get("INVOCATION_ID") or not re.search(
        r"(?m)^0::/system\.slice/t1os-bootstrap\.service$", Path("/proc/self/cgroup").read_text()
    ):
        raise ValueError("only the system t1os-bootstrap.service may invoke this mode")
    if command("systemd-detect-virt", "--vm") not in ("kvm", "qemu"):
        raise ValueError("requires the disposable QEMU guest")
    disk = Path("/sys/block/vda/serial")
    if disk.read_text().strip() != "T1OS_DISPOSABLE":
        raise ValueError("unexpected guest disk identity")
    if command("findmnt", "-n", "-o", "FSTYPE", "/") != "btrfs":
        raise ValueError("unexpected root filesystem")
    device = command("findmnt", "-n", "-o", "SOURCE", "/").split("[", 1)[0]
    if os.path.realpath(device) != "/dev/vda2":
        raise ValueError("not the designated installed root partition")
    if not re.fullmatch(r"omarchy (?:\d+:)?4\.5\.0-[^\s]+", command("pacman", "-Q", "omarchy")):
        raise ValueError("expected pinned Omarchy 4.5.0")
    trusted(BOOT, directory=True)
    for name in ("t1os-bootstrap.py", "provision.py", "expected-sha256"):
        trusted(BOOT / name)


def read_sha(path):
    """Read only a single lower-case SHA-256 digest from a trusted control file."""
    trusted(path)
    text = path.read_text()
    if not DIGEST.fullmatch(text.removesuffix("\n")):
        raise ValueError(f"invalid digest: {path}")
    return text.removesuffix("\n")


def deploy(provision, expected):
    """Verify the frozen tar once; extract atomically. Never import or execute any guest worktree."""
    release = BASE / "releases" / expected
    archive = BOOT / "t1os.tar"
    trusted(archive)
    release.parent.mkdir(mode=0o755, exist_ok=True)
    trusted(release.parent, directory=True)
    with archive.open("rb") as source:
        size = os.fstat(source.fileno()).st_size
        if not 0 < size <= provision.MAX_BYTES or provision.digest_file(source) != expected:
            raise ValueError("unattended bundle digest or size mismatch")
        if not release.exists():
            with tempfile.TemporaryDirectory(dir=release.parent, prefix=".verified-") as tmp:
                extracted = Path(tmp) / "payload"
                extracted.mkdir(mode=0o755)
                provision.unpack(source, extracted)
                extracted.rename(release)
    trusted(release, directory=True)
    # Never overwrite a deployment on a previously used machine. In the narrow
    # window after promotion but before our receipt we may retry the same digest.
    active = provision.managed_target("current")
    if active is not None and active != release:
        raise ValueError("another release is already active; use console recovery")
    provision.activate(release, check=verify_candidate)
    return release


def verify(expected):
    """Verify durable release, CLI-only boot and non-admin operator, not just QEMU process exit."""
    current = BASE / "current"
    if not current.is_symlink():
        raise ValueError("no active release")
    active = current.resolve(strict=True)
    trusted(active, directory=True)
    if active != BASE / "releases" / expected or read_sha(STATE / "applied") != expected:
        raise ValueError("applied digest and active release differ")
    verify_candidate(active)


def verify_candidate(active):
    """Check the prepared release using its own pinned binary before publishing current."""
    if command("systemctl", "get-default") != "multi-user.target":
        raise ValueError("unexpected default target")
    for name in ("sshd.service", "sshd.socket", "display-manager.service", "sddm.service"):
        unit_state = command("systemctl", "show", name, "-p", "ActiveState", "--value")
        if unit_state not in ("inactive", "failed"):
            raise ValueError(f"not CLI-only/private: {name} is {unit_state}")
    if command("id", "-Gn", "t1os") != "t1os" or int(command("id", "-u", "t1os")) < 1000:
        raise ValueError("operator has unexpected privileges")
    if command("passwd", "-S", "t1os").split()[1] != "L":
        raise ValueError("operator local password is not locked")
    # The unattended profile is a usable CLI workspace, not an empty base.
    cli = active / "bin/t1os"
    trusted(cli)
    if not cli.stat().st_mode & 0o111 or "t1os capture" not in command(
        "runuser", "-u", "t1os", "--", "env", "-i", "HOME=/home/t1os", f"PATH={PATH}", str(cli), "--help"
    ):
        raise ValueError("the compiled t1os CLI did not pass its unprivileged smoke check")


def receipt(path, value):
    """Create the completion receipt without replacing any existing state."""
    with tempfile.NamedTemporaryFile(dir=path.parent) as temp:
        temp.write((value + "\n").encode())
        temp.flush()
        os.fsync(temp.fileno())
        os.link(temp.name, path)
    parent = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def confirm_boot_record(digest, boot_id, text, fields):
    """A prior uptime's durable digest, a skipped unit, or a failed same-boot retry is not success."""
    if (not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", boot_id)
            or text != f"{digest} {boot_id}\n" or fields.get("LoadState") != "loaded"
            or fields.get("Result") != "success" or fields.get("ActiveState") != "active"
            or fields.get("SubState") != "exited" or fields.get("ExecMainStatus") != "0"
            or fields.get("ConditionResult") != "yes" or fields.get("AssertResult") != "yes"):
        raise ValueError("no successful first-boot unit execution for this kernel boot and digest")
    start = fields.get("ExecMainStartTimestampMonotonic", "")
    finish = fields.get("ExecMainExitTimestampMonotonic", "")
    if not (start.isdecimal() and finish.isdecimal() and 0 < int(start) <= int(finish)):
        raise ValueError("current first-boot unit did not complete")


def verify_current_boot(digest):
    """Require volatile, kernel-boot-ID-bound evidence and native oneshot result after ordering."""
    proof = Path("/run/t1os-first-boot.ok")
    trusted(proof)
    fields = dict(line.split("=", 1) for line in command(
        "systemctl", "show", "t1os-first-boot.service", "--property=LoadState,Result,ActiveState,SubState,ExecMainStatus,"
        "ConditionResult,AssertResult,ExecMainStartTimestampMonotonic,ExecMainExitTimestampMonotonic"
    ).splitlines())
    confirm_boot_record(digest, Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                        proof.read_text(), fields)


def checkpoint_probe(release, initial):
    """Verify one real operator-owned Git worktree and t1os checkpoint across fresh guest boots.

    This fixture exists only on the harness's disposable VM. No operator workspace or provider
    state is read. All commands touching user-owned data, including Git, run as that user.
    """
    root = Path("/var/lib/t1os-acceptance")
    root.mkdir(mode=0o711, exist_ok=True)
    trusted(root, directory=True)
    ident = pwd.getpwnam("t1os")
    fixture = root / "operator"
    if not fixture.exists():
        if not initial:
            raise ValueError("persisted operator fixture missing")
        fixture.mkdir(mode=0o700)
        os.chown(fixture, ident.pw_uid, ident.pw_gid)
    entry = fixture.lstat()
    if not stat.S_ISDIR(entry.st_mode) or entry.st_uid != ident.pw_uid or entry.st_mode & 0o077:
        raise ValueError("unsafe acceptance workspace")
    workspace = fixture / "worktree"
    state = fixture / "xdg-state"
    cli = release / "bin/t1os"

    def as_operator(*args):
        return command("runuser", "-u", "t1os", "--", "env", "-i", "LANG=C", f"PATH={PATH}",
                       f"HOME={fixture}", f"XDG_STATE_HOME={state}", f"T3CODE_HOME={fixture}/t3",
                       "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", *map(str, args))

    stamp = STATE / "acceptance-checkpoint"
    # A crash after persisting the read-back ID but before bootstrap completion is retryable.
    if not stamp.exists():
        if not initial:
            raise ValueError("missing prior-boot checkpoint")
        as_operator("/usr/bin/mkdir", "-p", workspace)
        as_operator("/usr/bin/git", "-C", workspace, "init", "--quiet")
        # An idempotent fixture commit with no private inputs.
        as_operator("/usr/bin/git", "-c", "user.name=t1os", "-c", "user.email=fixture@example.invalid",
                    "-C", workspace, "commit", "--allow-empty", "--quiet", "-m", "disposable boot fixture")
        captured = as_operator(cli, "capture", workspace)
        if not DIGEST.fullmatch(captured):
            raise ValueError("unexpected checkpoint ID")
        receipt(stamp, captured)
    expected = read_sha(stamp)
    saved = json.loads(as_operator(cli, "show", expected))
    if not isinstance(saved, dict):
        raise ValueError("invalid persisted checkpoint")
    head = as_operator("/usr/bin/git", "-C", workspace, "rev-parse", "--verify", "HEAD")
    if (saved.get("workspace") != str(workspace) or saved.get("head") != head or
            not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", head)):
        raise ValueError("prior worktree commit or saved checkpoint did not survive")
    ids = json.loads(as_operator(cli, "list"))
    if not isinstance(ids, list) or expected not in ids or as_operator(cli, "capture", workspace) != expected:
        raise ValueError("checkpoint could not be reopened by the operator")


def main():
    """Bootstrap once. Subsequent boots verify the active release, never reinstall the original."""
    assert_machine()
    expected = read_sha(BOOT / "expected-sha256")
    STATE.mkdir(mode=0o700, exist_ok=True)
    trusted(STATE, directory=True)
    done = STATE / "initial-bootstrap-sha256"
    with (STATE / "deployment.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if done.exists():
            if read_sha(done) != expected:
                raise ValueError("initial receipt conflicts with the provisioned media")
            active = read_sha(STATE / "applied")
            verify_current_boot(active)
            verify(active)
            checkpoint_probe(BASE / 'releases' / active, initial=False)
            return active
        spec = importlib.util.spec_from_file_location("t1os_provision", BOOT / "provision.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        deploy(module, expected)
        verify(expected)
        checkpoint_probe(BASE / 'releases' / expected, initial=True)
        receipt(done, expected)
    return expected


if __name__ == "__main__":
    try:
        sha = main()
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        # Nothing else writes to this dedicated serial evidence channel on our behalf.
        if os.geteuid() == 0 and os.environ.get("INVOCATION_ID"):
            try:
                with open("/dev/ttyS0", "w") as output:
                    print("T1OS_FAILED", file=output, flush=True)
            except OSError:
                pass
        raise SystemExit(f"unattended bootstrap failed: {exc}")
    with open("/dev/ttyS0", "w") as output:
        print("T1OS_READY", sha, file=output, flush=True)
