import { makeAnchor, resolveAnchor, sameAnchor } from '../anchor.js'
import { IconPin } from './Icons.jsx'
import { useRegionFade } from '../useRegionFade.js'
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'

// 「@名称」在分镜稿里显示成【缩略图 + 名称】的小标签：
// 文字本身还是 @名称（存盘、复制、发给 AI 的都是它），只是在文本框上面盖一个不透明的标签把它遮住。
// 标签得比 @名称 本身宽才盖得住（缩略图要占位置），所以插入时在后面带一个全角空格（U+2003）当「占位」，
// 标签盖住 @名称 + 这个占位。发给 AI 之前会把占位换成普通空格。
// 标签的盖板比 @名称 的位置往右缩进这么多：两个标签紧挨着的交界处露出一条缝，光标（落在交界上）才看得见
const CARET_WINDOW = 3
export const MENTION_GAP ='  '

// 在 value 里找出所有「@资产名」（名字有长有短时优先匹配长的），以及紧跟着的占位空格
export function findMentions(value, items) {
  const out = []
  if (!items || !items.length) return out
  const sorted = [...items].sort((a, b) => b.name.length - a.name.length)
  let i = value.indexOf('@')
  while (i >= 0) {
    const hit = sorted.find((it) => value.startsWith(it.name, i + 1))
    if (hit) {
      let e = i + 1 + hit.name.length
      if (value.startsWith(MENTION_GAP, e)) e += MENTION_GAP.length
      out.push({ s: i, e, item: hit })
      i = value.indexOf('@', e)
    } else {
      i = value.indexOf('@', i + 1)
    }
  }
  return out
}

// 带「钉住的大圆角选区」的文本框。
//
// - 选中一段文字后，整段画成【一整块】带圆角的深蓝色区域（不是每行各一条），选中文字变浅色。
// - 选区会被「钉住」：之后在文本框里点别处、切到另一边写字，这块深蓝都留在原处，不会被撤掉；
//   钉住的文字之前或之后改了字，它会跟着挪位置；改到钉住的那段本身，才会取消。
// - 取消钉住：点选区右上角的 ✕，或者在文本框里按 Esc；重新选一段文字会换成新的。
//
// 原生选中高亮是直角、形状改不了，所以这里把它设成透明，在文本框后面画深蓝底（SVG 圆角路径），
// 在文本框前面叠一层排版完全一样的浅色文字，用同一条路径裁出选中的那段。
const SEL_RADIUS = 10   // 选区外轮廓的圆角半径
const SEL_PAD_X = 4     // 选区比文字左右各多出一点
const SNAP = 8          // 相邻两行的左/右边相差不到这么多时对齐，避免出现细碎的台阶

// 一个多边形（顶点按顺时针）→ 带圆角的闭合路径；凹角、凸角都做圆角
function roundedPolygon(points, r) {
  const n = points.length
  let d = ''
  for (let i = 0; i < n; i++) {
    const p0 = points[(i + n - 1) % n]
    const p1 = points[i]
    const p2 = points[(i + 1) % n]
    const v1 = [p0[0] - p1[0], p0[1] - p1[1]]
    const v2 = [p2[0] - p1[0], p2[1] - p1[1]]
    const l1 = Math.hypot(v1[0], v1[1]) || 1
    const l2 = Math.hypot(v2[0], v2[1]) || 1
    const rr = Math.min(r, l1 / 2, l2 / 2)
    const a = [p1[0] + (v1[0] / l1) * rr, p1[1] + (v1[1] / l1) * rr]
    const b = [p1[0] + (v2[0] / l2) * rr, p1[1] + (v2[1] / l2) * rr]
    d += `${i === 0 ? 'M' : 'L'}${a[0].toFixed(1)} ${a[1].toFixed(1)}Q${p1[0].toFixed(1)} ${p1[1].toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`
  }
  return `${d}Z`
}

