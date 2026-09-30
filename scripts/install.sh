#!/usr/bin/env bash
# Only execute after verifying this script against the pinned release digest.
set +x
set -Eeuo pipefail
umask 077

readonly XRAY_VERSION='v26.3.27'
readonly INITIAL_VERSION='v0.1.0'
readonly AGENT_UNIT='proxysetting-agent.service'
readonly XRAY_UNIT='proxysetting-xray.service'
ROOT='/opt/proxysetting'
VERSION='' REPO='' CONTROL_URL='' ADDRESS='' PORT='' SERVER_NAME=''
MODE='install' TOKEN="${PROXYSETTING_ENROLL_TOKEN:-}"
WORK='' OLD_RELEASE='' NEW_RELEASE='' TRANSACTION=0 SUCCESS=0

say() { printf '%s\n' "$*"; }
die() { printf 'proxysetting: %s\n' "$*" >&2; exit 1; }
usage() {
    say 'install.sh --control-url HTTPS_URL --address IP --port PORT --server-name HOST --version v0.1.0 --repo OWNER/REPO [--root /opt/proxysetting]'
    say 'Supply PROXYSETTING_ENROLL_TOKEN in the environment; --token is supported but exposes it in process arguments.'
    say 'install.sh --upgrade --root ROOT --version VERSION [--repo OWNER/REPO]'
    say 'install.sh --rollback --root ROOT'
}
while (($#)); do
    case "$1" in
        --upgrade|--rollback)
            [[ $MODE == install ]] || die 'choose only one operation'
            MODE=${1#--}; shift ;;
        --control-url|--address|--port|--server-name|--version|--repo|--root|--token)
            (($# >= 2)) && [[ -n $2 && $2 != --* ]] || die 'missing option value'
            case "$1" in
                --control-url) CONTROL_URL=$2 ;; --address) ADDRESS=$2 ;; --port) PORT=$2 ;;
                --server-name) SERVER_NAME=$2 ;; --version) VERSION=$2 ;; --repo) REPO=$2 ;;
                --root) ROOT=$2 ;; --token) TOKEN=$2 ;;
            esac
            shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) die 'unknown option (see --help)' ;;
    esac
