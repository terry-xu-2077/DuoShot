// 分镜稿里的资产引用：「@名称」+ 一段看不见的资产 id（指纹）+ 两个全角空格（占位）。
//
// 引用靠 id 认，不靠名字：资源库里把图改了名，分镜稿里的引用照样指向那张图，标签上显示的是它现在的名字。
// id 用不可见字符（U+2060 / 2061 / 2062 / 2064 当四进制数字，U+2063 当首尾分隔）紧跟在名字后面，
// 所以哪怕被粘贴到别处、导出成文本，看到的也只是「@名称」，不会出现乱码；
// 旧数据里只有「@名称」的写法照样能认（按名字找），会在载入时自动补上 id。
// 发给 AI / 导出之前，统一把引用换成资产当前的名字（plainMentions）。

export const MENTION_GAP = '  '
const MARK = '⁣'
const DIGITS = ['⁠', '⁡', '⁢', '⁤']
const ID_BLOCK = /⁣[⁠⁡⁢⁤]*⁣/g
const ID_AFTER = /⁣([⁠⁡⁢⁤]*)⁣/y
const ID_TOKEN = /([^\s@⁣]+)⁣([⁠⁡⁢⁤]+)⁣/y

export function encodeId(id) {
  return MARK + [...String(id || '')].map((c) => {
    const n = c.charCodeAt(0) & 255
    return DIGITS[(n >> 6) & 3] + DIGITS[(n >> 4) & 3] + DIGITS[(n >> 2) & 3] + DIGITS[n & 3]
  }).join('') + MARK
}

function decodeDigits(ds) {
  let out = ''
  for (let i = 0; i + 3 < ds.length; i += 4) {
    const n = DIGITS.indexOf(ds[i]) * 64 + DIGITS.indexOf(ds[i + 1]) * 16 + DIGITS.indexOf(ds[i + 2]) * 4 + DIGITS.indexOf(ds[i + 3])
    out += String.fromCharCode(n)
  }
  return out
}

// 写进文稿的引用：@名称 + 看不见的 id + 占位空格
export const mentionToken = (item) => `@${item.name}${encodeId(item.id)}${MENTION_GAP}`

// 去掉所有看不见的 id（统计字数、识别秒数时用）
export const stripIdMarks = (s) => (s || '').replace(ID_BLOCK, '')

// 在 value 里找出所有引用 { s, e, item }：先按 id 认，认不出再按「@名称」认（名字有长有短时优先匹配长的）；e 包含后面的占位空格
export function findMentions(value, items) {
  const out = []
  if (!items || !items.length) return out
  const sorted = [...items].sort((a, b) => b.name.length - a.name.length)
  let i = value.indexOf('@')
  while (i >= 0) {
    let hit = null
    let e = i + 1
    ID_TOKEN.lastIndex = i + 1
    const m = ID_TOKEN.exec(value)
    if (m) {
      const byId = items.find((it) => it.id === decodeDigits(m[2]))
      if (byId) { hit = byId; e = i + 1 + m[0].length }
    }
    if (!hit) {
      hit = sorted.find((it) => value.startsWith(it.name, i + 1))
      if (hit) {
        e = i + 1 + hit.name.length
        ID_AFTER.lastIndex = e
        const k = ID_AFTER.exec(value)
        if (k) e += k[0].length          // 名字后面跟着的 id（对不上任何资产的）一起吞掉
      }
    }
    if (hit) {
      if (value.startsWith(MENTION_GAP, e)) e += MENTION_GAP.length
      out.push({ s: i, e, item: hit })
      i = value.indexOf('@', e)
    } else {
      i = value.indexOf('@', i + 1)
    }
  }
  return out
}

function rewrite(text, items, make) {
  const t = String(text || '')
  const hits = findMentions(t, items)
  let out = ''
  let pos = 0
  hits.forEach((h) => { out += t.slice(pos, h.s) + make(h.item, t.slice(h.s, h.e)); pos = h.e })
  return out + t.slice(pos)
}

// 引用 → 资产当前名字：「@名称」+ 占位空格（没有 id 的残留一并去掉）。发给 AI、导出前用
export const plainMentions = (text, items) => stripIdMarks(rewrite(text, items, (it) => `@${it.name}${MENTION_GAP}`))

// 旧写法（只有「@名称」）→ 带 id 的写法；已经是新写法且名字没变的原样不动
export const upgradeMentions = (text, items) => rewrite(text, items, (it, old) => {
  const next = mentionToken(it)
  return old === next ? old : next
})
