# Build the optional agent host payload

Prepare on Linux x86_64 as a normal user. The operator supplies the official
[T3 Code 0.1.10 Linux x64 archive][release]. Its SHA-256 matches the upstream GitHub release API
digest and the release's `SHA256SUMS`; `prepare.py` checks the pinned size and SHA-256 before
extracting. Do not substitute the npm `t3` launcher: it is not the native release and can fetch on
first invocation.

[release]: https://github.com/pingdotgg/t3code/releases/download/v0.1.10/t3-0.1.10-linux-x64.tar.gz

From the reviewed t1os checkout used to build the overlay:

```sh
mise exec -- python3 runtime/agent-host/prepare.py \
  --t3-archive /path/to/t3-0.1.10-linux-x64.tar.gz \
  --output /path/to/artifacts/agent-tools
python3 runtime/agent-host/smoke.py --tools /path/to/artifacts/agent-tools
```

The first command installs only the `@t1os/agent-host` workspace's production npm dependencies
from `bun.lock`, with lifecycle scripts disabled. Add `--offline` if Bun's package cache contains
all locked dependencies. It writes a new output directory and does not start a service.
The smoke test needs Linux user and network namespaces and fails rather than using host networking.
It validates the policy file's syntax, Pi and T3 Code versions, and T3 Code's loopback HTTP startup
using temporary home and state directories. It does not enable providers, enroll Tailscale, pair
a device, or make an external connection.

Pass the new directory as `--agent-tools /path/to/artifacts/agent-tools` to the overlay builder,
alongside the pinned HolyAgent package specified in the deployment instructions. Transfer the built
overlay and its trusted SHA-256 separately. The prepared tools add roughly 650 MiB to the bundle.
Keep them out of Git.

The guest's Pi entrypoint requires a trusted `/usr/bin/node` at version 22.19.0 or newer. The T3 Code
release includes its own native server and adjacent client assets, so it does not use npm or Bun at
runtime. Nothing installs or updates dependencies on first boot; upgrades replace the verified
bundle.
