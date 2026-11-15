import React, { useEffect, useState } from 'react'

// 剧本里钉住的那段选区 → 当前分镜稿批次的标题栏：一根平滑的曲线。
// 只在「当前批次关联了这段剧本」时显示。位置每一帧都按页面上的实际位置重新量一次（滚动、缩放、切换批次都能跟上），
// 数值没变就不更新，所以几乎没有开销。
export default function LinkLine({ active, hostRef }) {
  const [shape, setShape] = useState(null)   // {d, x2, y2, dim}

  useEffect(() => {
    if (!active) { setShape(null); return undefined }
    let raf = 0
    let last = ''
    const tick = () => {
      const host = hostRef.current
      const path = host?.querySelector('.folder-body.solid .sel-svg path, .folder-body.solid .md-sel path')
      const head = host?.querySelector('.block-head')
      const body = host?.querySelector('.folder-body.solid')
      let next = null
      if (path && head && body) {
        const hr = host.getBoundingClientRect()
        const pr = path.getBoundingClientRect()
        const br = body.getBoundingClientRect()
        const er = head.getBoundingClientRect()
        const x1 = pr.right - hr.left
        const mid = pr.top + pr.height / 2
        // 选区滚出了剧本页的可见范围：线贴着页面上 / 下边缘，并变淡
        const y1c = Math.min(Math.max(mid, br.top + 24), br.bottom - 24)
        const dim = pr.bottom < br.top + 8 || pr.top > br.bottom - 8
        const x2 = er.left - hr.left
        const y2 = er.top + er.height / 2 - hr.top
        const y1 = y1c - hr.top
        const dx = Math.max(48, Math.abs(x2 - x1) * 0.5)
        const d = `M${x1.toFixed(1)} ${y1.toFixed(1)}C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`
        next = { d, x2, y2, dim }
      }
      const key = next ? `${next.d}|${next.dim}` : ''
      if (key !== last) { last = key; setShape(next) }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, hostRef])

  if (!shape) return null
  return (
    <svg className={`link-line${shape.dim ? ' dim' : ''}`} aria-hidden="true">
      <path d={shape.d} />
      <circle cx={shape.x2} cy={shape.y2} r="4.5" />
    </svg>
  )
}
