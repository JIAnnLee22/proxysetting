#!/usr/bin/env bash
# Only execute after verifying this script against the pinned release digest.
set +x
set -Eeuo pipefail
umask 077

readonly XRAY_VERSION='v26.3.27'
readonly AGENT_UNIT='proxysetting-agent.service'
readonly XRAY_UNIT='proxysetting-xray.service'
OWNER_UID=$(id -u)
ROOT='/opt/proxysetting'
if [[ $OWNER_UID != 0 ]]; then
    [[ -n ${HOME:-} ]] || { printf 'proxysetting: HOME is required\n' >&2; exit 1; }
    ROOT="$HOME/.local/share/proxysetting"
fi
SERVICE_MODE='auto'
VERSION='' REPO='' CONTROL_URL='' ADDRESS='' PORT='' SERVER_NAME=''
MODE='install' TOKEN="${PROXYSETTING_ENROLL_TOKEN:-}"
WORK='' OLD_RELEASE='' NEW_RELEASE='' TRANSACTION=0 SUCCESS=0

say() { printf '%s\n' "$*"; }
die() { printf 'proxysetting: %s\n' "$*" >&2; exit 1; }
usage() {
    say 'install.sh --control-url HTTPS_URL --address IP --port PORT --server-name HOST --version vMAJOR.MINOR.PATCH --repo OWNER/REPO [--root DIR] [--service-mode auto|systemd|standalone]'
    say 'Default root: /opt/proxysetting for root; ~/.local/share/proxysetting otherwise. Auto uses systemd only with root and an available system manager.'
    say 'Supply PROXYSETTING_ENROLL_TOKEN in the environment; --token is supported but exposes it in process arguments.'
    say 'install.sh --upgrade --root ROOT --version VERSION [--repo OWNER/REPO]'
    say 'install.sh --rollback --root ROOT'
}
while (($#)); do
    case "$1" in
        --upgrade|--rollback)
            [[ $MODE == install ]] || die 'choose only one operation'
            MODE=${1#--}; shift ;;
        --control-url|--address|--port|--server-name|--version|--repo|--root|--token|--service-mode)
            if (($# < 2)) || [[ -z $2 || $2 == --* ]]; then die 'missing option value'; fi
            case "$1" in
                --control-url) CONTROL_URL=$2 ;; --address) ADDRESS=$2 ;; --port) PORT=$2 ;;
                --server-name) SERVER_NAME=$2 ;; --version) VERSION=$2 ;; --repo) REPO=$2 ;;
                --root) ROOT=$2 ;; --token) TOKEN=$2 ;; --service-mode) SERVICE_MODE=$2 ;;
            esac
            shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) die 'unknown option (see --help)' ;;
    esac
