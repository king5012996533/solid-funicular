-- 音频/音乐生成：新增一类生成任务（2026-09-26）
--
-- 为什么音频要独立成一类，而不是塞进 VIDEO：
--   1. 上游形状不同 —— 厂商的语音/音乐产品线通常是独立端点与独立请求体，
--      复用 /videos 会把方言差异越堆越脏；
--   2. 计费单位不同 —— 音频常按次或按字符/秒计价，跟视频的按秒不是一回事，
--      混在一起定价表与参数校验都说不清。
--
-- 关于 ENUM 的写法：这里用 MODIFY COLUMN 重写整列，并把新值插在中间（与 prisma/schema.prisma 的顺序一致）。
-- MySQL 的 ENUM 变更按**字符串值**做映射，只要旧值一个不少，存量行就不会错位；
-- 「落库时索引变化」这件事只影响按 ENUM 排序，本表没有按它排序的需求。

-- 1. 模型分类：ai_models 与 ai_provider_custom_models 两张表都要加 AUDIO
ALTER TABLE `ai_models`
  MODIFY COLUMN `category` ENUM('CHAT', 'IMAGE', 'VIDEO', 'AUDIO') NOT NULL COMMENT '模型分类';

ALTER TABLE `ai_provider_custom_models`
  MODIFY COLUMN `category` ENUM('CHAT', 'IMAGE', 'VIDEO', 'AUDIO') NOT NULL COMMENT '模型分类：对话、图片、视频、音频';

-- 2. 计价表跟着分类走
ALTER TABLE `model_pricing`
  MODIFY COLUMN `type` ENUM('CHAT', 'IMAGE', 'VIDEO', 'AUDIO') NOT NULL;

-- 3. 生成记录 / 产物类型
ALTER TABLE `generation_records`
  MODIFY COLUMN `type` ENUM('AGENT', 'IMAGE', 'VIDEO', 'AUDIO', 'DIGITAL_HUMAN', 'MOTION') NOT NULL COMMENT '生成类型';

ALTER TABLE `generation_outputs`
  MODIFY COLUMN `output_type` ENUM('IMAGE', 'VIDEO', 'AUDIO', 'TEXT', 'FILE') NOT NULL COMMENT '输出类型';

-- 4. 厂商与用户渠道：各加一列音频端点（默认值只是占位，真实取值由后台配置决定）
ALTER TABLE `ai_providers`
  ADD COLUMN `audio_endpoint` VARCHAR(255) NOT NULL DEFAULT '/audio/generations' COMMENT '音频端点' AFTER `video_endpoint`;

ALTER TABLE `ai_provider_configs`
  ADD COLUMN `audio_endpoint` VARCHAR(255) NOT NULL DEFAULT '/audio/generations' COMMENT '音频端点' AFTER `video_endpoint`;
