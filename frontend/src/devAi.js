// 仅浏览器预览（vite dev）使用：通过 vite 开发服务器里的 /__dev/chat 转发，真实调用 AI 接口。
// Key 由开发服务器从绿色版的 settings.json 里补上，浏览器里拿不到；逻辑与 Rust 端 stream_chat 保持一致
// （流式 SSE / 非流式兜底 / 过滤 <think> / 中文错误提示）。真实 exe 不会用到这个文件。

// 系统提示词和 Rust 端共用同一份文件（技能全文 + 本应用的调用约定）
import SYSTEM_PROMPT from './skill/system-prompt.md?raw'

export const DEV_KEY_MASK = '（沿用绿色版配置里的 Key）'

export async function fetchDevSettings() {
  try {
    const r = await fetch('/__dev/settings')
    if (!r.ok) return null
    const v = await r.json()
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}

// 没有图片时是普通字符串；有图片时用 OpenAI 多模态格式（文字 + 每张图前面标上「参考图N」），和 Rust 端一致
function userContent(message, images) {
  if (!images || !images.length) return message
  const parts = [{ type: 'text', text: message }]
  images.forEach((img, i) => {
    parts.push({ type: 'text', text: `参考图${i + 1}（${img.name}）：` })
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl } })
  })
  return parts
}

function httpErrorText(code, body) {
  let detail = ''
  try {
    let v = JSON.parse(body)
    if (Array.isArray(v)) v = v[0]   // Gemini 的错误是数组
    detail = v?.error?.message || v?.message || (typeof v?.error === 'string' ? v.error : '') || v?.proxyError || ''
  } catch { detail = (body || '').slice(0, 200) }
  const hint = code === 401 || code === 403 ? 'API Key 无效、已过期或没有权限，请到设置里检查'
    : code === 404 ? '接口地址不对（找不到 /chat/completions），请检查 Base URL 和模型名'
      : code === 429 ? '请求太频繁或额度已用完，请稍后再试'
        : code >= 500 ? '模型服务端出错了，请稍后再试'
          : '接口拒绝了这次请求'
  return `接口返回 ${code}：${hint}${detail ? `（${String(detail).trim()}）` : ''}`
}

// 把 <think>…</think> 里的思考过程分出来（正文走 push 的返回值，思考走 thinkOut）；标签可能被切在两个 chunk 之间
function makeThinkFilter() {
  let inThink = false
  let buf = ''
  const partial = (s, tag) => {
    for (let k = Math.min(tag.length - 1, s.length); k >= 1; k--) if (s.endsWith(tag.slice(0, k))) return k
    return 0
  }
  return {
    push(text) {
      buf += text
      let out = ''
      for (;;) {
        if (inThink) {
          const i = buf.indexOf('</think>')
          if (i >= 0) { this.thinkOut += buf.slice(0, i); buf = buf.slice(i + 8); inThink = false } else {
            const cut = buf.length - partial(buf, '</think>')
            this.thinkOut += buf.slice(0, cut); buf = buf.slice(cut); break
          }
        } else {
          const i = buf.indexOf('<think>')
          const j = buf.indexOf('</think>')
          if (j >= 0 && (i < 0 || j < i)) {
            // 只有 </think> 没有 <think>（模板已替模型写了开头）：前面吐出来的全是思考过程，丢掉，并通知调用方清空已显示的部分
            this.thinkOut += out + buf.slice(0, j); buf = buf.slice(j + 8); out = ''; this.reset = true
          } else if (i >= 0) { out += buf.slice(0, i); buf = buf.slice(i + 7); inThink = true } else {
            const keep = Math.max(partial(buf, '<think>'), partial(buf, '</think>'))
            out += buf.slice(0, buf.length - keep)
            buf = buf.slice(buf.length - keep)
            break
          }
        }
      }
      return out
    },
    reset: false,
    thinkOut: '',   // 这次 push 里识别出来的思考文字，调用方取走
    finish() { const t = inThink ? '' : buf; buf = ''; return t },
  }
}

const contentOf = (v) => v?.choices?.[0]?.delta?.content ?? v?.choices?.[0]?.message?.content ?? v?.choices?.[0]?.text ?? null
const errorOf = (v) => {
  if (!v || v.error == null) return null
  return typeof v.error === 'string' ? v.error : (v.error.message || JSON.stringify(v.error))
}

function chatRequest(settings, payload, signal) {
  return fetch('/__dev/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey === DEV_KEY_MASK ? '' : settings.apiKey,
      presetId: settings.id || settings.activePreset || '',
      payload,
    }),
    signal,
  })
}

