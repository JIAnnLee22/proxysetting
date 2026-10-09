#!/usr/bin/env bash
# Proxysetting uninstallation script.
set +x
set -Eeuo pipefail
umask 077

readonly AGENT_UNIT='proxysetting-agent.service'
readonly XRAY_UNIT='proxysetting-xray.service'
ROOT='/opt/proxysetting'
KEEP_DATA=0
FORCE=0

say() { printf '%s\n' "$*"; }
die() { printf 'proxysetting uninstall: %s\n' "$*" >&2; exit 1; }
warn() { printf 'proxysetting uninstall: warning: %s\n' "$*" >&2; }

usage() {
    say 'Usage: uninstall.sh [--root DIR] [--keep-data] [--force]'
    say '  --root DIR     Installation root directory (default: /opt/proxysetting)'
    say '  --keep-data    Keep config and state directories (removes binaries/units only)'
    say '  --force, -f    Force uninstallation without failing on missing items'
    say '  --help, -h     Show this message'
}

while (($#)); do
    case "$1" in
        --root)
            if (($# < 2)) || [[ -z $2 || $2 == --* ]]; then die 'missing root path'; fi
            ROOT=$2; shift 2 ;;
        --keep-data)
            KEEP_DATA=1; shift ;;
        --force|-f)
            FORCE=1; shift ;;
        --help|-h)
            usage; exit 0 ;;
        *)
            die "unknown option: $1 (see --help)" ;;
    esac
done

[[ $(id -u) == 0 ]] || die 'root is required'

# Ensure root path is absolute, normalized and not a sensitive system directory
[[ $ROOT =~ ^/[A-Za-z0-9_./-]+$ && $ROOT != / && $ROOT != */ && $ROOT != *//* && $ROOT != */../* && $ROOT != */.. && $ROOT != */./* && $ROOT != */. ]] || die 'root must be a safe absolute path without dot segments or trailing slash'
[[ $(realpath -m -- "$ROOT") == "$ROOT" ]] || die 'root or its parent must not be a symlink'

for sysdir in / /bin /boot /dev /etc /home /lib /lib64 /media /mnt /opt /proc /root /run /sbin /srv /sys /tmp /usr /var; do
    [[ $ROOT != "$sysdir" ]] || die "refusing to remove protected system directory: $ROOT"
done

for cmd in systemctl realpath stat rm flock; do
    command -v "$cmd" >/dev/null || die "missing prerequisite: $cmd (install it manually)"
done

# Ensure current working directory is outside ROOT to avoid busy directory locks
cd /

# Inspect systemd availability
has_systemd=0
if [[ -d /run/systemd/system ]] && systemctl show --property=Version --value >/dev/null 2>&1; then
    has_systemd=1
elif (( ! FORCE )); then
    die 'systemd is required'
else
    warn 'systemd is unavailable; proceeding with file removal only'
fi

# Serialize with any ongoing install/upgrade transaction if root exists
if [[ -d $ROOT && -f $ROOT/.install.lock ]]; then
    exec 9>"$ROOT/.install.lock"
    flock -n 9 || die 'another installation or maintenance operation is in progress'
fi

# Stop and disable systemd units
if (( has_systemd )); then
    # Stop agent first so it can perform final sampling while Xray is alive
    if systemctl is-active --quiet "$AGENT_UNIT" 2>/dev/null; then
        say "Stopping $AGENT_UNIT..."
        systemctl stop "$AGENT_UNIT" >/dev/null 2>&1 || true
    fi

    if systemctl is-active --quiet "$XRAY_UNIT" 2>/dev/null; then
        say "Stopping $XRAY_UNIT..."
        systemctl stop "$XRAY_UNIT" >/dev/null 2>&1 || true
    fi

    # Forcibly kill any remaining processes if services failed to stop cleanly
    for unit in "$AGENT_UNIT" "$XRAY_UNIT"; do
        if systemctl is-active --quiet "$unit" 2>/dev/null; then
            warn "Forcibly killing lingering processes for $unit..."
            systemctl kill --kill-whom=all --signal=KILL "$unit" >/dev/null 2>&1 || true
            systemctl stop "$unit" >/dev/null 2>&1 || true
        fi
    done

    # Stop any transient upgrade units
    systemctl stop 'proxysetting-upgrade-*' >/dev/null 2>&1 || true

    # Disable units
    systemctl disable "$AGENT_UNIT" >/dev/null 2>&1 || true
    systemctl disable "$XRAY_UNIT" >/dev/null 2>&1 || true
fi

# Remove unit files from systemd directory
for unit in "$AGENT_UNIT" "$XRAY_UNIT"; do
    unit_path="/etc/systemd/system/$unit"
    if [[ -e $unit_path || -L $unit_path ]]; then
        rm -f -- "$unit_path"
        say "Removed $unit_path"
    fi
done

if (( has_systemd )); then
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl reset-failed "$AGENT_UNIT" "$XRAY_UNIT" >/dev/null 2>&1 || true
fi

# Clean installation directory
if [[ -d $ROOT ]]; then
    if (( KEEP_DATA )); then
        say "Preserving config and state under $ROOT..."
        rm -rf -- "$ROOT/current" "$ROOT/previous" "$ROOT/releases"
        rm -rf -- "$ROOT"/.installer.* 2>/dev/null || true
        say "Binaries and releases removed. Configuration and state preserved in $ROOT/config and $ROOT/state."
    else
        say "Removing installation directory: $ROOT..."
        # Close file lock descriptor before deleting directory
        exec 9>&- 2>/dev/null || true
        rm -rf -- "$ROOT"
        say "Removed $ROOT"
    fi
else
    say "Installation directory $ROOT does not exist."
fi

say 'proxysetting uninstallation complete.'
