import React, { useLayoutEffect, useRef, useState } from 'react'
import { IconStar4, IconClose, IconSearch, IconPlusBig } from './Icons.jsx'
import { fmtFullDate } from '../api.js'

// 白色「新建」卡片的内圈虚线：向内缩进 INSET，沿着「标签＋卡片」整体轮廓走
// （标签 210×30 / 圆角 20 与 CSS 对应；卡片宽高实时量取，所以悬停伸展时虚线跟着变）
function NewOutline({ width, height }) {
  if (!width || !height) return null
  const W = width, H = height, R = 20, TW = 210, TY = -28, CAP = 32, I = 8
  const x0 = TW - CAP
  const r = 16 - I
  const f = (n) => Math.round(n * 100) / 100
  // 标签右侧斜边：圆弧末端 → 沿斜边向下 → 在卡片内圈顶边（y=I）处拐成水平
  const p1 = [x0 + 2 + 0.951 * r, TY + 16 - 0.309 * r]
  const dx = 0.3, dy = 0.954
  const t = (I - 5 - p1[1]) / dy
  const p2 = [p1[0] + dx * t, I - 5]
  const ctrl = [p2[0] + dx * (5 / dy), I]
  const end = [ctrl[0] + 8, I]
  const Ri = R - I
  const d = [
    `M${I} ${TY + 16} A${r} ${r} 0 0 1 16 ${TY + I} H${x0 + 2}`,
    `A${r} ${r} 0 0 1 ${f(p1[0])} ${f(p1[1])} L${f(p2[0])} ${f(p2[1])} Q${f(ctrl[0])} ${f(ctrl[1])} ${f(end[0])} ${f(end[1])}`,
    `H${W - I - Ri} A${Ri} ${Ri} 0 0 1 ${W - I} ${I + Ri} V${H - I - Ri} A${Ri} ${Ri} 0 0 1 ${W - I - Ri} ${H - I} H${I + Ri} A${Ri} ${Ri} 0 0 1 ${I} ${H - I - Ri} Z`,
  ].join(' ')
  return (
    <svg className="fc-outline" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

// 首页：上方是排版标题，下方是一份份分镜稿（文件夹卡片）+ 新建入口
export default function Home({ list, currentId, onOpen, onNew, onDelete }) {
  const [q, setQ] = useState('')
  const newRef = useRef(null)
  const [newSize, setNewSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = newRef.current
    if (!el) return undefined
    const measure = () => setNewSize({ w: el.offsetWidth, h: el.offsetHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const kw = q.trim().toLowerCase()
  const shown = kw ? list.filter((d) => (d.title + ' ' + (d.excerpt || '')).toLowerCase().includes(kw)) : list
  return (
    <div className="home">
      <section className="hero">
        <svg className="hero-bubble" viewBox="0 0 64 50" aria-hidden="true">
          <path d="M10 2h44a8 8 0 0 1 8 8v20a8 8 0 0 1-8 8H30L16 48V38h-6a8 8 0 0 1-8-8V10a8 8 0 0 1 8-8z" />
          <circle cx="20" cy="20" r="3.2" /><circle cx="32" cy="20" r="3.2" /><circle cx="44" cy="20" r="3.2" />
        </svg>
        <div className="hero-top">一份剧本，一份分镜</div>
        <div className="hero-main">
          <i className="hh tl" /><i className="hh br" />
          <span className="hero-word">分镜对照</span>
          <span className="hero-sparks" aria-hidden="true">
            <IconStar4 size={46} /><IconStar4 size={24} /><IconStar4 size={18} />
          </span>
        </div>
        <div className="hero-sub">对着剧本写，不用来回翻。</div>
      </section>

      <section className="shelf" aria-label="分镜稿">
        <button className="folder-card new" onClick={onNew} ref={newRef}>
          <NewOutline width={newSize.w} height={newSize.h} />
          <span className="fc-tab" />
          <span className="fc-body">
            <span className="fc-head"><span className="fc-name">空白分镜稿</span></span>
            <span className="fc-meta">从空白开始，写一份新的分镜稿</span>
            <span className="fc-bigplus"><IconPlusBig size={56} /></span>
          </span>
        </button>
        {shown.map((d) => (
          <div
            key={d.id}
            className={`folder-card ${d.id === currentId ? 'current' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(d.id)}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(d.id) }}
          >
            <span className="fc-tab" />
            {(
              <button
                className="fc-trash"
                onClick={(e) => { e.stopPropagation(); onDelete(d.id) }}
                title="删除这份分镜稿"
                aria-label="删除这份分镜稿"
              >
                <IconClose size={12} />
              </button>
            )}
            <span className="fc-body">
              <span className="fc-head">
                <span className="fc-name">{d.title}</span>
                <span className="fc-headmeta">
                  <span className="fc-date">{fmtFullDate(d.updatedAt)}</span>
                  {d.id === currentId && <span className="fc-now">上次打开</span>}
                </span>
              </span>
              <span className="fc-meta fc-excerpt">{d.excerpt || '（还没有剧本）'}</span>
            </span>
          </div>
        ))}
        {kw && shown.length === 0 && <div className="shelf-empty">没有找到匹配的分镜稿</div>}
        <label className="shelf-search">
          <IconSearch size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQ('') }}
            placeholder="搜索名称或剧本内容"
            spellCheck={false}
          />
          {q && <button type="button" className="search-x" onClick={() => setQ('')} aria-label="清除搜索"><IconClose size={11} /></button>}
        </label>
      </section>
    </div>
  )
}
