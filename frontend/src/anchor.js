// 剧本选区的「文字锚点」：分镜稿批次靠它记住自己对应剧本里的哪一段。
//
// 不存字符位置（剧本一改位置就变了），而是存：
//   quote   去掉空白和 Markdown 标记后的选中文字（比对时两边都做同样的处理，所以编辑框里的原文和预览里渲染出来的文字能互相找到）
//   nth     这段文字在整篇剧本里是第几次出现（同一段话出现多次时用来区分）
//   preview 给人看的原样片段（鼠标悬停 / 导出用）
// 剧本在这段文字之外怎么改，锚点都还能找到；改到这段文字本身，才会找不到（显示为「关联已失效」）。

const SKIP = /[\s*_~`#>\-|]/   // 比对时忽略的字符：空白，以及 Markdown 的 * _ ~ ` # > - | 标记
const MAX_QUOTE = 4000

// 去掉忽略的字符，同时记下每个保留字符在原文里的位置
export function compact(text) {
  const kept = []
  const idx = []
  for (let i = 0; i < text.length; i++) {
    if (!SKIP.test(text[i])) { kept.push(text[i]); idx.push(i) }
  }
  return { str: kept.join(''), idx }
}

// text：整篇文字（编辑框的原文，或预览里所有文字节点拼起来的文字）；[s, e) 是选区
export function makeAnchor(text, s, e) {
  const { str, idx } = compact(text)
  let a = idx.findIndex((i) => i >= s)
  if (a < 0 || idx[a] >= e) return null
  let b = a
  while (b + 1 < idx.length && idx[b + 1] < e) b++
  const quote = str.slice(a, b + 1)
  if (!quote) return null
  let nth = 0
  for (let from = 0; ;) {
    const k = str.indexOf(quote, from)
    if (k < 0 || k >= a) break
    nth++
    from = k + 1
  }
  return {
    quote: quote.slice(0, MAX_QUOTE),
    nth,
    preview: text.slice(s, e).replace(/\s+/g, ' ').trim().slice(0, 80),
  }
}

// 在当前文字里找回锚点：返回 {s, e}（原文位置），找不到返回 null
export function resolveAnchor(text, anchor) {
  if (!anchor || !anchor.quote) return null
  const { str, idx } = compact(text)
  const hits = []
  for (let from = 0; ;) {
    const k = str.indexOf(anchor.quote, from)
    if (k < 0) break
    hits.push(k)
    from = k + 1
  }
  if (!hits.length) return null
  const k = hits[Math.min(anchor.nth || 0, hits.length - 1)]
  return { s: idx[k], e: idx[k + anchor.quote.length - 1] + 1 }
}

export const sameAnchor = (a, b) => !!a && !!b && a.quote === b.quote && (a.nth || 0) === (b.nth || 0)

// ---- 预览（DOM）一侧：把容器里所有文字节点拼成一整段文字，并能在「文字位置」和「节点 + 偏移」之间互相换算 ----
export function domTextMap(root) {
  const nodes = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length })
    text += n.nodeValue
  }
  return { text, nodes }
}

export function domOffset(map, node, offset) {
  const hit = map.nodes.find((x) => x.node === node)
  if (hit) return hit.start + offset
  // 选区端点落在元素上（而不是文字节点）：取该元素下第一个文字节点之前的位置
  const first = map.nodes.find((x) => node.contains && node.contains(x.node))
  return first ? first.start : -1
}

export function domPoint(map, pos, preferEnd = false) {
  for (let i = 0; i < map.nodes.length; i++) {
    const { node, start } = map.nodes[i]
    const end = start + node.nodeValue.length
    if (pos < end || (preferEnd && pos === end)) return { node, offset: Math.max(0, pos - start) }
  }
  const last = map.nodes[map.nodes.length - 1]
  return last ? { node: last.node, offset: last.node.nodeValue.length } : null
}
