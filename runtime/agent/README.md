# HolyAgent on the operator account

Use **T3 Code + Pi**. Do not substitute standalone Pi or Claude Code as the user interface. This profile does not sign in to a model provider, grant Full access, enable CUA, publish software or enroll Tailscale.

## Pinned inputs

- **HolyAgent 0.3.3:** fetch the [published npm tarball](https://registry.npmjs.org/holyagent/-/holyagent-0.3.3.tgz). The matching [source tag](https://github.com/davidbasilefilho/holyagent/tree/holyagent-0.3.3) and [registry metadata](https://registry.npmjs.org/holyagent/0.3.3) document its provenance. The overlay verifies the pinned SHA-512 before extracting. **There is no npm `bin` in this release.** The archive does contain `scripts/holyagent`, its Bun-backed wrapper; do not rely on an invented npm global executable.
- **Pi 1.5.0:** use the frozen `apps/agent-host` dependencies. Its verified Linux x64 Node 24.22.3 and Bun 1.4.4 executables are in the same bundle. The service uses these, independently of your interactive PATH.
- **T3 Code 0.1.10:** use the verified native Linux x64 archive, not an npm shim that fetches a runtime on first use. Use the build instructions in [agent host tools](../agent-host/README.md). Never put credentials, a live HOME or a paired T3 state directory into an image.

Pass both the prepared tools tree (`--agent-tools`) and the HolyAgent archive (`--holyagent`) to the [overlay builder](../../platform/README.md). The latter is a build input, not vendored in Git. The builder compiles the t1os CLI unless `--cli` supplies one. A full profile requires all its inputs. See the [installer](../../platform/README.md) for profile selection and service lifecycle.

See the [default Android Device Hub capability](../android/README.md) for manual preview and separately authorized Pi use.

## Headless capabilities

The curated profile carries the [upstream HolyAgent 0.3.3 pins](https://github.com/davidbasilefilho/holyagent/blob/holyagent-0.3.3/packages/runtime/src/config/pi-packages.json): Kimi's provider extension (no login), Pi subagents, Billion Context, todo, ask, background processes and native FFF. It does not run upstream interactive setup or postinstall scripts, sign in to a provider, or enable upstream storage cleanup. HolyAgent gets no automatic browser/desktop control grant; the [local browser fixture](../README.md#browser-fixture-and-local-checks) is available to the operator, not a native desktop CUA backend; pairing, machine trust and credentials are not build inputs.

As the non-admin operator, first boot registers the verified extension graph and Pi driver without overwriting conflicting settings. The freshly generated Pi settings select HolyAgent's default Kimi root route and codemode; they do not grant model access or force a T3 thread's model selection. Only HolyAgent specialists are enabled in the subagent package. Dedicated FFF searches do not follow links beyond the chosen worktree. A conflicting existing installation is preserved and reported instead of being replaced.

The candidate readiness gate starts Pi in RPC mode using the authentic packages. Its isolated HOME contains no logins; a successful check establishes that local tools load, not that a provider accepts a token or that T3 completed a model turn. The bundled HolyAgent CLI is at `~/.local/share/t1os/agent/holyagent-0.3.3/scripts/holyagent`; use the bundled `agent-host/bin` on PATH when running it outside the managed service.

## Private T3 service

Use the installed service rather than T3's upstream installer or updater. It binds 127.0.0.1:3773 and does not add a tailnet route. Use an SSH local forward as described in [remote access](../README.md). Verify the actual listener with `ss -lntp` and use the installed T3 binary's local pairing flow on the guest console. Never put pairing links, bearer tokens, provider keys, or passwords into logs. The unit discards application output because T3 can print pairing credentials; use `systemctl --user status t1os-t3` and the unit journal for lifecycle and exit status. The root-owned managed policy explicitly disables T3 Connect (an outbound relay), telemetry, browser cookie import, webhooks and automatic updates, and limits drivers to Pi. The pinned T3 binary accepted this policy. If the existing machine policy differs, provisioning stops rather than overwriting it. Do not enable hosted pairing, LAN binds, Serve or Funnel.

Use T3's Pi provider only in a trusted workspace. Its agent access does not become sandboxed simply because rootless Podman is available for individual CLI jobs. Security-sensitive and untrusted work belongs in a separate disposable guest. To stop remote access, disable the optional units, and revoke relevant pairings/keys using the operator's console. Do not erase T3 userdata, Pi state, worktrees or work-in-progress.
