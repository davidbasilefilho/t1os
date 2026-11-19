# t1os

t1os turns a pinned **Omarchy 4.5.0 x86-64** installation into a CLI-first workspace for HolyAgent in **T3 Code with the Pi provider**. It is a provisioning overlay, not an Arch fork or a custom installer ISO. The stock installer runs in a disposable VM; a separate offline appliance stages the reviewed overlay, and the installed guest applies it without console input. A manual console recovery path is also available.

## Try it without installing an OS

Install the versioned development tools as described in [development](docs/development.md). From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run verify
bun run t1os --help
bun run t1os capture "$PWD"
bun run t1os list
bun run t1os show <checkpoint-id>
```

A capture is an integrity-checked reference to a local worktree, its current Git commit (if available) and the presence of HolyAgent and T3 state directories. No file contents, credentials or process memory enter it. Matching observations produce the same identifier; changed observations leave earlier records intact. The CLI never resets or cleans the worktree. This is not a backup: keep normal backups of your work and T3/Pi data.

## Build and operate a guest

1. **[Install the base and overlay](platform/README.md).** Start with the dry run. The disk-writing harness accepts no host disk or existing image. An actual run creates a fresh VM disk, verifies the stock ISO digest and signature, and requires explicit confirmation. The configuration drive is for the stock installer, not cloud-init.
2. **[Prepare the agent profile](runtime/agent/README.md).** Use the pinned T3, Pi, Bun and Node runtimes, the locked headless feature packages and the verified HolyAgent artifact in the full bundle. The candidate must answer a credential-free Pi RPC readiness probe before it is promoted. The core-only bundle intentionally contains no agent software. First boot creates a separate non-admin operator; publishing a repository or starting CI does not install an OS, start a provider or enroll a tailnet.
3. **[Enable private access if needed](runtime/README.md).** T3 uses loopback. Tailscale SSH grants the operator shell; an independently restricted OpenSSH tunnel forwards only T3/WayVNC. Neither is enabled by default. No pairing secrets or keys are part of the build.
4. **[Run isolated jobs and validate optional graphics](runtime/README.md#rootless-cli-jobs).** CLI jobs use rootless Podman with an explicit worktree mount, digest-pinned local image, disabled network and resource limits. The operator desktop is not an isolation boundary. Use a fresh guest for untrusted GUI workloads, without host credentials, shared mounts, display/input sockets or browser profiles.

After installing the full guest, `t1os android --help` lists the [optional local Android emulator and Device Hub setup](runtime/android/README.md). The base installer does not download an SDK, accept a license, enable agent control or start an emulator.

The normal boot target does not launch Hyprland. Persistent virtual Hyprland/XWayland and loopback WayVNC are opt-in candidates; no CUA version tuple is certified. Prefer the local browser fixture to desktop automation for web UI work. Recovery preserves durable files and reconnects the operator to services, **not** the memory or in-flight actions of a process that died.

## Repository map

| Path              | Responsibility                                                                |
| ----------------- | ----------------------------------------------------------------------------- |
| `apps/cli`        | Bun command-line interface                                                    |
| `apps/agent-host` | Frozen Pi host dependency set                                                 |
| `packages/core`   | Effect-based durable checkpoint operations                                    |
| `platform`        | Pinned ISO, disposable QEMU harness, verified overlay and first-boot recovery |
| `runtime`         | Private agent, remote access, job and optional desktop profiles               |

See [validation](docs/validation.md) for the distinction between tested behavior and guest-only acceptance checks.
