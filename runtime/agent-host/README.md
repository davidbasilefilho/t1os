# Build the optional agent host payload

Prepare on Linux x86_64 as a normal user. The operator supplies the official
[T3 Code 0.1.10 Linux x64 archive][release]. Its SHA-256 matches the upstream GitHub release API
digest and the release's `SHA256SUMS`; `prepare.ts` checks the pinned size and SHA-256 before
extracting. Do not substitute the npm `t3` launcher: it is not the native release and can fetch on
first invocation.

[release]: https://github.com/pingdotgg/t3code/releases/download/v0.1.10/t3-0.1.10-linux-x64.tar.gz

From the reviewed t1os checkout used to build the overlay:

```sh
mise exec -- bun apps/agent-host/src/cli.ts prepare \
  --t3-archive /path/to/t3-0.1.10-linux-x64.tar.gz \
  --output /path/to/artifacts/agent-tools
bun apps/agent-host/src/smoke.ts --tools /path/to/artifacts/agent-tools
```

The first command installs only the `@t1os/agent-host` workspace's production npm dependencies
from `bun.lock`, with lifecycle scripts disabled. Add `--offline` if Bun's package cache contains
all locked dependencies. It writes a new output directory and does not start a service.
The smoke uses separate Linux user and network namespaces and fails instead of using host networking.
It checks the pinned Pi/T3 versions and managed policy syntax. It starts the real T3 binary twice
in one disposable HOME, checks both listeners/HTTP responses, and verifies the operator settings
and an uncommitted worktree file survive restart. It does not pair a device or resume a live thread.

Pass that directory as `--agent-tools` alongside the pinned HolyAgent package to the overlay builder.
Transfer the built overlay and its trusted SHA-256 separately. The prepared tools themselves are
about 1 GB (33,029 files before the standalone t1os CLI and HolyAgent archive). Keep them out of Git.

The guest uses frozen Linux x64 releases of Node 24.22.3 and Bun 1.4.4 from this very bundle,
not an admin's mise installation or a system package manager. Exact executable SHA-256 digests
are checked at build time. The Pi wrapper disables automatic network fetches (Pi's offline switch);
this is not a firewall or an authorization to use a model. The production dependency graph
includes native Linux FFF plus the [pinned headless feature set](../agent/README.md).

To validate an extracted candidate, run `bin/t1os-guest-platform check-ready /absolute/release`
as the non-root operator. It builds a disposable clean HOME using the same registration routine as
the installed profile, with links to that candidate (not the active release). In a private network
namespace it checks exact versions, exercises a native FFF search on one synthetic file, and starts
real Pi RPC with the bundled HolyAgent and feature packs. It issues only `get_state` and
`get_commands` and checks the loaded commands/tools. It never sends a prompt or reads an operator's
real settings or credentials. Failure to isolate or a missing expected feature fails the gate.
