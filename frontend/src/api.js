// 与 Tauri(Rust) 后端的桥接；浏览器预览(vite dev)时走下面的 mock，
// mock 把数据存在 localStorage，刷新不丢，方便反复调界面。
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { fetchDevSettings, runDevAi, testDevAi, DEV_KEY_MASK } from './devAi.js'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// ---------- 公共小工具（前端与 mock 共用；Rust 侧以后按同样规则实现） ----------
export const countChars = (s) => [...(s || '').replace(/\s/g, '')].length

export function draftTitle(d) {
  const t = (d.title || '').trim()
  if (t) return t
  const first = (d.script || '').split('\n').map((l) => l.trim()).find(Boolean)
  return first ? [...first].slice(0, 20).join('') : '未命名分镜稿'
}

const pad = (n) => String(n).padStart(2, '0')
export const fmtClock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
export const fmtShort = (ms) => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` }

// 「2026年11月15日 16:32」
export const fmtFullDate = (ms) => { const t = new Date(ms); return `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日 ${pad(t.getHours())}:${pad(t.getMinutes())}` }

export const DEFAULT_SETTINGS = { baseUrl: 'http://127.0.0.1:11434/v1', model: '', apiKey: '', temperature: 0.3 }
export const aiConfigured = (s) => !!(s && s.baseUrl && s.baseUrl.trim() && s.model && s.model.trim())

// ---------- Tauri 路由：通道名 -> [Rust 命令, 参数映射] ----------
const ROUTES = {
  'settings:get': ['get_settings', () => ({})],
  'settings:set': ['set_settings', (a) => ({ settings: a[0] })],
  'doc:get': ['doc_get', () => ({})],
  'doc:save': ['doc_save', (a) => ({ doc: a[0] })],
  'doc:new': ['doc_new', () => ({})],
  'doc:open': ['doc_open', (a) => ({ id: a[0] })],
  'doc:delete': ['doc_delete', (a) => ({ id: a[0] })],
  'doc:export': ['doc_export', (a) => ({ id: a[0] })],
  'asset:add': ['asset_add', (a) => ({ docId: a[0], name: a[1], dataUrl: a[2], thumbDataUrl: a[3] || null })],
  'asset:addRef': ['asset_add_ref', (a) => ({ docId: a[0], path: a[1], thumbDataUrl: a[2] })],
  'asset:readPath': ['asset_read_path', (a) => ({ path: a[0] })],
  'asset:pick': ['pick_images', () => ({})],
  'file:read': ['file_read', (a) => ({ path: a[0] })],
  'asset:thumb': ['asset_thumb', (a) => ({ docId: a[0], assetId: a[1] })],
  'asset:data': ['asset_data', (a) => ({ docId: a[0], assetId: a[1] })],
  'asset:rename': ['asset_rename', (a) => ({ docId: a[0], assetId: a[1], name: a[2] })],
  'asset:remove': ['asset_remove', (a) => ({ docId: a[0], assetId: a[1] })],
  'ai:test': ['ai_test', (a) => ({ settings: a[0] })],
  'ai:start': ['ai_start', (a) => ({ message: a[0], images: a[1] || [] })],
  'ai:stop': ['ai_stop', () => ({})],
  'frame:setStyle': ['frame_set_style', (a) => ({ color: a[0], size: a[1] })],
}

// ---------- 浏览器预览 mock ----------
const LS = { docs: 'sb.docs', cur: 'sb.currentId', old: 'sb.current', set: 'sb.settings.dev' }
const read = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb } catch { return fb } }
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v))
// 列表里只放摘要：名称 / 最近保存时间 / 分镜字数（按最近保存倒序）
const meta = (docs) => [...docs]
  .sort((x, y) => y.updatedAt - x.updatedAt)
  .map((d) => ({ id: d.id, title: draftTitle(d), updatedAt: d.updatedAt, boardLen: (d.blocks || []).reduce((n, b) => n + countChars(b.text), 0), excerpt: (d.script || '').replace(/\s+/g, ' ').trim().slice(0, 420) }))
const newId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const blankDoc = () => ({ id: newId(), title: '', script: '', blocks: [], optimized: '', updatedAt: Date.now() })
const newBlockId = () => 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
// 旧数据里整块的 board 文字 → 一个批次（和 Rust 端的迁移规则一致）
const migrateDoc = (d) => {
  if (!Array.isArray(d.blocks)) d.blocks = d.board && d.board.trim() ? [{ id: newBlockId(), title: '', text: d.board, link: null }] : []
  delete d.board
  return d
}
// 分镜稿的存放位置：开发服务器在时，直接读写绿色版旁边的 drafts.json（和 exe 是同一份数据）；
// 没有开发服务器时退回 localStorage。注意：预览和 exe 不要同时开着改同一份数据。
let devStore = null   // { currentId, docs }
let devStoreTried = false
let devFlushT = null
async function ensureStore() {
  if (devStoreTried) return
  devStoreTried = true
  try {
    const r = await fetch('/__dev/drafts')
    if (r.ok) { devStore = await r.json(); devStore.docs = (devStore.docs || []).map(migrateDoc) }
  } catch { /* 没有开发服务器：用 localStorage */ }
}
function flushDevStore() {
  clearTimeout(devFlushT)
  devFlushT = setTimeout(() => {
    fetch('/__dev/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(devStore) }).catch(() => { })
  }, 60)
}
const getDocs = () => (devStore ? devStore.docs : (read(LS.docs, null) || null)?.map(migrateDoc) ?? null)
const getCur = () => (devStore ? devStore.currentId : read(LS.cur, ''))
const putDocs = (docs) => { if (devStore) { devStore.docs = docs; flushDevStore() } else write(LS.docs, docs) }
const putCur = (id) => { if (devStore) { devStore.currentId = id; flushDevStore() } else write(LS.cur, id) }
// 资产名：能写成 @名称（不含空白、@、文件名非法字符），同一份分镜稿里不重名；规则与 Rust 端一致
const EXT_OF = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }
export function cleanAssetName(raw) {
  const t = [...String(raw || '')].map((c) => (/\s/.test(c) || '@＠\\/:*?"<>|'.includes(c) ? '_' : c)).join('').replace(/^_+|_+$/g, '')
  return [...t].slice(0, 20).join('') || '图片'
}
export function uniqueAssetName(base, existing, skipId) {
  const taken = (n) => existing.some((a) => a.id !== skipId && a.name === n)
  if (!taken(base)) return base
  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`
    const cand = [...base].slice(0, 20 - suffix.length).join('') + suffix
    if (!taken(cand)) return cand
  }
  return `${base}_${Date.now()}`
}
async function devAsset(op, body) {
  let r
  try {
    r = await fetch('/__dev/asset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, ...body }) })
  } catch { throw new Error('资源库的图片需要开发服务器（npm run dev）或 exe 才能保存') }
  const v = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(v.error || '资源库操作失败')
  return v
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const flag = (name) => typeof location !== 'undefined' && location.hash.includes(name)

const DEMO_SCRIPT = `第一场　雨夜·旧书店门口
夜，大雨。霓虹在积水里碎成一片。
林舟撑着黑伞站在旧书店门口，犹豫了很久，终于推门。
门铃轻响。柜台后的老板没有抬头。
老板：这么晚了，还有人来找书？
林舟：我找一本……不在书架上的书。

第二场　旧书店内
老板缓缓抬头，目光落在林舟湿透的袖口上。
他从抽屉里取出一本没有封面的册子，推了过来。`

const DEMO_BOARD = `镜头1｜全景｜雨夜街头，霓虹倒映在积水中，林舟撑伞走近旧书店
镜头2｜中景｜林舟在门口站定，犹预片刻后推门
镜头3｜特写｜门铃晃动，柜台后老板的手指停在书页上
镜头4｜中近景｜老扳缓缓抬头，目光落向林舟湿透的衣袖`

// 导出的 Markdown：标题 / 剧本 / 分镜稿 / （有的话）AI 优化
const boardMarkdown = (d) => {
  const blocks = (d.blocks || []).filter((b) => (b.text || '').trim() || (b.title || '').trim())
  if (!blocks.length) return '（空）'
  return blocks.map((b, i) => [
    `### ${String(i + 1).padStart(2, '0')}${(b.title || '').trim() ? ` ${b.title.trim()}` : ''}`,
    ...(b.link && (b.link.preview || '').trim() ? [`> 对应剧本：${b.link.preview.trim()}`] : []),
    (b.text || '').trim() || '（空）',
    ...((b.optimized || '').trim() ? ['**AI 优化稿：**', b.optimized.trim()] : []),
  ].join('\n\n')).join('\n\n')
}

export const docToMarkdown = (d) => [
  `# ${draftTitle(d)}`,
  '## 剧本', (d.script || '').trim() || '（空）',
  '## 分镜稿', boardMarkdown(d),
  ...((d.optimized || '').trim() ? ['## AI 优化', d.optimized.trim()] : []),
].join('\n\n') + '\n'

const listeners = new Set()
const emit = (p) => listeners.forEach((fn) => fn(p))
let aiTimer = null
let aiAbort = null

// 预览里的 AI 设置：以绿色版 settings.json 为准（由开发服务器读出，Key 不会进浏览器），
// 在预览里改过的字段另存在 localStorage 里覆盖。没有开发服务器时退回默认值。
async function currentSettings() {
  const file = await fetchDevSettings()
  const base = { ...DEFAULT_SETTINGS }
  let presets = []
  let activePreset = ''
  if (file) {
    base.baseUrl = file.baseUrl || base.baseUrl
    base.model = file.model || ''
    base.temperature = file.temperature
    base.apiKey = file.hasKey ? DEV_KEY_MASK : ''
    presets = (file.presets || []).map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, temperature: p.temperature, apiKey: p.hasKey ? DEV_KEY_MASK : '' }))
    activePreset = file.activePreset || ''
  }
  const local = read(LS.set, null)
  if (local) {
    if (Array.isArray(local.presets)) {
      // 预览里改过预设：整份用预览里的（没改过的 Key 仍是「沿用绿色版」，由开发服务器按预设 id 补上）
      presets = local.presets
      activePreset = local.activePreset || ''
    } else {
      for (const k of ['baseUrl', 'model', 'temperature']) if (local[k] !== undefined && local[k] !== '') base[k] = local[k]
      if (local.apiKey && local.apiKey !== DEV_KEY_MASK) base.apiKey = local.apiKey
    }
  }
  if (!presets.length && (base.model || base.apiKey)) presets = [{ id: 'default', name: '默认', baseUrl: base.baseUrl, model: base.model, temperature: base.temperature, apiKey: base.apiKey }]
  const active = presets.find((p) => p.id === activePreset) || presets[0]
  if (active) { base.baseUrl = active.baseUrl || base.baseUrl; base.model = active.model; base.temperature = active.temperature; base.apiKey = active.apiKey }
  return { ...base, presets, activePreset: active ? active.id : '' }
}

