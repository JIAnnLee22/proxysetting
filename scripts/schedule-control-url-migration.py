#!/usr/bin/env python3
"""Schedule one root/systemd control-URL migration, default today 22:05 Beijing."""
import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

TARGET = "https://jiannlee22panel.ccwu.cc"
NAME = "proxysetting-control-url-migration"
AGENT = "proxysetting-agent.service"
XRAY = "proxysetting-xray.service"
BEIJING = dt.timezone(dt.timedelta(hours=8))


class Failure(Exception):
    pass


def log(message):
    print(dt.datetime.now(BEIJING).strftime("[%Y-%m-%d %H:%M:%S +08:00] ") + message, flush=True)


def command(*args, timeout=150):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Failure("命令超时：" + Path(args[0]).name) from None
    if result.returncode:
        # Never forward subprocess output: it could contain configuration secrets.
        raise Failure("命令失败：" + Path(args[0]).name) from None
    return result.stdout.strip()


def private_bytes(path, limit=1024 * 1024):
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise Failure("配置/状态必须是 root 所有、无组及其他用户权限的普通文件")
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise Failure("配置/状态文件过大")
        return data


def installed(root):
    data = json.loads(private_bytes(root / "config/agent.json"))
    if data.get("schema") != 1 or not re.fullmatch(r"[A-Za-z0-9_-]{43}", data.get("credential", "")):
        raise Failure("安装配置格式无效")
    return data