// 量出 [s, e) 这段文字在每一行占的左右范围，拼成一整块的外轮廓
function computeGeometry(inner, textNode, s, e, lineH) {
  const range = document.createRange()
  range.setStart(textNode, s)
  range.setEnd(textNode, e)
  const base = inner.getBoundingClientRect()
  const rows = new Map()
  for (const r of Array.from(range.getClientRects())) {
    if (r.height <= 0) continue
    const idx = Math.floor(((r.top + r.bottom) / 2 - base.top) / lineH)
    const L = r.left - base.left
    const R = r.right - base.left
    const row = rows.get(idx)
    if (row) { row.L = Math.min(row.L, L); row.R = Math.max(row.R, R) } else rows.set(idx, { L, R })
  }
  if (!rows.size) return null
  const keys = Array.from(rows.keys()).sort((a, b) => a - b)
  const first = keys[0]
  const last = keys[keys.length - 1]
  const list = []
  for (let k = first; k <= last; k++) {
    const row = rows.get(k)
    list.push(row
      ? { L: row.L - SEL_PAD_X, R: Math.max(row.R, row.L + 6) + SEL_PAD_X, top: k * lineH, bottom: (k + 1) * lineH }
      : { blank: true, top: k * lineH, bottom: (k + 1) * lineH })
  }
  // 中间的空行（段落之间）没有文字可量：取上下两行里较窄的那个范围，整块才连成一体、没有细脖子
  list.forEach((row, i) => {
    if (!row.blank) return
    let up = i - 1
    while (up >= 0 && list[up].blank) up--
    let down = i + 1
    while (down < list.length && list[down].blank) down++
    const nb = [list[up], list[down]].filter(Boolean)
    row.L = Math.max(...nb.map((x) => x.L))
    row.R = Math.min(...nb.map((x) => x.R))
    if (row.R - row.L < 12) { row.L = Math.min(...nb.map((x) => x.L)); row.R = Math.max(...nb.map((x) => x.R)) }
  })
  return blockPathFromRows(list)
}

// 一组「行」（每行 {L, R, top, bottom}，上下相接）→ 一整块带圆角的外轮廓路径。剧本编辑框和 Markdown 预览共用。
export function blockPathFromRows(list) {
  // 整块连起来：中间的行一律铺满整块的左右边，不留段落末行那种凹进去的台阶；
  // 只有第一行的左端、最后一行的右端保持选中的真实位置（和常见的选中形状一样）
  if (list.length > 1) {
    const minL = Math.min(...list.map((x) => x.L))
    const maxR = Math.max(...list.map((x) => x.R))
    list.forEach((row, i) => {
      if (i === 0) row.R = maxR
      else if (i === list.length - 1) row.L = minL
      else { row.L = minL; row.R = maxR }
    })
  }
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i]
    const b = list[i + 1]
    if (Math.abs(a.L - b.L) < SNAP) { const v = Math.min(a.L, b.L); a.L = v; b.L = v }
    if (Math.abs(a.R - b.R) < SNAP) { const v = Math.max(a.R, b.R); a.R = v; b.R = v }
  }
  // 顺时针：先沿右边一路向下，再沿左边一路向上
  const pts = []
  const push = (x, y) => {
    const q = pts[pts.length - 1]
    if (!q || q[0] !== x || q[1] !== y) pts.push([x, y])
  }
  list.forEach((row, i) => {
    if (i === 0) push(row.L, row.top)
    push(row.R, row.top)
    push(row.R, row.bottom)
  })
  for (let i = list.length - 1; i >= 0; i--) {
    push(list[i].L, list[i].bottom)
    push(list[i].L, list[i].top)
  }
  // 左边一路向上会回到起点：去掉重复的终点，否则左上角这个顶点会被当成共线点误删
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop()
  // 去掉共线的多余顶点
  const clean = pts.filter((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length]
    const b = pts[(i + 1) % pts.length]
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]))
  })
  const head = list[0]
  return { d: roundedPolygon(clean, SEL_RADIUS), chipX: head.R, chipY: head.top }
}

