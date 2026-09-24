# 发布、回滚与镜像保留策略

> 相关文件：`.github/workflows/docker-image.yml`、`.github/workflows/deploy.yml`、`docker-compose.yml`。

## 1. 发布物与固定 tag 策略

镜像由 `docker-image.yml` 构建并推送，每次会打三类 tag：

| tag                       | 含义                     | 用途                       |
| ------------------------- | ------------------------ | -------------------------- |
| `latest`                  | 最新构建                 | 仅供本地/手工调试          |
| `v<package.json version>` | 语义版本                 | 对外发布单元               |
| `sha-<commit 短 hash>`    | 不可变，精确指向某个提交 | **生产部署与回滚都消费它** |

`deploy.yml` 部署时：

1. 由触发构建的 `head_sha` 算出 `IMAGE_TAG=sha-<短hash>`；
2. 用该 tag `docker compose pull` / `up -d`（不回落 `latest`）；
3. 把本次版本写到部署目录的 `.deployed-version`：
   ```
   IMAGE_TAG=sha-1a2b3c4
   COMMIT=<完整 sha>
   DEPLOYED_AT=<UTC 时间>
   ```
4. **不再执行 `docker image prune`** —— 上一版镜像要留着当回滚素材。

`docker-compose.yml` 里镜像是 `couei/canana-vue:${IMAGE_TAG:-latest}`，tag 由环境变量注入。

## 2. 回滚步骤

回滚 = 换回上一个镜像 tag 重启，**不改数据库结构**。

1. 在服务器上看这次部署了什么、上一版是什么：
   ```bash
   cd <DEPLOY_DIR>
   cat .deployed-version
   docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedSince}}' | grep canana-vue
   ```
2. 选定要回滚到的 tag（例如上一版 `sha-9f8e7d6`，或更早的 `v1.0.2`）。
3. 用该 tag 重新拉起：
   ```bash
   IMAGE_TAG=sha-9f8e7d6 docker compose pull
   IMAGE_TAG=sha-9f8e7d6 docker compose up -d --force-recreate --remove-orphans
   printf 'IMAGE_TAG=%s\nROLLED_BACK_AT=%s\n' sha-9f8e7d6 "$(date -u +%FT%TZ)" >> .deployed-version
   ```
4. 验证：
   ```bash
   curl -fsS http://127.0.0.1:5409/api/ready   # 应 200
   ```

> 若回滚目标镜像在服务器上已被删除（比如手工执行过 prune），先 `docker pull couei/canana-vue:sha-9f8e7d6` 拉回来。

## 3. 数据库迁移与回滚

- 迁移由 `prisma migrate deploy` 在**每次容器启动时自动、单向**执行，Prisma **没有 down 迁移**。
- 现有 14 个迁移均为增量（无 `DROP TABLE/COLUMN`、无 `TRUNCATE`），所以**代码回滚通常不需要动 schema**。
- 一旦某次迁移改坏了数据：代码回滚救不回来，只能走 [数据库恢复](backup-restore.md)。
  **因此：含破坏性变更的迁移，必须先做备份再发布。**

## 4. 发布前置检查清单

- [ ] `npm run type-check`、`npm run type-check:server`、`npm test` 全绿
- [ ] `package.json` 版本号已升（决定 `vX.Y.Z` tag）
- [ ] 若本次含破坏性迁移：已手工备份（`scripts/backup-db.sh`）
- [ ] 发布后确认 `/api/ready` 返回 200（CI 会自动探一次）
- [ ] 记录 `.deployed-version`，确认上一版镜像仍在 `docker images` 里

## 5. 回滚演练建议

至少演练一次：在预发/本地起两版镜像，用 `IMAGE_TAG` 来回切，确认回滚命令可用、耗时可控。
首次真正回滚不要发生在事故现场。
