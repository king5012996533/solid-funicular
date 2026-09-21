<script setup lang="ts">
/**
 * 素材节点（清单 F6）
 *
 * 对齐 LibTV「添加节点 → 素材库」。它不是生成节点 —— 不调模型、不消耗积分，
 * 只做一件事：把资产库里的素材接到画布上，作为下游生成节点的参考图 / 首帧来源。
 *
 * 为什么要做成节点而不是面板：LibTV 的资产既是底部入口、也是画布节点。
 * 做成节点之后，"这张图从哪来"在画布上就是可见的 ——
 * 下游的参考图能顺着连线找到出处，而不是凭空出现在某个节点的参数里。
 */

import { computed, ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Picture, Delete, Upload as UploadIcon, Search } from '@element-plus/icons-vue'
import CanvasNodeHoverToolbar, { type NodeToolbarAction } from '@/components/canvas/CanvasNodeHoverToolbar.vue'
import CanvasNodeAddHandle from '@/components/canvas/CanvasNodeAddHandle.vue'
import { useNodeTitleEdit } from '@/composables/useNodeTitleEdit'
import { updateNode, removeNode, duplicateNode, type WorkflowAssetNodeData } from '../../composables/useWorkflowCanvas'
import { useNodeCollapse } from '../../composables/useNodeCollapse'
import { listAssetItems, type PersistedAssetItem } from '@/api/asset-items'

const props = defineProps<{
  id: string
  data: WorkflowAssetNodeData
  selected?: boolean
}>()

const titleEdit = useNodeTitleEdit(props.id, () => String(props.data?.label || '素材'))
const { collapsed, toggleCollapse } = useNodeCollapse(() => props.id)

const isSelected = computed(() => Boolean(props.selected))
// hover 工具条的显隐：与其它节点一致，鼠标进出时切换
const showActions = ref(false)
const assetUrl = computed(() => String(props.data?.url || ''))
const assetName = computed(() => String(props.data?.name || ''))

// === 素材库 ===
const pickerOpen = ref(false)
const loading = ref(false)
const keyword = ref('')
const assets = ref<PersistedAssetItem[]>([])

/** 只列图片素材：视频素材目前没有下游能消费（视频节点还没接后端） */
const filteredAssets = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  if (!key) return assets.value
  return assets.value.filter(item => (item.title || '').toLowerCase().includes(key))
})

const loadAssets = async () => {
  loading.value = true
  try {
    const items = await listAssetItems({ assetType: 'image', pageSize: 60 })
    assets.value = items
  } catch (error) {
    console.error('[AssetNode] 素材库加载失败', error)
    ElMessage.warning('素材库加载失败，可稍后重试或直接上传')
  } finally {
    loading.value = false
  }
}

const openPicker = () => {
  pickerOpen.value = true
  if (!assets.value.length) void loadAssets()
}

/**
 * 选中一个素材 → 写进节点 data。
 * 存 url 而不是只存 assetId：下游收集参考图读的就是 url，
 * 存下来渲染与提交都不用再查一遍资产接口。
 */
const pickAsset = (item: PersistedAssetItem) => {
  updateNode(props.id, {
    url: item.previewUrl || item.fileUrl || item.thumbnailUrl || '',
    assetId: item.id,
    assetType: 'image',
    name: item.title || '素材',
  } as Partial<WorkflowAssetNodeData>)
  pickerOpen.value = false
}

const clearAsset = () => {
  updateNode(props.id, { url: '', assetId: '', name: '' } as Partial<WorkflowAssetNodeData>)
  pickerOpen.value = false
}

// === 上传本地图片作为素材 ===
const fileInputRef = ref<HTMLInputElement | null>(null)
const triggerUpload = () => fileInputRef.value?.click()

const handleFileChange = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const { uploadStorageFile } = await import('@/api/storage')
    const uploaded = await uploadStorageFile(file, 'asset')
    const url = String((uploaded as { fileUrl?: string })?.fileUrl || '')
    if (!url) throw new Error('上传未返回地址')
    updateNode(props.id, { url, name: file.name, assetType: 'image' } as Partial<WorkflowAssetNodeData>)
  } catch (error) {
    console.error('[AssetNode] 上传失败', error)
    ElMessage.error('上传失败，请重试')
  } finally {
    input.value = ''
  }
}

