#!/usr/bin/env python3
"""Stage pinned Pi packages and the verified T3 Code Linux x64 release for t1os."""

import argparse
import hashlib
import os
import platform
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import tempfile

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
BUN_VERSION = "1.4.4"
T3_ARCHIVE = "t3-0.1.10-linux-x64"
T3_BYTES = 182240288
T3_SHA256 = "9bea9d36a217299a0af880e8c347b536ed6a9a2f5bf328a695d174d63628c5e8"
T3_ROOTS = {"client", "lib", "node_modules", "resource-monitor", "t3"}
WORKSPACE_FILES = (
    "package.json", "bun.lock", "apps/agent-host/package.json",
    "apps/cli/package.json", "packages/core/package.json",
)


def expand_t3(archive, destination):
    """Hash exact upstream bytes, then extract only the release's ordinary files."""
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    written = set()
    total = 0
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != T3_BYTES:
            raise ValueError("expected the official T3 Code 0.1.10 Linux x64 tar.gz file")
        if hashlib.file_digest(stream, "sha256").hexdigest() != T3_SHA256:
            raise ValueError("T3 Code archive SHA-256 does not match the pinned release")
        stream.seek(0)
        with tarfile.open(fileobj=stream, mode="r|gz") as source:
            for member in source:
                name = PurePosixPath(member.name)
                if (name.is_absolute() or not name.parts or name.parts[0] != T3_ARCHIVE
                        or any(part.startswith(".") for part in name.parts)
                        or "\\" in member.name or len(written) >= 10000 or name in written):
                    raise ValueError(f"unexpected T3 Code archive member: {member.name}")
                written.add(name)
                if len(name.parts) == 1 and member.isdir():
                    continue
                if len(name.parts) < 2 or name.parts[1] not in T3_ROOTS:
                    raise ValueError(f"unexpected root in T3 Code archive: {member.name}")
                target = destination.joinpath(*name.parts[1:])
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                total += member.size
                if not member.isfile() or total > 512 * 1024**2:
                    raise ValueError(f"unsupported or oversized T3 Code archive member: {member.name}")
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as incoming, target.open("xb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    executable = destination / "t3"
    with executable.open("rb") as stream:
        elf = stream.read(20)
    if not elf.startswith(b"\x7fELF\x02\x01") or elf[18:20] != b"\x3e\x00":
        raise ValueError("T3 Code release did not contain its Linux x86_64 ELF binary")
    if not executable.stat().st_mode & 0o111 or not (destination / "client/index.html").is_file():
        raise ValueError("T3 Code release is missing an executable server or its web client")


def copy_pi(source, destination):
    """Copy hoisted production dependencies; no workspace links or development metadata."""
    destination.mkdir(parents=True)
    for child in sorted(source.iterdir()):
        if child.name.startswith(".") or child.name == "@t1os":
            continue
        mode = child.lstat().st_mode
        target = destination / child.name
        if stat.S_ISDIR(mode):
            copy_pi(child, target)
        elif stat.S_ISREG(mode):
            shutil.copyfile(child, target)
            target.chmod(0o755 if mode & 0o111 else 0o644)
        else:
            raise ValueError(f"unexpected link or special file in hoisted Pi install: {child}")


def stage_pi(work, destination, offline):
    """Install just the Pi workspace from the same integrity-checked Bun lock as CI."""
    bun = shutil.which("bun")
    if not bun or subprocess.check_output([bun, "--version"], text=True).strip() != BUN_VERSION:
        raise ValueError(f"agent host preparation requires pinned Bun {BUN_VERSION}; use mise exec")
    work.mkdir()
    for name in WORKSPACE_FILES:
        manifest = work / name
        manifest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO / name, manifest)
    command = [
        bun, "install", "--filter", "@t1os/agent-host", "--production", "--linker", "hoisted",
        "--frozen-lockfile", "--ignore-scripts", "--registry=https://registry.npmjs.org",
    ]
    if offline:
        command.append("--offline")
    subprocess.run(command, cwd=work, check=True)
    copy_pi(work / "node_modules", destination / "node_modules")
    pi = destination / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
    if not pi.is_file():
        raise ValueError("Pi launcher missing from the hoisted node_modules tree")


def main():
    """Create one new immutable-ready tools tree without running any host services."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--t3-archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="new output directory; parent must exist")
    parser.add_argument("--offline", action="store_true", help="require an already populated Bun cache")
    args = parser.parse_args()
    if os.geteuid() == 0:
        parser.error("prepare the toolchain as a normal user, not root")
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        parser.error("agent tools must be prepared on Linux x86_64")
    output = args.output.absolute()
    if output.exists() or output.is_symlink():
        parser.error("output already exists")
    with tempfile.TemporaryDirectory(prefix=".agent-host-", dir=output.parent) as staging:
        work = Path(staging)
        payload = work / "payload"
        payload.mkdir()
        expand_t3(args.t3_archive, payload / "t3-release")
        stage_pi(work / "locked-workspace", payload / "pi-deps", args.offline)
        (payload / "bin").mkdir()
        for name in ("pi", "t3code"):
            shutil.copyfile(HERE / name, payload / "bin" / name)
            (payload / "bin" / name).chmod(0o755)
        # Use a private, operator-controlled parent directory for the prepared output.
        if output.exists() or output.is_symlink():
            raise ValueError("output already exists")
        payload.rename(output)
    print(output)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        raise SystemExit(f"t1os agent host: {error}") from error
