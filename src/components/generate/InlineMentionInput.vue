<script setup lang="ts">
/**
 * 内联 @ 引用输入框（清单 F8）
 *
 * LibTV 的 @ 引用是内联 chip，不是纯文本，所以输入框必须是 contenteditable。
 * 但这里**不引入富文本模型**：纯文本（`@图片1` 这种 token）始终是唯一真相，
 * DOM 只是它的投影 —— 每次输入都把 DOM 序列化回纯文本 emit 出去。
 * 这样 reference-resolver 的解析层一个字都不用改，提交载荷也与 textarea 完全一致。
 *
 * 中文 IME 是本组件最大的风险，三条硬约束：
 *   1. composition 期间绝不读写 DOM（重建节点会把输入法的候选词状态打断）；
 *   2. 上屏后才补一次序列化（部分输入法最后那次 input 仍带 isComposing，只靠 input 会丢字）；
 *   3. 重渲染后按**纯文本偏移**还原光标 —— chip 是 contenteditable=false 的原子节点，
 *      按 DOM 偏移还原会在 chip 前后偏差一位。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  REFERENCE_TOKEN_PATTERN,
  type ReferenceableAsset,
} from '@/views/workflow/composables/reference-resolver'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  /** 单行模式（折叠态）：Enter 一律提交，不接受换行 */
  singleLine?: boolean
  /** 可引用资产：只用来给 chip 补展示名与种类；取不到也不影响解析（token 本身自足） */
  assets?: ReferenceableAsset[]
  ariaLabel?: string
}>(), {
  placeholder: '',
  singleLine: false,
  assets: () => [],
  ariaLabel: '',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** 用户改动了内容：带上纯文本与光标偏移，上层据此判断「是不是刚敲下 @」 */
  input: [payload: { value: string; caret: number }]
  /** 回车（非 Shift）：语义是「发送」，发不发由上层决定 */
  submit: []
}>()

const rootRef = ref<HTMLElement | null>(null)
/** 组字标志：为真时一切 DOM 读写都停手 */
const isComposing = ref(false)
const isEmpty = ref(true)

/** chip 上存 token 原文的属性名：序列化时直接读它，不依赖视觉文本 */
const CHIP_ATTRIBUTE = 'data-mention-token'

interface MentionSegment {
  /** 非空表示这一段是 chip，值是 token 文案（不含 @） */
  token: string | null
  text: string
}

/**
 * 把纯文本切成「文本段 / chip 段」。
 *
 * 光标正好贴在某个 token 末尾时**不转 chip**：那多半是用户正在手敲 `@图片1`，
 * 立刻转成不可编辑的 chip 后，下一个数字字符就接不上去（chip 里放不进光标）。
 * 等敲了分隔符（插入时补的那个空格）或光标移开，下一轮重建才收成 chip。
 */
const segmentPlainText = (value: string, caret: number): MentionSegment[] => {
  const source = String(value ?? '')
  const pattern = new RegExp(REFERENCE_TOKEN_PATTERN.source, 'g')
  const segments: MentionSegment[] = []
  const pushText = (text: string) => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (last && last.token === null) last.text += text
    else segments.push({ token: null, text })
  }

  let cursor = 0
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const tokenText = match[0]
    const tokenEnd = match.index + tokenText.length
    pushText(source.slice(cursor, match.index))
    if (caret === tokenEnd) pushText(tokenText)
    else segments.push({ token: tokenText.slice(1), text: '' })
    cursor = tokenEnd
  }
  pushText(source.slice(cursor))
  return segments
}

const isChip = (node: Node): node is HTMLElement =>
  node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).hasAttribute(CHIP_ATTRIBUTE)