def atomic_write(path, data, mode):
    fd, temporary = tempfile.mkstemp(prefix=".control-url-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, str(path))
        directory = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def exclusive(path):
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise Failure("锁文件权限无效")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Failure("已有任务/Agent持有安装目录锁，请勿并行维护") from None
        yield
    finally:
        os.close(fd)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(path, credential=None):
    headers = {"Accept": "application/json"}
    if credential:
        headers["Authorization"] = "Bearer " + credential
    opener = urllib.request.build_opener(
        NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    try:
        with opener.open(urllib.request.Request(TARGET + path, headers=headers), timeout=15) as response:
            body = response.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            raise Failure("目标接口响应过大")
        return json.loads(body)
    except urllib.error.HTTPError as error:
        raise Failure("目标接口拒绝请求，HTTP " + str(error.code)) from None
    except (urllib.error.URLError, TimeoutError, ssl.SSLError, ValueError, OSError):
        raise Failure("目标接口 DNS/TLS/网络或 JSON 验证失败；未关闭证书校验") from None


def probe(root):
    local = installed(root)
    remote = request_json("/api/agent/config", local["credential"])
    if not isinstance(remote, dict) or any(remote.get(key) != local.get(key)
                                         for key in ("schema", "vpsId", "port", "serverName")):
        raise Failure("新入口返回的固定节点参数不匹配")
    revision = remote.get("revision")
    if type(revision) is not int or revision < local["desired"]["revision"]:
        raise Failure("新入口配置 revision 无效或回退")
    upgrade = remote.get("upgrade")
    version = command(str(root / "current/bin/proxysetting-agent"), "--version")
    if upgrade and upgrade.get("version") != version:
        raise Failure("存在待执行的版本升级；请先处理升级，勿与域名迁移并行")
    return local


def remote_snapshot(vps_id):
    state = request_json("/api/admin/state")  # This project's read-only guest endpoint.
    for item in state.get("snapshots", []):
        if item.get("vps_id") == vps_id:
            return item.get("payload", {})
    return {}


def counters_cover(reported, expected):
    by_id = {item["id"]: item for item in reported}
    return all(identity in by_id and all(by_id[identity].get(key, -1) >= counters[key]
                                         for key in ("uplink", "downlink"))
               for identity, counters in expected.items())


def fresh_report(snapshot, baseline, usage, daily):
    if (snapshot.get("sequence", -1) <= baseline or snapshot.get("month") != usage["month"]
            or snapshot.get("day") != usage["day"] or snapshot.get("status") != "ready"
            or not counters_cover(snapshot.get("users", []), usage["users"])):
        return False
    if daily:
        observed = snapshot.get("daily") or {}
        return (observed.get("date") == daily["date"]
                and counters_cover(observed.get("users", []), daily["users"]))
    return True


def local_health(root):
    command("systemctl", "is-active", "--quiet", AGENT, XRAY)
    command(str(root / "current/bin/proxysetting-agent"), "check", "--root", str(root), timeout=15)


def validate_root(value):
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", value) or Path(value).is_symlink():
        raise Failure("安装目录必须是无空格的绝对路径，且不能是符号链接")
    root = Path(value).resolve(strict=True)
    if root == Path("/"):
        raise Failure("不能使用根目录作为安装目录")
    for directory in (root, root / "config", root / "state"):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise Failure("安装目录/config/state必须是 root 所有的0700目录，不能是符号链接")
    if not Path("/run/systemd/system").is_dir() or not shutil.which("systemctl"):
        raise Failure("此脚本只支持 root + systemd 安装")
    release = root / "config/release.env"
    lines = private_bytes(release, 1024).decode().splitlines() if release.exists() else []
    modes = [line.split("=", 1)[1] for line in lines if line.startswith("SERVICE_MODE=")]
    if modes not in ([], ["systemd"]):
        raise Failure("此脚本不支持 standalone；未停止任何服务")
    for unit in (AGENT, XRAY):
        if command("systemctl", "show", unit, "--property=WorkingDirectory", "--value") != str(root):
            raise Failure("systemd服务的安装目录与 --root 不一致")
        if command("systemctl", "show", unit, "--property=User", "--value") not in ("", "root"):
            raise Failure("systemd服务不是root服务")
    installed(root)
    local_health(root)
    return root


def set_url(root, target, allowed):
    current = installed(root)
    if current.get("controlUrl") not in allowed:
        raise Failure("controlUrl被其他操作修改，拒绝覆盖")
    current["controlUrl"] = target  # Preserve every other field, including newer desired config.
    atomic_write(root / "config/agent.json",
                 (json.dumps(current, separators=(",", ":")) + "\n").encode(), 0o600)


def migrate(root):
    local = probe(root)  # Abort before touching services if TLS/device authentication fails.
    old = local["controlUrl"]
    if old.rstrip("/") == TARGET:
        log("已经使用固定域名，无需切换")
        return
    touched = False
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda signum, frame: (_ for _ in ()).throw(Failure("收到终止信号")))
    try:
        log("开始切换；正常停止Agent/Xray，完成最终采样落盘")
        touched = True
        command("systemctl", "stop", AGENT, XRAY)
        with exclusive(root / "state/agent.lock"):
            local = installed(root)
            if local["controlUrl"] != old:
                raise Failure("停机前controlUrl被其他操作修改")
            usage = json.loads(private_bytes(root / "state/usage.json"))
            analytics = root / "state/analytics.json"
            daily = json.loads(private_bytes(analytics)) if analytics.exists() else None
            if daily and daily.get("date") != usage["day"]:
                raise Failure("本地日报与月用量日期不一致，拒绝迁移")
            backup_parent = root / "backups"
            backup_parent.mkdir(mode=0o700, exist_ok=True)
            backup = backup_parent / ("control-url-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + str(os.getpid()))
            backup.mkdir(mode=0o700)
            shutil.copytree(str(root / "config"), str(backup / "config"))
            shutil.copytree(str(root / "state"), str(backup / "state"))
            log("停机后配置/完整状态已备份：" + str(backup))
            baseline = remote_snapshot(local["vpsId"]).get("sequence", -1)
            set_url(root, TARGET, {old})
        command("systemctl", "start", AGENT)
        local_health(root)
        probe(root)
        log("服务已启动，等待新面板月/日用量追上停机前数值（最多7分钟）")
        deadline = time.monotonic() + 420
        while time.monotonic() < deadline:
            local_health(root)
            try:
                snapshot = remote_snapshot(local["vpsId"])
                if fresh_report(snapshot, baseline, usage, daily):
                    log("切换成功：本地计量健康，停机前月/日用量已在新面板观测到；state未清空")
                    return
            except Failure:
                pass  # Keep local accounting running during transient HTTP failures.
            time.sleep(10)
        raise Failure("新面板未在时限内确认完整的停机前月/日用量")
    except BaseException:
        if touched:
            # Keep a second termination signal from interrupting best-effort rollback.
            for sig in (signal.SIGINT, signal.SIGTERM):
                signal.signal(sig, signal.SIG_IGN)
            log("迁移未确认成功，尝试仅回滚URL；绝不用备份覆盖state或新配置的其他字段")
            try:
                command("systemctl", "stop", AGENT, XRAY)
                with exclusive(root / "state/agent.lock"):
                    set_url(root, old, {old, TARGET})
                command("systemctl", "start", AGENT)
                local_health(root)
                log("旧URL和本地服务已恢复；云端可达性仍取决于旧入口，当前用量保持最新")
            except Exception:
                log("自动回滚未完成：请检查服务和备份；不要恢复旧state或重新安装")
        raise


def schedule(root, clock, job):
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", clock):
        raise Failure("--time 格式必须为 HH:MM，北京时间")
    hour, minute = map(int, clock.split(":"))
    now = dt.datetime.now(BEIJING)
    when = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if when <= now + dt.timedelta(minutes=1):
        raise Failure("今天的计划时间已过或不足1分钟；请用 --time 选择今天稍后的时间，不会自动顺延")
    if installed(root)["controlUrl"].rstrip("/") == TARGET:
        log("已经使用固定域名，无需安排任务")
        return
    probe(root)
    remote_snapshot(installed(root)["vpsId"])
    for unit in (NAME + ".timer", NAME + ".service"):
        result = subprocess.run(["systemctl", "is-active", "--quiet", unit], check=False)
        if result.returncode == 0:
            raise Failure("已有同名任务正在等待或执行；请先查看，勿重复安排")
    helper = job / "migrate.py"
    atomic_write(helper, Path(__file__).read_bytes(), 0o700)
    units = Path("/etc/systemd/system")
    python = str(Path(sys.executable).resolve())
    utc = when.astimezone(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    service = ("[Unit]\nDescription=One-shot proxysetting fixed-domain migration\n"
               "Wants=network-online.target\nAfter=network-online.target\n\n"
               "[Service]\nType=oneshot\nUser=root\nUMask=0077\n"
               "TimeoutStartSec=15min\nTimeoutStopSec=180s\n"
               "ExecStart=" + python + " " + str(helper) + " --run --root " + str(root) + "\n")
    timer = ("[Unit]\nDescription=Scheduled proxysetting fixed-domain migration\n\n"
             "[Timer]\nOnCalendar=" + utc + "\nAccuracySec=1s\nRandomizedDelaySec=0\n"
             "Persistent=true\nUnit=" + NAME + ".service\n\n[Install]\nWantedBy=timers.target\n")
    for suffix, content in (("service", service), ("timer", timer)):
        path = units / (NAME + "." + suffix)
        if path.is_symlink():
            raise Failure("同名systemd unit为符号链接/已屏蔽，拒绝覆盖")
        atomic_write(path, content.encode(), 0o644)
    command("systemctl", "daemon-reload")
    command("systemctl", "enable", "--now", NAME + ".timer")
    log("预检通过，已安排北京时间 " + when.strftime("%Y-%m-%d %H:%M:%S") + "；现在不会停服务")
    log("SSH断开不影响；若关机错过时间，Persistent定时器会在开机后补执行")
    log("查看：systemctl list-timers --all " + NAME + ".timer")
    log("日志：journalctl -u " + NAME + ".service -n 80 --no-pager")
    log("取消尚未开始的任务：systemctl disable --now " + NAME + ".timer")


def main():
    parser = argparse.ArgumentParser(description="root/systemd：今天北京时间22:05迁移控制URL，保留月/日用量；不会立刻停机")
    parser.add_argument("--root", default="/opt/proxysetting", help="原安装目录")
    parser.add_argument("--time", default="22:05", help="今天北京时间HH:MM，默认22:05；过时拒绝安排")
    parser.add_argument("--run", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise Failure("必须以root执行；仅适用于root+systemd安装")
    os.umask(0o077)
    root = validate_root(args.root)
    job = root / ".control-url-migration"
    job.mkdir(mode=0o700, exist_ok=True)
    info = job.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise Failure("任务目录必须为root所有的0700普通目录")
    with exclusive(job / "job.lock"):
        if args.run:
            migrate(root)
        else:
            schedule(root, args.time, job)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not print tracebacks, HTTP bodies, credentials, UUIDs, or subprocess output.
        detail = str(error) if isinstance(error, Failure) else type(error).__name__
        log("失败：" + detail)
        sys.exit(1)
