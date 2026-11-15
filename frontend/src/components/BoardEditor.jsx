import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { findMentions, MENTION_GAP } from './MarkedTextarea.jsx'

// 分镜稿（批次）的编辑器：contenteditable。
// 资产标签（缩略图 + 名称）是编辑器里真正的行内元素（contenteditable=false），跟文字一起排版：
// 光标、选中、换行、撤销都是浏览器自己处理，不需要在文字上盖东西。
//
// 存下来的数据格式不变：纯文本，资产写成「@名称」+ 两个全角空格（MENTION_GAP）。
//   - 读：文本里的「@名称」（名称在资源库里能找到）→ 标签
//   - 写：编辑器内容 → 纯文本，标签 → 「@名称」+ MENTION_GAP
// 标签后面跟一个零宽空格（ZW），只是给光标一个落脚的地方（行尾的标签后面也能放光标），序列化时去掉。
const ZW = '\u200b'

const MENU_ROWS = 8   // @ 菜单一屏显示几行；资产更多时在菜单里滚动，不再只列前几个
const isBlock =(n) => n.nodeType === 1 && /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE)$/.test(n.tagName)
const isChip = (n) => n && n.nodeType === 1 && n.dataset && n.dataset.mention !== undefined

// 一个节点里的行内内容 → 文本（嵌套的块之间补换行）
function inlineText(node) {
  let out = ''
  const kids = Array.from(node.childNodes)
  kids.forEach((c, i) => {
    if (c.nodeType === 3) out += c.nodeValue.split(ZW).join('')
    else if (isChip(c)) out += `@${c.dataset.mention}${MENTION_GAP}`
    else if (c.nodeType === 1) {
      if (c.tagName === 'BR') { if (i < kids.length - 1) out += '\n' }   // 块末尾那个 <br> 只是占位，不是换行
      else if (isBlock(c)) out += `${out && !out.endsWith('\n') ? '\n' : ''}${inlineText(c)}`
      else out += inlineText(c)
    }
  })
  return out
}

// 整个编辑器 → 纯文本：每个块（Chrome 回车会生成 <div>）是一行
export function serialize(root) {
  const lines = []
  let cur = null
  const flush = () => { if (cur !== null) { lines.push(cur); cur = null } }
  Array.from(root.childNodes).forEach((c) => {
    if (isBlock(c)) { flush(); lines.push(inlineText(c)) }
    else if (c.nodeType === 1 && c.tagName === 'BR') { if (cur === null) cur = ''; flush() }
    else cur = (cur === null ? '' : cur) + (c.nodeType === 3 ? c.nodeValue.split(ZW).join('') : isChip(c) ? `@${c.dataset.mention}${MENTION_GAP}` : inlineText(c))
  })
  flush()
  return lines.join('\n')
}

function makeChip(item) {
  const chip = document.createElement('span')
  chip.className = 'mchip'
  chip.contentEditable = 'false'
  chip.dataset.id = item.id
  chip.dataset.mention = item.name
  fillChip(chip, item)
  return chip
}

function fillChip(chip, item) {
  chip.dataset.mention = item.name
  chip.textContent = ''
  if (item.url) {
    const img = document.createElement('img')
    img.src = item.url
    img.alt = ''
    img.draggable = false
    chip.appendChild(img)
  } else {
    const ph = document.createElement('i')
    ph.className = 'mi-ph'
    chip.appendChild(ph)
  }
  const name = document.createElement('span')
  name.className = 'mchip-name'
  name.textContent = item.name
  chip.appendChild(name)
}

const chipHtml = (item) => `${ZW}${makeChip(item).outerHTML}${ZW}`

// 一行文本 → 一组节点（文字 + 标签）
function lineNodes(line, items) {
  const out = []
  const hits = findMentions(line, items)
  let pos = 0
  hits.forEach((h) => {
    if (h.s > pos) out.push(document.createTextNode(line.slice(pos, h.s)))
    if (!out.length) out.push(document.createTextNode(ZW))   // 行首的标签：前面也要有个落脚的地方，否则光标在这里是看不见的
    out.push(makeChip(h.item), document.createTextNode(ZW))
    pos = h.e
  })
  if (pos < line.length) out.push(document.createTextNode(line.slice(pos)))
  return out
}

