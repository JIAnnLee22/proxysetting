#!/usr/bin/env bash
set -euo pipefail
ROOT=/opt/proxysetting
if [[ $(id -u) != 0 ]]; then ROOT="${HOME:?HOME is required}/.local/share/proxysetting"; fi
if [[ ${1:-} == --root && $# == 2 ]]; then ROOT=$2; elif (($#)); then printf 'Usage: check.sh [--root ROOT]\n' >&2; exit 2; fi
MODE=$(awk -F= '$1=="SERVICE_MODE" {n++; mode=$2} END {if(n==0) print "systemd"; else if(n==1) print mode}' "$ROOT/config/release.env")
if [[ $MODE == standalone ]]; then
    "$ROOT/current/bin/proxysetting-agent" status --root "$ROOT"
elif [[ $MODE == systemd ]]; then
    systemctl is-active --quiet proxysetting-agent.service
    systemctl is-active --quiet proxysetting-xray.service
    "$ROOT/current/bin/proxysetting-agent" check --root "$ROOT"
    printf '\nService status:\n'
    systemctl --no-pager status proxysetting-agent.service proxysetting-xray.service
else
    printf 'Invalid installed service mode\n' >&2; exit 1
fi
if command -v ss >/dev/null; then
    printf '\nLocal API listener (must be loopback 127.0.0.1:10085):\n'
    ss -ltn 'sport = :10085'
fi
printf '\nFirewall rules were not changed. Verify host firewall AND cloud security group permit the configured Reality TCP port.\n'