/** 一个 DOM 节点在「纯文本」里占多少字符 */
const nodePlainText = (node: Node): string => {
  if (isChip(node)) return node.getAttribute(CHIP_ATTRIBUTE) || ''
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || ''
  // 浏览器偶尔会自己塞进 <br> / <div>（拖拽、输入法补字等），按等价纯文本认下来，
  // 免得序列化把它们吞掉导致「看到的」与「发出去的」不一致
  if (node.nodeName === 'BR') return '\n'
  return node.textContent || ''
}

const serializePlainText = (root: HTMLElement): string => {
  let text = ''
  root.childNodes.forEach((node) => { text += nodePlainText(node) })
  return text
}

/** 当前光标对应的纯文本偏移；不在编辑器内或不是折叠选区时返回 -1 */
const readCaretOffset = (): number => {
  const root = rootRef.value
  const selection = window.getSelection()
  if (!root || !selection || selection.rangeCount === 0) return -1
  const range = selection.getRangeAt(0)
  if (!range.collapsed || !root.contains(range.startContainer)) return -1

  const children = Array.from(root.childNodes)
  let offset = 0
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child === range.startContainer) {
      if (child.nodeType === Node.TEXT_NODE) return offset + Math.min(range.startOffset, nodePlainText(child).length)
      // chip 是原子：光标只可能落在它的前边界或后边界
      return range.startOffset > 0 ? offset + nodePlainText(child).length : offset
    }
    if (range.startContainer === root && index === range.startOffset) return offset
    offset += nodePlainText(child).length
  }
  return range.startContainer === root ? offset : -1
}

