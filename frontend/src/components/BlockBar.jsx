import React, { useEffect, useRef, useState } from 'react'
import { IconChevron, IconClose } from './Icons.jsx'

// 分镜稿页顶上的「批次栏」：编号 · 批次名（可直接改，点箭头切换批次）· ＋新建批次。
// 一个批次 = 分镜稿里一段独立的文字，可以（不强制）关联剧本里的一段话；关联了的话会从剧本选区连一根线到这里。
export default function BlockBar({ blocks, activeId, onSelect, onAdd, onTitle, onDelete, linkState, onUnlink, mode = 'src', onMode = () => { }, wheelSwitch = true }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const index = Math.max(0, blocks.findIndex((b) => b.id === activeId))
  const active = blocks[index]
  const num = (i) => String(i + 1).padStart(2, '0')

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  // 鼠标悬停在批次名上滚轮：向下 = 下一个批次，向上 = 上一个（到头不循环）。触控板的小幅滚动先累积，够一格才切一次
  const wheelAcc = useRef(0)
  const onWheel = (e) => {
    if (!wheelSwitch || blocks.length < 2) return
    if (Math.sign(e.deltaY) !== Math.sign(wheelAcc.current)) wheelAcc.current = 0
    wheelAcc.current += e.deltaY
    if (Math.abs(wheelAcc.current) < 50) return
    const step = wheelAcc.current > 0 ? 1 : -1
    wheelAcc.current = 0
    const next = blocks[index + step]
    if (next) onSelect(next.id)
  }

  return (
    <div className="block-head" ref={wrapRef}>
      <span className="bh-badge" title={active ? `第 ${index + 1} 个批次（共 ${blocks.length} 个）` : ''}>{active ? num(index) : '··'}</span>
      <div className="bh-title" onWheel={onWheel}>
        {/* 输入框只有文字那么宽：点到文字是编辑；文字右边的空白区域点一下是展开 / 收起批次菜单 */}
        <span className="bh-name-wrap" data-v={active && active.title ? active.title : (active ? '给这个批次起个名字' : '还没有批次')}>
          <input
            value={active ? active.title : ''}
            onChange={(e) => onTitle(e.target.value)}
            placeholder={active ? '给这个批次起个名字' : '还没有批次'}
            maxLength={40}
            disabled={!active}
            spellCheck={false}
          />
        </span>
        <span className="bh-fill" onClick={() => blocks.length && setOpen((v) => !v)} aria-hidden="true" />
        <button className="bh-caret" onClick={() => setOpen((v) => !v)} aria-expanded={open} title="切换批次（也可以在这一栏上滚动滚轮）" aria-label="切换批次" disabled={!blocks.length}>
          <IconChevron size={18} />
        </button>
      </div>

      {linkState === 'broken' && (
        <button className="bh-link warn" onClick={onUnlink} title="这个批次关联的那段剧本文字已经被改掉了，找不到了。点一下取消关联。">
          关联已失效
        </button>
      )}

      <button className="bh-add" onClick={onAdd} title="新建批次" aria-label="新建批次">＋</button>

      {/* 当前批次：看手写的分镜稿，还是看 AI 给它优化出来的版本 */}
      {/* 左边是当前在看的内容，右边是开关（关：分镜稿，开：AI 优化稿）；同一时间只显示一种文字 */}
      <button
        className={`bh-mode${mode === 'opt' ? ' on' : ''}`}
        role="switch"
        aria-checked={mode === 'opt'}
        onClick={() => onMode(mode === 'opt' ? 'src' : 'opt')}
        disabled={!active}
        title={mode === 'opt' ? '正在看 AI 优化稿，点击回到分镜稿' : active && active.optimized ? '点击查看这个批次的 AI 优化稿' : '点击查看 AI 优化稿（这个批次还没有）'}
      >
        <span className="bh-mode-text">{mode === 'opt' ? 'AI稿' : '原文'}</span>
        <span className="bh-switch"><i /></span>
        {mode !== 'opt' && active && active.optimized ? <i className="bh-mode-dot" /> : null}
      </button>

      {open && (
        <ul className="menu bh-menu" role="listbox">
          {blocks.map((b, i) => (
            <li
              key={b.id}
              role="option"
              aria-selected={b.id === activeId}
              className={`menu-item bh-item${b.id === activeId ? ' sel' : ''}`}
              onClick={() => { onSelect(b.id); setOpen(false) }}
            >
              <span className="bh-badge sm">{num(i)}</span>
              <span className="bh-text">
                <span className="bh-name">{b.title.trim() || '（未命名）'}</span>
                <span className="bh-sub">{(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '（还没有内容）'}</span>
              </span>
              {b.link && <i className="bh-dot" title="已关联剧本" />}
              <button className="bh-del" onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete(b) }} title="删除这个批次" aria-label="删除这个批次">
                <IconClose size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
