<script setup lang="ts">
/**
 * 节点顶部悬浮工具栏（参照 RunningHUB .image-toolbar）
 *
 * 浮在节点上方居中，bottom: calc(100% + 36px)；
 * 悬浮面板 + 8px 圆角 + 1px 描边 + 阴影（对齐 LibTV 的悬浮件）；
 * 按钮 28px 高，hover 底色 --bg-block-secondary-hover；支持 divider / icon-only / has-dropdown。
 *
 * @example
 * <CanvasNodeTopToolbar :visible="isSelected" :items="[
 *   { id: 'panorama', label: '全景图', icon: Aim, hasDropdown: true, onClick: ... },
 *   { type: 'divider' },
 *   { id: 'crop', label: '裁剪', icon: Crop, iconOnly: true, onClick: ... },
 * ]" />
 */
import type { Component } from 'vue'

export interface NodeTopToolbarDropdownItem {
  id: string
  label: string
  /** 副标题，用来把「这个选项到底做什么」说清楚 */
  description?: string
  onClick: () => void
}

export interface NodeTopToolbarItem {
  /** 'divider' 时只渲染竖线 */
  type?: 'item' | 'divider'
  id?: string
  label?: string
  icon?: Component
  /** true 时不渲染 label，仅 icon */
  iconOnly?: boolean
  /** true 时尾部加 ▾ 下拉箭头 */
  hasDropdown?: boolean
  /**
   * 点击展开的菜单项。给了它就渲染成真下拉（Element Plus el-dropdown，click 触发）；
   * 只给 hasDropdown 而不给它是"有个箭头但点不出东西"，属于假入口。
   */
  dropdownItems?: NodeTopToolbarDropdownItem[]
  /** 自定义文字标记（如 "R"，代替 icon） */
  textMark?: string
  disabled?: boolean
  onClick?: () => void
}

defineProps<{
  visible?: boolean
  items: NodeTopToolbarItem[]
}>()
</script>

<template>
  <Transition name="canvas-node-top-toolbar">
    <div
      v-if="visible && items.length > 0"
      class="canvas-node-top-toolbar nodrag nopan"
      @mousedown.stop
      @click.stop
    >
      <template v-for="(item, idx) in items" :key="item.id || `divider-${idx}`">
        <div v-if="item.type === 'divider'" class="canvas-node-top-toolbar__divider" />
        <!-- 有 dropdownItems 的走真下拉；没有的还是普通按钮 -->
        <el-dropdown
          v-else-if="item.dropdownItems && item.dropdownItems.length"
          trigger="click"
          placement="bottom"
          :teleported="true"
        >
          <button
            type="button"
            class="canvas-node-top-toolbar__btn"
            :class="{ 'is-icon-only': item.iconOnly, 'has-dropdown': true }"
            :title="item.label"
          >
            <el-icon v-if="item.icon" class="canvas-node-top-toolbar__icon">
              <component :is="item.icon" />
            </el-icon>
            <span v-else-if="item.textMark" class="canvas-node-top-toolbar__text-mark">{{ item.textMark }}</span>
            <span v-if="!item.iconOnly && item.label" class="canvas-node-top-toolbar__label">{{ item.label }}</span>
            <svg
              class="canvas-node-top-toolbar__chevron"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <path d="M3 5l3 3 3-3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="action in item.dropdownItems"
                :key="action.id"
                @click="action.onClick()"
              >
                <div class="canvas-node-top-toolbar__menu-item">
                  <span class="canvas-node-top-toolbar__menu-label">{{ action.label }}</span>
                  <span v-if="action.description" class="canvas-node-top-toolbar__menu-desc">{{ action.description }}</span>
                </div>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <button
          v-else
          type="button"
          class="canvas-node-top-toolbar__btn"
          :class="{
            'is-icon-only': item.iconOnly,
            'has-dropdown': item.hasDropdown,
            'is-disabled': item.disabled,
          }"
          :disabled="item.disabled"
          :title="item.label"
          @click.stop="item.onClick && item.onClick()"
        >
          <el-icon v-if="item.icon" class="canvas-node-top-toolbar__icon">
            <component :is="item.icon" />
          </el-icon>
          <span v-else-if="item.textMark" class="canvas-node-top-toolbar__text-mark">{{ item.textMark }}</span>
          <span v-if="!item.iconOnly && item.label" class="canvas-node-top-toolbar__label">{{ item.label }}</span>
          <svg
            v-if="item.hasDropdown"
            class="canvas-node-top-toolbar__chevron"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="M3 5l3 3 3-3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </template>
    </div>
  </Transition>
</template>

<style scoped>
.canvas-node-top-toolbar {
  position: absolute;
  bottom: calc(100% + 36px);
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  background: var(--canvas-float-block-default);
  border: 1px solid var(--stroke-secondary);
  border-radius: 8px;
  box-shadow: var(--shadow-generator-float-block);
  color: var(--text-secondary);
  z-index: 50;
  pointer-events: auto;
  white-space: nowrap;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.canvas-node-top-toolbar__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* 32px 高是 LibTV 实测值（且两档缩放下都是 32，不随画布缩放） */
  height: 32px;
  padding: 0 10px;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.15s, color 0.15s;
}
.canvas-node-top-toolbar__btn:hover:not(.is-disabled) {
  background: var(--bg-block-secondary-hover);
  color: var(--text-primary);
}
.canvas-node-top-toolbar__btn.is-icon-only {
  width: 32px;
  padding: 0;
}
.canvas-node-top-toolbar__btn.is-disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.canvas-node-top-toolbar__icon {
  font-size: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.canvas-node-top-toolbar__text-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 12px;
  font-weight: 700;
  font-family: serif;
  font-style: italic;
}

.canvas-node-top-toolbar__chevron {
  width: 10px;
  height: 10px;
  opacity: 0.6;
  margin-left: -2px;
}

.canvas-node-top-toolbar__divider {
  width: 1px;
  height: 18px;
  background: var(--stroke-secondary);
  margin: 0 4px;
}

/* 下拉菜单项：一行标题 + 一行说明（说明用来说明这个选项到底做什么） */
.canvas-node-top-toolbar__menu-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0;
  max-width: 260px;
}
.canvas-node-top-toolbar__menu-label {
  font-size: 13px;
  line-height: 18px;
  color: var(--text-primary);
}
.canvas-node-top-toolbar__menu-desc {
  font-size: 11px;
  line-height: 15px;
  color: var(--text-tertiary);
}

.canvas-node-top-toolbar-enter-active,
.canvas-node-top-toolbar-leave-active {
  transition: opacity 0.16s, transform 0.16s;
}
.canvas-node-top-toolbar-enter-from,
.canvas-node-top-toolbar-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(4px);
}
</style>
