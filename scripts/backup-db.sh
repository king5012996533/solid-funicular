#!/usr/bin/env bash
#
# 数据库逻辑备份：mysqldump + gzip + 轮转 + 失败告警（非零退出）。
#
# 用法（推荐，从 DATABASE_URL 解析）：
#   DATABASE_URL='mysql://user:pass@host:3306/canana_mind' scripts/backup-db.sh
# 用法（拆分字段）：
#   MYSQL_HOST=127.0.0.1 MYSQL_USER=canana MYSQL_PASSWORD=*** MYSQL_DATABASE=canana_mind scripts/backup-db.sh
#
# 可选环境变量：
#   BACKUP_DIR             备份输出目录（默认 <仓库根>/backups）
#   BACKUP_RETENTION_DAYS  保留天数（默认 14）
#   BACKUP_MIN_KEEP        至少保留份数，避免被清空（默认 7）
#   BACKUP_ALERT_WEBHOOK   失败时 POST JSON 告警（飞书/钉钉/Slack 自定义机器人均可）
#   MYSQLDUMP_BIN          mysqldump 可执行文件（默认 mysqldump）
#   BACKUP_UPLOADS_DIR     设置后额外打包该上传目录；不设置则只备库
#
# 退出码：0 成功；非 0 失败（stderr 写明原因，并在配置了 webhook 时发告警）。
#
# 说明：上传文件建议由对象存储承担备份；只有本地上传目录的场景才用 BACKUP_UPLOADS_DIR。
#
# 注意 -E（errtrace）：若不开启，ERR trap 不会被 main 函数继承，
# 失败时清理临时文件/发告警的 on_error 不会执行（会让 .partial 残留、告警丢失）。
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_MIN_KEEP="${BACKUP_MIN_KEEP:-7}"
MYSQLDUMP_BIN="${MYSQLDUMP_BIN:-mysqldump}"
MYSQLDUMP_EXTRA_OPTIONS="${MYSQLDUMP_EXTRA_OPTIONS:-}"

DB_HOST="${MYSQL_HOST:-}"
DB_PORT="${MYSQL_PORT:-3306}"
DB_USER="${MYSQL_USER:-}"
DB_PASS="${MYSQL_PASSWORD:-}"
DB_NAME="${MYSQL_DATABASE:-}"

TMP_FILE=""

log() { echo "[backup-db] $*"; }
err() { echo "[backup-db] $*" >&2; }

# 发送失败告警；未配置 webhook 时只写日志。
send_alert() {
  local message="$1"
  err "告警：$message"
  if [[ -n "${BACKUP_ALERT_WEBHOOK:-}" ]]; then
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"[数据库备份] ${message}\"},\"text\":\"[数据库备份] ${message}\"}" \
      "$BACKUP_ALERT_WEBHOOK" >/dev/null 2>&1 || err "告警发送失败（webhook 不可达）"
  fi
}

# 从 DATABASE_URL 解析连接信息（形如 mysql://user:pass@host:port/db?params）。
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

on_error() {
  local exit_code=$?
  if [[ -n "$TMP_FILE" ]]; then
    rm -f "$TMP_FILE"
  fi
  err "备份失败（退出码 ${exit_code}）"
  send_alert "备份失败：${DB_NAME:-?}@${DB_HOST:-?}，退出码 ${exit_code}"
  exit "$exit_code"
}
trap on_error ERR

# 轮转：保留最近 BACKUP_MIN_KEEP 份，超出的按 BACKUP_RETENTION_DAYS 删除。
rotate_backups() {
  local files=()
  mapfile -t files < <(
    find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sql.gz' -printf '%T@\t%p\n' \
      | sort -rn | cut -f2-
  )

  local total="${#files[@]}"
  local keep="${BACKUP_MIN_KEEP}"
  local deleted=0

  local index
  for ((index = keep; index < total; index++)); do
    local file="${files[$index]}"
    if [[ -n "$(find "$file" -maxdepth 0 -mtime "+${BACKUP_RETENTION_DAYS}" -print -quit 2>/dev/null)" ]]; then
      rm -f -- "$file"
      deleted=$((deleted + 1))
    fi
  done

  log "轮转完成：共 ${total} 份，本轮删除 ${deleted} 份（保留 ≥${keep} 份 / ${BACKUP_RETENTION_DAYS} 天内）"
}

main() {
  resolve_database_url
  [[ -n "$DB_HOST" ]] || { err "缺少数据库地址（DATABASE_URL 或 MYSQL_HOST）"; exit 2; }
  [[ -n "$DB_USER" ]] || { err "缺少数据库用户（MYSQL_USER）"; exit 2; }
  [[ -n "$DB_NAME" ]] || { err "缺少数据库名（MYSQL_DATABASE）"; exit 2; }

  command -v "$MYSQLDUMP_BIN" >/dev/null 2>&1 || { err "找不到 $MYSQLDUMP_BIN"; exit 2; }
  command -v gzip >/dev/null 2>&1 || { err "找不到 gzip"; exit 2; }

  mkdir -p "$BACKUP_DIR"

  local timestamp
  timestamp="$(date +%Y%m%d_%H%M%S)"
  local final_file="$BACKUP_DIR/${DB_NAME}_${timestamp}.sql.gz"
  TMP_FILE="$final_file.partial"

  log "开始备份 ${DB_NAME}@${DB_HOST}:${DB_PORT} → ${final_file}"

  # --single-transaction 不锁表（InnoDB）；MYSQL_PWD 避免密码出现在命令行/ps 里。
  # shellcheck disable=SC2086
  MYSQL_PWD="$DB_PASS" "$MYSQLDUMP_BIN" \
    --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
    --single-transaction --quick --routines --triggers --events \
    --hex-blob --default-character-set=utf8mb4 --set-gtid-purged=OFF --no-tablespaces \
    $MYSQLDUMP_EXTRA_OPTIONS \
    "$DB_NAME" | gzip -c > "$TMP_FILE"

  # 校验产物有效，再原子改名，避免半截/空文件被当成有效备份。
  [[ -s "$TMP_FILE" ]] || { err "备份文件为空"; false; }
  gzip -t "$TMP_FILE" 2>/dev/null || { err "gzip 校验失败"; false; }
  # gzip 空流的文件仍有几十字节，所以还要看解压后是否有内容。
  [[ -n "$(gunzip -c "$TMP_FILE" | head -c 1)" ]] || { err "备份内容为空，判定为失败"; false; }
  mv "$TMP_FILE" "$final_file"
  TMP_FILE=""

  local size
  size="$(du -h "$final_file" | cut -f1)"
  log "数据库备份完成：${final_file}（${size}）"

  # 上传目录备份（可选）。生产建议直接由对象存储承担，见 docs/ops/backup-restore.md。
  if [[ -n "${BACKUP_UPLOADS_DIR:-}" ]]; then
    if [[ -d "$BACKUP_UPLOADS_DIR" ]]; then
      local uploads_archive="$BACKUP_DIR/uploads_${timestamp}.tar.gz"
      log "打包上传目录 ${BACKUP_UPLOADS_DIR} → ${uploads_archive}"
      tar -czf "$uploads_archive" -C "$(dirname "$BACKUP_UPLOADS_DIR")" "$(basename "$BACKUP_UPLOADS_DIR")"
      log "上传目录备份完成：${uploads_archive}（$(du -h "$uploads_archive" | cut -f1)）"
    else
      log "跳过上传目录备份：${BACKUP_UPLOADS_DIR} 不存在"
    fi
  fi

  rotate_backups
}

main "$@"