function mockOptimized(board) {
  const fixes = [['犹预', '犹豫'], ['老扳', '老板'], ['衣袖', '袖口']]
  let out = board
  fixes.forEach(([a, b]) => { out = out.split(a).join(b) })
  return out
    .split('\n')
    .map((l) => l.replace(/｜/g, ' ｜ ').replace(/\s+｜\s+/g, '｜'))
    .join('\n')
}

const mock = {
  invoke: async (channel, ...a) => {
    await sleep(120)
    await ensureStore()
    switch (channel) {
      case 'settings:get': return currentSettings()
      case 'settings:set': write(LS.set, a[0]); return currentSettings()
      case 'doc:get': {
        let docs = getDocs()
        if (!docs) {
          const old = read(LS.old, null)
          const now = Date.now()
          if (old) docs = [migrateDoc({ id: newId(), title: old.title || '', script: old.script || '', board: old.board || '', optimized: old.optimized || '', updatedAt: now })]
          else if (flag('empty')) docs = []
          else docs = [
            migrateDoc({ id: newId(), title: '雨夜旧书店', script: DEMO_SCRIPT, board: DEMO_BOARD, optimized: '', updatedAt: now }),
            migrateDoc({ id: newId(), title: '第一场 试写', script: DEMO_SCRIPT.split('\n').slice(0, 4).join('\n'), board: '镜头1｜全景｜雨夜街头', optimized: '', updatedAt: now - 1000 * 60 * 60 * 26 }),
          ]
          putDocs(docs)
        }
        if (docs.length === 0) return { doc: null, list: [] }   // 一份都没有：首页只显示「空白分镜稿」
        const cur = docs.find((d) => d.id === getCur()) || meta(docs).map((m) => docs.find((d) => d.id === m.id))[0]
        if (getCur() !== cur.id) putCur(cur.id)
        return { doc: cur, list: meta(docs) }
      }
      case 'doc:save': {
        const d = a[0]
        const now = Date.now()
        const docs = (getDocs() || [])
        const i = docs.findIndex((x) => x.id === d.id)
        let updatedAt = now
        if (i >= 0) {
          const o = docs[i]
          const same = o.title === d.title && o.script === d.script && JSON.stringify(o.blocks || []) === JSON.stringify(d.blocks || []) && (o.optimized || '') === (d.optimized || '')
          if (same) updatedAt = o.updatedAt
          else docs[i] = { ...o, title: d.title, script: d.script, blocks: d.blocks || [], optimized: d.optimized || '', updatedAt: now }
        } else docs.push({ ...d, optimized: d.optimized || '', updatedAt: now })
        putDocs(docs)
        return { updatedAt, list: meta(docs) }
      }
      case 'doc:new': {
        const docs = (getDocs() || [])
        const doc = blankDoc()
        docs.push(doc)
        putDocs(docs)
        putCur(doc.id)
        return { doc, list: meta(docs) }
      }
      case 'doc:open': {
        const doc = (getDocs() || []).find((x) => x.id === a[0])
        if (!doc) throw new Error('这份分镜稿已不存在')
        putCur(doc.id)
        return doc
      }
      case 'doc:delete': {
        devAsset('purge', { docId: a[0] }).catch(() => { })   // 连同这份分镜稿的资产图一起删
        const docs = (getDocs() || []).filter((x) => x.id !== a[0])
        putDocs(docs)
        if (docs.length === 0) return { doc: null, list: [] }
        let cur = docs.find((x) => x.id === getCur())
        if (!cur) { cur = docs.find((x) => x.id === meta(docs)[0].id); putCur(cur.id) }
        return { doc: cur, list: meta(docs) }
      }
      case 'asset:add': {
        const [docId, name, dataUrl] = a
        const docs = getDocs() || []
        const doc = docs.find((x) => x.id === docId)
        if (!doc) throw new Error('这份分镜稿已不存在')
        const mime = /^data:([^;]+);base64,/.exec(dataUrl || '')?.[1]
        const ext = EXT_OF[mime]
        if (!ext) throw new Error(`不支持这种图片格式（${mime || '未知'}），请用 jpg / png / webp / gif`)
        const id = newId()
        await devAsset('put', { docId, id, ext, dataUrl })
        const asset = { id, name: uniqueAssetName(cleanAssetName(name), doc.assets || [], null), mime }
        doc.assets = [...(doc.assets || []), asset]
        putDocs(docs)
        return { asset, assets: doc.assets }
      }
      case 'asset:thumb':
      case 'asset:data': {
        const doc = (getDocs() || []).find((x) => x.id === a[0])
        const asset = doc?.assets?.find((x) => x.id === a[1])
        if (!asset) throw new Error('这张图已不在资源库里')
        return (await devAsset('get', { docId: a[0], id: asset.id, ext: EXT_OF[asset.mime] })).dataUrl
      }
      case 'asset:rename': {
        const docs = getDocs() || []
        const doc = docs.find((x) => x.id === a[0])
        const asset = doc?.assets?.find((x) => x.id === a[1])
        if (!asset) throw new Error('这张图已不在资源库里')
        asset.name = uniqueAssetName(cleanAssetName(a[2]), doc.assets, asset.id)
        putDocs(docs)
        return { assets: doc.assets }
      }
      case 'asset:remove': {
        const docs = getDocs() || []
        const doc = docs.find((x) => x.id === a[0])
        const asset = doc?.assets?.find((x) => x.id === a[1])
        if (asset) {
          await devAsset('del', { docId: a[0], id: asset.id, ext: EXT_OF[asset.mime] }).catch(() => { })
          doc.assets = doc.assets.filter((x) => x.id !== asset.id)
          putDocs(docs)
        }
        return { assets: doc?.assets || [] }
      }
      case 'doc:export': {
        const d = (getDocs() || []).find((x) => x.id === a[0])
        if (!d) throw new Error('这份分镜稿已不存在')
        const name = (draftTitle(d).replace(/[\\/:*?"<>|]/g, '_') || '分镜稿') + '.md'
        const url = URL.createObjectURL(new Blob([docToMarkdown(d)], { type: 'text/markdown;charset=utf-8' }))
        const link = document.createElement('a')
        link.href = url; link.download = name
        document.body.appendChild(link); link.click(); link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 2000)
        return { path: name }
      }
      case 'ai:test': {
        const form = { ...(await currentSettings()), ...(a[0] || {}) }
        if (form.apiKey && !flag('test-fail')) return testDevAi(form)   // 有 Key：真实调用
        await sleep(700)
        if (flag('test-fail')) throw new Error('无法连接到 127.0.0.1:11434，请确认模型服务已启动')
        return { ok: true, message: '连接成功，模型已响应' }
      }
      case 'ai:start': {
        const s = await currentSettings()
        if (s.baseUrl && s.model && !flag('ai-error') && !flag('ai-slow')) {
          // 配了接口地址和模型名（本地模型可以没有 Key）：真实调用（经开发服务器转发），逻辑和 Rust 端一致；
          // 以前只在有 Key 时才真调用，本地模型没 Key 会落到下面的演示数据（把手写稿原样返回），看起来就像模型把原文吐了回来
          if (aiAbort) aiAbort.abort()
          const ctrl = new AbortController()
          aiAbort = ctrl
          runDevAi(s, { message: a[0], images: a[1] || [] }, (p) => { if (!ctrl.signal.aborted) emit(p) }, ctrl.signal)
          return { ok: true }
        }
        const text = mockOptimized(String(a[0] || '').split('【手写分镜稿】').pop() || DEMO_BOARD)
        let i = 0
        clearInterval(aiTimer)
        aiTimer = setInterval(() => {
          if (flag('ai-error') && i > 40) {
            clearInterval(aiTimer)
            emit({ type: 'error', message: '接口返回 401：API Key 无效或已过期，请到设置里检查' })
            return
          }
          emit({ type: 'chunk', text: text.slice(i, i + 3) })
          i += 3
          if (i >= text.length) { clearInterval(aiTimer); emit({ type: 'done' }) }
        }, flag('ai-slow') ? 160 : 45)
        return { ok: true }
      }
      case 'ai:stop':
        clearInterval(aiTimer)
        if (aiAbort) { aiAbort.abort(); aiAbort = null }
        emit({ type: 'stopped' })
        return { ok: true }
      default: return { ok: true }
    }
  },
  onAi: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
}

const tauri = {
  invoke: (channel, ...args) => {
    const route = ROUTES[channel]
    if (!route) return Promise.reject(new Error(`未知命令: ${channel}`))
    // Rust 命令以纯字符串 reject，这里统一成 Error，保证 e.message 就是真实原因
    return invoke(route[0], route[1](args)).catch((e) => {
      throw new Error(typeof e === 'string' && e ? e : (e?.message || String(e)))
    })
  },
  onAi: (cb) => {
    let un = () => {}
    listen('ai-event', (e) => cb(e.payload)).then((fn) => { un = fn })
    return () => un()
  },
}

// 把 CSS 里的窗口描边样式交给 Rust 的描边窗（浏览器预览下跳过）
export function applyWindowFrameStyle() {
  if (!isTauri) return
  const css = getComputedStyle(document.documentElement)
  const color = (css.getPropertyValue('--win-stroke-color') || '').trim()
  const size = (css.getPropertyValue('--win-stroke-size') || '').trim()
  if (!color && !size) return
  api.invoke('frame:setStyle', color, size).catch(() => { })
}

export const api = isTauri ? tauri : mock
export const isMock = !isTauri
