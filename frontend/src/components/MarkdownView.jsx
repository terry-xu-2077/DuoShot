import { IconPin } from './Icons.jsx'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { blockPathFromRows } from './MarkedTextarea.jsx'
import { domOffset, domPoint, domTextMap, makeAnchor, resolveAnchor, sameAnchor } from '../anchor.js'

// 剧本页的 Markdown 预览：自己解析、直接生成 React 元素（不用 innerHTML，所以拖进来的文件里就算有 HTML 也只会当文字显示）。
// 支持：标题 # ~ ######、粗体 / 斜体 / 删除线 / 行内代码、链接（只显示文字，不会跳转）、引用 >、有序 / 无序列表（可嵌套）、
// 分隔线、代码块 ```、表格。单个换行会保留成换行（剧本里一行一句台词，不能被合并成一段）。

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(__[^_\n]+?__)|(~~[^~\n]+?~~)|(!?\[[^\]\n]*\]\([^)\n]+\))|(\*[^*\s][^*\n]*?\*)|((?<![A-Za-z0-9])_[^_\s][^_\n]*?_(?![A-Za-z0-9]))/

function renderInline(text, keyPrefix = 'i') {
  const out = []
  let rest = text
  let n = 0
  while (rest) {
    const m = INLINE.exec(rest)
    if (!m) { out.push(rest); break }
    if (m.index > 0) out.push(rest.slice(0, m.index))
    const tok = m[0]
    const key = `${keyPrefix}${n++}`
    if (m[1]) out.push(<code key={key}>{tok.slice(1, -1)}</code>)
    else if (m[2] || m[3]) out.push(<strong key={key}>{renderInline(tok.slice(2, -2), `${key}-`)}</strong>)
    else if (m[4]) out.push(<del key={key}>{renderInline(tok.slice(2, -2), `${key}-`)}</del>)
    else if (m[5]) {
      const isImg = tok.startsWith('!')
      const mm = /^!?\[([^\]]*)\]\(([^)]+)\)$/.exec(tok)
      out.push(
        <span key={key} className={isImg ? 'md-img' : 'md-link'} title={mm ? mm[2] : undefined}>
          {isImg ? `[图片：${mm ? mm[1] : ''}]` : renderInline(mm ? mm[1] : tok, `${key}-`)}
        </span>,
      )
    } else out.push(<em key={key}>{renderInline(tok.slice(1, -1), `${key}-`)}</em>)
    rest = rest.slice(m.index + tok.length)
  }
  return out
}

