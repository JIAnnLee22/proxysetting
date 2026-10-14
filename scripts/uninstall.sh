#!/usr/bin/env bash
# Proxysetting uninstallation script; use the same account as the installation.
set +x
set -Eeuo pipefail
umask 077

readonly AGENT_UNIT='proxysetting-agent.service'
readonly XRAY_UNIT='proxysetting-xray.service'
OWNER_UID=$(id -u)
ROOT='/opt/proxysetting'
if [[ $OWNER_UID != 0 ]]; then
    [[ -n ${HOME:-} ]] || { printf 'proxysetting uninstall: HOME is required\n' >&2; exit 1; }
    ROOT="$HOME/.local/share/proxysetting"
fi
KEEP_DATA=0 FORCE=0
say() { printf '%s\n' "$*"; }
die() { printf 'proxysetting uninstall: %s\n' "$*" >&2; exit 1; }
usage() {
    say 'Usage: uninstall.sh [--root DIR] [--keep-data] [--force]'
    say 'Default root: /opt/proxysetting for root; ~/.local/share/proxysetting otherwise.'
    say '--keep-data preserves config/state. --force permits absent systemd on a system installation; it never bypasses standalone shutdown.'
}
while (($#)); do
    case "$1" in
        --root)
            if (($# < 2)) || [[ -z $2 || $2 == --* ]]; then die 'missing root path'; fi
            ROOT=$2; shift 2 ;;
        --keep-data) KEEP_DATA=1; shift ;;
        --force|-f) FORCE=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) die 'unknown option (see --help)' ;;
    esac
done
for cmd in realpath stat rm flock awk; do
    command -v "$cmd" >/dev/null || die "missing prerequisite: $cmd (install it manually)"
done
[[ $ROOT =~ ^/[A-Za-z0-9_./-]+$ && $ROOT != / && $ROOT != */ && $ROOT != *//* && $ROOT != */../* && $ROOT != */.. && $ROOT != */./* && $ROOT != */. ]] || die 'root must be a safe absolute path without dot segments or trailing slash'
[[ $(realpath -m -- "$ROOT") == "$ROOT" ]] || die 'root or its parent must not be a symlink'
for sysdir in / /bin /boot /dev /etc /home /lib /lib64 /media /mnt /opt /proc /root /run /sbin /srv /sys /tmp /usr /var "${HOME:-/}"; do
    [[ $ROOT != "$sysdir" ]] || die "refusing to remove protected directory: $ROOT"
done
cd /
[[ -e $ROOT ]] || { say 'Installation directory does not exist.'; exit 0; }
[[ -d $ROOT && $(stat -c %u "$ROOT") == "$OWNER_UID" ]] || die 'installation directory belongs to another user'
[[ ! -L $ROOT/config && ! -L $ROOT/state && ! -L $ROOT/.install.lock ]] || die 'unsafe managed directory or lock'
exec 9>"$ROOT/.install.lock"
flock -n 9 || die 'another installation or maintenance operation is in progress'
SERVICE_MODE=systemd
if [[ -e $ROOT/config/release.env || -L $ROOT/config/release.env ]]; then
    [[ -f $ROOT/config/release.env && ! -L $ROOT/config/release.env && $(stat -c %u "$ROOT/config/release.env") == "$OWNER_UID" ]] || die 'unsafe release metadata'
    SERVICE_MODE=$(awk -F= '$1=="SERVICE_MODE" {n++; mode=$2} END {if(n==0) print "systemd"; else if(n==1) print mode}' "$ROOT/config/release.env")
fi
[[ $SERVICE_MODE == standalone || $SERVICE_MODE == systemd ]] || die 'invalid installed service mode'
has_systemd=0
if [[ $SERVICE_MODE == standalone ]]; then
    if [[ -x $ROOT/current/bin/proxysetting-agent ]]; then
        "$ROOT/current/bin/proxysetting-agent" stop --root "$ROOT" || die 'cannot confirm standalone service shutdown; files retained'
    elif [[ -e $ROOT/state/supervisor.json ]]; then
        die 'supervisor metadata exists but agent binary is missing; restore binary and stop service first'
    fi
else
    [[ $OWNER_UID == 0 ]] || die 'systemd installation must be uninstalled by root'
    if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] && systemctl show --property=Version --value >/dev/null 2>&1; then
        has_systemd=1
    elif (( ! FORCE )); then
        die 'systemd manager unavailable; stop services manually before using --force'
    fi
    if (( has_systemd )); then
        # Final sample must finish while Xray API is alive.
        systemctl stop "$AGENT_UNIT" || systemctl kill --kill-whom=all --signal=KILL "$AGENT_UNIT"
        systemctl stop "$XRAY_UNIT" || systemctl kill --kill-whom=all --signal=KILL "$XRAY_UNIT"
        systemctl stop proxysetting-upgrade.service >/dev/null 2>&1 || true
        systemctl disable "$AGENT_UNIT" "$XRAY_UNIT" >/dev/null 2>&1 || true
    fi
    for unit in "$AGENT_UNIT" "$XRAY_UNIT"; do
        rm -f -- "/etc/systemd/system/$unit"
    done
    if (( has_systemd )); then
        systemctl daemon-reload
        systemctl reset-failed "$AGENT_UNIT" "$XRAY_UNIT" >/dev/null 2>&1 || true
    fi
fi
if (( KEEP_DATA )); then
    rm -rf -- "$ROOT/current" "$ROOT/previous" "$ROOT/releases" "$ROOT"/.installer.*
    say "Binaries removed; config/state preserved under $ROOT. Keep billing state for reinstallation."
else
    rm -rf -- "$ROOT"
    say "Removed $ROOT"
fi
say 'proxysetting uninstallation complete.'
