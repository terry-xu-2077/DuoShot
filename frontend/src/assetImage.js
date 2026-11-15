// 资源库的图片处理：把拖进来 / 选中 / 粘贴的图片文件整理成 data URL。
// 图片会随 AI 请求一起发出去，太大的图又慢又贵，所以长边超过 MAX_SIDE 或文件超过 MAX_KEEP_BYTES 就缩小重新编码成 JPEG；
// 本来就不大的 jpg / png / webp / gif 原样保留（保住 PNG 的透明背景）。
const MAX_SIDE = 1280
const MAX_KEEP_BYTES = 1.5 * 1024 * 1024
const KEEP_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

export const isImageFile = (file) => /^image\//.test(file.type || '') || /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name || '')

const readAsDataUrl = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader()
  fr.onload = () => resolve(fr.result)
  fr.onerror = () => reject(new Error('读取图片失败'))
  fr.readAsDataURL(blob)
})

// 文件名去掉扩展名当作默认的资产名（真正的清理和去重由后端负责）
export const assetNameFromFile = (file) => (file.name || '图片').replace(/\.[^.\\/]{1,8}$/, '') || '图片'

const THUMB_SIDE = 360

const dataUrlToBlob = async (dataUrl) => (await fetch(dataUrl)).blob()

// 缩略图：长边 THUMB_SIDE 的 JPEG（资源库格子、@ 标签里显示用，比原图小得多，列表不卡）
async function thumbOfBitmap(bitmap, side = THUMB_SIDE) {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, w, h)
  g.drawImage(bitmap, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', 0.82)
}

export async function makeThumb(source) {
  const blob = typeof source === 'string' ? await dataUrlToBlob(source) : source
  let bitmap
  try { bitmap = await createImageBitmap(blob) } catch { throw new Error('不是能识别的图片') }
  try { return await thumbOfBitmap(bitmap) } finally { bitmap.close?.() }
}

// 发给 AI 之前：原图（引用的原文件可能很大）按需缩小，长边超过 MAX_SIDE 或超过 MAX_KEEP_BYTES 才重新编码成 JPEG
export async function shrinkForAi(dataUrl) {
  const blob = await dataUrlToBlob(dataUrl)
  const bitmap = await createImageBitmap(blob)
  try {
    if (Math.max(bitmap.width, bitmap.height) <= MAX_SIDE && blob.size <= MAX_KEEP_BYTES) return dataUrl
    return await thumbOfBitmap(bitmap, MAX_SIDE)
  } finally { bitmap.close?.() }
}

export async function prepareImage(file) {
  let bitmap
  try { bitmap = await createImageBitmap(file) } catch { throw new Error(`「${file.name}」不是能识别的图片`) }
  const { width, height } = bitmap
  const longest = Math.max(width, height)
  const small = longest <= MAX_SIDE && file.size <= MAX_KEEP_BYTES && KEEP_TYPES.includes(file.type)
  if (small) {
    bitmap.close?.()
    return { name: assetNameFromFile(file), dataUrl: await readAsDataUrl(file), width, height }
  }
  const scale = Math.min(1, MAX_SIDE / longest)
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  g.fillStyle = '#ffffff'      // JPEG 没有透明通道：透明处铺白底
  g.fillRect(0, 0, w, h)
  g.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  return { name: assetNameFromFile(file), dataUrl: canvas.toDataURL('image/jpeg', 0.88), width: w, height: h }
}