const isBlank = (l) => !l.trim()
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const FENCE = /^\s*(```|~~~)/
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

function parseBlocks(lines, keyPrefix = 'b') {
  const out = []
  let i = 0
  let k = 0
  const key = () => `${keyPrefix}${k++}`
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) { i++; continue }

    if (FENCE.test(line)) {
      const fence = FENCE.exec(line)[1]
      const body = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++])
      i++
      out.push(<pre key={key()} className="md-code"><code>{body.join('\n')}</code></pre>)
      continue
    }

    const h = HEADING.exec(line)
    if (h) {
      const Tag = `h${h[1].length}`
      out.push(<Tag key={key()}>{renderInline(h[2], `${keyPrefix}h${k}-`)}</Tag>)
      i++
      continue
    }

    if (HR.test(line)) { out.push(<hr key={key()} />); i++; continue }

    if (/^\s{0,3}>/.test(line)) {
      const body = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''))
      out.push(<blockquote key={key()}>{parseBlocks(body, `${keyPrefix}q${k}-`)}</blockquote>)
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) rows.push(splitRow(lines[i++]))
      out.push(
        <table key={key()}>
          <thead><tr>{head.map((c, ci) => <th key={ci}>{renderInline(c, `${keyPrefix}th${ci}-`)}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, ri) => <tr key={ri}>{head.map((_, ci) => <td key={ci}>{renderInline(r[ci] || '', `${keyPrefix}td${ri}-${ci}-`)}</td>)}</tr>)}
          </tbody>
        </table>,
      )
      continue
    }

    if (LIST_ITEM.test(line)) {
      const first = LIST_ITEM.exec(line)
      const ordered = /\d/.test(first[2])
      const baseIndent = first[1].length
      const items = []
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i])
        if (!m || m[1].length < baseIndent) break
        if (m[1].length > baseIndent) {
          // 缩进更深：并入上一项，作为子列表
          const sub = []
          while (i < lines.length && LIST_ITEM.test(lines[i]) && LIST_ITEM.exec(lines[i])[1].length > baseIndent) sub.push(lines[i++])
          if (items.length) items[items.length - 1].sub = parseBlocks(sub, `${keyPrefix}s${k}-`)
          continue
        }
        items.push({ text: m[3], sub: null })
        i++
      }
      const ListTag = ordered ? 'ol' : 'ul'
      out.push(
        <ListTag key={key()} start={ordered ? Number.parseInt(first[2], 10) || 1 : undefined}>
          {items.map((it, ii) => <li key={ii}>{renderInline(it.text, `${keyPrefix}li${k}-${ii}-`)}{it.sub}</li>)}
        </ListTag>,
      )
      continue
    }

    // 普通段落：连续的非空行，单个换行保留成换行
    const para = []
    while (
      i < lines.length && !isBlank(lines[i]) && !HEADING.test(lines[i]) && !FENCE.test(lines[i])
      && !HR.test(lines[i]) && !/^\s{0,3}>/.test(lines[i]) && !(para.length && LIST_ITEM.test(lines[i]))
    ) para.push(lines[i++])
    const nodes = []
    para.forEach((l, pi) => {
      if (pi) nodes.push(<br key={`br${pi}`} />)
      nodes.push(...renderInline(l, `${keyPrefix}p${k}-${pi}-`))
    })
    out.push(<p key={key()}>{nodes}</p>)
  }
  return out
}

// 把选区（DOM Range）里每个文字片段所在的行量出来，上下相接，交给 blockPathFromRows 画成一整块圆角区域
function rowsFromRange(range, base) {
  const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const rects = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue
    const r = document.createRange()
    r.selectNodeContents(n)
    if (n === range.startContainer) r.setStart(n, range.startOffset)
    if (n === range.endContainer) r.setEnd(n, range.endOffset)
    Array.from(r.getClientRects()).forEach((x) => { if (x.width > 0.5 && x.height > 0) rects.push(x) })
  }
  rects.sort((a, b) => a.top - b.top || a.left - b.left)
  const rows = []
  for (const r of rects) {
    const cy = (r.top + r.bottom) / 2
    const row = rows.find((x) => Math.abs(cy - x.cy) <= Math.max(x.h, r.height) * 0.4)
    if (row) {
      row.L = Math.min(row.L, r.left)
      row.R = Math.max(row.R, r.right)
      row.top = Math.min(row.top, r.top)
      row.bottom = Math.max(row.bottom, r.bottom)
      row.cy = (row.top + row.bottom) / 2
      row.h = row.bottom - row.top
    } else rows.push({ L: r.left, R: r.right, top: r.top, bottom: r.bottom, cy, h: r.height })
  }
  rows.sort((a, b) => a.top - b.top)
  // 上下相接：每一行的下沿一直延伸到下一行的上沿，段落之间的空隙也被填上，整块才是连着的
  return rows.map((r, i) => ({
    L: r.L - base.left - 4,
    R: r.R - base.left + 4,
    top: r.top - base.top,
    bottom: (i + 1 < rows.length && rows[i + 1].top > r.bottom ? rows[i + 1].top : r.bottom) - base.top,
  }))
}

export default function MarkdownView({ source, pinAnchor = null, onPinChange, onFix }) {
  const text = (source || '').replace(/\r\n?/g, '\n')
  const innerRef = useRef(null)
  const mapRef = useRef(null)          // 预览里所有文字拼成的一整段文字，以及每个文字节点的位置
  const pinAnchorRef = useRef(pinAnchor)
  pinAnchorRef.current = pinAnchor
  const onPinChangeRef = useRef(onPinChange)
  onPinChangeRef.current = onPinChange
  const [geom, setGeom] = useState(null)   // 已固定的选区外轮廓 {d, chipX, chipY}
  const [sel, setSel] = useState(null)     // 当前选中的文字（标准选中样式）：{x, y, anchor}，图钉按钮放在 (x, y)

  // 钉住的选区由外面（App）持有「文字锚点」：这里按当前显示的文字把它找出来、量出轮廓
  const compute = useCallback(() => {
    const inner = innerRef.current
    if (!inner) return
    const map = domTextMap(inner)
    mapRef.current = map
    const anchor = pinAnchorRef.current
    const hit = anchor ? resolveAnchor(map.text, anchor) : null
    const a = hit && domPoint(map, hit.s)
    const b = hit && domPoint(map, hit.e, true)
    if (!a || !b) { setGeom((g) => (g ? null : g)); return }
    const range = document.createRange()
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
    const rows = rowsFromRange(range, inner.getBoundingClientRect())
    const g = rows.length ? blockPathFromRows(rows) : null
    setGeom((old) => (old && g && old.d === g.d && old.chipX === g.chipX && old.chipY === g.chipY ? old : g))
  }, [])

  // 在预览里选中文字：只是记下它的位置，好在右上角放「图钉」按钮；选中本身用系统自带的标准样式
  useEffect(() => {
    const onSel = () => {
      const selection = document.getSelection()
      const inner = innerRef.current
      if (!inner) return
      if (!selection || !selection.rangeCount || selection.isCollapsed || !inner.contains(selection.anchorNode) || !inner.contains(selection.focusNode)) {
        setSel((p) => (p ? null : p))
        return
      }
      const range = selection.getRangeAt(0)
      const map = mapRef.current || domTextMap(inner)
      const s = domOffset(map, range.startContainer, range.startOffset)
      const e = domOffset(map, range.endContainer, range.endOffset)
      const anchor = s >= 0 && e > s ? makeAnchor(map.text, s, e) : null
      const rows = anchor ? rowsFromRange(range, inner.getBoundingClientRect()) : []
      const g = rows.length ? blockPathFromRows(rows) : null
      setSel(anchor && g ? { x: g.chipX, y: g.chipY, anchor } : null)
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

  const unpin = useCallback(() => {
    onPinChangeRef.current?.(null)
  }, [])

  // Esc 取消钉住
  useEffect(() => {
    if (!pinAnchor) return undefined
    const onKey = (e) => { if (e.key === 'Escape') unpin() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pinAnchor, unpin])

  useLayoutEffect(compute, [pinAnchor, text, compute])
  useEffect(() => {
    const inner = innerRef.current
    if (!inner || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(compute)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [compute])

  return (
    <div className="md-view">
      <div ref={innerRef} className="md-inner">
        {geom && <svg className="md-sel" width="1" height="1" aria-hidden="true"><path d={geom.d} /></svg>}
        {text.trim() ? parseBlocks(text.split('\n')) : <p className="md-empty">（剧本还是空的，点右上角的 MD 切回编辑）</p>}
        {sel && !sameAnchor(sel.anchor, pinAnchor) && (
          <button
            type="button"
            className="pin-btn"
            style={{ left: sel.x, top: sel.y }}
            title="固定这段选区，并把它关联到当前批次（固定后你仍然可以照常选中、复制别的文字）"
            aria-label="固定选区"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onFix?.(sel.anchor)}
          >
            <IconPin size={13} />
          </button>
        )}
        {geom && (
          <button
            type="button"
            className="sel-chip"
            style={{ left: geom.chipX, top: geom.chipY }}
            title="取消钉住（Esc）"
            aria-label="取消钉住选区"
            onMouseDown={(e) => e.preventDefault()}
            onClick={unpin}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  )
}
