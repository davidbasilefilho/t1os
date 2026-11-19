#!/usr/bin/env bash
set -euo pipefail
runtime=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT

for script in "$runtime"/{install.sh,run-job,remote/check-tailscale,desktop/run-desktop,desktop/run-wayvnc,desktop/check-wayvnc-config}; do
  bash -n "$script"
done
"$runtime/install.sh" "$stage"
"$runtime/install.sh" "$stage"
[[ -f $stage/etc/systemd/system/t1os-ssh-tunnel.socket ]]
[[ -f $stage/etc/systemd/user/t1os-desktop.service ]]
expected_files=5
if [[ -f $runtime/agent/t1os-t3.service ]]; then
  cmp "$runtime/agent/t1os-t3.service" "$stage/etc/systemd/user/t1os-t3.service"
  for safe_setting in 'ConditionUser=t1os' 'Environment=T3CODE_HOST=127.0.0.1' \
    'Environment=T3CODE_PORT=3773' 'StandardOutput=null' 'StandardError=null'; do
    grep -Fx "$safe_setting" "$stage/etc/systemd/user/t1os-t3.service"
  done
  grep -E '^ExecStart=[^ ]+ serve --host 127\.0\.0\.1 --port 3773$' \
    "$stage/etc/systemd/user/t1os-t3.service"
  expected_files=6
fi
if [[ -f $runtime/agent/policy.json ]]; then
  cmp "$runtime/agent/policy.json" "$stage/etc/t3code/policy.json"
  expected_files=$((expected_files + 1))
fi
[[ $(find "$stage" -type f | wc -l) == "$expected_files" ]]
[[ -z $(find "$stage" -type l -print -quit) ]]
grep -Fx 'BindToDevice=tailscale0' "$stage/etc/systemd/system/t1os-ssh-tunnel.socket"
grep -Fx 'Environment=TS_SSH_DISABLE_FORWARDING=1' \
  "$stage/etc/systemd/system/tailscaled.service.d/10-no-ssh-forwarding.conf"

if command -v sshd >/dev/null && command -v ssh-keygen >/dev/null; then
  ssh-keygen -q -t ed25519 -N '' -f "$stage/host-key"
  sed "s%^HostKey .*%HostKey $stage/host-key%" \
    "$stage/etc/t1os/sshd_tunnel_config" > "$stage/test-sshd-config"
  if ! LC_ALL=C sshd -T -f "$stage/test-sshd-config" > "$stage/sshd-effective" 2> "$stage/sshd-error"; then
    if grep -Fq 'Missing privilege separation directory:' "$stage/sshd-error"; then
      echo 'OpenSSH effective configuration verification skipped; distro runtime directory is absent.'
    else
      cat "$stage/sshd-error" >&2
      exit 1
    fi
  else
    for setting in 'maxsessions 0' 'permitrootlogin no' 'allowtcpforwarding local' \
    'allowstreamlocalforwarding no' 'allowagentforwarding no' 'passwordauthentication no' \
    'allowusers t1os' 'permitopen 127.0.0.1:3773 127.0.0.1:5900'; do
      grep -Fx "$setting" "$stage/sshd-effective"
    done
  fi
else
  echo 'OpenSSH effective configuration verification skipped; sshd and ssh-keygen are required.'
fi

if (( EUID != 0 )); then
  mkdir -p "$stage/home/worktrees/project"
  digest=registry.example.invalid/fixture@sha256:$(printf '%064d' 0)
  expect_rejection() {
    local error=$1
    shift
    if HOME="$stage/home" "$runtime/run-job" "$@" > "$stage/job-result" 2>&1; then
      echo 'Expected job guard to reject the request' >&2
      return 1
    fi
    grep -F -- "$error" "$stage/job-result"
  }
  expect_rejection 'fully qualified image pinned by digest' "$stage/home/worktrees/project" 'test:latest' ro true
  expect_rejection 'workspace access must be ro or rw' "$stage/home/worktrees/project" "$digest" root true
  expect_rejection 'under ~/worktrees' "$stage/home" "$digest" ro true
  ln -s "$stage/home" "$stage/home/worktrees/outside"
  expect_rejection 'under ~/worktrees' "$stage/home/worktrees/outside" "$digest" ro true
fi

vnc="$stage/private-vnc"
mkdir -m 700 "$vnc"
# Stub TLS components are used only for configuration preflight, not authentication.
(umask 077; touch "$vnc/tls_key.pem" "$vnc/tls_cert.pem" "$vnc/wayvnc")
cat > "$vnc/wayvnc" <<'FIXTURE'
enable_auth=true
use_relative_paths=true
username=fixture
password=not-a-real-credential
private_key_file=tls_key.pem
certificate_file=tls_cert.pem
FIXTURE
vnc_check="$runtime/desktop/check-wayvnc-config"
"$vnc_check" "$vnc"
expect_vnc_rejection() {
  if "$vnc_check" "$vnc"; then
    echo 'Expected the VNC authentication config to be rejected' >&2
    return 1
  fi
}
chmod 644 "$vnc/tls_key.pem"
expect_vnc_rejection
chmod 600 "$vnc/tls_key.pem"
printf '%s\n' 'relax_encryption=true' >> "$vnc/wayvnc"
expect_vnc_rejection
sed -i '$d' "$vnc/wayvnc"
printf '%s\n' 'enable_auth=false' >> "$vnc/wayvnc"
expect_vnc_rejection
sed -i '$d' "$vnc/wayvnc"
printf '%s\n' 'enable_auth=true' >> "$vnc/wayvnc"
expect_vnc_rejection
