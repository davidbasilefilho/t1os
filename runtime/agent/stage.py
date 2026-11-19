#!/usr/bin/env python3
"""Register the actual, pinned HolyAgent Pi package for a new non-root operator; no network."""
import argparse
import fcntl
import hashlib
import json
import os
import re
import stat
import tarfile
import tempfile
from pathlib import Path

VERSION = "0.3.3"
DIGEST = "9c8f4341d79b1213ba3bb9499a0a00a65c3eb0e6172e8a3e4d88f443befcccfffe882f137b9b8414607e4e4c8fc061ccff766de0815590a600481c56cd36590e"


def private_dir(path, home):
    """Create private descendants, rejecting pre-existing symlinks or directories writable by others."""
    current = home
    if home.resolve() != home or not home.is_dir() or home.stat().st_uid != os.getuid() or home.stat().st_mode & 0o022:
        raise ValueError("operator HOME must be real, owned and not writable by others")
    for part in path.relative_to(home).parts:
        current = current / part
        current.mkdir(mode=0o700, exist_ok=True)
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError(f"unsafe operator directory: {current}")


def decode_settings(path):
    """Reject symlinks, devices and oversized files before reading existing operator settings."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022 or info.st_size > 1048576:
            raise ValueError(f"unsafe settings: {path}")
        obj = json.load(source)
    if not isinstance(obj, dict):
        raise ValueError(f"expected a settings object: {path}")
    return obj


def seed(path, initial, accepts):
    """Initialize by atomic link; do not merge into or replace an operator's existing settings."""
    existing = decode_settings(path)
    if existing is not None:
        if not accepts(existing):
            raise ValueError(f"existing settings left intact; review the required entry manually: {path}")
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, mode="w") as temp:
        json.dump(initial, temp, indent=2)
        temp.write("\n")
        temp.flush()
        os.fsync(temp.fileno())
        os.link(temp.name, path)


def check_package(artifact, dest):
    """Copy only bounded regular files of the verified upstream extension. Compare existing installs."""
    fd = os.open(artifact, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        st = os.fstat(source.fileno())
        if not stat.S_ISREG(st.st_mode) or not 0 < st.st_size < 16 * 1024**2:
            raise ValueError("invalid HolyAgent package file")
        import io
        data = source.read(st.st_size + 1)
        if hashlib.sha512(data).hexdigest() != DIGEST:
            raise ValueError("HolyAgent SHA-512 mismatch")
    with tempfile.TemporaryDirectory(dir=dest.parent) as temp:
        stage = Path(temp) / "payload"
        stage.mkdir()
        total = 0
        files = set()
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            for entry in archive:
                match = re.fullmatch(r"package/([a-zA-Z0-9._@/-]+)", entry.name)
                if (not match or not entry.isfile() or any(p in ("", ".", "..") for p in match[1].split("/"))
                       or match[1] in files):
                    raise ValueError("unexpected HolyAgent archive member")
                name = match[1]
                files.add(name)
                total += entry.size
                if total > 32 * 1024**2 or len(files) > 1024:
                    raise ValueError("HolyAgent archive exceeds limit")
                target = stage / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(entry).read())
                target.chmod(0o700 if entry.mode & 0o111 else 0o600)
        package = json.loads((stage / "package.json").read_text())
        if (package["name"], package["version"]) != ("holyagent", VERSION) or not package.get("pi", {}).get("extensions") or not (stage / "scripts/holyagent").is_file():
            raise ValueError("unexpected HolyAgent manifest or missing upstream wrapper")
        if dest.is_symlink():
            raise ValueError("unsafe release directory")
        if dest.exists():
            if not dest.is_dir() or any(p.is_symlink() for p in dest.rglob("*")):
                raise ValueError("unsafe release contents")
            existing = {p.relative_to(dest).as_posix() for p in dest.rglob("*") if not p.is_dir()}
            if existing != files or any(not (dest / n).is_file() or (dest / n).read_bytes() != (stage / n).read_bytes() or (dest/n).stat().st_mode & 0o777 != (stage/n).stat().st_mode & 0o777 for n in files):
                raise ValueError("existing pinned package differs; stopped without overwriting it")
        else:
            stage.rename(dest)


