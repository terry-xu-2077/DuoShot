import { useLayoutEffect, useRef, useState } from 'react'

// 固定选区（蓝色区块）换成另一个、或被取消时：新的淡入、旧的淡出。
//   anchor  当前固定的锚点（没有就是 null）
//   geom    当前这块的外轮廓 {d, ...}（没有就是 null）
// 返回 { gen, ghost }：
//   gen    每换一次锚点加一，用作新区块的 React key，让它重新播放淡入动画（区块自己因为文字改动、窗口缩放而变形时不会重播）
//   ghost  上一块的轮廓路径（淡出期间有值，约 0.45 秒后清掉）
export function useRegionFade(anchor, geom) {
  const key = anchor ? `${anchor.quote}|${anchor.nth || 0}` : ''
  const prevKey = useRef(key)
  const shown = useRef(geom)        // 上一次提交时显示着的轮廓
  const timer = useRef(0)
  const [gen, setGen] = useState(0)
  const [ghost, setGhost] = useState(null)

  // 注意顺序：这个 effect 要排在下面「记下当前轮廓」的 effect 之前，这样读到的还是换之前的那块
  useLayoutEffect(() => {
    if (prevKey.current === key) return
    prevKey.current = key
    setGen((g) => g + 1)
    const old = shown.current
    if (old && old.d) {
      setGhost(old.d)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setGhost(null), 450)
    }
  }, [key])

  useLayoutEffect(() => { shown.current = geom })
  useLayoutEffect(() => () => clearTimeout(timer.current), [])

  return { gen, ghost }
}
