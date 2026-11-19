#!/usr/bin/env python3
"""Run `python3 -B platform/bench-stage.py` on Linux; no root or VM required.

Use the same TMPDIR filesystem to compare revisions. Measurements cover stage() only,
not fixture creation, release cleanup or service activation. Writes are process syscall
bytes rather than physical disk traffic. The fixture is disposable and has no agent data.
"""

import hashlib
import io
import statistics
import tarfile
import tempfile
import time
from pathlib import Path

from provision import stage

MIB = 1024**2


def fixture(directory):
    """Make a reproducible 64 MiB uncompressed overlay (no installed tools required)."""
    path = directory / "media.tar"
    with tarfile.open(path, "w:") as archive:
        for name in ("platform/first-boot", "platform/t1os-first-boot.service", "runtime/install.sh"):
            entry = tarfile.TarInfo(name)
            entry.mode = 0o755
            entry.size = 7
            archive.addfile(entry, io.BytesIO(b"fixture"))
        with tempfile.TemporaryFile(dir=directory) as contents:
            contents.truncate(64 * MIB)
            entry = tarfile.TarInfo("runtime/payload")
            entry.size = 64 * MIB
            archive.addfile(entry, contents)
    with path.open("rb") as stream:
        return path, hashlib.file_digest(stream, "sha256").hexdigest()


def write_count():
    """Linux counts bytes passed to write syscalls, including buffered/cache-backed IO."""
    for line in Path("/proc/self/io").read_text().splitlines():
        if line.startswith("wchar:"):
            return int(line.split()[1])
    raise RuntimeError("missing Linux process IO counters")


def main():
    with tempfile.TemporaryDirectory(prefix="t1os-bench-") as space:
        directory = Path(space)
        archive, digest = fixture(directory)
        samples = {"fresh": [], "reapply": []}
        for trial in range(6):
            with tempfile.TemporaryDirectory(dir=directory) as releases:
                for results in samples.values():
                    before = write_count()
                    start = time.perf_counter()
                    stage(archive, digest, Path(releases))
                    elapsed = time.perf_counter() - start
                    written = write_count() - before
                    if trial:  # Exclude the warm-up pair.
                        results.append((elapsed, written))
        for mode, results in samples.items():
            elapsed, writes = zip(*results)
            print(f"{mode}: median {statistics.median(elapsed)*1000:.1f} ms, "
                  f"{statistics.median(writes)/MIB:.2f} MiB written (n={len(results)})")


if __name__ == "__main__":
    main()
