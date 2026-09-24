#!/usr/bin/env bash
#
# 从 mysqldump 备份恢复数据库（对应 scripts/backup-db.sh 的产物）。
#
# 用法：
#   RESTORE_CONFIRM=yes DATABASE_URL='mysql://user:pass@host:3306/canana_mind' \
#     scripts/restore-db.sh backups/canana_mind_20260925_030000.sql.gz
#
# 支持 .sql.gz / .sql 两种备份。
#
# 安全护栏：必须显式设置 RESTORE_CONFIRM=yes，否则直接拒绝执行 ——
# 恢复会覆盖目标库现有数据，本脚本刻意做成"不能手滑跑起来"。
#
# 退出码：0 成功；非 0 失败。
set -euo pipefail

MYSQL_BIN="${MYSQL_BIN:-mysql}"

DB_HOST="${MYSQL_HOST:-}"
DB_PORT="${MYSQL_PORT:-3306}"
DB_USER="${MYSQL_USER:-}"
DB_PASS="${MYSQL_PASSWORD:-}"
DB_NAME="${MYSQL_DATABASE:-}"

log() { echo "[restore-db] $*"; }
err() { echo "[restore-db] $*" >&2; }

resolve_database_url() {
  [[ -n "${DATABASE_URL:-}" ]] || return 0

  if [[ "${DATABASE_URL}" =~ ^mysql://([^:/@]+)(:([^@]*))?@([^:/]+)(:([0-9]+))?/([^?]+) ]]; then
    DB_USER="${BASH_REMATCH[1]}"
    DB_PASS="${BASH_REMATCH[3]:-}"
    DB_HOST="${BASH_REMATCH[4]}"
    DB_PORT="${BASH_REMATCH[6]:-$DB_PORT}"
    DB_NAME="${BASH_REMATCH[7]}"
  else
    err "无法解析 DATABASE_URL（期望 mysql://user:pass@host:port/db）"
    return 1
  fi
}

main() {
  local backup_file="${1:-}"
  [[ -n "$backup_file" ]] || { err "用法：RESTORE_CONFIRM=yes DATABASE_URL=... scripts/restore-db.sh <备份文件.sql.gz|.sql>"; exit 2; }
  [[ -f "$backup_file" ]] || { err "备份文件不存在：$backup_file"; exit 2; }

  if [[ "${RESTORE_CONFIRM:-}" != "yes" ]]; then
    err "拒绝执行：恢复会覆盖目标库数据。确认无误请加 RESTORE_CONFIRM=yes 重跑。"
    exit 3
  fi

  resolve_database_url
  [[ -n "$DB_HOST" ]] || { err "缺少数据库地址（DATABASE_URL 或 MYSQL_HOST）"; exit 2; }
  [[ -n "$DB_USER" ]] || { err "缺少数据库用户（MYSQL_USER）"; exit 2; }
  [[ -n "$DB_NAME" ]] || { err "缺少数据库名（MYSQL_DATABASE）"; exit 2; }

  command -v "$MYSQL_BIN" >/dev/null 2>&1 || { err "找不到 $MYSQL_BIN"; exit 2; }

  log "即将把 $backup_file 恢复到 ${DB_NAME}@${DB_HOST}:${DB_PORT}（用户 ${DB_USER}）"
  log "提示：恢复前请先停掉应用，避免写入竞争；恢复后核对行数并重启。"

  if [[ "$backup_file" == *.gz ]]; then
    gunzip -c "$backup_file" | MYSQL_PWD="$DB_PASS" "$MYSQL_BIN" \
      --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
      --default-character-set=utf8mb4 "$DB_NAME"
  else
    MYSQL_PWD="$DB_PASS" "$MYSQL_BIN" \
      --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
      --default-character-set=utf8mb4 "$DB_NAME" < "$backup_file"
  fi

  log "恢复完成：${DB_NAME}@${DB_HOST}:${DB_PORT}"
}

main "$@"