done
valid_version() { [[ $1 =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; }
valid_repo() { [[ $1 =~ ^[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$ && $1 != */. && $1 != */.. ]]; }
[[ $(id -u) == 0 ]] || die 'root is required'
[[ $ROOT =~ ^/[A-Za-z0-9_./-]+$ && $ROOT != / && $ROOT != */ && $ROOT != *//* && $ROOT != */../* && $ROOT != */.. && $ROOT != */./* && $ROOT != */. ]] || die 'root must be a safe absolute path without dot segments or trailing slash'
for cmd in systemctl curl sha256sum tar unzip ss flock realpath stat cmp awk sed install mktemp readlink find sort sync; do
    command -v "$cmd" >/dev/null || die "missing prerequisite: $cmd (install it manually)"
done
[[ $(realpath -m -- "$ROOT") == "$ROOT" ]] || die 'root or its parent must not be a symlink'
[[ -d /run/systemd/system ]] || die 'systemd is required'
systemctl show --property=Version --value >/dev/null 2>&1 || die 'systemd manager is unavailable'
# Do not source any host/config file: values are parsed, never executed.
os_id=$(awk -F= '$1=="ID" {gsub(/"/, "", $2); print $2}' /etc/os-release)
[[ $os_id == debian || $os_id == ubuntu || $os_id == arch ]] || die 'only Debian, Ubuntu and Arch Linux are supported'
case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64; XRAY_ASSET='Xray-linux-64.zip'; XRAY_SHA='23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae' ;;
    aarch64|arm64) ARCH=arm64; XRAY_ASSET='Xray-linux-arm64-v8a.zip'; XRAY_SHA='4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c' ;;
    *) die 'only amd64 and arm64 are supported' ;;
esac
readonly ARCH XRAY_ASSET XRAY_SHA

render_unit() { sed "s|@ROOT@|$ROOT|g" "$1"; }
unit_absent() {
    local unit=$1 state
    [[ ! -e /etc/systemd/system/$unit && ! -L /etc/systemd/system/$unit ]] || die 'existing unit: refusing to overwrite'
    state=$(systemctl show "$unit" --property=LoadState --value) || die 'cannot inspect unit ownership'
    [[ $state == not-found ]] || die 'a service with our unit name already exists'
}
owned_file() {
    [[ -f $1 && ! -L $1 && $(stat -c %u "$1") == 0 ]] || die 'unsafe or missing managed file'
    local mode
    mode=$(stat -c %a "$1")
    (( (8#$mode & 8#022) == 0 )) || die 'managed file is writable by non-root users'
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
    valid_version "$version" && [[ $target == "$ROOT/releases/$version" && -d $target && ! -L $target ]] || die 'release link escapes managed releases'
    owned_file "$target/bin/proxysetting-agent"
    owned_file "$target/bin/xray"
    printf '%s\n' "$target"
}
atomic_link() {
    local target=$1 name=$2
    ln -s -- "$target" "$ROOT/.$name.next" || return 1
    mv -Tf -- "$ROOT/.$name.next" "$ROOT/$name" || return 1
    sync -f "$ROOT"
}
stop_services() {
    # Agent stops FIRST: final sample + fsync must finish while Xray API is alive.
    systemctl stop "$AGENT_UNIT" || return 1
    systemctl stop "$XRAY_UNIT" || return 1
    ! systemctl is-active --quiet "$XRAY_UNIT"
}
start_services() {
    systemctl reset-failed "$AGENT_UNIT" "$XRAY_UNIT" || return 1
    systemctl start "$AGENT_UNIT" || return 1
    systemctl is-active --quiet "$AGENT_UNIT" && systemctl is-active --quiet "$XRAY_UNIT" || return 1
    "$ROOT/current/bin/proxysetting-agent" check --root "$ROOT" >/dev/null 2>&1
}
restore_backup() {
    # Only config is rolled back: NEVER roll back durable usage/sequence state.
    rm -rf -- "$ROOT/config" || return 1
    cp -a -- "$WORK/backup/config" "$ROOT/config" || return 1
    for unit in "$AGENT_UNIT" "$XRAY_UNIT"; do
        install -m 0644 "$WORK/backup/$unit" "/etc/systemd/system/$unit" || return 1
    done
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
    systemctl daemon-reload
}
cleanup() {
    local rc=$?
    trap - EXIT INT TERM HUP
    set +e
    unset TOKEN PROXYSETTING_ENROLL_TOKEN
    if (( ! SUCCESS && TRANSACTION )); then
        say 'Operation failed; keeping Xray fail-closed and restoring the previous release.' >&2
        # Even if the failing command was a start/stop, forcibly stop both before restoration.
        if ! systemctl stop "$AGENT_UNIT"; then
            systemctl kill --kill-whom=all --signal=KILL "$AGENT_UNIT" >/dev/null 2>&1 || true
        fi
        systemctl stop "$XRAY_UNIT" >/dev/null 2>&1 || true
        systemctl kill --kill-whom=all --signal=KILL "$XRAY_UNIT" >/dev/null 2>&1 || true
        if [[ $MODE != install ]]; then
            if restore_backup && start_services; then
                say 'Previous release restored; current usage state retained.' >&2
            else
                systemctl stop "$AGENT_UNIT" "$XRAY_UNIT" >/dev/null 2>&1 || true
                systemctl kill --kill-whom=all --signal=KILL "$XRAY_UNIT" >/dev/null 2>&1 || true
                say "Recovery failed: services stopped. Protected backup: $WORK/backup" >&2
                WORK='' # Preserve the recovery backup, not any secret console output.
            fi
        else
            systemctl disable "$AGENT_UNIT" >/dev/null 2>&1 || true
            rm -f -- "/etc/systemd/system/$AGENT_UNIT" "/etc/systemd/system/$XRAY_UNIT" "$ROOT/current"
            systemctl daemon-reload >/dev/null 2>&1 || true
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
    [[ $VERSION == "$INITIAL_VERSION" ]] || die 'initial install is locked to v0.1.0'
    valid_repo "$REPO" || die 'repo must be OWNER/REPO'
    [[ $CONTROL_URL =~ ^https://[^[:space:]?#]+$ && $CONTROL_URL != *'@'* ]] || die 'control URL must be HTTPS without userinfo, query or fragment'
    [[ -n $ADDRESS && -n $SERVER_NAME && -n $TOKEN ]] || die 'address, server name and enrollment token are required'
    [[ $PORT =~ ^[0-9]{1,5}$ ]] || die 'invalid port'
    PORT=$((10#$PORT))
    (( PORT >= 1 && PORT <= 65535 && PORT != 10085 )) || die 'port must be 1..65535 and must not be the API port 10085'
    [[ ! -e $ROOT || -d $ROOT ]] || die 'root is not a directory'
    [[ ! -d $ROOT || -z $(find "$ROOT" -mindepth 1 -maxdepth 1 -print -quit) ]] || die 'already installed or nonempty root; use explicit upgrade/rollback'
    unit_absent "$AGENT_UNIT"; unit_absent "$XRAY_UNIT"
    for p in "$PORT" 10085; do
        sockets=$(ss -H -ltn "sport = :$p") || die 'cannot inspect listening TCP ports'
        [[ -z $sockets ]] || die "TCP port $p is already in use"
    done
else
    [[ -z $CONTROL_URL && -z $ADDRESS && -z $PORT && -z $SERVER_NAME && -z $TOKEN ]] || die 'enrollment options are not valid for upgrade/rollback'
    [[ -d $ROOT/config && ! -L $ROOT/config && -d $ROOT/state && ! -L $ROOT/state ]] || die 'missing managed installation'
fi
install -d -m 0755 "$ROOT"
# Lock serializes first install, manual upgrade, and systemd-run upgrade.
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
    managed_units
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
    local base archive
    NEW_RELEASE="$ROOT/releases/$VERSION"
    [[ ! -e $NEW_RELEASE && ! -L $NEW_RELEASE ]] || die 'release directory already exists; refusing to overwrite'
    base="https://github.com/$REPO/releases/download/$VERSION"
    archive="proxysetting-agent-linux-$ARCH.tar.gz"
    download "$base/SHA256SUMS" "$WORK/SHA256SUMS"
    download "$base/$archive" "$WORK/agent.tar.gz"
    download "$base/install.sh" "$WORK/install.sh"
    verify_digest "$WORK/agent.tar.gz" "$(release_digest "$archive")"
    verify_digest "$WORK/install.sh" "$(release_digest install.sh)"
    download "https://github.com/XTLS/Xray-core/releases/download/$XRAY_VERSION/$XRAY_ASSET" "$WORK/xray.zip"
    verify_digest "$WORK/xray.zip" "$XRAY_SHA"
    install -d -m 0755 "$WORK/release/bin" "$WORK/release/packaging"
    extract_member "$WORK/agent.tar.gz" 'bin/proxysetting-agent' "$WORK/release/bin/proxysetting-agent"
    for unit in "$AGENT_UNIT" "$XRAY_UNIT"; do
        extract_member "$WORK/agent.tar.gz" "packaging/$unit" "$WORK/release/packaging/$unit"
    done
    unzip -p "$WORK/xray.zip" xray >"$WORK/release/bin/xray"
    [[ -s $WORK/release/bin/xray ]] || die 'official Xray archive has no binary'
    install -m 0755 "$WORK/install.sh" "$WORK/release/install.sh"
    chmod 0755 "$WORK/release/bin/"*; chmod 0644 "$WORK/release/packaging/"*
    install -d -m 0755 "$ROOT/releases"
    mv -- "$WORK/release" "$NEW_RELEASE"
}
write_units() {
    local unit
    for unit in "$AGENT_UNIT" "$XRAY_UNIT"; do
        render_unit "$NEW_RELEASE/packaging/$unit" >"$WORK/$unit"
        install -m 0644 "$WORK/$unit" "/etc/systemd/system/$unit"
    done
    systemctl daemon-reload
}
backup_installation() {
    install -d -m 0700 "$WORK/backup"
    cp -a -- "$ROOT/config" "$WORK/backup/config"
    cp -a -- "$ROOT/state" "$WORK/backup/state" # For inspection only; never restored over newer counters.
    cp -a -- "/etc/systemd/system/$AGENT_UNIT" "/etc/systemd/system/$XRAY_UNIT" "$WORK/backup/"
    [[ ! -L $ROOT/previous ]] || cp -a -- "$ROOT/previous" "$WORK/backup/previous"
    TRANSACTION=1
}

if [[ $MODE == install ]]; then
    stage_release
    install -d -m 0700 "$ROOT/config" "$ROOT/state"
    TRANSACTION=1
    atomic_link "$NEW_RELEASE" current
    export PROXYSETTING_ENROLL_TOKEN="$TOKEN"
    # Agent owns IP/public reachability, TLS1.3 probe, keys, registration, and config/state generation.
    if ! "$ROOT/current/bin/proxysetting-agent" install --control-url "$CONTROL_URL" --address "$ADDRESS" --port "$PORT" --server-name "$SERVER_NAME" --root "$ROOT" >/dev/null 2>&1; then
        die 'agent installation/enrollment failed (token may be consumed); no automatic retry'
    fi
    unset TOKEN PROXYSETTING_ENROLL_TOKEN
    for file in "$ROOT/config/agent.json" "$ROOT/config/xray.json" "$ROOT/state/usage.json"; do
        owned_file "$file"; chmod 0600 "$file"
    done
    printf 'RELEASE_REPO=%s\nXRAY_VERSION=%s\n' "$REPO" "$XRAY_VERSION" >"$ROOT/config/release.env"
    chmod 0600 "$ROOT/config/release.env"
    "$ROOT/current/bin/xray" run -test -config "$ROOT/config/xray.json" >/dev/null 2>&1 || die 'Xray configuration test failed'
    write_units
    systemctl enable "$AGENT_UNIT"
    start_services || die 'agent readiness/health check failed'
else
    backup_installation
    # Stop before downloading: this enforces final sampling even for automated systemd-run upgrades.
    stop_services || die 'could not stop agent/Xray safely'
    if [[ $MODE == upgrade ]]; then stage_release; fi
    "$NEW_RELEASE/bin/xray" run -test -config "$ROOT/config/xray.json" >/dev/null 2>&1 || die 'Xray configuration test failed'
    atomic_link "$NEW_RELEASE" current
    write_units
    start_services || die 'new release readiness/health check failed'
    atomic_link "$OLD_RELEASE" previous
fi
SUCCESS=1
say "proxysetting $MODE succeeded: ${NEW_RELEASE##*/} ($ARCH)"
say "Health: systemctl status $AGENT_UNIT $XRAY_UNIT"
say "Health: $ROOT/current/bin/proxysetting-agent check --root $ROOT"
say 'WARNING: host firewall and cloud security group must allow your Reality TCP port. Firewall rules were NOT changed.'