function build(root, value, items) {
  root.textContent = ''
  String(value || '').replace(/\r\n?/g, '\n').split('\n').forEach((line) => {
    const div = document.createElement('div')
    const nodes = lineNodes(line, items)
    if (nodes.length) nodes.forEach((n) => div.appendChild(n))
    else div.appendChild(document.createElement('br'))
    root.appendChild(div)
  })
}

const BoardEditor = forwardRef(function BoardEditor({ value = '', onChange, hidden, disabled, placeholder, mentionItems, mentionEmpty, spellCheck = false, className = '' }, ref) {
  const rootRef = useRef(null)
  const wrapRef = useRef(null)
  const lastRef = useRef(null)          // 最近一次和外面同步过的文本
  const itemsRef = useRef(mentionItems || [])
  itemsRef.current = mentionItems || []
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [empty, setEmpty] = useState(!String(value || '').trim())
  const [menu, setMenu] = useState(null)   // {node, start, offset, query, active, x, y}

  const emit = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    // 在两个标签中间按回车，Chrome 会在新的一行开头塞一个占位的 <br>：它会把后面的标签顶到再下一行。
    // 行首紧跟着标签（或零宽空格）的 <br> 是多余的，去掉；行首是标签就补上前面的零宽空格，光标才画得出来
    Array.from(root.children).forEach((line) => {
      const f = line.firstChild
      if (f && f.nodeName === 'BR' && line.childNodes.length > 1) {
        const n = f.nextSibling
        const zwOnly = n && n.nodeType === 3 && /^\u200b+$/.test(n.nodeValue)
        if (isChip(n) || zwOnly) {
          const sel = window.getSelection()
          const hadCaret = sel.rangeCount && line.contains(sel.anchorNode) && sel.isCollapsed
          f.remove()
          let zw = line.firstChild
          if (!(zw && zw.nodeType === 3 && zw.nodeValue.startsWith('\u200b'))) {
            zw = document.createTextNode('\u200b')
            line.insertBefore(zw, line.firstChild)
          }
          if (hadCaret) {
            const r = document.createRange()
            r.setStart(zw, zw.nodeValue.length >= 1 ? 1 : 0)
            r.collapse(true)
            sel.removeAllRanges()
            sel.addRange(r)
          }
        }
      }
    })
    const text = serialize(root)
    setEmpty(!text.length)
    if (text === lastRef.current) return
    lastRef.current = text
    onChangeRef.current?.(text)
  }, [])

  // 外面换了文字（换批次 / 拖入文件 / 兜底改文字）：重建内容。自己输入产生的变化 value === lastRef，不会重建（保住撤销记录）
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (lastRef.current === value && root.firstChild) return
    build(root, value, itemsRef.current)
    lastRef.current = value
    setEmpty(!String(value || '').trim())
  }, [value])

  // 资源库里的图加载出来 / 改了名 / 删了：同步已有的标签
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    let changed = false
    Array.from(root.querySelectorAll('.mchip')).forEach((chip) => {
      const it = itemsRef.current.find((x) => x.id === chip.dataset.id)
      if (!it) {
        // 资产已删除：变回普通文字 @名称
        chip.replaceWith(document.createTextNode(`@${chip.dataset.mention}`))
        changed = true
      } else if (chip.dataset.mention !== it.name || (chip.querySelector('img')?.getAttribute('src') || '') !== (it.url || '')) {
        if (chip.dataset.mention !== it.name) changed = true
        fillChip(chip, it)
      }
    })
    if (changed) emit()
  }, [mentionItems, emit])

  const focus = () => { rootRef.current?.focus() }
  const selectAll = () => {
    const root = rootRef.current
    if (!root) return
    const r = document.createRange()
    r.selectNodeContents(root)
    const s = window.getSelection()
    s.removeAllRanges()
    s.addRange(r)
  }
  const caretToEnd = () => {
    const root = rootRef.current
    const r = document.createRange()
    r.selectNodeContents(root)
    r.collapse(false)
    const s = window.getSelection()
    s.removeAllRanges()
    s.addRange(r)
  }
  // 在文末插入一串资产标签（走编辑命令，Ctrl+Z 能撤销）。返回是否成功
  const insertMentions = (list, newLine = false) => {
    const root = rootRef.current
    if (!root || !list.length) return false
    root.focus()
    caretToEnd()
    if (newLine) { try { document.execCommand('insertParagraph') } catch { /* 忽略 */ } }
    const html = list.map(chipHtml).join('')
    try { return document.execCommand('insertHTML', false, html) } catch { return false }
  }
  useImperativeHandle(ref, () => ({
    focus,
    select: selectAll,
    insertMentions,
    get isEditor() { return true },
  }))

  // ---------- @ 菜单 ----------
  const mentionOn = Array.isArray(mentionItems)
  const menuItems = menu && mentionOn
    ? mentionItems.filter((it) => !menu.query || it.name.toLowerCase().includes(menu.query.toLowerCase()))
    : []

  const detectMention = () => {
    const sel = window.getSelection()
    if (!mentionOn || !sel || !sel.rangeCount || !sel.isCollapsed || !rootRef.current?.contains(sel.anchorNode) || sel.anchorNode.nodeType !== 3) { setMenu(null); return }
    const node = sel.anchorNode
    const offset = sel.anchorOffset
    const m = /(^|[^A-Za-z0-9])@([^\s@＠]{0,20})$/.exec(node.nodeValue.slice(0, offset))
    if (!m) { setMenu(null); return }
    const start = offset - m[2].length - 1
    const r = document.createRange()
    r.setStart(node, start)
    r.setEnd(node, start + 1)
    const rect = r.getBoundingClientRect()
    const wrap = wrapRef.current.getBoundingClientRect()
    setMenu((prev) => ({
      node, start, offset, query: m[2],
      active: prev && prev.node === node && prev.start === start ? prev.active : 0,
      x: rect.left - wrap.left, y: rect.bottom - wrap.top,
    }))
  }

  const pickMention = (item) => {
    if (!menu) return
    const r = document.createRange()
    try {
      r.setStart(menu.node, menu.start)
      r.setEnd(menu.node, Math.min(menu.offset, menu.node.nodeValue.length))
    } catch { setMenu(null); return }
    rootRef.current.focus()
    const s = window.getSelection()
    s.removeAllRanges()
    s.addRange(r)
    try { document.execCommand('insertHTML', false, chipHtml(item)) } catch { /* 忽略 */ }
    setMenu(null)
    emit()
  }

  // 退格 / Delete 碰到标签：整个删掉（连同后面那个零宽空格），而不是先啃掉看不见的零宽空格
  const deleteChipAt = (back) => {
    const sel = window.getSelection()
    if (!sel.rangeCount || !sel.isCollapsed) return false
    const { anchorNode: node, anchorOffset: off } = sel
    let chip = null
    let range = null
    if (back) {
      if (node.nodeType === 3 && /^\u200b*$/.test(node.nodeValue.slice(0, off)) && isChip(node.previousSibling)) {
        chip = node.previousSibling
        range = document.createRange()
        range.setStartBefore(chip)
        range.setEnd(node, off)
      } else if (node.nodeType === 1 && isChip(node.childNodes[off - 1])) {
        chip = node.childNodes[off - 1]
        range = document.createRange()
        range.setStartBefore(chip)
        range.setEnd(node, off)
      }
    } else if (node.nodeType === 3 && off === node.nodeValue.length && isChip(node.nextSibling)) {
      chip = node.nextSibling
      range = document.createRange()
      range.setStart(node, off)
      const after = chip.nextSibling
      if (after && after.nodeType === 3 && after.nodeValue.startsWith(ZW)) range.setEnd(after, 1)
      else range.setEndAfter(chip)
    } else if (node.nodeType === 3 && off < node.nodeValue.length && /^\u200b+$/.test(node.nodeValue.slice(off)) && isChip(node.nextSibling)) {
      chip = node.nextSibling
      range = document.createRange()
      range.setStart(node, off)
      range.setEndAfter(chip)
    } else if (node.nodeType === 1 && isChip(node.childNodes[off])) {
      chip = node.childNodes[off]
      range = document.createRange()
      range.setStartBefore(chip)
      const after = chip.nextSibling
      if (after && after.nodeType === 3 && after.nodeValue.startsWith(ZW)) range.setEnd(after, 1)
      else range.setEndAfter(chip)
    }
    if (!chip || !range) return false
    sel.removeAllRanges()
    sel.addRange(range)
    try { return document.execCommand('delete') } catch { return false }
  }

  // ---------- 光标在标签 / 零宽空格附近的移动 ----------
  // 零宽空格看不见但算一个字符：按一次方向键光标"原地不动"就是它造成的。这里让一次按键永远是一次看得见的移动。
  const zwStart = (v, off) => { let k = off; while (k > 0 && v[k - 1] === ZW) k -= 1; return k }
  const zwEnd = (v, off) => { let k = off; while (k < v.length && v[k] === ZW) k += 1; return k }
  const lineOf = (n) => { let x = n; while (x && x.parentNode !== rootRef.current) x = x.parentNode; return x }
  const setCaret = (node, off) => {
    const r = document.createRange()
    r.setStart(node, off)
    r.collapse(true)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
  }
  const setCaretBefore = (chip) => {
    const p = chip.previousSibling
    if (p && p.nodeType === 3) setCaret(p, p.nodeValue.length)
    else { const r = document.createRange(); r.setStartBefore(chip); r.collapse(true); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r) }
  }
  const setCaretAfter = (chip) => {
    const a = chip.nextSibling
    if (a && a.nodeType === 3) setCaret(a, zwEnd(a.nodeValue, 0))
    else { const r = document.createRange(); r.setStartAfter(chip); r.collapse(true); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r) }
  }
  const setCaretLineEnd = (line) => {
    const l = line.lastChild
    if (l && l.nodeType === 3) setCaret(l, l.nodeValue.length)
    else if (isChip(l)) setCaretAfter(l)
    else setCaret(line, 0)
  }

  // 返回：'handled'（已经移动好了，要拦掉默认行为）/ 'native'（光标已摆好，交给浏览器继续走一格）/ null（不用管）
  const navKey = (dir) => {
    const sel = window.getSelection()
    if (!sel.rangeCount || !sel.isCollapsed || !rootRef.current.contains(sel.anchorNode)) return null
    const { anchorNode: node, anchorOffset: off } = sel
    if (dir < 0) {
      if (node.nodeType === 1) {
        const c = node.childNodes[off - 1]
        if (isChip(c)) { setCaretBefore(c); return 'handled' }
        return null
      }
      if (node.nodeType !== 3) return null
      const k = zwStart(node.nodeValue, off)
      if (k > 0) { if (k < off) { setCaret(node, k); return 'native' } return null }
      // 光标前面（本节点里）只有零宽空格：看左边挨着什么
      const prev = node.previousSibling
      if (isChip(prev)) { setCaretBefore(prev); return 'handled' }
      if (!prev) {
        const line = lineOf(node)
        const pl = line && line.previousElementSibling
        if (pl) setCaretLineEnd(pl)
        else setCaret(node, 0)
        return 'handled'
      }
      if (prev.nodeType === 3) { setCaret(prev, prev.nodeValue.length); return 'native' }
      return null
    }
    if (node.nodeType === 1) {
      const c = node.childNodes[off]
      if (isChip(c)) { setCaretAfter(c); return 'handled' }
      return null
    }
    if (node.nodeType !== 3) return null
    const v = node.nodeValue
    const k = zwEnd(v, off)
    if (k < v.length) { if (k > off) { setCaret(node, k); return 'native' } return null }
    // 光标后面（本节点里）只有零宽空格或已到头：看右边挨着什么
    const next = node.nextSibling
    if (isChip(next)) { setCaretAfter(next); return 'handled' }
    if (!next) {
      const line = lineOf(node)
      const nl = line && line.nextElementSibling
      const f = nl && nl.firstChild
      if (f && f.nodeType === 3 && f.nodeValue.startsWith(ZW)) { setCaret(f, zwEnd(f.nodeValue, 0)); return 'handled' }
      return null
    }
    if (next.nodeType === 3) { setCaret(next, 0); return 'native' }
    return null
  }

  // 退格前：光标前面如果只有看不见的零宽空格，先越过它，免得一次退格什么都没删
  const prepBackspace = () => {
    const sel = window.getSelection()
    if (!sel.rangeCount || !sel.isCollapsed) return
    const { anchorNode: node, anchorOffset: off } = sel
    if (node.nodeType !== 3 || off === 0 || node.nodeValue[off - 1] !== ZW) return
    setCaret(node, zwStart(node.nodeValue, off))
  }

  const onKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !menu) {
      if (navKey(e.key === 'ArrowLeft' ? -1 : 1) === 'handled') { e.preventDefault(); return }
    }
    if (menu && mentionOn) {
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
    if ((e.key === 'Backspace' || e.key === 'Delete') && deleteChipAt(e.key === 'Backspace')) { e.preventDefault(); emit(); return }
    if (e.key === 'Backspace') prepBackspace()
  }

  // 粘贴一律按纯文本（不带来源网页的格式）
  const onPaste = (e) => {
    const text = e.clipboardData?.getData('text/plain')
    if (text === undefined) return
    e.preventDefault()
    const t = text.replace(/\r\n?/g, '\n')
    try { if (document.execCommand('insertText', false, t)) return } catch { /* 忽略 */ }
    emit()
  }

  // 复制 / 剪切：标签复制成「@名称」，不带零宽空格
  const onCopy = (e) => {
    const sel = window.getSelection()
    if (!sel.rangeCount || sel.isCollapsed) return
    const box = document.createElement('div')
    box.appendChild(sel.getRangeAt(0).cloneContents())
    e.preventDefault()
    e.clipboardData.setData('text/plain', serialize(box))
    if (e.type === 'cut') { try { document.execCommand('delete') } catch { /* 忽略 */ } }
  }

  // ↑↓ 选到菜单可见范围之外时，菜单跟着滚
  useEffect(() => {
    if (menu) wrapRef.current?.querySelector('.mention-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [menu?.active, menu?.query])

  useEffect(() => {
    if (!menu) return undefined
    const onSel = () => { if (!rootRef.current?.contains(window.getSelection().anchorNode)) setMenu(null) }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [menu])

  return (
    <div ref={wrapRef} className={`editor-wrap${hidden ? ' is-hidden' : ''}`}>
      <div
        ref={rootRef}
        className={`editor board-editor ${className}`.trim()}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        spellCheck={spellCheck}
        data-disabled={disabled ? '' : undefined}
        onInput={() => { emit(); detectMention() }}
        onKeyUp={(e) => { if (!['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key) || !menu) detectMention() }}
        onMouseUp={detectMention}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCopy={onCopy}
        onCut={onCopy}
        onBlur={() => setMenu(null)}
      />
      {empty && placeholder && <div className="editor-placeholder" aria-hidden="true">{placeholder}</div>}
      {menu && mentionOn && (() => {
        const wrap = wrapRef.current
        const h = Math.min(Math.max(1, menuItems.length), MENU_ROWS) * 42 + 14   // 最多同时显示 MENU_ROWS 行，多的滚动
        let top = menu.y + 6
        if (wrap && top + h > wrap.clientHeight) top = Math.max(4, menu.y - 30 - h)   // 下面放不下就翻到上面
        const left = Math.max(8, Math.min(menu.x, (wrap ? wrap.clientWidth : 400) - 260))
        return (
          <div className="mention-menu" style={{ left, top, maxHeight: h, overflowY: 'auto' }} onMouseDown={(e) => e.preventDefault()} role="listbox">
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
    </div>
  )
})

export default BoardEditor
