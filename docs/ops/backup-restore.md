# 数据库备份与恢复

> 适用对象：线上 MySQL/MariaDB（`DATABASE_URL` 指向的库）、本地演练。
> 相关脚本：`scripts/backup-db.sh`、`scripts/restore-db.sh`、`scripts/check-backup-freshness.sh`。

## 1. 为什么要有这个

上线审计发现：老项目 `/root/check-server.sh` 里有备份新鲜度检查，新项目**没有任何备份机制**。
数据库里是用户、点数、生成记录、厂商密钥密文，丢一次无法重建。本页给出可执行的最小备份链路。

## 2. 备份脚本

`scripts/backup-db.sh`：

- `mysqldump --single-transaction` 逻辑备份（不锁表），`gzip` 压缩；
- 产物先写 `.partial`，校验非空且 `gzip -t` 通过后再原子改名，避免半截文件被当成有效备份；
- **轮转**：保留最近 `BACKUP_MIN_KEEP`（默认 7）份，其余超过 `BACKUP_RETENTION_DAYS`（默认 14 天）才删；
- **失败告警 + 非零退出**：任一步失败都会写 stderr，并在配置了 `BACKUP_ALERT_WEBHOOK` 时发 JSON 告警。

常用变量：

| 变量                    | 默认               | 说明                                               |
| ----------------------- | ------------------ | -------------------------------------------------- |
| `DATABASE_URL`          | 无                 | `mysql://user:pass@host:3306/db`，或改用 `MYSQL_*` |
| `BACKUP_DIR`            | `<仓库根>/backups` | 备份输出目录                                       |
| `BACKUP_RETENTION_DAYS` | `14`               | 保留天数                                           |
| `BACKUP_MIN_KEEP`       | `7`                | 至少保留份数                                       |
| `BACKUP_ALERT_WEBHOOK`  | 空                 | 失败告警 webhook（飞书/钉钉/Slack 自定义机器人）   |
| `BACKUP_UPLOADS_DIR`    | 空                 | 设置后额外 `tar` 打包上传目录                      |
| `MYSQLDUMP_BIN`         | `mysqldump`        | 可执行文件路径                                     |

### 手动执行

```bash
DATABASE_URL='mysql://user:pass@host:3306/canana_mind' \
  BACKUP_DIR=/var/backups/canana \
  scripts/backup-db.sh
```

### 定时执行（cron 示例）

```cron
# 每天 03:10 备份，日志留在 /var/log
10 3 * * * cd /opt/canana && DATABASE_URL="$(cat deploy/.env.production | grep ^DATABASE_URL= | cut -d= -f2-)" BACKUP_DIR=/var/backups/canana BACKUP_ALERT_WEBHOOK="https://open.feishu.cn/.../hook/xxx" BACKUP_UPLOADS_DIR=/var/lib/docker/volumes/... /opt/canana/scripts/backup-db.sh >> /var/log/canana-backup.log 2>&1
```

### 新鲜度检查（防"备份其实早停了"）

```cron
# 每天 09:00 校验：最新备份超过 26 小时即告警并非零退出
0 9 * * * BACKUP_DIR=/var/backups/canana BACKUP_ALERT_WEBHOOK="..." /opt/canana/scripts/check-backup-freshness.sh
```

## 3. 恢复步骤

> ⚠️ 恢复会**覆盖目标库现有数据**。脚本要求显式 `RESTORE_CONFIRM=yes` 才会执行。

1. **停应用**（避免恢复期间写入竞争）：
   ```bash
   cd <部署目录> && docker compose stop app
   ```
2. **先备份当前库**（万一恢复的备份选错，还能退回去）：
   ```bash
   DATABASE_URL=... scripts/backup-db.sh
   ```
3. **恢复**：
   ```bash
   RESTORE_CONFIRM=yes DATABASE_URL='mysql://user:pass@host:3306/canana_mind' \
     scripts/restore-db.sh /var/backups/canana/canana_mind_20260925_031000.sql.gz
   ```
4. **核对**：对照备份前的行数检查关键表：
   ```sql
   SELECT (SELECT COUNT(*) FROM users) users,
          (SELECT COUNT(*) FROM generation_records) records,
          (SELECT COUNT(*) FROM ai_providers) providers;
   ```
5. **重启应用**并看 readiness：
   ```bash
   docker compose start app
   curl -fsS http://127.0.0.1:5409/api/ready
   ```

### 只恢复单表（可选）

`mysqldump` 产物是标准 SQL，可先解压出需要的表段再喂给 mysql：

```bash
gunzip -c backup.sql.gz | sed -n '/^-- Table structure for table `users`/,/^-- Dump completed/p' | mysql ...
```

## 4. 上传目录的备份

- **生产推荐由对象存储承担**：上传走 S3 兼容存储时，备份/版本化交给对象存储的生命周期策略，仓库侧不重复做。
- **仍在本地上传目录**（`UPLOADS_DIR` / compose 的 `uploads_data` 卷）的场景：
  - 备份：`BACKUP_UPLOADS_DIR=/app/uploads scripts/backup-db.sh`（额外产出 `uploads_<时间戳>.tar.gz`）；
  - 或对卷单独做快照；
  - 恢复：停应用后解包回原目录，再启动。

## 5. 本地演练（不连生产）

本脚本不依赖数据库内部逻辑，可用一个假的 `mysqldump` 在本地完整演练"成功 / 轮转 / 失败非零退出"三条路径：

```bash
tmp=$(mktemp -d)
printf '#!/usr/bin/env bash\necho "-- fake dump"\n' > "$tmp/mysqldump"; chmod +x "$tmp/mysqldump"
PATH="$tmp:$PATH" DATABASE_URL='mysql://u:p@127.0.0.1:3306/canana_mind' BACKUP_DIR="$tmp/bk" scripts/backup-db.sh
ls -la "$tmp/bk"

# 失败路径：让假 mysqldump 退出 1 → 脚本应非零退出
printf '#!/usr/bin/env bash\necho boom >&2; exit 1\n' > "$tmp/mysqldump"; chmod +x "$tmp/mysqldump"
PATH="$tmp:$PATH" DATABASE_URL='mysql://u:p@127.0.0.1:3306/canana_mind' BACKUP_DIR="$tmp/bk" scripts/backup-db.sh; echo "退出码=$?"
```

> 本仓库提交时未连接任何生产库执行本脚本；生产上的首次执行请务必人工确认 `DATABASE_URL` 指向正确。
