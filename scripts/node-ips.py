#!/usr/bin/env python3
"""Export and batch-update registered VPS public IPs through remote Cloudflare D1."""
import argparse
import csv
import datetime as dt
import io
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FILE = ROOT / ".tools/node-ips.txt"
MAGIC = "# proxysetting-node-ips-v1 database_id="
COLUMNS = ["name", "ip", "original_ip", "id"]
ELIGIBLE = ("vps.revoked=0 AND vps.status NOT IN ('deleted','revoked','pending') "
            "AND vps.credential_hash IS NOT NULL AND vps.public_key IS NOT NULL")


class Failure(Exception):
    pass


def wrangler(*args):
    binary = ROOT / "node_modules/.bin/wrangler"
    if not binary.is_file():
        raise Failure("缺少 Wrangler，请先在仓库运行 npm ci")
    try:
        result = subprocess.run(
            [str(binary), *args, "--config", str(ROOT / "wrangler.jsonc"), "--json"],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
            env={**os.environ, "WRANGLER_SEND_METRICS": "false", "NO_COLOR": "1"},
        )
    except subprocess.TimeoutExpired:
        raise Failure("Wrangler 超时；若正在写入，结果可能已提交，请重新导出核对，勿盲目重试") from None
    if result.returncode:
        # Do not forward logs that could contain account credentials or .env values.
        raise Failure("Wrangler 执行失败；请检查 Cloudflare 登录（npx wrangler login）和 D1 权限。"
                      "若正在写入，结果可能已提交，请重新导出核对")
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise Failure("Wrangler 返回无效 JSON；若正在写入，请重新导出核对结果") from None


def database_id(database):
    info = wrangler("d1", "info", database)
    try:
        return str(uuid.UUID(info["uuid"]))
    except (KeyError, TypeError, ValueError):
        raise Failure("无法确认远端 D1 database_id") from None


def query(database, sql):
    result = wrangler("d1", "execute", database, "--remote", "--command", sql)
    if (not isinstance(result, list) or len(result) != 1
            or not isinstance(result[0], dict) or result[0].get("success") is not True
            or not isinstance(result[0].get("results"), list)):
        raise Failure("D1 返回异常；若正在写入，请重新导出核对结果")
    return result[0]["results"]


def nodes(database):
    return query(database, "SELECT id,name,address,public_key FROM vps WHERE "
                 + ELIGIBLE + " ORDER BY created_at,id")


def public_ip(value):
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        raise Failure(f"无效 IP：{value!r}（只接受公网 IPv4/IPv6，不接受域名或端口）") from None
    if not ip.is_global or ip.is_multicast or "%" in value or getattr(ip, "ipv4_mapped", None):
        raise Failure(f"不是可用的公网单播 IP：{value!r}")
    return str(ip)


