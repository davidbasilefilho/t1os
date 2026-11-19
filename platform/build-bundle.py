#!/usr/bin/env python3
"""Package the t1os overlay from a committed Git tree and optional standalone Linux CLI."""

import argparse
import hashlib
import io
import re
import os
import stat
import tempfile
import subprocess
import tarfile
from pathlib import Path

from provision import MAX_BYTES, MAX_ENTRIES, allowed


ROOT = Path(__file__).resolve().parent.parent
HOLYAGENT_SHA512 = ("9c8f4341d79b1213ba3bb9499a0a00a65c3eb0e6172e8a3e4d88f443befcccfffe"
                    "882f137b9b8414607e4e4c8fc061ccff766de0815590a600481c56cd36590e")
HOLYAGENT_PATH = "runtime/agent/holyagent-0.3.3.tgz"
REQUIRED = ["platform/first-boot", "platform/t1os-first-boot.service"]


def git(*arguments):
    """Read immutable source bytes from the authorized checkout."""
    return subprocess.check_output(["git", "-C", ROOT, *arguments])


def add(archive, name, data, mode):
    """Add normalized bytes without embedding owner, host paths or build timestamps."""
    info = tarfile.TarInfo(name)
    info.mode = mode
    info.size = len(data)
    archive.addfile(info, io.BytesIO(data))


def add_tools(archive, prepared):
    """Stream only prepared regular trees and explicitly approved host wrappers."""
    if not stat.S_ISDIR(prepared.lstat().st_mode):
        raise ValueError("--agent-tools must name the prepared agent-host directory")
    byte_count = 0
    count = 0
    for folder, directories, files in os.walk(prepared):
        directories.sort()
        files.sort()
        for directory in directories:
            path = Path(folder) / directory
            rel = path.relative_to(prepared).as_posix()
            if not allowed(f"agent-host/{rel}/fixture") or not stat.S_ISDIR(path.lstat().st_mode):
                raise ValueError(f"unexpected tool directory: {path}")
        for file in files:
            path = Path(folder) / file
            name = "agent-host/" + path.relative_to(prepared).as_posix()
            if not allowed(name) or not stat.S_ISREG(path.lstat().st_mode):
                raise ValueError(f"unexpected tool file: {path}")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as contents:
                st = os.fstat(contents.fileno())
                if not stat.S_ISREG(st.st_mode):
                    raise ValueError(f"tool file changed during build: {path}")
                byte_count += st.st_size
                count += 1
                if count > MAX_ENTRIES or byte_count > MAX_BYTES:
                    raise ValueError("prepared tool files exceed the bundle limit")
                member = tarfile.TarInfo(name)
                member.mode = 0o755 if st.st_mode & 0o111 else 0o644
                member.size = st.st_size
                archive.addfile(member, contents)


def main():
    """Build and print the digest to convey through a trusted separate channel."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True, help="full Git commit SHA (40 characters)")
    parser.add_argument("--cli", type=Path, help="standalone t1os CLI compiled for Linux x86_64")
    parser.add_argument("--holyagent", type=Path, help="pinned HolyAgent 0.3.3 registry archive")
    parser.add_argument("--agent-tools", type=Path, help="prepared agent-host directory")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        parser.error("--commit requires a full Git commit SHA")
    if git("rev-parse", f"{args.commit}^{{commit}}").decode().strip() != args.commit:
        parser.error("--commit must name a commit")
    names = git("ls-tree", "-rz", args.commit, "--", *REQUIRED, "runtime").decode().split("\0")
    cli = args.cli.read_bytes() if args.cli else None
    if cli is not None and (not cli.startswith(b"\x7fELF\x02\x01") or cli[18:20] != b"\x3e\x00"):
        parser.error("--cli must be a standalone Linux x86_64 ELF executable")
    agent = args.holyagent.read_bytes() if args.holyagent else None
    if agent is not None and hashlib.sha512(agent).hexdigest() != HOLYAGENT_SHA512:
        parser.error("HolyAgent archive failed the pinned registry SHA-512")
    if args.output.exists() or args.output.is_symlink():
        parser.error("bundle output already exists")
    seen = set()
    with tempfile.NamedTemporaryFile(dir=args.output.parent, prefix=".t1os-bundle-") as result:
        with tarfile.open(fileobj=result, mode="w:") as archive:
            for entry in sorted(filter(None, names)):
                metadata, name = entry.split("\t", 1)
                mode, kind, oid = metadata.split()
                if name == HOLYAGENT_PATH:
                    raise ValueError("HolyAgent registry archive must not be committed")
                if not allowed(name) or mode not in ("100644", "100755") or kind != "blob":
                    raise ValueError(f"unexpected bundle source: {name}")
                add(archive, name, git("cat-file", "blob", oid), int(mode, 8) & 0o777)
                seen.add(name)
            if not set(REQUIRED + ["runtime/install.sh"]).issubset(seen):
                raise ValueError("selected commit does not contain all required platform inputs")
            if cli is not None:
                add(archive, "bin/t1os", cli, 0o755)
            if agent is not None:
                add(archive, HOLYAGENT_PATH, agent, 0o644)
            if args.agent_tools is not None:
                add_tools(archive, args.agent_tools)
        result.flush()
        if result.tell() > MAX_BYTES:
            raise ValueError("bundle exceeds the provisioning byte limit")
        result.seek(0)
        digest = hashlib.file_digest(result, "sha256").hexdigest()
        os.fsync(result.fileno())
        os.link(result.name, args.output)
    print(f"{digest}  {args.output}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"t1os bundle: {error}") from error
