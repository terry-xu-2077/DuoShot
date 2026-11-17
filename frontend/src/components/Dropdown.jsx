import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconChevron } from './Icons.jsx'

// 通用下拉选择：代替原生 <select>，菜单样式统一用 styles.css 里的 .menu / .menu-item。
//   options: [{ value, label, hint?, icon?, disabled? }]
//   renderOption(opt, { selected, active }) 可以自己排版一项的内部（缩略图、两行文字、徽标……）；不传就是 icon + label + 右侧 hint
//   renderValue(opt) 自定义触发按钮里显示的内容；不传就显示 label
// 菜单挂在 body 上（不会被弹窗/面板裁切），空间不够时自动翻到按钮上方。
export default function Dropdown({ value, options, onChange, renderOption, renderValue, disabled = false, className = '', title, placeholder = '请选择', align = 'left', minWidth }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const cur = options.find((o) => o.value === value)

  const close = useCallback(() => setOpen(false), [])
  const toggle = () => {
    if (disabled) return
    if (!open) setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen((v) => !v)
  }

  // 定位：先放在按钮下方，量出菜单高度后，下面放不下就翻到上方
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const h = menuRef.current ? menuRef.current.offsetHeight : 0
    const w = menuRef.current ? menuRef.current.offsetWidth : r.width
    const up = h > 0 && r.bottom + 6 + h > window.innerHeight - 8 && r.top - 6 - h > 8
    let left = align === 'right' ? r.right - w : r.left
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    setPos({ left, top: up ? r.top - 6 - h : r.bottom + 6, minWidth: Math.max(r.width, minWidth || 0), up })
  }, [open, options.length, align, minWidth])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return
      close()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); btnRef.current?.focus() }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = options.length
        if (!n) return
        const dir = e.key === 'ArrowDown' ? 1 : -1
        setActive((a) => {
          let i = a
          for (let k = 0; k < n; k++) { i = (i + dir + n) % n; if (!options[i].disabled) break }
          return i
        })
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        const o = options[active]
        if (o && !o.disabled) { onChange?.(o.value); close(); btnRef.current?.focus() }
      } else if (e.key === 'Tab') close()
    }
    const onScroll = (e) => { if (!menuRef.current?.contains(e.target)) close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, active, options, onChange, close])

  useEffect(() => {
    if (open) menuRef.current?.querySelector('.menu-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const row = (o, i) => {
    const selected = o.value === value
    const isActive = i === active
    return (
      <li
        key={String(o.value)}
        role="option"
        aria-selected={selected}
        aria-disabled={o.disabled || undefined}
        className={`menu-item${selected ? ' sel' : ''}${isActive ? ' on' : ''}`}
        onMouseEnter={() => setActive(i)}
        onClick={() => { if (o.disabled) return; onChange?.(o.value); close() }}
      >
        {renderOption ? renderOption(o, { selected, active: isActive }) : (
          <>
            {o.icon ? <span className="mi-icon">{o.icon}</span> : null}
            <span className="mi-label">{o.label}</span>
            {o.hint ? <span className="mi-hint">{o.hint}</span> : null}
          </>
        )}
      </li>
    )
  }

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={`dd-trigger ${className}${open ? ' open' : ''}`}
        onClick={toggle}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="dd-value">{cur ? (renderValue ? renderValue(cur) : cur.label) : <span className="dd-ph">{placeholder}</span>}</span>
        <span className="dd-caret"><IconChevron size={16} /></span>
      </button>
      {open && createPortal(
        <ul
          ref={menuRef}
          className={`menu dd-menu${pos?.up ? ' up' : ''}`}
          role="listbox"
          style={{ left: pos ? pos.left : -9999, top: pos ? pos.top : -9999, minWidth: pos ? pos.minWidth : undefined, visibility: pos ? 'visible' : 'hidden' }}
        >
          {options.map(row)}
        </ul>,
        document.body,
      )}
    </>
  )
}
