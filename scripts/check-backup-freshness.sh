#!/usr/bin/env bash
#
# 备份新鲜度检查：最新一份备份超过阈值即告警并非零退出（可挂 cron/systemd timer）。
#
# 老项目 /root/check-server.sh 里有同类检查，新项目以前完全没有 —— 这里补上。
#
# 用法：
#   BACKUP_DIR=./backups scripts/check-backup-freshness.sh
#
# 可选环境变量：
#   BACKUP_DIR           备份目录（默认 <仓库根>/backups）
#   BACKUP_MAX_AGE_HOURS 允许的最大间隔小时（默认 26，容忍一次日备失败）
#   BACKUP_ALERT_WEBHOOK 失败时 POST JSON 告警
#
# 退出码：0 新鲜；1 过期或无备份；2 用法/环境错误。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"

err() { echo "[check-backup] $*" >&2; }

send_alert() {
  local message="$1"
  err "告警：$message"
  if [[ -n "${BACKUP_ALERT_WEBHOOK:-}" ]]; then
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"[备份新鲜度] ${message}\"},\"text\":\"[备份新鲜度] ${message}\"}" \
      "$BACKUP_ALERT_WEBHOOK" >/dev/null 2>&1 || err "告警发送失败（webhook 不可达）"
  fi
}

if [[ ! -d "$BACKUP_DIR" ]]; then
  send_alert "备份目录不存在：$BACKUP_DIR"
  exit 1
fi

latest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sql.gz' -printf '%T@\t%p\n' | sort -rn | head -n1 | cut -f2-)"
if [[ -z "$latest" ]]; then
  send_alert "备份目录里没有任何 .sql.gz 备份：$BACKUP_DIR"
  exit 1
fi

now="$(date +%s)"
mtime="$(stat -c %Y "$latest")"
age_hours="$(( (now - mtime) / 3600 ))"

if (( age_hours > BACKUP_MAX_AGE_HOURS )); then
  send_alert "最新备份已过期：${latest}（${age_hours} 小时前，阈值 ${BACKUP_MAX_AGE_HOURS} 小时）"
  exit 1
fi

echo "[check-backup] 备份新鲜：${latest}（${age_hours} 小时前）"
