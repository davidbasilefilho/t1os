#!/usr/bin/env python3
"""Smoke-test staged Pi and T3 Code with disposable state and no external networking."""

import argparse
import fcntl
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen

PI = "pi-deps/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
T3 = "t3-release/t3"
POLICY = """{
  "schemaVersion": 1,
  "organization": "t1os",
  "limits": {
    "connect": false,
    "telemetry": false,
    "browserCookieImport": false,
    "webhookTasks": false,
    "providers": { "allowedDrivers": ["pi"] },
    "updates": { "mode": "off" }
  }
}
"""


def loopback():
    """Raise only lo inside the already-created network namespace."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as interface:
        request = struct.pack("16sH14x", b"lo", 0)
        flags = struct.unpack("16sH14x", fcntl.ioctl(interface, 0x8913, request))[1]
        fcntl.ioctl(interface, 0x8914, struct.pack("16sH14x", b"lo", flags | 1))


def check_output(arguments, home):
    """Inspect local CLI results with no inherited environment or credentials."""
    return subprocess.check_output(
        arguments, cwd=home, stdin=subprocess.DEVNULL, text=True, timeout=15,
        env={"HOME": str(home), "PATH": "/usr/bin:/bin", "CI": "1", "TERM": "dumb"},
    )


def smoke(ready, node):
    """Validate staged versions, managed policy syntax, and loopback-only web startup."""
    loopback()
    with tempfile.TemporaryDirectory(prefix="t1os-agent-smoke-") as state:
        home = Path(state)
        policy = home / "policy.json"
        policy.write_text(POLICY)
        t3 = ready / T3
        if check_output([node, ready / PI, "--version"], home).strip() != "1.5.0":
            raise ValueError("wrong staged Pi version")
        if check_output([t3, "--version"], home).strip() != "t3 v0.1.10":
            raise ValueError("wrong staged T3 Code version")
        if '"connect": false' not in check_output([t3, "policy", "check", policy], home):
            raise ValueError("pinned T3 does not accept the managed policy")
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as selector:
            selector.bind(("127.0.0.1", 0))
            address, port = selector.getsockname()
        cmd = [t3, "serve", "--mode", "desktop", "--host", address, "--port", str(port),
               "--base-dir", home / "data", "--no-browser", home]
        # Startup output is deliberately discarded: do not display or preserve a bootstrap credential.
        with subprocess.Popen(cmd, cwd=home, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, env={"HOME": state, "PATH": "/usr/bin:/bin",
                                                              "CI": "1", "TERM": "dumb"}) as server:
            try:
                for _ in range(80):
                    if server.poll() is not None:
                        raise ValueError("T3 exited before starting its loopback server")
                    try:
                        with urlopen(f"http://127.0.0.1:{port}/", timeout=1) as response:
                            if response.status == 200 and response.read(4096):
                                break
                    except URLError:
                        time.sleep(0.25)
                else:
                    raise ValueError("T3 did not respond in the isolated namespace")
                addresses = set()
                for protocol in ("tcp", "tcp6"):
                    with Path(f"/proc/net/{protocol}").open() as table:
                        next(table)
                        for line in table:
                            _, local, _, state, *_ = line.split()
                            if state == "0A" and local.endswith(f":{port:04X}"):
                                addresses.add(local)
                if addresses != {f"0100007F:{port:04X}"}:
                    raise ValueError("T3 was not bound exclusively to 127.0.0.1")
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
    print("Pi 1.5.0 and T3 Code 0.1.10: versions, policy syntax and isolated loopback HTTP passed")


def main():
    """Require an isolated Linux namespace; never fall back to host networking."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tools", type=Path, required=True)
    parser.add_argument("--node", type=Path, default=Path("/usr/bin/node"))
    args = parser.parse_args()
    inherited = os.environ.get("T1OS_SMOKE_PARENT_NET")
    if not inherited:
        if os.geteuid() == 0:
            raise ValueError("run the isolated smoke test as a normal user")
        parent_net = os.readlink("/proc/self/ns/net")
        command = [
            "unshare", "--user", "--map-root-user", "--net", "--",
            sys.executable, Path(__file__).resolve(), "--tools", args.tools.absolute(),
            "--node", args.node.absolute(),
        ]
        subprocess.run(command, env={"T1OS_SMOKE_PARENT_NET": parent_net, "PATH": "/usr/bin:/bin"},
                       check=True)
        return
    uid_map = Path("/proc/self/uid_map").read_text().split()
    interfaces = {
        line.split(":", 1)[0].strip()
        for line in Path("/proc/net/dev").read_text().splitlines()[2:]
    }
    if (inherited == os.readlink("/proc/self/ns/net") or os.geteuid() != 0
            or len(uid_map) != 3 or uid_map[0] != "0" or uid_map[1] == "0"
            or uid_map[2] != "1" or interfaces != {"lo"}):
        raise ValueError("smoke test requires a separate Linux user and network namespace")
    smoke(args.tools, args.node)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise SystemExit(f"t1os agent smoke: {error}") from error
