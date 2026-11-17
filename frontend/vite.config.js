import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import http from 'node:http'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// 开发预览直接沿用绿色版的配置文件（AI 的地址 / 模型 / Key），不用在预览里再填一遍
const PORTABLE_SETTINGS = path.resolve(here, '../release/分镜对照-绿色版/settings.json')

const PORTABLE_ASSETS = path.resolve(here, '../release/分镜对照-绿色版/assets')
const PORTABLE_DRAFTS =path.resolve(here, '../release/分镜对照-绿色版/drafts.json')

// 预览里的 /__dev/chat 由 Node 转发请求；访问 Google 等在线接口要走代理：环境变量优先，没有就读 Windows 系统代理。本机地址不走代理
function enableProxy() {
  try {
    const env = process.env
    let proxy = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || ''
    if (!proxy && process.platform === 'win32') {
      const q = (n) => {
        const out = execSync(`reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ${n}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        return (out.split(/\r?\n/).find((l) => l.includes(n)) || '').trim().split(/\s+/).pop()
      }
      if (q('ProxyEnable') === '0x1') {
        const server = q('ProxyServer') || ''
        proxy = server.split(';').map((p) => p.replace(/^https?=/, '')).find((p) => p && !p.includes('=')) || ''
      }
    }
    if (!proxy || typeof http.setGlobalProxyFromEnv !== 'function') return
    if (!/^\w+:\/\//.test(proxy)) proxy = `http://${proxy}`
    http.setGlobalProxyFromEnv({ HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,::1,.local,192.168.0.0/16,10.0.0.0/8' })
  } catch { /* 拿不到代理就直连 */ }
}
enableProxy()

function readPortableSettings() {
  try {
    const text = fs.readFileSync(PORTABLE_SETTINGS, 'utf8').replace(/^﻿/, '')
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

// 绿色版 settings.json 里的 AI 预设（旧版只有顶层字段：当成一个叫「默认」的预设）
function portablePresets(s) {
  if (Array.isArray(s.presets)) {
    return s.presets.map((p, i) => ({
      id: String(p.id || `p${i}`), name: String(p.name || `预设 ${i + 1}`), baseUrl: String(p.baseUrl || ''), model: String(p.model || ''), models: Array.isArray(p.models) ? p.models.map(String) : [],
      apiKey: String(p.apiKey || '').trim(), temperature: typeof p.temperature === 'number' ? p.temperature : 0.3,
    }))
  }
  if (s.baseUrl || s.model) {
    return [{ id: 'default', name: '默认', baseUrl: String(s.baseUrl || ''), model: String(s.model || ''), apiKey: String(s.apiKey || '').trim(), temperature: typeof s.temperature === 'number' ? s.temperature : 0.3 }]
  }
  return []
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

// 仅开发服务器使用的本地接口（构建出的页面里没有它）：
//   GET  /__dev/settings  -> 绿色版配置里的 baseUrl / model / temperature，以及有没有 Key（Key 本身不会发给浏览器）
//   POST /__dev/chat      -> 把请求转发到配置的 /chat/completions，Key 在这里由服务端从配置文件补上，并把响应原样流回去
function devApiPlugin() {
  return {
    name: 'storyboard-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/settings', (req, res) => {
        const s = readPortableSettings()
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        const presets = portablePresets(s)
        res.end(JSON.stringify({
          baseUrl: s.baseUrl || '',
          model: s.model || '',
          temperature: typeof s.temperature === 'number' ? s.temperature : 0.3,
          hasKey: !!(s.apiKey && String(s.apiKey).trim()),
          // 预设：Key 本身不发给浏览器，只告诉有没有
          presets: presets.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, models: p.models, temperature: p.temperature, hasKey: !!p.apiKey })),
          activePreset: s.activePreset || (presets[0] && presets[0].id) || '',
          source: PORTABLE_SETTINGS,
        }))
      })

      // 分镜稿：直接读写绿色版旁边的 drafts.json（和 exe 是同一份数据）。
      // 本次开发服务器第一次写入前，把现有文件备份一份（drafts.dev-backup.json）；写入走「临时文件 + 改名」。
      let backedUp = false
      server.middlewares.use('/__dev/drafts', async (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        if (req.method === 'POST') {
          try {
            const v = JSON.parse(await readBody(req))
            if (!v || !Array.isArray(v.docs) || typeof v.currentId !== 'string') throw new Error('格式不对')
            if (!backedUp && fs.existsSync(PORTABLE_DRAFTS)) {
              fs.copyFileSync(PORTABLE_DRAFTS, PORTABLE_DRAFTS.replace(/\.json$/, '.dev-backup.json'))
              backedUp = true
            }
            fs.mkdirSync(path.dirname(PORTABLE_DRAFTS), { recursive: true })
            const tmp = `${PORTABLE_DRAFTS}.tmp`
            fs.writeFileSync(tmp, JSON.stringify({ currentId: v.currentId, docs: v.docs }, null, 2), 'utf8')
            fs.renameSync(tmp, PORTABLE_DRAFTS)
            res.end('{"ok":true}')
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(e.message || e) }))
          }
          return
        }
        try {
          const text = fs.readFileSync(PORTABLE_DRAFTS, 'utf8').replace(/^﻿/, '')
          const v = JSON.parse(text)
          res.end(JSON.stringify({ currentId: typeof v.currentId === 'string' ? v.currentId : '', docs: Array.isArray(v.docs) ? v.docs : [] }))
        } catch {
          res.end(JSON.stringify({ currentId: '', docs: [] }))
        }
      })

      // 资源库的图片文件：放在绿色版旁边的 assets\<分镜稿id>\<资产id>.<扩展名>（和 exe 用同一个位置）
      //   POST /__dev/asset  {op: 'put'|'get'|'del'|'purge', docId, id, ext, dataUrl}
      const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '')
      const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }
      server.middlewares.use('/__dev/asset', async (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          if (req.method !== 'POST') throw new Error('只接受 POST')
          const { op, docId, id, ext, dataUrl } = JSON.parse(await readBody(req))
          const dir = path.join(PORTABLE_ASSETS, safe(docId))
          if (!safe(docId)) throw new Error('缺少分镜稿 id')
          const file = path.join(dir, `${safe(id)}.${safe(ext)}`)
          if (op === 'put') {
            const m = /^data:([a-z/+-]+);base64,(.*)$/s.exec(dataUrl || '')
            if (!m) throw new Error('图片数据格式不对')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(file, Buffer.from(m[2], 'base64'))
            res.end('{"ok":true}')
          } else if (op === 'get') {
            const buf = fs.readFileSync(file)
            res.end(JSON.stringify({ dataUrl: `data:${MIME[safe(ext)] || 'application/octet-stream'};base64,${buf.toString('base64')}` }))
          } else if (op === 'del') {
            fs.rmSync(file, { force: true })
            res.end('{"ok":true}')
          } else if (op === 'purge') {
            fs.rmSync(dir, { recursive: true, force: true })
            res.end('{"ok":true}')
          } else throw new Error('未知操作')
        } catch (e) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: String(e.message || e) }))
        }
      })

      server.middlewares.use('/__dev/chat', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        const abort = new AbortController()
        res.on('close', () => abort.abort())
        try {
          const { baseUrl, apiKey, presetId, payload } = JSON.parse(await readBody(req))
          const file = readPortableSettings()
          const preset = portablePresets(file).find((p) => p.id === presetId)   // 浏览器没有 Key 时，按预设 id 在服务端补上
          const key = (apiKey && String(apiKey).trim()) || (preset ? preset.apiKey : (file.apiKey ? String(file.apiKey).trim() : ''))
          const base = String(baseUrl || (preset ? preset.baseUrl : file.baseUrl) || '').trim().replace(/\/+$/, '')
          const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
          const headers = { 'Content-Type': 'application/json', Accept: payload.stream ? 'text/event-stream' : 'application/json' }
          if (key) headers.Authorization = `Bearer ${key}`
          const up = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: abort.signal })
          res.statusCode = up.status
          res.setHeader('Content-Type', up.headers.get('content-type') || 'application/json')
          res.setHeader('Cache-Control', 'no-cache')
          if (!up.body) { res.end(); return }
          for await (const chunk of up.body) res.write(chunk)
          res.end()
        } catch (e) {
          if (abort.signal.aborted) return
          if (res.headersSent) { res.destroy(); return }   // 流到一半上游断了：直接断开，前端才知道输出不完整
          res.statusCode = 502
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ proxyError: String(e && e.cause && e.cause.message ? e.cause.message : e.message || e) }))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), devApiPlugin()],
  base: './',
  clearScreen: false,
  build: { outDir: 'dist' },
  server: { port: 1420, strictPort: true }
})