const MarkedTextarea = forwardRef(function MarkedTextarea({ hidden, className = '', mentionItems, mentionEmpty, pinSelection = false, pinAnchor = null, onPinChange, onFix, ...props }, ref) {
  const taRef = useRef(null)
  const backScrollRef = useRef(null)
  const frontScrollRef = useRef(null)
  const frontInnerRef = useRef(null)
  const pinAnchorRef = useRef(pinAnchor)
  pinAnchorRef.current = pinAnchor
  const onPinChangeRef = useRef(onPinChange)
  onPinChangeRef.current = onPinChange
  const [geom, setGeom] = useState(null)       // {d, chipX, chipY}：已固定的选区的外轮廓
  const [selRange, setSelRange] = useState(null)   // 当前正在选中的文字 {s, e}（标准选中样式，没有固定）
  const [selGeom, setSelGeom] = useState(null)     // 当前选中文字的外轮廓：图钉按钮放在它的右上角
  const [focused, setFocused] = useState(false)
  const [caretPos, setCaretPos] = useState(-1)      // 光标（没选中文字时）的位置
  const [selSpan, setSelSpan] = useState(null)      // 当前选中的范围：被选中的 @标签 要跟着变成选中色（标签盖住了系统自带的高亮）
  const selMeasureRef = useRef(null)
  const pinScrollRef = useRef(null)
  const [box, setBox] = useState({ sbw: 0, w: 0 })   // 滚动条宽度 / 文本框宽度：变了就要重新排版量一次

  useImperativeHandle(ref, () => taRef.current)

  // 记下当前选中的文字（只为了在它的右上角放「图钉」按钮；选中本身用系统自带的标准样式，不会固定、不会连线）
  const readSel = useCallback(() => {
    const ta = taRef.current
    if (!ta || !pinSelection) return   // 图钉只给剧本用，分镜稿用系统自带的选中样式
    const s = ta.selectionStart
    const e = ta.selectionEnd
    setSelRange((prev) => (s === e ? (prev ? null : prev) : prev && prev.s === s && prev.e === e ? prev : { s, e }))
  }, [pinSelection])

  // 拖动选择时选区一直在变：监听 document 的 selectionchange（只处理当前聚焦的这个文本框）
  // @标签盖住了 @名称 和后面的占位空格：光标落在它们中间（点在标签旁边的空白处、或用方向键走进去）时，
  // 光标被盖在标签底下看不见。这里把它挪到标签的前面或后面（往哪边挪看光标是往右还是往左走的）
  const lastCaret = useRef(-1)
  const snapCaret = useCallback(() => {
    const ta = taRef.current
    if (!ta || ta.selectionStart !== ta.selectionEnd) { lastCaret.current = -1; return }
    const pos = ta.selectionStart
    const prev = lastCaret.current
    const t = (tokensRef.current || []).find((x) => pos > x.s && pos < x.e)
    if (!t) { lastCaret.current = pos; return }
    // 方向键一次只走一格：按走的方向跳过整个标签；其余（鼠标点的）就近
    const stepped = prev >= 0 && Math.abs(pos - prev) === 1
    const to = stepped ? (pos > prev ? t.e : t.s) : pos - t.s > (t.e - t.s) / 2 ? t.e : t.s
    lastCaret.current = to
    ta.setSelectionRange(to, to)
  }, [])

  const trackSel = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    const s = ta.selectionStart
    const e = ta.selectionEnd
    setSelSpan((prev) => (s === e ? (prev ? null : prev) : prev && prev.s === s && prev.e === e ? prev : { s, e }))
    setCaretPos(s === e ? s : -1)
  }, [])

  useEffect(() => {
    const onChange = () => { if (document.activeElement === taRef.current) { snapCaret(); trackSel(); readSel() } }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [readSel, snapCaret, trackSel])

  const measureBox = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    const sbw = Math.max(0, ta.offsetWidth - ta.clientWidth)
    setBox((b) => (b.sbw === sbw && b.w === ta.offsetWidth ? b : { sbw, w: ta.offsetWidth }))
  }, [])
  const value = props.value ?? ''
  useLayoutEffect(measureBox, [measureBox, value])
  useEffect(() => {
    const ta = taRef.current
    if (!ta || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measureBox)
    ro.observe(ta)
    return () => ro.disconnect()
  }, [measureBox])

  // 钉住的选区由外面（App）持有锚点：这里每次按当前文字重新找出它的位置，所以剧本在别处怎么改它都跟得上
  const pin = useMemo(() => (pinSelection && pinAnchor ? resolveAnchor(value, pinAnchor) : null), [pinSelection, pinAnchor, value])
  const valid = !!pin && pin.s < pin.e && pin.e <= value.length
  const { gen: fadeGen, ghost } = useRegionFade(valid ? pinAnchor : null, geom)   // 换批次 / 取消固定时：新的淡入、旧的淡出

  // 量选区外轮廓：文字、选区、宽度任何一个变了都重新量
  useLayoutEffect(() => {
    if (!valid) { setGeom((g) => (g ? null : g)); return }
    const inner = frontInnerRef.current
    const node = inner?.firstChild
    if (!inner || !node) return
    const lineH = parseFloat(getComputedStyle(inner).lineHeight) || 27.5
    const g = computeGeometry(inner, node, pin.s, pin.e, lineH)
    setGeom((old) => (old && g && old.d === g.d && old.chipX === g.chipX && old.chipY === g.chipY ? old : g))
  }, [valid, pin, value, box])

  // 量当前选中文字的外轮廓：图钉按钮的位置
  useLayoutEffect(() => {
    if (!pinSelection || !selRange) { setSelGeom((g) => (g ? null : g)); return }
    const inner = selMeasureRef.current
    const node = inner?.firstChild
    if (!inner || !node || selRange.e > value.length) return
    const lineH = parseFloat(getComputedStyle(inner).lineHeight) || 27.5
    const g = computeGeometry(inner, node, selRange.s, selRange.e, lineH)
    setSelGeom((old) => (old && g && old.chipX === g.chipX && old.chipY === g.chipY ? old : g))
  }, [pinSelection, selRange, value, box])

  const selAnchor = useMemo(() => (pinSelection && selRange && selRange.e <= value.length ? makeAnchor(value, selRange.s, selRange.e) : null), [pinSelection, selRange, value])
  // 已经有固定的选区时不再冒出图钉；要换，先把已固定的那块叉掉
  const showPin = !!selAnchor && !!selGeom && focused && !valid
  const fixNow = () => { if (selAnchor) onFix?.(selAnchor) }

  const syncScroll = () => {
    const y = taRef.current ? taRef.current.scrollTop : 0
    if (backScrollRef.current) backScrollRef.current.style.transform = `translateY(${-y}px)`
    if (frontScrollRef.current) frontScrollRef.current.style.transform = `translateY(${-y}px)`
    if (pinScrollRef.current) pinScrollRef.current.style.transform = `translateY(${-y}px)`
    if (chipScrollRef.current) chipScrollRef.current.style.transform = `translateY(${-y}px)`
  }
  useLayoutEffect(syncScroll)

  // ---------- @名称 标签（缩略图 + 名称）----------
  const tokens = useMemo(
    () => (Array.isArray(mentionItems) ? findMentions(props.value ?? '', mentionItems) : []),
    [props.value, mentionItems],
  )
  const tokensRef = useRef(tokens)
  tokensRef.current = tokens
  const tokensKey = tokens.map((t) => `${t.s}-${t.e}-${t.item.id}`).join(',')
  const measureRef = useRef(null)
  const chipScrollRef = useRef(null)
  const [chips, setChips] = useState([])

  // 量每个 @名称 占的位置（跨行时每行一段），标签就盖在这些位置上
  useLayoutEffect(() => {
    const inner = measureRef.current
    const node = inner?.firstChild
    if (!tokens.length || !node) { setChips((c) => (c.length ? [] : c)); return }
    const base = inner.getBoundingClientRect()
    const out = []
    tokens.forEach((t) => {
      const range = document.createRange()
      range.setStart(node, t.s)
      range.setEnd(node, t.e)
      const rows = []
      Array.from(range.getClientRects()).filter((r) => r.width > 0.5).forEach((r) => {
        const last = rows[rows.length - 1]
        if (last && Math.abs(last.top - r.top) < 4) { last.right = Math.max(last.right, r.right); last.left = Math.min(last.left, r.left) }
        else rows.push({ left: r.left, right: r.right, top: r.top, height: r.height })
      })
      rows.forEach((r, i) => out.push({
        key: `${t.s}-${i}`, id: t.item.id, first: i === 0, s: t.s, e: t.e,
        left: Math.round((r.left - base.left) * 10) / 10,
        top: Math.round((r.top - base.top + r.height / 2 - 11) * 10) / 10,
        width: Math.round((r.right - r.left) * 10) / 10,
      }))
    })
    setChips((prev) => (JSON.stringify(prev) === JSON.stringify(out) ? prev : out))
  }, [tokensKey, props.value, box])

  // 光标正好停在某个标签的前沿 / 后沿时（两个标签紧挨着的交界），自己画一根光标：系统的那根会被标签盖板挡住
  const caretMark = useMemo(() => {
    if (caretPos < 0) return null
    const next = chips.find((c) => c.first && c.s === caretPos)
    if (next) return { x: next.left, top: next.top }
    const prev = [...chips].reverse().find((c) => c.e === caretPos)
    if (prev) return { x: prev.left + prev.width, top: prev.top }
    return null
  }, [caretPos, chips])

  // 光标不能停在 @名称 中间（那里被标签盖住了）：点进去 / 方向键走进去，就挪到标签后面
  const snapOutOfToken = () => {
    const ta = taRef.current
    if (!ta || ta.selectionStart !== ta.selectionEnd) return
    const c = ta.selectionStart
    const t = tokensRef.current.find((x) => c > x.s && c < x.e)
    if (t) ta.setSelectionRange(t.e, t.e)
  }

  // 退格 / Delete 碰到标签：整个删掉，而不是一个字一个字啃
  const deleteWholeToken = (e) => {
    const ta = taRef.current
    if (!ta || ta.selectionStart !== ta.selectionEnd) return false
    const c = ta.selectionStart
    const t = tokensRef.current.find((x) => (e.key === 'Backspace' ? c > x.s && c <= x.e : c >= x.s && c < x.e))
    if (!t) return false
    e.preventDefault()
    ta.setSelectionRange(t.s, t.e)
    try { if (document.execCommand('delete')) return true } catch { /* 退回下面的写法 */ }
    ta.setRangeText('', t.s, t.e, 'end')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

  // ---------- @ 菜单（只有传了 mentionItems 的文本框才有，比如分镜稿）----------
  // 输入 @ 弹出资源库里的图片（↑↓ 选择，Enter / Tab 插入「@名称 」，Esc 关闭）
  const wrapRef = useRef(null)
  const [menu, setMenu] = useState(null)   // {start, query, active, x, y, lh}
  const mentionOn = Array.isArray(mentionItems)
  const menuItems = menu && mentionOn
    ? mentionItems.filter((it) => !menu.query || it.name.toLowerCase().includes(menu.query.toLowerCase())).slice(0, 8)
    : []

  // 量某个字符位置在文本框里的坐标：用一个同样排版的隐藏 div 排到那个位置
  const caretXY = (ta, index) => {
    const cs = getComputedStyle(ta)
    const div = document.createElement('div')
    ;['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom', 'tabSize']
      .forEach((p) => { div.style[p] = cs[p] })
    Object.assign(div.style, {
      position: 'absolute', visibility: 'hidden', top: '0', left: '0', width: `${ta.clientWidth}px`,
      whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'normal', boxSizing: 'border-box',
    })
    div.textContent = ta.value.slice(0, index)
    const mark = document.createElement('span')
    mark.textContent = '​'
    div.appendChild(mark)
    wrapRef.current.appendChild(div)
    const r = { x: mark.offsetLeft, y: mark.offsetTop, lh: parseFloat(cs.lineHeight) || 27 }
    div.remove()
    return r
  }

  const detectMention = () => {
    const ta = taRef.current
    if (!ta || !mentionOn || ta.selectionStart !== ta.selectionEnd) { setMenu(null); return }
    const caret = ta.selectionStart
    const m = /(^|[^A-Za-z0-9])@([^\s@＠]{0,20})$/.exec(ta.value.slice(0, caret))
    if (!m) { setMenu(null); return }
    const start = caret - m[2].length - 1
    const { x, y, lh } = caretXY(ta, start)
    setMenu((prev) => ({ start, query: m[2], active: prev && prev.start === start ? prev.active : 0, x, y, lh }))
  }

  const pickMention = (item) => {
    const ta = taRef.current
    if (!ta || !menu) return
    ta.focus()
    ta.setSelectionRange(menu.start, ta.selectionEnd)
    const text = `@${item.name}${MENTION_GAP}`
    let ok = false
    try { ok = document.execCommand('insertText', false, text) } catch { ok = false }   // 走编辑命令，Ctrl+Z 能撤销
    if (!ok) {
      ta.setRangeText(text, menu.start, ta.selectionEnd, 'end')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setMenu(null)
  }

  const { onFocus, onBlur, onScroll, onKeyUp, onKeyDown, onMouseUp, onChange, ...rest } = props
  const layerStyle = { paddingRight: `calc(var(--editor-pr, 24px) + ${box.sbw}px)` }

  return (
    <div ref={wrapRef} className={`editor-wrap${hidden ? ' is-hidden' : ''}${pinSelection ? ' pin' : ''}`}>
      {(valid || ghost) && (
        <div className="sel-layer sel-back" aria-hidden="true" style={layerStyle}>
          <div ref={backScrollRef} className="sel-scroll">
            {geom && valid && <svg className="sel-svg" width="1" height="1"><path key={fadeGen} className="sel-fade-in" d={geom.d} /></svg>}
            {ghost && <svg className="sel-svg" width="1" height="1"><path className="sel-fade-out" d={ghost} /></svg>}
          </div>
        </div>
      )}
      <textarea
        {...rest}
        ref={taRef}
        className={`editor ${className}${focused && caretMark ? ' own-caret' : ''}`.trim()}
        onFocus={(e) => { setFocused(true); onFocus?.(e) }}
        onBlur={(e) => { setFocused(false); setMenu(null); onBlur?.(e) }}
        onChange={(e) => { onChange?.(e); detectMention() }}
        onScroll={(e) => { syncScroll(); onScroll?.(e) }}
        onSelect={readSel}
        onKeyUp={(e) => {
          snapOutOfToken()
          readSel()
          if (!(menu && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key))) detectMention()
          onKeyUp?.(e)
        }}
        onMouseUp={(e) => { snapOutOfToken(); readSel(); detectMention(); onMouseUp?.(e) }}
        onKeyDown={(e) => {
          if (mentionOn && !menu && !e.nativeEvent.isComposing && (e.key === 'Backspace' || e.key === 'Delete') && deleteWholeToken(e)) return
          if (menu && mentionOn && !e.nativeEvent.isComposing) {
            const n = Math.max(1, menuItems.length)
            if (e.key === 'ArrowDown') { e.preventDefault(); setMenu((m) => ({ ...m, active: (m.active + 1) % n })); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setMenu((m) => ({ ...m, active: (m.active + n - 1) % n })); return }
            if ((e.key === 'Enter' || e.key === 'Tab') && menuItems.length) {
              e.preventDefault()
              pickMention(menuItems[Math.min(menu.active, menuItems.length - 1)])
              return
            }
            if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return }
          }
          if (e.key === 'Escape' && pin) { e.preventDefault(); onPinChange?.(null) }
          onKeyDown?.(e)
        }}
      />
      {tokens.length > 0 && (
        <>
          {/* 隐藏的同排版文字，只用来量 @名称 的位置 */}
          <div className="sel-layer" aria-hidden="true" style={layerStyle}>
            <div className="sel-scroll">
              <div ref={measureRef} className="sel-inner" style={{ visibility: 'hidden' }}>
                {props.value ?? ''}
                {'​'}
              </div>
            </div>
          </div>
          <div className="sel-layer chip-layer" aria-hidden="true" style={layerStyle}>
            <div ref={chipScrollRef} className="sel-scroll">
              {focused && caretMark && <i className="mcaret" style={{ left: caretMark.x - 1, top: caretMark.top - 2 }} />}
              {chips.map((c) => {
                const it = mentionItems.find((x) => x.id === c.id)
                return (
                  <span key={c.key} className={`mchip-cover${focused && selSpan && selSpan.s < c.e && selSpan.e > c.s ? ' sel' : ''}`} style={{ left: c.left + CARET_WINDOW, top: c.top, width: c.width - CARET_WINDOW }}>
                    {c.first && it && (
                      <span className="mchip">
                        {it.url ? <img src={it.url} alt="" draggable={false} /> : <i className="mi-ph" />}
                        <span className="mchip-name">{it.name}</span>
                      </span>
                    )}
                  </span>
                )
              })}
            </div>
          </div>
        </>
      )}
      {pinSelection && selRange && (
        <div className="sel-layer" aria-hidden="true" style={layerStyle}>
          <div className="sel-scroll">
            <div ref={selMeasureRef} className="sel-inner" style={{ visibility: 'hidden' }}>
              {value}
              {'​'}
            </div>
          </div>
        </div>
      )}
      {showPin && (
        <div className="sel-layer pin-layer" style={layerStyle}>
          <div ref={pinScrollRef} className="sel-scroll">
            <button
              type="button"
              className="pin-btn"
              style={{ left: selGeom.chipX, top: selGeom.chipY }}
              title="固定这段选区，并把它关联到当前批次（固定后你仍然可以照常选中、复制别的文字）"
              aria-label="固定选区"
              onMouseDown={(e) => e.preventDefault()}
              onClick={fixNow}
            >
              <IconPin size={13} />
            </button>
          </div>
        </div>
      )}
      {menu && mentionOn && (() => {
        const wrap = wrapRef.current
        const h = Math.max(1, menuItems.length) * 42 + 14
        const scrollTop = taRef.current ? taRef.current.scrollTop : 0
        let top = menu.y - scrollTop + menu.lh + 6
        if (wrap && top + h > wrap.clientHeight) top = Math.max(4, menu.y - scrollTop - h - 6)   // 下面放不下就翻到上面
        const left = Math.max(8, Math.min(menu.x, (wrap ? wrap.clientWidth : 400) - 260))
        return (
          <div className="mention-menu" style={{ left, top }} onMouseDown={(e) => e.preventDefault()} role="listbox">
            {mentionItems.length === 0 && <div className="mention-empty">{mentionEmpty || '资源库还是空的'}</div>}
            {mentionItems.length > 0 && menuItems.length === 0 && <div className="mention-empty">没有叫「{menu.query}」的资产</div>}
            {menuItems.map((it, i) => (
              <div
                key={it.id}
                role="option"
                aria-selected={i === Math.min(menu.active, menuItems.length - 1)}
                className={`mention-item${i === Math.min(menu.active, menuItems.length - 1) ? ' on' : ''}`}
                onMouseEnter={() => setMenu((m) => ({ ...m, active: i }))}
                onClick={() => pickMention(it)}
              >
                {it.url ? <img src={it.url} alt="" draggable={false} /> : <span className="mi-ph" />}
                <span className="mi-name">{it.name}</span>
              </div>
            ))}
          </div>
        )
      })()}
      {valid && (
        <div key={fadeGen} className="sel-layer sel-front sel-fade-in" aria-hidden={geom ? undefined : 'true'} style={layerStyle}>
          <div ref={frontScrollRef} className="sel-scroll">
            <div ref={frontInnerRef} className="sel-inner" style={geom ? { clipPath: `path('${geom.d}')` } : { visibility: 'hidden' }}>
              {value}
              {'​'}
            </div>
            {geom && (
              <button
                type="button"
                className="sel-chip"
                style={{ left: geom.chipX, top: geom.chipY }}
                title="取消钉住（Esc）"
                aria-label="取消钉住选区"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onPinChange?.(null); taRef.current?.focus() }}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

export default MarkedTextarea
