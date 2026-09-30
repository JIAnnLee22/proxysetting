#!/usr/bin/env bash
set -euo pipefail
ROOT=/opt/proxysetting
if [[ ${1:-} == --root && $# == 2 ]]; then ROOT=$2; elif (($#)); then printf 'Usage: check.sh [--root ROOT]\n' >&2; exit 2; fi
systemctl is-active --quiet proxysetting-agent.service
systemctl is-active --quiet proxysetting-xray.service
"$ROOT/current/bin/proxysetting-agent" check --root "$ROOT"
printf '\nLocal API listener (must be loopback 127.0.0.1:10085):\n'
ss -ltn 'sport = :10085'
printf '\nService status:\n'
systemctl --no-pager status proxysetting-agent.service proxysetting-xray.service
printf '\nFirewall rules were not changed. Verify host firewall AND cloud security group permit the configured Reality TCP port.\n'