// === 工具栏 ===
const handleDelete = () => removeNode(props.id)
const handleDuplicate = () => duplicateNode(props.id)

const hoverActions = computed<NodeToolbarAction[]>(() => {
  const list: NodeToolbarAction[] = [
    { id: 'duplicate', label: '复制', icon: Picture, onClick: handleDuplicate },
  ]
  if (assetUrl.value) {
    list.push({ id: 'replace', label: '换一个', icon: Search, onClick: openPicker })
  }
  list.push({ id: 'delete', label: '删除', icon: Delete, danger: true, onClick: handleDelete })
  return list
})

onMounted(() => {
  // 已经有素材就不预加载列表，省一次请求
  if (!assetUrl.value) void loadAssets()
})
</script>

<template>
  <div class="asset-node-wrapper" @mouseenter="showActions = true" @mouseleave="showActions = false">
    <!-- 标题：与其它节点一致，折叠开关在图标之前 -->
    <div class="asset-node-title" :title="titleEdit.editing.value ? '' : '双击编辑名称'" @dblclick.stop="titleEdit.start">
      <button
        type="button"
        class="node-collapse-toggle nodrag nopan"
        :class="{ 'is-collapsed': collapsed }"
        :title="collapsed ? '展开节点' : '折叠节点'"
        @click.stop="toggleCollapse"
        @mousedown.stop
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <el-icon class="asset-node-title-icon"><Picture /></el-icon>
      <input
        v-if="titleEdit.editing.value"
        :ref="titleEdit.setInputRef"
        v-model="titleEdit.draft.value"
        class="asset-node-title-input nodrag"
        :maxlength="40"
        @blur="titleEdit.commit"
        @keydown.enter.prevent="titleEdit.commit"
        @keydown.esc.prevent="titleEdit.cancel"
        @mousedown.stop
        @click.stop
      />
      <span v-else>{{ data?.label || '素材' }}</span>
    </div>

    <div class="asset-node-card" :class="{ 'is-selected': isSelected, 'is-collapsed': collapsed }">
      <!-- 折叠态：显示素材名，光看标题认不出是哪一个 -->
      <div v-if="collapsed" class="node-collapsed-summary">
        <span class="node-collapsed-summary__text">{{ assetName || '未选择素材' }}</span>
      </div>

      <template v-else>
        <!-- 已选素材 -->
        <div v-if="assetUrl" class="asset-node-picked">
          <img :src="assetUrl" :alt="assetName || '素材'" class="asset-node-image" draggable="false">
          <div class="asset-node-picked-bar">
            <span class="asset-node-picked-name" :title="assetName">{{ assetName || '素材' }}</span>
            <button type="button" class="asset-node-swap nodrag nopan" @click.stop="openPicker">换一个</button>
          </div>
        </div>

        <!-- 空态 -->
        <div v-else class="asset-node-empty">
          <div class="asset-node-empty-hint">从素材库选择一个素材，或上传新的</div>
          <button type="button" class="asset-node-empty-action nodrag nopan" @click.stop="openPicker">
            <el-icon><Search /></el-icon>
            <span>从素材库选择</span>
          </button>
          <button type="button" class="asset-node-empty-action nodrag nopan" @click.stop="triggerUpload">
            <el-icon><UploadIcon /></el-icon>
            <span>上传图片</span>
          </button>
        </div>

        <input
          ref="fileInputRef"
          type="file"
          accept="image/*"
          style="display: none"
          @change="handleFileChange"
        />
      </template>

      <!-- 素材选择面板：复用节点内的浮层形态，避免再引入一层全局弹窗 -->
      <div v-if="pickerOpen" class="asset-node-picker nodrag nopan" @mousedown.stop @click.stop>
        <div class="asset-node-picker-head">
          <span>素材库</span>
          <button type="button" class="asset-node-picker-close" @click.stop="pickerOpen = false">✕</button>
        </div>
        <input
          v-model="keyword"
          class="asset-node-picker-search"
          type="text"
          placeholder="搜索素材名"
          @mousedown.stop
        >
        <div class="asset-node-picker-body">
          <div v-if="loading" class="asset-node-picker-state">加载中…</div>
          <template v-else-if="filteredAssets.length">
            <button
              v-for="item in filteredAssets"
              :key="item.id"
              type="button"
              class="asset-node-picker-item"
              :title="item.title"
              @click.stop="pickAsset(item)"
            >
              <img :src="item.thumbnailUrl || item.previewUrl || item.fileUrl" :alt="item.title" draggable="false">
            </button>
          </template>
          <div v-else class="asset-node-picker-state">素材库还是空的</div>
        </div>
        <button v-if="assetUrl" type="button" class="asset-node-picker-clear" @click.stop="clearAsset">
          清除选择
        </button>
      </div>
    </div>

    <CanvasNodeHoverToolbar :visible="showActions" :actions="hoverActions" />

    <CanvasNodeAddHandle side="left" :visible="isSelected" />
    <CanvasNodeAddHandle side="right" :visible="isSelected" />
  </div>