done
valid_version() { [[ $1 =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; }
valid_repo() { [[ $1 =~ ^[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$ && $1 != */. && $1 != */.. ]]; }
[[ $SERVICE_MODE == auto || $SERVICE_MODE == systemd || $SERVICE_MODE == standalone ]] || die 'invalid service mode'
[[ $ROOT =~ ^/[A-Za-z0-9_./-]+$ && $ROOT != / && $ROOT != */ && $ROOT != *//* && $ROOT != */../* && $ROOT != */.. && $ROOT != */./* && $ROOT != */. ]] || die 'root must be a safe absolute path without dot segments or trailing slash'
for cmd in curl sha256sum tar gzip flock realpath stat cmp awk sed install mktemp readlink find sort sync; do
    command -v "$cmd" >/dev/null || die "missing prerequisite: $cmd (install it manually)"
done
[[ $(realpath -m -- "$ROOT") == "$ROOT" ]] || die 'root or its parent must not be a symlink'
has_systemd=0
if [[ $OWNER_UID == 0 && -d /run/systemd/system ]] && command -v systemctl >/dev/null && systemctl show --property=Version --value >/dev/null 2>&1; then
    has_systemd=1
fi
if [[ $MODE != install ]]; then
    [[ -f $ROOT/config/release.env && ! -L $ROOT/config/release.env ]] || die 'missing managed release metadata'
    installed_mode=$(awk -F= '$1=="SERVICE_MODE" {n++; mode=$2} END {if(n==0) print "systemd"; else if(n==1) print mode}' "$ROOT/config/release.env")
    [[ $installed_mode == systemd || $installed_mode == standalone ]] || die 'invalid installed service mode'
    [[ $SERVICE_MODE == auto || $SERVICE_MODE == "$installed_mode" ]] || die 'cannot change service mode during upgrade/rollback'
    SERVICE_MODE=$installed_mode
elif [[ $SERVICE_MODE == auto ]]; then
    if (( has_systemd )); then SERVICE_MODE=systemd; else SERVICE_MODE=standalone; fi
fi
if [[ $SERVICE_MODE == systemd ]]; then
    (( has_systemd )) || die 'systemd mode requires root and an available systemd manager'
fi
# Do not source any host/config file: values are parsed, never executed.
os_id=$(awk -F= '$1=="ID" {gsub(/"/, "", $2); print $2}' /etc/os-release)
[[ $os_id == debian || $os_id == ubuntu || $os_id == arch ]] || die 'only Debian, Ubuntu and Arch Linux are supported'
case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die 'only amd64 and arm64 are supported' ;;
esac
readonly ARCH

render_unit() { sed "s|@ROOT@|$ROOT|g" "$1"; }
unit_absent() {
    local unit=$1 state
    [[ ! -e /etc/systemd/system/$unit && ! -L /etc/systemd/system/$unit ]] || die 'existing unit: refusing to overwrite'
    state=$(systemctl show "$unit" --property=LoadState --value) || die 'cannot inspect unit ownership'
    [[ $state == not-found ]] || die 'a service with our unit name already exists'
}
owned_file() {
    [[ -f $1 && ! -L $1 && $(stat -c %u "$1") == "$OWNER_UID" ]] || die 'unsafe, foreign-owned or missing managed file'
    local mode
    mode=$(stat -c %a "$1")
    (( (8#$mode & 8#022) == 0 )) || die 'managed file is writable by other users'
}
managed_units() {
    local unit fragment dropins
    for unit in "$AGENT_UNIT" "$XRAY_UNIT"; do
        owned_file "/etc/systemd/system/$unit"
        owned_file "$OLD_RELEASE/packaging/$unit"
        fragment=$(systemctl show "$unit" --property=FragmentPath --value) || die 'cannot inspect unit ownership'
        dropins=$(systemctl show "$unit" --property=DropInPaths --value) || die 'cannot inspect unit drop-ins'
        [[ $fragment == "/etc/systemd/system/$unit" && -z $dropins ]] || die 'unmanaged unit or drop-in: refusing to overwrite'
        render_unit "$OLD_RELEASE/packaging/$unit" >"$WORK/$unit.expected"
        cmp -s "$WORK/$unit.expected" "/etc/systemd/system/$unit" || die 'modified or foreign unit: refusing to overwrite'
    done
}
resolve_release() {
    local link=$1 target version
    [[ -L $link ]] || die 'missing managed release link'
    target=$(readlink -- "$link")
    version=${target##*/}
    if ! valid_version "$version" || [[ $target != "$ROOT/releases/$version" || ! -d $target || -L $target ]]; then
        die 'release link escapes managed releases'
    fi
    owned_file "$target/bin/proxysetting-agent"
    owned_file "$target/bin/xray"
    if [[ $SERVICE_MODE == standalone ]]; then
        [[ " $("$target/bin/proxysetting-agent" --capabilities 2>/dev/null) " == *' standalone '* ]] || die 'release does not support standalone service management'
    fi
    printf '%s\n' "$target"
}
atomic_link() {
    local target=$1 name=$2
    ln -s -- "$target" "$ROOT/.$name.next" || return 1
    mv -Tf -- "$ROOT/.$name.next" "$ROOT/$name" || return 1
    sync -f "$ROOT"
}
stop_services() {
    if [[ $SERVICE_MODE == standalone ]]; then
        "$ROOT/current/bin/proxysetting-agent" stop --root "$ROOT"
        return
    fi
    # Agent stops FIRST: final sample + fsync must finish while Xray API is alive.
    systemctl stop "$AGENT_UNIT" || return 1
    systemctl stop "$XRAY_UNIT" || return 1
    ! systemctl is-active --quiet "$XRAY_UNIT"
}
start_services() {
    if [[ $SERVICE_MODE == standalone ]]; then
        "$ROOT/current/bin/proxysetting-agent" start --root "$ROOT" || return 1
    else
        systemctl reset-failed "$AGENT_UNIT" "$XRAY_UNIT" || return 1
        systemctl start "$AGENT_UNIT" || return 1
        systemctl is-active --quiet "$AGENT_UNIT" && systemctl is-active --quiet "$XRAY_UNIT" || return 1
    fi
    "$ROOT/current/bin/proxysetting-agent" check --root "$ROOT" >/dev/null 2>&1
}
force_stop_services() {
    if [[ $SERVICE_MODE == standalone ]]; then
        stop_services
        return
    fi
    if ! systemctl stop "$AGENT_UNIT"; then
        systemctl kill --kill-whom=all --signal=KILL "$AGENT_UNIT" >/dev/null 2>&1 || true
    fi
    systemctl stop "$XRAY_UNIT" >/dev/null 2>&1 || true
    systemctl kill --kill-whom=all --signal=KILL "$XRAY_UNIT" >/dev/null 2>&1 || true
}
restore_backup() {
    # Only config is rolled back: NEVER roll back durable usage/sequence state.
    rm -rf -- "$ROOT/config" || return 1
    cp -a -- "$WORK/backup/config" "$ROOT/config" || return 1
    if [[ $SERVICE_MODE == systemd ]]; then
        for unit in "$AGENT_UNIT" "$XRAY_UNIT"; do
            install -m 0644 "$WORK/backup/$unit" "/etc/systemd/system/$unit" || return 1
        done
    fi
    if [[ -n $OLD_RELEASE ]]; then
        rm -f -- "$ROOT/.current.next" || return 1
        atomic_link "$OLD_RELEASE" current || return 1
    fi
    if [[ -L $WORK/backup/previous ]]; then
        rm -f -- "$ROOT/.previous.next" || return 1
        atomic_link "$(readlink "$WORK/backup/previous")" previous || return 1
    else
        rm -f -- "$ROOT/previous" || return 1
    fi
    if [[ $SERVICE_MODE == systemd ]]; then systemctl daemon-reload; fi
}
cleanup() {
    local rc=$?
    trap - EXIT INT TERM HUP
    set +e
    unset TOKEN PROXYSETTING_ENROLL_TOKEN
    if (( ! SUCCESS && TRANSACTION )); then
        say 'Operation failed; keeping Xray fail-closed and restoring the previous release.' >&2
        # Even if the failing command was a start/stop, forcibly stop both before restoration.
        if ! force_stop_services; then
            say "Cannot confirm service shutdown; preserving recovery files: $WORK" >&2
            WORK=''
            exit "$rc"
        fi
        if [[ $MODE != install ]]; then
            if restore_backup && start_services; then
                say 'Previous release restored; current usage state retained.' >&2
            else
                force_stop_services >/dev/null 2>&1 || true
                say "Recovery failed: services stopped. Protected backup: $WORK/backup" >&2
                WORK='' # Preserve the recovery backup, not any secret console output.
            fi
        else
            if [[ $SERVICE_MODE == systemd ]]; then
                systemctl disable "$AGENT_UNIT" >/dev/null 2>&1 || true
                rm -f -- "/etc/systemd/system/$AGENT_UNIT" "/etc/systemd/system/$XRAY_UNIT"
                systemctl daemon-reload >/dev/null 2>&1 || true
            fi
            rm -f -- "$ROOT/current"
            say 'Incomplete files retained under root; inspect them before a new-token reinstall. Do not retry a consumed token.' >&2
        fi
    fi
    [[ -z $WORK ]] || rm -rf -- "$WORK"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

if [[ $MODE == install ]]; then
    valid_version "$VERSION" || die 'initial install requires a fixed vMAJOR.MINOR.PATCH version'
    valid_repo "$REPO" || die 'repo must be OWNER/REPO'
    [[ $CONTROL_URL =~ ^https://[^[:space:]?#]+$ && $CONTROL_URL != *'@'* ]] || die 'control URL must be HTTPS without userinfo, query or fragment'
    [[ -n $ADDRESS && -n $SERVER_NAME && -n $TOKEN ]] || die 'address, server name and enrollment token are required'
    [[ $PORT =~ ^[0-9]{1,5}$ ]] || die 'invalid port'
    PORT=$((10#$PORT))
    (( PORT >= 1 && PORT <= 65535 && PORT != 10085 )) || die 'port must be 1..65535 and must not be the API port 10085'
    [[ ! -e $ROOT || -d $ROOT ]] || die 'root is not a directory'
    [[ ! -d $ROOT || -z $(find "$ROOT" -mindepth 1 -maxdepth 1 -print -quit) ]] || die 'already installed or nonempty root; use explicit upgrade/rollback'
    if [[ $SERVICE_MODE == systemd ]]; then unit_absent "$AGENT_UNIT"; unit_absent "$XRAY_UNIT"; fi
    if [[ $OWNER_UID != 0 ]] && (( PORT < 1024 )); then
        say 'WARNING: unprivileged nodes usually require a TCP port >=1024 (for example 8443); agent will verify bind permission before enrollment.' >&2
    fi
    if command -v ss >/dev/null; then
        for p in "$PORT" 10085; do
            sockets=$(ss -H -ltn "sport = :$p") || die 'cannot inspect listening TCP ports'
            [[ -z $sockets ]] || die "TCP port $p is already in use"
        done
    fi # Agent always checks both actual bind permissions and conflicts before enrollment.
else
    [[ -z $CONTROL_URL && -z $ADDRESS && -z $PORT && -z $SERVER_NAME && -z $TOKEN ]] || die 'enrollment options are not valid for upgrade/rollback'
    [[ -d $ROOT/config && ! -L $ROOT/config && -d $ROOT/state && ! -L $ROOT/state ]] || die 'missing managed installation'
fi
if [[ -d $ROOT ]]; then
    [[ $(stat -c %u "$ROOT") == "$OWNER_UID" ]] || die 'installation directory belongs to another user'
fi
install -d -m 0700 "$ROOT"
[[ ! -L $ROOT/.install.lock ]] || die 'unsafe installer lock'
# Lock serializes first install, manual upgrade, and detached upgrade.
exec 9>"$ROOT/.install.lock"
flock -n 9 || die 'another installation operation is in progress'
if [[ $MODE == install ]]; then
    [[ -z $(find "$ROOT" -mindepth 1 -maxdepth 1 ! -name .install.lock -print -quit) ]] || die 'root became nonempty; refusing to overwrite'
fi
owned_file "$ROOT/.install.lock"
WORK=$(mktemp -d "$ROOT/.installer.XXXXXXXX")
if [[ $MODE != install ]]; then
    OLD_RELEASE=$(resolve_release "$ROOT/current")
    owned_file "$ROOT/config/release.env"
    installed_repo=$(awk -F= '$1=="RELEASE_REPO" {print $2}' "$ROOT/config/release.env")
    valid_repo "$installed_repo" || die 'invalid installed release repository'
    [[ -z $REPO || $REPO == "$installed_repo" ]] || die 'repo differs from the installed release repository'
    REPO=$installed_repo
    if [[ $SERVICE_MODE == systemd ]]; then managed_units; fi
    if [[ $MODE == upgrade ]]; then
        valid_version "$VERSION" || die 'upgrade requires a fixed vMAJOR.MINOR.PATCH version'
        [[ $OLD_RELEASE != "$ROOT/releases/$VERSION" ]] || die 'requested version is already current'
    else
        [[ -z $VERSION ]] || die 'rollback does not accept a version'
        NEW_RELEASE=$(resolve_release "$ROOT/previous")
        [[ $NEW_RELEASE != "$OLD_RELEASE" ]] || die 'no different previous release'
    fi
fi

download() {
    curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --max-time 300 --retry 2 --output "$2" "$1"
}
verify_digest() {
    local file=$1 digest=$2 actual
    actual=$(sha256sum -- "$file"); actual=${actual%% *}
    [[ $actual == "$digest" ]] || die 'SHA256 verification failed; refusing to execute downloads'
}
release_digest() {
    # Exactly one literal basename; never feed untrusted checksum paths to sha256sum -c.
    local name=$1 digest
    digest=$(awk -v name="$name" 'NF==2 {n=$2; sub(/^\*/, "", n); if(n==name){count++; hash=$1}} END {if(count==1) print hash}' "$WORK/SHA256SUMS")
    [[ $digest =~ ^[a-f0-9]{64}$ ]] || die 'missing, duplicate or invalid fixed-release checksum'
    printf '%s\n' "$digest"
}
extract_member() {
    local archive=$1 member=$2 output=$3 count
    count=$(tar -tzf "$archive" | awk -v name="$member" '$0==name {n++} END {print n+0}')
    [[ $count == 1 ]] || die 'missing or duplicate required release archive member'
    # Stream named members; no archive path, symlink or permissions can escape into the filesystem.
    tar -xOzf "$archive" -- "$member" >"$output"
    [[ -s $output ]] || die 'empty release archive member'
}
stage_release() {
    local base archive xray_archive
    NEW_RELEASE="$ROOT/releases/$VERSION"
    [[ ! -e $NEW_RELEASE && ! -L $NEW_RELEASE ]] || die 'release directory already exists; refusing to overwrite'
    base="https://github.com/$REPO/releases/download/$VERSION"
    archive="proxysetting-agent-linux-$ARCH.tar.gz"
    download "$base/SHA256SUMS" "$WORK/SHA256SUMS"
    download "$base/$archive" "$WORK/agent.tar.gz"
    download "$base/install.sh" "$WORK/install.sh"
    verify_digest "$WORK/agent.tar.gz" "$(release_digest "$archive")"
    verify_digest "$WORK/install.sh" "$(release_digest install.sh)"
    xray_archive="proxysetting-xray-linux-$ARCH.tar.gz"
    download "$base/$xray_archive" "$WORK/xray.tar.gz"
    verify_digest "$WORK/xray.tar.gz" "$(release_digest "$xray_archive")"
    install -d -m 0755 "$WORK/release/bin" "$WORK/release/packaging"
    extract_member "$WORK/agent.tar.gz" 'bin/proxysetting-agent' "$WORK/release/bin/proxysetting-agent"
    for unit in "$AGENT_UNIT" "$XRAY_UNIT"; do
        extract_member "$WORK/agent.tar.gz" "packaging/$unit" "$WORK/release/packaging/$unit"
    done
    extract_member "$WORK/xray.tar.gz" 'bin/xray' "$WORK/release/bin/xray"
    install -m 0755 "$WORK/install.sh" "$WORK/release/install.sh"
    chmod 0755 "$WORK/release/bin/"*; chmod 0644 "$WORK/release/packaging/"*
    [[ $("$WORK/release/bin/proxysetting-agent" --version) == "$VERSION" ]] || die 'agent binary version does not match pinned release'
    if [[ $SERVICE_MODE == standalone ]]; then
        [[ " $("$WORK/release/bin/proxysetting-agent" --capabilities 2>/dev/null) " == *' standalone '* ]] || die 'release lacks standalone support; choose a new compatible fixed release'
    fi
    install -d -m 0755 "$ROOT/releases"
    mv -- "$WORK/release" "$NEW_RELEASE"
}
write_units() {
    [[ $SERVICE_MODE == systemd ]] || return 0
    local unit
    for unit in "$AGENT_UNIT" "$XRAY_UNIT"; do
        render_unit "$NEW_RELEASE/packaging/$unit" >"$WORK/$unit"
        install -m 0644 "$WORK/$unit" "/etc/systemd/system/$unit"
    done
    systemctl daemon-reload
}
configure_network() {
    (( OWNER_UID == 0 )) || return 0
    [[ -d /etc/sysctl.d && -w /etc/sysctl.d ]] || return 0
    cat >/etc/sysctl.d/99-proxysetting-network.conf 2>/dev/null <<'EOF' || return 0
# Optimized by proxysetting for high-latency cross-border proxy performance
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_fastopen = 3
net.core.rmem_max = 33554432
net.core.wmem_max = 33554432
net.ipv4.tcp_mtu_probing = 1
EOF
    chmod 0644 /etc/sysctl.d/99-proxysetting-network.conf 2>/dev/null || true
    if command -v sysctl >/dev/null; then
        sysctl -q -p /etc/sysctl.d/99-proxysetting-network.conf 2>/dev/null || true
    fi
}
tune_xray_config() {
    local xp="$ROOT/config/xray.json"
    [[ -f $xp ]] || return 0
    if command -v python3 >/dev/null 2>&1; then
        python3 -c "
import json
p = '$xp'
try:
    with open(p) as f: c = json.load(f)
    changed = False
    if c.get('log', {}).get('loglevel') != 'warning':
        c.setdefault('log', {})['loglevel'] = 'warning'
        changed = True
    lvl0 = c.setdefault('policy', {}).setdefault('levels', {}).setdefault('0', {})
    if lvl0.get('connIdle') != 1800:
        lvl0['connIdle'] = 1800
        lvl0['statsUserUplink'] = True
        lvl0['statsUserDownlink'] = True
        changed = True
    if changed:
        with open(p + '.tmp', 'w') as f: json.dump(c, f, indent=2)
except Exception:
    pass
" 2>/dev/null || true
        if [[ -f "$xp.tmp" ]]; then
            chmod 0600 "$xp.tmp"
            mv -f "$xp.tmp" "$xp"
        fi
    fi
}
backup_installation() {
    install -d -m 0700 "$WORK/backup"
    cp -a -- "$ROOT/config" "$WORK/backup/config"
    cp -a -- "$ROOT/state" "$WORK/backup/state" # For inspection only; never restored over newer counters.
    if [[ $SERVICE_MODE == systemd ]]; then
        cp -a -- "/etc/systemd/system/$AGENT_UNIT" "/etc/systemd/system/$XRAY_UNIT" "$WORK/backup/"
    fi
    [[ ! -L $ROOT/previous ]] || cp -a -- "$ROOT/previous" "$WORK/backup/previous"
    TRANSACTION=1
}

if [[ $MODE == install ]]; then
    stage_release
    install -d -m 0700 "$ROOT/config" "$ROOT/state"
    TRANSACTION=1
    atomic_link "$NEW_RELEASE" current
    printf 'RELEASE_REPO=%s\nXRAY_VERSION=%s\n' "$REPO" "$XRAY_VERSION" >"$ROOT/config/release.env"
    if [[ $SERVICE_MODE == standalone ]]; then printf 'SERVICE_MODE=standalone\n' >>"$ROOT/config/release.env"; fi
    chmod 0600 "$ROOT/config/release.env"
    export PROXYSETTING_ENROLL_TOKEN="$TOKEN"
    # Agent owns IP/public reachability, TLS1.3 probe, keys, registration, and config/state generation.
    if ! "$ROOT/current/bin/proxysetting-agent" install --control-url "$CONTROL_URL" --address "$ADDRESS" --port "$PORT" --server-name "$SERVER_NAME" --root "$ROOT" >/dev/null 2>&1; then
        die 'agent installation/enrollment failed (token may be consumed); no automatic retry'
    fi
    unset TOKEN PROXYSETTING_ENROLL_TOKEN
    for file in "$ROOT/config/agent.json" "$ROOT/config/xray.json" "$ROOT/state/usage.json"; do
        owned_file "$file"; chmod 0600 "$file"
    done
    "$ROOT/current/bin/xray" run -test -config "$ROOT/config/xray.json" >/dev/null 2>&1 || die 'Xray configuration test failed'
    write_units
    configure_network
    if [[ $SERVICE_MODE == systemd ]]; then systemctl enable "$AGENT_UNIT"; fi
    start_services || die 'agent readiness/health check failed'
else
    backup_installation
    # Stop before downloading: this enforces final sampling even for automated systemd-run upgrades.
    stop_services || die 'could not stop agent/Xray safely'
    if [[ $MODE == upgrade ]]; then stage_release; fi
    tune_xray_config
    "$NEW_RELEASE/bin/xray" run -test -config "$ROOT/config/xray.json" >/dev/null 2>&1 || die 'Xray configuration test failed'
    atomic_link "$NEW_RELEASE" current
    write_units
    configure_network
    start_services || die 'new release readiness/health check failed'
    atomic_link "$OLD_RELEASE" previous
fi
SUCCESS=1
say "proxysetting $MODE succeeded: ${NEW_RELEASE##*/} ($ARCH)"
say "Service manager: $SERVICE_MODE (root: $ROOT)"
if [[ $SERVICE_MODE == systemd ]]; then
    say "Health: systemctl status $AGENT_UNIT $XRAY_UNIT"
else
    say "Service: $ROOT/current/bin/proxysetting-agent start|stop|restart|status --root $ROOT"
    say 'WARNING: standalone mode has no automatic reboot startup; configure your user startup mechanism (for example crontab @reboot), if available.'
fi
say "Health: $ROOT/current/bin/proxysetting-agent check --root $ROOT"
say 'WARNING: host firewall and cloud security group must allow your Reality TCP port. Firewall rules were NOT changed.'
