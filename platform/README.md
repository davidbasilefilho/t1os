# Install and recover

t1os is an overlay, not a custom ISO. The only automated disk-writing entry point is the disposable QEMU harness. It cannot accept an existing disk image or raw device. The runtime overlay itself does not partition, format or write a bootloader.

## Stock Omarchy 4.5.0 x86_64

The harness follows the [Omarchy unattended installation contract](https://omarchy.org/manual/unattended-installs/) and the [x86 stock configurator schema](https://github.com/omacom/omarchy-iso/blob/d5136a69782c00fe8d53fc98e4f3a990447d4840/configs/airootfs/root/configurator). The pinned upstream ISO is [omarchy-4.5.0-x86.iso](https://iso.omarchy.org/omarchy-4.5.0-x86.iso); fetch its [detached signature](https://iso.omarchy.org/omarchy-4.5.0-x86.iso.sig) and the [full-fingerprint release public key](https://keys.openpgp.org/vks/v1/by-fingerprint/40DFB630FF42BCFFB047046CF0134EE680CAC571). Every real run requires both a matching pinned SHA-256 and signature. The [upstream signing and archive documentation](https://github.com/omacom/omarchy-iso#verifying-the-iso) explains provenance. No network access is given to the guest by the harness.

Run as a regular user with Python 3.11+, OpenSSL, GnuPG, QEMU x86, OVMF (non-Secure-Boot code and paired variables) and `genisoimage`. Set `TMPDIR` to a private writable directory on a filesystem with sufficient disk space for the populated guest. Use a short absolute path; Unix socket names are length-limited.

```bash
# Print the exact Omarchy configuration without reading inputs or creating files.
./platform/omarchy-vm.py --iso omarchy-4.5.0-x86.iso --signature omarchy-4.5.0-x86.iso.sig \
  --public-key omarchy-key.asc --ovmf-code /path/to/OVMF_CODE.fd --ovmf-vars /path/to/OVMF_VARS.fd

# To execute the same command, append:
# --apply --confirm ERASE-NEW-DISPOSABLE-VM-DISK
# Add --accel tcg when /dev/kvm is unavailable (substantially slower).
```

The drive is an unencrypted disposable image. The printed directory holds a temporary console password for `vmadmin`; only its salted hash is included in `cidata`. Keep the directory private. It is removed when the harness exits. There are no SSH keys, provider tokens or Tailscale enrollment keys. Inspect the printed local Unix VNC socket with a compatible viewer. The installer phase exits on reboot, and the harness then starts a separate VM boot using the same UEFI vars and disk, without installation media. A reboot or QEMU exit alone is not proof of successful installation. For restricted cloud runners, append `--probe-output /path/to/new.ppm --probe-seconds 90` to capture one framebuffer through a stdio pipe instead of using Unix sockets. This deliberately stops after the frame and does not assert an installation or second boot.

## Provision from the installed VM console

The upstream `cidata` reader supports a fixed list of installer files, not arbitrary t1os hooks. That separation is deliberate: the stock installer establishes the known base, and the overlay first-boot service performs t1os changes after the trusted bundle is supplied. No background process downloads or runs scripts.

1. From a trusted t1os checkout, optionally compile the CLI with `bun build --compile apps/cli/src/cli.ts --outfile artifacts/t1os`. On an existing directory, use `./platform/build-bundle.py --commit FULL_GIT_COMMIT --cli artifacts/t1os --output artifacts/t1os.tar`. The CLI binary is optional. The bundle format is a plain tar, not ZIP or a compressed archive. Add `--holyagent /path/to/holyagent-0.3.3.tgz` for the agent profile; the bundle builder verifies its exact pinned registry SHA-512. Add `--agent-tools /path/to/prepared/agent-host` for the separately prepared Pi/T3 binaries and dependencies. A complete agent profile needs the HolyAgent archive and prepared agent tools. The archive contains committed platform and runtime sources plus explicitly supplied verified inputs. Send the printed SHA-256 to the operator separately from the archive.
2. Provide the trusted `provision.py` (from the same commit) and tar as read-only optical media on **second boot only**: a supplemental ISO created with `genisoimage -o t1os-overlay.iso -V T1OSOVERLAY DIRECTORY` can be passed to the harness with `--overlay-iso`. Mount it read-only at the VM console. Verify provenance of `provision.py` before running it; the argument pin verifies the **bundle**, not the provisioner.
3. As `vmadmin` on a local kernel console (for instance `Ctrl+Alt+F2` in the VM), run `sudo python3 /mnt/overlay/provision.py --bundle /mnt/overlay/t1os.tar --sha256 TRUSTED_SHA256`. This is dry-run. Repeat with `--apply` to stage and apply.
4. Inspect `systemctl status t1os-first-boot.service`, `journalctl -u t1os-first-boot.service`, and `systemctl get-default`. Reboot, confirm the multi-user target and no stock SSH/SDDM listener, and verify `t1os --help` if bundled. Optional remote and graphical units remain disabled; see the runtime guide before testing them. The `t1os` operator has a locked local password, no supplementary groups, and no baked authorized keys. Admin can access it locally with `sudo -u t1os -H bash` for setup.

Reapply the same bundle to retry; there is no second payload installation under the same digest. An unsuccessful apply is visible in the service result/journal. The first-boot unit re-runs on the next boot. If the new overlay still fails, use the console or rescue boot and run the trusted provisioner with `--rollback --apply` to select the preceding staged digest. Local workspaces, operator data, and keys are untouched by rollback; CLI-only boot and the stock SSH shutdown are not undone. No running sessions, in-memory work or agent state are reconstructed. Restart optional t1os units explicitly if an active unit needs to reload binaries or configuration.

Hardware and GPU/remote desktop compatibility require a separate readiness pass. Do not use the VM media as a hardware installer.
