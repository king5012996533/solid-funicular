<template>
  <section class="agent-result-section">
    <div v-if="summary" class="agent-result-summary">
      {{ summary }}
    </div>
    <div v-if="images.length" class="agent-result-grid">
      <div
        v-for="image in images"
        :key="image.id"
        class="agent-result-card"
      >
        <!-- 与首页同一批第三方图：带 Referer 会被防盗链拒（403 XML → Chrome ORB 拦掉）→ 裂图。
             这里同样不发 Referer，并在失败时收起这张卡而不是画裂图。 -->
        <img
          v-if="image.imageSrc && !failedIds.has(image.id)"
          :src="image.imageSrc"
          referrerpolicy="no-referrer"
          :alt="image.promptText || image.id"
          class="agent-result-image"
          @error="markFailed(image.id)"
        >
        <div v-else class="agent-result-image agent-result-image--fallback" aria-hidden="true" />
        <div v-if="image.promptText" class="agent-result-caption">
          {{ image.promptText }}
        </div>
      </div>
    </div>
    <div v-if="images.length" class="agent-result-footer">
      <div class="agent-result-notice">以上内容由 AI 生成</div>
      <div class="agent-result-actions">
        <button class="agent-result-action primary" type="button">重新生成</button>
        <button class="agent-result-action icon-only" type="button" aria-label="点赞">喜欢</button>
        <button class="agent-result-action icon-only" type="button" aria-label="更多">更多</button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'

/** 加载失败的图：失败就换成中性底，别让浏览器画裂图图标 */
const failedIds = ref(new Set<string>())
const markFailed = (id: string) => {
  const next = new Set(failedIds.value)
  next.add(id)
  failedIds.value = next
}

import { computed } from 'vue'
import type { AgentImageResult } from '@/types/agent'

const props = defineProps<{
  summary?: string
  images?: AgentImageResult[]
}>()

const images = computed(() => props.images || [])
</script>

<style scoped>
.agent-result-section {
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin-top: 26px;
}

.agent-result-summary {
  max-width: 820px;
  color: rgba(255, 255, 255, 0.68);
  font-size: 13px;
  line-height: 22px;
}

.agent-result-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.agent-result-card {
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  transition: transform 0.18s ease, border-color 0.18s ease, background-color 0.18s ease;
}

.agent-result-card:hover {
  transform: translateY(-1px);
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.045);
}

.agent-result-image--fallback {
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02)),
    var(--bg-block-secondary-default, rgba(255, 255, 255, 0.04));
}

.agent-result-image {
  display: block;
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
}

.agent-result-caption {
  padding: 9px 10px 11px;
  color: rgba(255, 255, 255, 0.56);
  font-size: 12px;
  line-height: 18px;
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.agent-result-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 32px;
}

.agent-result-notice {
  color: rgba(255, 255, 255, 0.42);
  font-size: 12px;
  line-height: 18px;
}

.agent-result-actions {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.agent-result-action {
  height: 32px;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.72);
  font-size: 12px;
  cursor: pointer;
}

.agent-result-action.primary {
  padding: 0 14px;
}

.agent-result-action.icon-only {
  min-width: 32px;
  padding: 0 10px;
}

@media (max-width: 1200px) {
  .agent-result-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 768px) {
  .agent-result-grid {
    grid-template-columns: 1fr;
  }

  .agent-result-footer {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