</template>

<style>
.asset-node-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
}

.asset-node-title {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 22px;
  max-width: 100%;
  padding: 0 8px 0 2px;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  white-space: nowrap;
}

.asset-node-title-icon {
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-size: 14px;
}

.asset-node-title-input {
  min-width: 0;
  flex: 1;
  padding: 0 4px;
  border: none;
  border-radius: 4px;
  background: var(--bg-block-secondary-default);
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  outline: none;
}

.asset-node-card {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 260px;
  min-height: 200px;
  overflow: hidden;
  border: 1px solid var(--canvas-node-border);
  border-radius: 12px;
  background: var(--canvas-node-bg);
  box-sizing: border-box;
  transition: border-color 0.16s ease;
}

.asset-node-card.is-selected {
  border-color: var(--canvas-node-border-selected);
}

/* 已选素材：图撑满，底部一条名称栏 */
.asset-node-picked {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.asset-node-image {
  flex: 1;
  min-height: 0;
  width: 100%;
  object-fit: contain;
  background: var(--bg-block-secondary-default);
}

.asset-node-picked-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--stroke-secondary);
}

.asset-node-picked-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-node-swap {
  flex-shrink: 0;
  padding: 2px 8px;
  border: 1px solid var(--stroke-secondary);
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
}

.asset-node-swap:hover {
  color: var(--text-primary);
  background: var(--bg-block-secondary-hover);
}

/* 空态 */
.asset-node-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
}

.asset-node-empty-hint {
  margin-bottom: 4px;
  color: var(--text-tertiary);
  font-size: 13px;
  line-height: 18px;
  text-align: center;
}

.asset-node-empty-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--stroke-secondary);
  border-radius: 8px;
  background: var(--bg-block-secondary-default);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}

.asset-node-empty-action:hover {
  color: var(--text-primary);
  background: var(--bg-block-secondary-hover);
}

/* 素材选择面板 */
.asset-node-picker {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  bottom: 8px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--stroke-secondary);
  border-radius: 10px;
  background: var(--canvas-float-block-default);
  backdrop-filter: blur(var(--canvas-float-backdrop-blur, 16px));
}

.asset-node-picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--stroke-secondary);
  color: var(--text-secondary);
  font-size: 12px;
}

.asset-node-picker-close {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
}

.asset-node-picker-search {
  margin: 8px 10px 0;
  padding: 5px 8px;
  border: 1px solid var(--stroke-secondary);
  border-radius: 6px;
  background: var(--bg-block-secondary-default);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

.asset-node-picker-body {
  display: grid;
  flex: 1;
  grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
  gap: 6px;
  margin: 8px 10px;
  overflow-y: auto;
  align-content: start;
}

.asset-node-picker-item {
  padding: 0;
  aspect-ratio: 1;
  overflow: hidden;
  border: 1px solid var(--stroke-secondary);
  border-radius: 6px;
  background: var(--bg-block-secondary-default);
  cursor: pointer;
}

.asset-node-picker-item:hover {
  border-color: var(--brand-main-default);
}

.asset-node-picker-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.asset-node-picker-state {
  grid-column: 1 / -1;
  padding: 12px 0;
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: center;
}

.asset-node-picker-clear {
  margin: 0 10px 10px;
  padding: 5px 0;
  border: 1px solid var(--stroke-secondary);
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
}

.asset-node-picker-clear:hover {
  color: var(--text-primary);
  background: var(--bg-block-secondary-hover);
}
</style>