# Non-GUI features selected by HolyAgent 0.3.3 for its headless Kimi profile.
# Names map to the exact, integrity-locked apps/agent-host dependency graph.
FEATURES = {
    "pi-provider-kimi-code": "0.6.13",
    "@tintinweb/pi-subagents": "0.23.2",
    "billion-context": "0.1.213",
    "@juicesharp/rpiv-todo": "2.15.0",
    "@juicesharp/rpiv-ask-user-question": "2.15.0",
    "@aliou/pi-processes": "0.13.6",
    "@ff-labs/pi-fff": "0.11.0"
}


def keep_link(path, dest):
    """Pin the managed package at its versioned target without replacing an operator install."""
    if path.is_symlink() and os.readlink(path) == str(dest):
        return
    if path.is_symlink() or path.exists():
        raise ValueError(f"existing package path differs; left intact: {path}")
    path.symlink_to(dest, target_is_directory=True)


def stage(artifact, home, modules=Path("/opt/t1os/current/agent-host/pi-deps/node_modules")):
    """Prepare an operator's user-scope local Pi extension and enable only T3's Pi driver."""
    if os.geteuid() == 0:
        raise ValueError("refusing to configure root")
    os.umask(0o077)
    store = home / ".local/share/t1os/agent"
    pi = home / ".pi/agent/settings.json"
    t3 = home / ".t3/userdata/settings.json"
    for path in (store, pi.parent, t3.parent):
        private_dir(path, home)
    lock = os.open(store / "install.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(lock).st_mode):
            raise ValueError("not a regular lock")
        fcntl.flock(lock, fcntl.LOCK_EX)
        dest = store / ("holyagent-" + VERSION)
        check_package(artifact, dest)
        # Pi's package has external peer imports. Resolve them from the same frozen
        # dependency tree as the Pi host, never from npm or the current worktree.
        keep_link(store / "node_modules", modules)
        # Pi's TypeScript loader resolves from the logical managed package path, not the link target.
        keep_link(pi.parent / "node_modules", modules)
        locations = {"holyagent": (VERSION, dest),
                     **{package: (version, modules / package) for package, version in FEATURES.items()}}
        packages = []
        for package, (version, location) in locations.items():
            # Use Pi's managed per-user npm layout so HolyAgent doctor recognizes the exact versions.
            # No package manager or package installation scripts are run on the guest.
            link = pi.parent / "npm/node_modules" / package
            private_dir(link.parent, home)
            keep_link(link, location)
            packages.append(f"npm:{package}@{version}")
        seed(pi, {"packages": packages, "defaultProvider": "kimi-coding", "defaultModel": "k3.1-pro",
                  "defaultThinkingLevel": "high", "codemode": {"mode": "only"}},
             lambda conf: isinstance(conf.get("packages"), list)
             and all(pkg in conf["packages"] for pkg in packages))
        # Seed only reviewed settings, never execute the upstream interactive installer.
        # No project trust, model credentials, provider grants or display/browser integration.
        for path, contents in (
            (pi.parent / "subagents.json", {"disableDefaultAgents": True, "fallbackSubagent": "none"}),
            (pi.parent / "pi-fff.json", {"mode": "override", "followSymlinks": False}),
            (home / ".config/billion-context/billion-context.json", {"pi": {"subagents": False}}),
            (home / ".holyagent/config.json", {"pi": {"features": {"computerUse": False, "browserUse": False}}}),
        ):
            private_dir(path.parent, home)
            def includes(obj, needed):
                return isinstance(obj, dict) and all(
                    includes(obj.get(k), v) if isinstance(v, dict) else obj.get(k) == v
                    for k, v in needed.items())
            seed(path, contents, lambda conf: includes(conf, contents))
        def provider_enabled(conf):
            providers = conf.get("providerInstances")
            provider = providers.get("pi") if isinstance(providers, dict) else None
            if not isinstance(provider, dict):
                return False
            config = provider.get("config", {})
            return (provider.get("driver") == "pi" and provider.get("enabled") is True
                    and isinstance(config, dict) and config.get("enabled") is not False)
        seed(t3, {"providerInstances": {"pi": {"driver": "pi", "enabled": True}}}, provider_enabled)
        print(f"HolyAgent {VERSION}: verified and registered for Pi/T3. No provider or service started.")
    finally:
        os.close(lock)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    try:
        stage(parser.parse_args().archive, Path.home())
    except (ValueError, OSError, KeyError, tarfile.TarError) as ex:
        raise SystemExit(str(ex))
