import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

// 全应用统一的悬停提示（圆角矩形）：代替浏览器自带的 title 小黄条。
// 做法：监听鼠标移入，把元素上的 title 换成 data-tip（否则浏览器会同时弹它自己的提示），再在元素上方（放不下就在下方）显示。
// 所以界面里照常写 title="…" 就行，换行用 \n。
export default function Tooltip() {
  const [tip, setTip] = useState(null)   // { text, rect }
  const [pos, setPos] = useState(null)   // { left, top, below }
  const boxRef = useRef(null)
  const curRef = useRef(null)

  useEffect(() => {
    const hide = () => { curRef.current = null; setTip(null); setPos(null) }
    const onOver = (e) => {
      const el = e.target instanceof Element ? e.target.closest('[title],[data-tip]') : null
      if (!el) { if (curRef.current) hide(); return }
      const t = el.getAttribute('title')
      if (t != null) { if (t.trim()) el.setAttribute('data-tip', t); else el.removeAttribute('data-tip'); el.removeAttribute('title') }
      const text = el.getAttribute('data-tip')
      if (!text) { if (curRef.current) hide(); return }
      if (curRef.current === el) return
      curRef.current = el
      setPos(null)
      setTip({ text, rect: el.getBoundingClientRect() })
    }
    const onOut = (e) => {
      const cur = curRef.current
      if (cur && !(e.relatedTarget instanceof Node && cur.contains(e.relatedTarget))) hide()
    }
    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseout', onOut, true)
    document.addEventListener('mousedown', hide, true)
    document.addEventListener('keydown', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseout', onOut, true)
      document.removeEventListener('mousedown', hide, true)
      document.removeEventListener('keydown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // 量出提示框的大小，再决定放哪：默认在元素上方居中，上面放不下翻到下方，左右不超出窗口
  useLayoutEffect(() => {
    if (!tip || !boxRef.current) return
    const b = boxRef.current.getBoundingClientRect()
    const r = tip.rect
    const gap = 8
    const below = r.top - b.height - gap < 6
    const top = below ? r.bottom + gap : r.top - b.height - gap
    const left = Math.min(window.innerWidth - b.width - 6, Math.max(6, r.left + r.width / 2 - b.width / 2))
    setPos({ left, top, below })
  }, [tip])

  if (!tip) return null
  return (
    <div ref={boxRef} className={`tooltip${pos ? ' show' : ''}`} role="tooltip" style={{ left: pos ? pos.left : 0, top: pos ? pos.top : 0 }}>
      {tip.text}
    </div>
  )
}
