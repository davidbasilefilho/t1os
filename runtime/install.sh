#!/usr/bin/env bash
set -euo pipefail
(( $# == 1 )) || { echo "usage: $0 ABSOLUTE_TARGET_ROOT" >&2; exit 2; }
[[ $1 == /* && -d $1 ]] || { echo 'provide an existing absolute target root' >&2; exit 2; }
root=$(realpath -e -- "$1")
runtime=$(dirname "$(realpath -e -- "$0")")
unitdir="${root%/}/etc/systemd/system"
confdir="${root%/}/etc/t1os"
usrunitdir="${root%/}/etc/systemd/user"
# All units remain disabled; installation does not touch operator state, create keys or enroll Tailscale.
install -d -m 0755 "$unitdir" "$usrunitdir" "$confdir" "$unitdir/tailscaled.service.d"
install -m 0644 "$runtime"/remote/t1os-ssh-tunnel{.socket,@.service} "$unitdir"
install -m 0644 "$runtime/remote/sshd_config" "$confdir/sshd_tunnel_config"
install -m 0644 "$runtime/remote/10-no-ssh-forwarding.conf" "$unitdir/tailscaled.service.d/"
install -m 0644 "$runtime/desktop/t1os-desktop.service" "$usrunitdir"
if [[ -f $runtime/agent/t1os-t3.service ]]; then
  install -m 0644 "$runtime/agent/t1os-t3.service" "$usrunitdir"
fi
# T3 Connect is an outbound path even on loopback. Never replace independent machine policy.
if [[ -f $runtime/agent/policy.json ]]; then
  policydir="${root%/}/etc/t3code"
  [[ ! -L $policydir ]] || { echo 'refusing a symlinked T3 policy directory' >&2; exit 1; }
  install -d -m 0755 "$policydir"
  policy="$policydir/policy.json"
  if [[ -e $policy || -L $policy ]]; then
    [[ ! -L $policy && -f $policy ]] && cmp -s "$policy" "$runtime/agent/policy.json" ||
      { echo 'existing T3 policy differs; review it on the console before proceeding' >&2; exit 1; }
  else
    install -m 0644 "$runtime/agent/policy.json" "$policy"
  fi
fi
