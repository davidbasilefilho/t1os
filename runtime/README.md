# Runtime profiles

The default is console/CLI. The installer stages these files but starts no
listeners, enrolls no devices, generates no credentials, and enables no desktop.
Run changes from a guest console and keep that console open until the remote
checks pass. All remote work uses the dedicated non-admin `t1os` account.

## Tailnet access (manual, off by default)

1. On the guest console, confirm that no stock SSH daemon or desktop listener is
   publicly bound. Review the [Tailscale security bulletins](https://tailscale.com/security-bulletins#ts-2026-014)
   and use a reviewed stable Tailscale package at or above 1.104.4. Keep Serve,
   Funnel, subnet/exit-node advertising and agent forwarding off for this guest.
2. Merge `remote/tailnet-policy.example.hujson` into the tailnet policy with
   named operator identities. Eliminate overlapping broad grants and SSH rules
   to this tag, and test denial from a non-operator. The template alone cannot
   override other grants. Enroll manually; no tailnet credentials belong in the
   image. Enable built-in Tailscale SSH only for the `t1os` shell and require
   check mode. The staged tailscaled drop-in disables its forwarding; verify
   that the daemon was restarted with the drop-in before enabling its SSH.
3. After generating fresh machine SSH host keys on the installed guest, pin its
   Ed25519 host key fingerprint out of band. Install **only the dedicated
   operator's public key** in the root-owned, mode-0644
   `/etc/t1os/authorized_keys`. Use `sshd -t -f /etc/t1os/sshd_tunnel_config`
   on the guest, then enable `t1os-ssh-tunnel.socket`. It only accepts TCP on
   the kernel's `tailscale0` interface (IPv4, port 2222). Its OpenSSH instance
   has no shell/session, no reverse, agent, X11 or Unix-socket forwarding, and
   permits only the two named loopback targets. This is separate from Tailscale
   SSH port 22 (its authorized interactive shell is not restricted to those
   two targets) and deliberately cannot be enabled without the host key and
   operator public key.
4. Use `ssh t1os@GUEST` for the Tailscale SSH shell. To forward both local
   endpoints, use `ssh -NT -o ExitOnForwardFailure=yes -p 2222 -L 127.0.0.1:3773:127.0.0.1:3773 -L 127.0.0.1:5900:127.0.0.1:5900 t1os@GUEST_TAILNET_IPV4`.
   On the guest inspect `ss -lntp`: T3 and WayVNC must bind 127.0.0.1
   only. Verify shell/root access fails on 2222; unlisted forwarding targets
   fail when an actual connection is attempted; a client outside the tailnet
   cannot reach 22, 2222, 3773, or 5900 on the guest. Socket activation and
   live tailnet policy behavior require guest testing; no live enrollment was
   performed. For T3, confirm the expected service owns port 3773 before
   opening or pairing the client at the forwarded loopback address. Pair from a
   private interactive terminal; do not put pairing secrets in logs or files.
   Leave T3 Connect, LAN mode, and `t3 pair --tailscale` off; those features can
   create separate paths to a loopback listener. Restart with the pinned T3
   profile rather than activating its upstream background installer or updater.
   [T3 remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)
   explains the separate relay and LAN mechanisms. [OpenSSH options](https://man.openbsd.org/sshd_config)
   document the forwarding restrictions.

## Optional persistent virtual desktop (validation candidate)

Use a disposable guest first. This profile requires a supported render device or
virtual GPU; it does not imply CPU-only compositor support. Follow the
[Hyprland virtual GPU notes](https://wiki.hypr.land/configuring/extra/virtual-gpu/)
and confirm the actual output in `hyprctl monitors`. Hyprland's old wlroots
environment variables are not used. The matching Lua (0.55+) or Hyprlang
template is deliberately not installed as an active config. Choose the reviewed
template as `/etc/t1os/hyprland.lua` or `/etc/t1os/hyprland.conf`, never both.
Only the trusted operator desktop supports access to its state.

As `t1os`, create a private mode-0700 `~/.config/t1os` directory. Its mode-0600
`wayvnc` config accepts exactly the options `enable_auth=true`,
`use_relative_paths=true`, `private_key_file=tls_key.pem`,
`certificate_file=tls_cert.pem`, and unique `username` and `password` values.
Generate VeNCrypt TLS material locally and keep `tls_key.pem` mode-0600, following
[WayVNC authentication](https://github.com/any1/wayvnc#encryption--authentication).
Do not put credentials in source, shell history or logs, or enable plaintext
legacy fallback. Connect only via the SSH tunnel and verify the VNC certificate.
The launcher passes an explicit localhost endpoint independently of the config.

For a disposable compatibility test, capture `pacman -Q hyprland xorg-xwayland wayvnc`
in the root-owned `/etc/t1os/desktop-versions`. It must match installed versions
exactly or the desktop refuses to start. For the trusted host use that file
**only** after the same exact tuple passes the guest checks below. Enable
lingering with `loginctl enable-linger t1os`, then run
`systemctl --user daemon-reload` and `systemctl --user enable --now t1os-desktop.service`
as `t1os` with its user bus. The systemd user manager owns the compositor,
WayVNC and their lifecycle independently of SSH. Use
`journalctl --user -u t1os-desktop.service` for diagnostics. A WayVNC restart
does not relaunch Hyprland. A compositor restart creates a _new_ session; only
state written to disk persists. The profile never starts without explicit opt-in.

Record the full guest versions and renderer, then confirm startup without a
physical display, a native and an XWayland fixture, screenshot, mouse and
keyboard input, accessibility tree through the actual CUA backend, disconnect/
reconnect over SSH, WayVNC failure/restart, and compositor restart. If a check
fails, leave CUA disabled and use CLI/Playwright where applicable. The verified
version matrix is currently **empty**; desktop CUA is not installed or exposed.
For untrusted GUI workloads, use a separate guest with fresh state, no host home,
shared mounts, display/input sockets, Podman socket, provider credentials,
SSH agent or operator browser profile. Do not use the operator desktop as a
sandbox. Disable guest networking unless deliberately confined to an authorized
fixture.

## Rootless CLI jobs

Run `runtime/run-job WORKSPACE IMAGE@sha256:DIGEST ro|rw COMMAND [ARG...]`
as `t1os` after staging a reviewed image by digest into rootless Podman storage.
The wrapper never pulls an image or attaches a network. It mounts only the
operator-owned subdirectory under `~/worktrees`, non-recursively, read-only
unless explicitly requested, and does not mount credentials or runtime sockets.
Keep secrets (including hidden dotenv files) out of the selected worktree.
Limits include a read-only root filesystem, tmpfs writes, memory, pids, CPU,
and a 30-minute conmon deadline. Use a clean tree and reviewed image on a
cgroup-v2 host; this is defense in depth, not VM isolation. Actual container
execution and resource enforcement require a guest smoke test.
[Podman run reference](https://docs.podman.io/en/stable/markdown/podman-run.1.html).

## Browser fixture and local checks

`runtime/tests/runtime-config.sh` checks idempotent staging, guard failures and
the effective OpenSSH restrictions when OpenSSH is available. It does not
activate systemd services.

`python3 runtime/browser/local-smoke.py WORKSPACE_ID` exercises
[Playwright Chromium](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)
screenshot, input, ARIA and reconnect using its own static loopback fixture,
a mode-0700 persistent profile per workspace, and Chromium sandboxing. Use a
reviewed pinned Playwright release with its matching Chromium build. The CLI
takes no target URLs and never imports a personal browser session. Run on a
network-disabled guest with loopback enabled; the page route is not a network
sandbox. The host cloud sandbox blocks Chromium's required socket operation,
so this fixture was not verified end-to-end here. Browser DOM input/ARIA does
not verify OS-level CUA.