def mapping_text(db_id, rows):
    stream = io.StringIO(newline="")
    stream.write(MAGIC + db_id + "\n")
    stream.write("# 只修改 ip 列；保留 name、original_ip、id 及 Tab 分隔符。可删除不需处理的行。\n")
    writer = csv.DictWriter(stream, fieldnames=COLUMNS, delimiter="\t", lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


def write_private(path, content, force=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".node-ips-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if force:
            os.replace(temporary, path)
        else:
            # Atomically refuse to overwrite an existing (possibly edited) file.
            try:
                os.link(temporary, path)
            except FileExistsError:
                raise Failure(f"文件已存在，未覆盖：{path}；确认后用 export --force 重新生成") from None
        if os.name == "posix":
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_mapping(path):
    if path.stat().st_size > 128 * 1024:
        raise Failure("映射文件超过 128 KiB")
    content = path.read_text(encoding="utf-8-sig").splitlines()
    if not content or not content[0].startswith(MAGIC):
        raise Failure("缺少数据库标识，请先用 export 生成映射文件")
    try:
        db_id = str(uuid.UUID(content[0][len(MAGIC):]))
    except ValueError:
        raise Failure("映射文件中的 database_id 无效") from None
    lines = content[1:]
    while lines and lines[0].startswith("#"):
        lines.pop(0)
    reader = csv.DictReader(io.StringIO("\n".join(lines)), delimiter="\t", strict=True)
    if reader.fieldnames != COLUMNS:
        raise Failure("表头必须为 Tab 分隔的 name、ip、original_ip、id")
    rows, ids, names = [], set(), set()
    for row in reader:
        if set(row) != set(COLUMNS) or any(not isinstance(v, str) or not v for v in row.values()):
            raise Failure(f"第 {reader.line_num} 行缺列或格式无效，请保留 Tab 分隔符")
        try:
            if str(uuid.UUID(row["id"])) != row["id"]:
                raise ValueError
        except ValueError:
            raise Failure(f"节点 {row['name']!r} 的 id 无效") from None
        if len(row["name"]) > 100 or any(ord(c) < 32 for c in row["name"]):
            raise Failure("节点名称无效")
        if row["id"] in ids or row["name"] in names:
            raise Failure(f"重复节点：{row['name']!r}")
        ids.add(row["id"])
        names.add(row["name"])
        row["ip"] = public_ip(row["ip"].strip())
        # Validate but preserve the original spelling for SQL's exact IPv6 text guard.
        public_ip(row["original_ip"])
        rows.append(row)
    if len(rows) > 10:
        raise Failure("映射文件最多包含 10 个不重复节点")
    return db_id, rows


def export(args):
    if args.file.exists() and not args.force:
        raise Failure(f"文件已存在，未覆盖：{args.file}；确认后用 export --force 重新生成")
    db_id = database_id(args.database)
    current = nodes(args.database)
    if not current:
        raise Failure("没有可导出的已注册、未撤销节点")
    rows = [{"name": n["name"], "ip": n["address"], "original_ip": n["address"], "id": n["id"]}
            for n in current]
    write_private(args.file, mapping_text(db_id, rows), force=args.force)
    print(f"已导出 {len(rows)} 个节点：{args.file}\n仅修改 ip 列；未注册、已撤销和已删除节点不导出。")


def update_sql(changes):
    def quote(value):
        return "'" + value.replace("'", "''") + "'"

    values = ",\n".join("(" + ",".join(quote(n[k]) for k in
                          ("id", "name", "address", "ip", "public_key")) + ")" for n in changes)
    # A single statement is atomic. Materialize the guard before any address changes;
    # if even one row is stale/revoked/re-enrolled, the entire update affects zero rows.
    return f"""WITH edits(id,name,old_ip,new_ip,public_key) AS MATERIALIZED (VALUES {values}),
valid AS MATERIALIZED (
  SELECT COUNT(*) AS n FROM vps JOIN edits ON vps.id=edits.id
  WHERE vps.name=edits.name AND vps.address=edits.old_ip
    AND vps.public_key=edits.public_key AND {ELIGIBLE}
)
UPDATE vps SET address=(SELECT new_ip FROM edits WHERE edits.id=vps.id)
WHERE id IN (SELECT id FROM edits) AND (SELECT n FROM valid)={len(changes)}
RETURNING id,name,address;"""


def apply(args):
    expected_db, rows = read_mapping(args.file)
    if database_id(args.database) != expected_db:
        raise Failure("映射文件不属于当前 D1 数据库，拒绝写入")
    current = {n["id"]: n for n in nodes(args.database)}
    changes = []
    for row in rows:
        n = current.get(row["id"])
        if not n or n["name"] != row["name"]:
            raise Failure(f"节点 {row['name']!r} 已改名、未注册或已撤销/删除，请重新导出")
        # Unedited rows must never roll back a newer address from another operation.
        if row["ip"] == public_ip(row["original_ip"]) or row["ip"] == public_ip(n["address"]):
            continue
        if n["address"] != row["original_ip"]:
            raise Failure(f"节点 {row['name']!r} 的 IP 已被其他操作修改，请重新导出")
        changes.append({**n, "ip": row["ip"]})
    if not changes:
        print("没有需要更新的 IP；未写入数据库。")
        return
    print("即将更新远端 D1（只改 address，不改凭据、密钥、端口、revision 或用量）：")
    for n in changes:
        print(f"  {n['name']}: {n['address']} -> {n['ip']}")
    if args.dry_run:
        print("预览结束，未写入数据库。")
        return
    if not args.yes:
        if not sys.stdin.isatty():
            raise Failure("非交互环境须显式指定 --yes；可先用 --dry-run 预览")
        if input("仅适用于原机换 IP；确认执行以上更新？输入 yes：").strip() != "yes":
            print("已取消，未写入数据库。")
            return
    backup = ROOT / ".tools/node-ip-backups" / (dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".txt")
    rollback = [{"name": n["name"], "ip": n["address"], "original_ip": n["ip"], "id": n["id"]}
                for n in changes]
    write_private(backup, mapping_text(expected_db, rollback))
    print(f"已保存回滚映射：{backup}", flush=True)
    updated = query(args.database, update_sql(changes))
    if not updated:
        raise Failure("未返回更新记录：可能有并行变更，或请求重试前已提交；请重新导出核对，回滚映射已保留")
    expected = {n["id"]: n["ip"] for n in changes}
    if {n["id"]: n["address"] for n in updated} != expected:
        raise Failure("更新返回结果异常，请重新导出核对；不要盲目重试或回滚")
    fresh = {n["id"]: n["address"] for n in nodes(args.database)}
    if any(fresh.get(node_id) != ip for node_id, ip in expected.items()):
        raise Failure("写入已提交，但回读不一致，请检查是否存在并行操作；回滚映射已保留")
    print(f"已更新并回读确认 {len(updated)} 个节点。请刷新面板并更新客户端订阅；旧的本地导出配置需重新导出。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", default="proxysetting", help="wrangler.jsonc 中的 D1 名称（默认 proxysetting）")
    commands = parser.add_subparsers(dest="command", required=True)
    out = commands.add_parser("export", help="从远端 D1 导出节点/IP 文本")
    out.add_argument("file", nargs="?", type=Path, default=DEFAULT_FILE)
    out.add_argument("--force", action="store_true", help="覆盖既有映射（会丢弃尚未应用的编辑）")
    out.set_defaults(run=export)
    update = commands.add_parser("apply", help="预览后确认，批量更新编辑过的 IP")
    update.add_argument("file", nargs="?", type=Path, default=DEFAULT_FILE)
    mode = update.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="只校验和预览，不写入")
    mode.add_argument("--yes", action="store_true", help="跳过交互确认（仍执行全部校验）")
    update.set_defaults(run=apply)
    args = parser.parse_args()
    args.file = args.file.expanduser().absolute()
    try:
        args.run(args)
    except (Failure, OSError, UnicodeError, csv.Error) as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("\n操作中断；若已开始写入，请重新导出核对结果。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
