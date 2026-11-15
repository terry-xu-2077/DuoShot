import React, { useEffect, useRef, useState } from 'react'
import { IconChevron, IconClose } from './Icons.jsx'

// 分镜稿页顶上的「批次栏」：编号 · 批次名（可直接改，点箭头切换批次）· ＋新建批次。
// 一个批次 = 分镜稿里一段独立的文字，可以（不强制）关联剧本里的一段话；关联了的话会从剧本选区连一根线到这里。
export default function BlockBar({ blocks, activeId, onSelect, onAdd, onTitle, onDelete, linkState, onUnlink }) {
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

  return (
    <div className="block-head" ref={wrapRef}>
      <span className="bh-badge" title={active ? `第 ${index + 1} 个批次（共 ${blocks.length} 个）` : ''}>{active ? num(index) : '··'}</span>
      <div className="bh-title">
        <input
          value={active ? active.title : ''}
          onChange={(e) => onTitle(e.target.value)}
          placeholder={active ? '给这个批次起个名字' : '还没有批次'}
          maxLength={40}
          disabled={!active}
          spellCheck={false}
        />
        <button className="bh-caret" onClick={() => setOpen((v) => !v)} aria-expanded={open} title="切换批次" aria-label="切换批次" disabled={!blocks.length}>
          <IconChevron size={18} />
        </button>
      </div>

      {linkState === 'broken' && (
        <button className="bh-link warn" onClick={onUnlink} title="这个批次关联的那段剧本文字已经被改掉了，找不到了。点一下取消关联。">
          关联已失效
        </button>
      )}

      <button className="bh-add" onClick={onAdd} title="新建批次" aria-label="新建批次">＋</button>

      {open && (
        <ul className="bh-menu" role="listbox">
          {blocks.map((b, i) => (
            <li
              key={b.id}
              role="option"
              aria-selected={b.id === activeId}
              className={`bh-item${b.id === activeId ? ' sel' : ''}`}
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