const setCaretOffset = (offset: number) => {
  const root = rootRef.value
  const selection = window.getSelection()
  if (!root || !selection) return

  const children = Array.from(root.childNodes)
  const total = children.reduce((sum, child) => sum + nodePlainText(child).length, 0)
  const target = Math.max(0, Math.min(offset, total))
  const range = document.createRange()
  let offsetBefore = 0
  let placed = false

  for (const child of children) {
    const length = nodePlainText(child).length
    if (child.nodeType === Node.TEXT_NODE) {
      if (target <= offsetBefore + length) {
        range.setStart(child, target - offsetBefore)
        placed = true
        break
      }
      offsetBefore += length
      continue
    }
    // chip 是原子：目标落在它内部（或正好在它前面）时夹到前边界；
    // 正好等于后边界时继续往后走，让光标落到下一个节点头上
    if (target < offsetBefore + length) {
      range.setStartBefore(child)
      placed = true
      break
    }
    offsetBefore += length
  }

  if (!placed) range.setStart(root, children.length)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

const resolveAsset = (token: string): ReferenceableAsset | undefined =>
  props.assets.find((asset) => asset.token === token)

const buildChip = (token: string): HTMLElement => {
  const asset = resolveAsset(token)
  const chip = document.createElement('span')
  chip.className = 'inline-mention-chip'
  // chip 整体不可编辑：光标进不去、Backspace 一次删掉整个引用 —— 这正是「引用是一个整体」
  chip.setAttribute('contenteditable', 'false')
  chip.setAttribute(CHIP_ATTRIBUTE, `@${token}`)
  chip.setAttribute('data-mention-kind', asset?.kind || 'text')
  chip.setAttribute('title', asset?.displayName || token)
  // chip 上显示 token 原文：纯文本里写的就是它，视觉升级不改语义
  chip.textContent = `@${token}`
  return chip
}

/**
 * 重建 DOM。caret 用纯文本偏移给出（-1 表示不关心）。
 * 只有编辑器正持有焦点时才动选区：否则会把光标从别的输入框「拽」过来。
 */
const render = (value: string, caret: number) => {
  const root = rootRef.value
  if (!root) return

  const fragment = document.createDocumentFragment()
  for (const segment of segmentPlainText(value, caret)) {
    fragment.appendChild(segment.token ? buildChip(segment.token) : document.createTextNode(segment.text))
  }
  root.replaceChildren(fragment)
  isEmpty.value = value.length === 0

  if (caret >= 0 && document.activeElement === root) setCaretOffset(caret)
}

/** 已渲染的 DOM 是否已经等于目标形态：相等就一个节点都不动，光标与输入法状态原样保留 */
const domMatches = (root: HTMLElement, value: string, caret: number): boolean => {
  if (serializePlainText(root) !== value) return false
  // 只比 chip 的序列，不比节点种类：换行既可能是浏览器塞的 <br>（Shift+Enter），
  // 也可能是文本里的 '\n'，两者序列化后等价，不该因此重建 DOM
  const desired = segmentPlainText(value, caret).filter(segment => segment.token)
  const chips = Array.from(root.childNodes).filter(isChip)
  if (chips.length !== desired.length) return false
  return chips.every((chip, index) => {
    const token = desired[index]?.token
    return token !== undefined && chip.getAttribute(CHIP_ATTRIBUTE) === `@${token}`
  })
}

const syncDom = (value: string, caret: number) => {
  const root = rootRef.value
  if (!root) return
  const resolved = caret < 0 ? value.length : Math.min(caret, value.length)
  if (domMatches(root, value, resolved)) return
  render(value, resolved)
}

const emitFromDom = () => {
  const root = rootRef.value
  if (!root) return
  const value = serializePlainText(root)
  const caret = readCaretOffset()
  isEmpty.value = value.length === 0
  emit('update:modelValue', value)
  emit('input', { value, caret })
  syncDom(value, caret)
}

const handleInput = (event: Event) => {
  // 组字期间只更新「空/非空」这一个显示状态；读写 DOM 一律停手，否则候选词会被打断
  isEmpty.value = (rootRef.value ? serializePlainText(rootRef.value) : props.modelValue).length === 0
  if (isComposing.value || (event as InputEvent).isComposing === true) return
  emitFromDom()
}

const handleCompositionStart = () => {
  isComposing.value = true
}

const handleCompositionEnd = () => {
  isComposing.value = false
  // 上屏这一刻 DOM 已是最终文本；部分输入法最后那次 input 仍带 isComposing，
  // 只靠 input 会漏掉收尾，所以这里补一次序列化（随后那次 input 重复一次也无害）
  emitFromDom()
}

/** 用模型层的方式插入纯文本：不借 execCommand，保证插入结果与渲染完全可控 */
const insertPlainText = (text: string) => {
  const root = rootRef.value
  if (!root || !text) return
  const value = serializePlainText(root)
  const caret = readCaretOffset()
  const at = caret < 0 ? value.length : caret
  const next = value.slice(0, at) + text + value.slice(at)
  const nextCaret = at + text.length
  render(next, nextCaret)
  emit('update:modelValue', next)
  emit('input', { value: next, caret: nextCaret })
}

const handleKeydown = (event: KeyboardEvent) => {
  // 组字中的 Enter 是「上屏」，绝不能当成发送
  if (event.isComposing || isComposing.value) return
  if (event.key !== 'Enter') return

  if (event.shiftKey) {
    // 换行交给浏览器自己插：它插的表示（pre-wrap 下是 '\n' 文本，个别情况是 <br>）
    // 会被序列化认回成 '\n'。自己插看着更"纯"，但 contenteditable 里结尾的 '\n'
    // 不产生新行盒，浏览器会把光标夹回它前面 —— 换行既看不见、后续输入还插错位置。
    // 单行模式（折叠态）压根不该换行，也不该顺手把消息发出去，直接吞掉。
    if (props.singleLine) event.preventDefault()
    return
  }

  // 面板开着时的不发送由上层判断（它才知道 @ 面板的状态），这里只管语义
  event.preventDefault()
  emit('submit')
}

const handlePaste = (event: ClipboardEvent) => {
  if (isComposing.value) return
  const text = event.clipboardData?.getData('text/plain') ?? ''
  // 默认粘贴会带 HTML 结构与样式，与「纯文本是唯一真相」冲突，一律按纯文本插入
  event.preventDefault()
  insertPlainText(text.replace(/\r\n?/g, '\n'))
}

const focus = () => {
  const root = rootRef.value
  if (!root) return
  root.focus()
  setCaretOffset(serializePlainText(root).length)
}

const getElement = (): HTMLElement | null => rootRef.value

/** 用新的纯文本 + 光标位置重建（上层插入 token 后调它，chip 立刻出现） */
const setValueAndCaret = (value: string, caret: number) => {
  const root = rootRef.value
  if (root && document.activeElement !== root) root.focus()
  render(value, caret)
  emit('update:modelValue', value)
}

watch(
  () => props.modelValue,
  (value) => {
    // 组字中绝不重建 DOM
    if (isComposing.value) return
    syncDom(String(value ?? ''), readCaretOffset())
  },
)

// 卸载时若还挂着组字，把标志收掉（防止后续事件误判）
onBeforeUnmount(() => { isComposing.value = false })

onMounted(() => {
  syncDom(String(props.modelValue ?? ''), -1)
})

const showPlaceholder = computed(() => !!props.placeholder && isEmpty.value)
const fieldClass = computed(() => ({
  'is-single-line': props.singleLine,
  'is-empty': isEmpty.value,
}))

defineExpose({
  focus,
  getElement,
  setValueAndCaret,
})
</script>

<template>
  <div class="inline-mention-field" :class="fieldClass">
    <div
      ref="rootRef"
      class="inline-mention-input"
      contenteditable="true"
      role="textbox"
      :aria-multiline="!singleLine"
      :aria-label="ariaLabel || undefined"
      :aria-placeholder="placeholder || undefined"
      spellcheck="false"
      @input="handleInput"
      @keydown="handleKeydown"
      @paste="handlePaste"
      @compositionstart="handleCompositionStart"
      @compositionend="handleCompositionEnd"
    />
    <span v-if="showPlaceholder" class="inline-mention-placeholder" aria-hidden="true">{{ placeholder }}</span>
  </div>
</template>

<!-- 这里刻意不加 scoped：chip 是用 document.createElement 动态建的，
     拿不到 Vue 给模板节点附加的 scope 属性，scoped 样式对它一律不生效。 -->
<style>
.inline-mention-field {
  position: relative;
  width: 100%;
}

.inline-mention-input {
  box-sizing: border-box;
  width: 100%;
  min-height: var(--content-generator-prompt-control-height, 24px);
  max-height: 40vh;
  padding: 0 4px 0 0;
  overflow-x: hidden;
  overflow-y: auto;
  outline: none;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  color: var(--text-primary);
  caret-color: var(--brand-main-default);
  font-size: 14px;
  font-weight: 400;
  line-height: var(--content-generator-prompt-control-line-height, 24px);
  scrollbar-width: thin;
  transition: height var(--content-generator-collapse-transition-duration, 0.35s)
    var(--content-generator-collapse-transition-timing-function, ease);
}

.inline-mention-field.is-single-line .inline-mention-input {
  max-height: var(--content-generator-prompt-control-height, 42px);
  overflow-y: hidden;
  white-space: pre;
  text-overflow: ellipsis;
}

.inline-mention-placeholder {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  overflow: hidden;
  color: var(--text-placeholder);
  font-size: 14px;
  line-height: var(--content-generator-prompt-control-line-height, 24px);
  pointer-events: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* chip：内联 pill。色值全部走 token，圆角与卡片内小块一致（8px） */
.inline-mention-chip {
  display: inline-block;
  max-width: 100%;
  margin: 0 2px;
  padding: 0 6px;
  overflow: hidden;
  border: 1px solid var(--stroke-secondary);
  border-radius: 8px;
  background: var(--bg-block-secondary-default);
  color: var(--brand-main-default);
  font-size: 12px;
  line-height: 20px;
  text-overflow: ellipsis;
  vertical-align: baseline;
  white-space: nowrap;
  cursor: default;
  user-select: none;
}

</style>
