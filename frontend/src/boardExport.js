import { aiSeconds, countSeconds } from './api.js'
import { plainMentions } from './mentions.js'

// 「导出分镜稿」：把所有批次按顺序拼成一份文本。
// 每个批次前面一行标题：批次N_批次主题_(N秒)；批次内容优先用 AI 稿（只取 [导演说明] 那一行开始往后的部分，前面的批次名、建议生成时长等不要），
// 没有 AI 稿的批次用手写的分镜稿。批次之间空两行。

// AI 稿从 [导演说明] 所在的那一行开始（前面的内容忽略）；找不到这个标记就原样保留
export function fromDirectorNote(text) {
  const t = String(text || '')
  const i = t.indexOf('[导演说明]')
  if (i < 0) return t.trim()
  return t.slice(t.lastIndexOf('\n', i) + 1).trim()
}

const fmtNum = (n) => String(Math.round(n * 10) / 10)

export function boardExportText(doc) {
  const assets = doc.assets || []
  const parts = []
  ;(doc.blocks || []).forEach((b, i) => {
    const ai = (b.optimized || '').trim()
    const body = ai ? fromDirectorNote(ai) : plainMentions(b.text || '', assets).trim()
    if (!body) return                                   // 既没有 AI 稿也没有手写内容的批次不导出
    const sec = ai ? aiSeconds(ai) : countSeconds(b.text || '')
    const theme = (b.title || '').trim() || '未命名'
    parts.push(`批次${i + 1}_${theme}_(${sec ? `${fmtNum(sec)}秒` : '未标时长'})\n\n${body}`)
  })
  return parts.join('\n\n\n')
}
