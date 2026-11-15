// 把拖进来的文件读成文本（只支持文本类文件：txt / md / fountain …）。
// 编码：带 BOM 的 UTF-16 → 严格 UTF-8 → 失败就按 GB18030（Windows 记事本旧版另存的中文 txt）。
const MAX_BYTES = 3 * 1024 * 1024

export const fileTitle = (name) => (name || '').replace(/\.[^.\\/]{1,8}$/, '').trim().slice(0, 40)

export async function readTextFile(file) {
  if (/^image\//.test(file.type || '') || /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name || '')) {
    throw new Error(`「${file.name}」是图片：请切到「资源库」页再拖进来，作为这份分镜稿的资产图`)
  }
  if (file.size > MAX_BYTES) {
    throw new Error(`「${file.name}」太大了（${(file.size / 1048576).toFixed(1)} MB），最多支持 3 MB 的文本文件`)
  }
  const buf = new Uint8Array(await file.arrayBuffer())
  let text
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(buf.subarray(2))
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(buf.subarray(2))
  } else {
    if (buf.subarray(0, 4096).includes(0)) {
      throw new Error(`「${file.name}」不是文本文件（可能是 Word、PDF 等），请先另存为 .txt 或 .md 再拖进来`)
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      text = new TextDecoder('gb18030').decode(buf)
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  }
  text = text.replace(/\r\n?/g, '\n')
  if (!text.trim()) throw new Error(`「${file.name}」是空的，没有内容可以放进来`)
  return text
}