// 流式优化：emit 收到 {type: chunk|done|error}；signal 被 abort 时悄悄退出
export async function runDevAi(settings, { message, images }, emit, signal) {
  const payload = {
    model: settings.model,
    stream: true,
    temperature: Number(settings.temperature) || 0.3,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent(message, images) }],
  }
  let resp
  try { resp = await chatRequest(settings, payload, signal) } catch (e) {
    if (signal.aborted) return
    emit({ type: 'error', message: `无法连接到预览服务：${e.message}` }); return
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    let proxyError = ''
    try { proxyError = JSON.parse(body).proxyError || '' } catch { /* 不是 JSON */ }
    emit({ type: 'error', message: proxyError ? `无法连接到接口：${proxyError}。请确认地址正确、网络通畅` : httpErrorText(resp.status, body) })
    return
  }

  const filter = makeThinkFilter()
  let started = false
  let any = false
  const out = (text) => {
    const t = started ? text : text.replace(/^\s+/, '')
    if (!t) return
    started = true; any = true
    emit({ type: 'chunk', text: t })
  }
  const think = (text) => { if (text) emit({ type: 'think', text }) }   // 思考过程：单独发给界面，在 AI 页以可折叠的灰色块显示
  const feed = (text) => {
    const visible = filter.push(text)
    // 只有 </think>：前面已经当正文发出去的文字其实是思考，让界面把它们挪到思考区
    if (filter.reset) { filter.reset = false; started = false; any = false; emit({ type: 'rethink' }) }
    const thinking = filter.thinkOut; filter.thinkOut = ''
    think(thinking)
    out(visible)
  }

  let raw = ''
  const reader = resp.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let pending = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const lineRaw of lines) {
        const t = lineRaw.trim()
        if (!t || t.startsWith(':') || t.startsWith('event:') || t.startsWith('id:')) continue
        if (t.startsWith('data:')) {
          const data = t.slice(5).trim()
          if (data === '[DONE]') { pending = ''; break }
          let v
          try { v = JSON.parse(data) } catch { continue }
          const err = errorOf(v)
          if (err) { emit({ type: 'error', message: `模型返回错误：${err}` }); return }
          const rs = v?.choices?.[0]?.delta?.reasoning_content ?? v?.choices?.[0]?.delta?.reasoning
          if (rs) think(rs)
          const c = contentOf(v)
          if (c) feed(c)
        } else if (raw.length < 262144) raw += `${t}\n`
      }
    }
  } catch (e) {
    if (signal.aborted) return
    emit({ type: 'error', message: `读取模型输出时中断：${e.message}` }); return
  }
  if (signal.aborted) return
  if (!any && raw.trim()) {
    try {
      const v = JSON.parse(raw.trim())
      const err = errorOf(v) || v?.proxyError
      if (err) { emit({ type: 'error', message: `模型返回错误：${err}` }); return }
      const c = contentOf(v)
      if (c) feed(c)
    } catch { /* 解析不了就当没有内容 */ }
  }
  out(filter.finish())
  if (!any) { emit({ type: 'error', message: '模型没有返回任何内容。请确认模型名正确，并且这个接口支持 /chat/completions' }); return }
  emit({ type: 'done' })
}

export async function testDevAi(settings) {
  if (!(settings.model || '').trim()) throw new Error('请先填写模型名')
  const payload = {
    model: settings.model, stream: false, max_tokens: 16, temperature: 0,
    messages: [{ role: 'user', content: '回复“ok”两个字母即可。' }],
  }
  let resp
  try { resp = await chatRequest(settings, payload, undefined) } catch (e) { throw new Error(`无法连接到预览服务：${e.message}`) }
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    let proxyError = ''
    try { proxyError = JSON.parse(text).proxyError || '' } catch { /* 不是 JSON */ }
    throw new Error(proxyError ? `无法连接到接口：${proxyError}。请确认地址正确、网络通畅` : httpErrorText(resp.status, text))
  }
  let v
  try { v = JSON.parse(text) } catch { throw new Error('接口返回的不是 JSON') }
  if (v.proxyError) throw new Error(`无法连接到接口：${v.proxyError}`)
  const err = errorOf(v)
  if (err) throw new Error(`模型返回错误：${err}`)
  if (!Array.isArray(v.choices)) throw new Error('接口有响应，但格式不像 OpenAI（缺少 choices），请检查 Base URL')
  return { ok: true, message: '连接成功，模型已响应' }
}
