import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, isMock, aiConfigured, countChars, draftTitle, fmtClock, fmtShort } from './api.js'
import WinControls from './components/WinControls.jsx'
import AiPanel from './components/AiPanel.jsx'
import Home from './components/Home.jsx'
import BoardEditor from './components/BoardEditor.jsx'
import ConfirmDialog from './components/ConfirmDialog.jsx'
import MarkedTextarea, { MENTION_GAP } from './components/MarkedTextarea.jsx'
import AssetLibrary from './components/AssetLibrary.jsx'
import MarkdownView from './components/MarkdownView.jsx'
import BlockBar from './components/BlockBar.jsx'
import LinkLine from './components/LinkLine.jsx'
import { resolveAnchor, sameAnchor } from './anchor.js'
import { isImageFile, prepareImage, makeThumb, shrinkForAi } from './assetImage.js'
import { readTextFile, fileTitle } from './readFile.js'
import SettingsModal from './components/SettingsModal.jsx'
import { IconGear, IconCopy, IconClose, IconStar4, IconClock, IconChevron, IconPencil, IconHome } from './components/Icons.jsx'

const SAVE_DELAY = 400      // 输入停顿后，把改动直接覆盖保存到当前这份分镜稿

// 一份「分镜稿」= 名称 + 剧本 + 分镜稿（由很多个独立的批次 blocks 组成，你手写的，AI 永远不会改）
//               + AI优化(optimized，AI 给出的优化版本，单独保存、单独显示) + 专属资源库(assets)
// 批次 block = {id, title, text, link}：link 是（可选的）剧本文字锚点，记住它对应剧本里的哪一段
const EMPTY = { id: '', title: '', script: '', blocks: [], optimized: '', assets: [] }

const newBlockId = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

// 旧数据里整块的 board 文字 → 一个批次
const normDoc = (doc) => {
  const d = { ...doc, assets: doc.assets || [] }
  if (!Array.isArray(d.blocks)) d.blocks = d.board && d.board.trim() ? [{ id: newBlockId(), title: '', text: d.board, link: null }] : []
  delete d.board
  return d
}

// 所有批次的正文拼在一起（统计字数、找 @ 引用用）
const blocksText = (blocks) => (blocks || []).map((b) => b.text || '').join('\n\n')

// 发给 AI 的一整条消息（和以前在对话窗口里把参考图、手写分镜发给「分镜脚本大师」一样，只是由工具代发）：
// 批次 / 对应的剧本片段（只有固定了选区才发；没固定就不发剧本）/ 上一批次的优化稿（衔接连续性）/ 参考图清单 / 手写的分镜稿 / 额外要求。
// 参考图本身随请求附在文字后面，顺序与清单一致。
function buildAiMessage({ script, blocks, target, assets, refs, extra }) {
  const fixGap = (txt) => assets.reduce((t, a) => t.split(`@${a.name}${MENTION_GAP}`).join(`@${a.name} `), txt || '')   // 标签占位的全角空格换回普通空格
  const idx = blocks.findIndex((b) => b.id === target.id)
  const num = String(idx + 1).padStart(2, '0')
  const parts = [`【批次】第 ${num} 个批次${target.title.trim() ? `，名称：${target.title.trim()}` : '（还没有起名）'}`]
  const hit = target.link ? resolveAnchor(script, target.link) : null
  const passage = hit ? script.slice(hit.s, hit.e).trim() : ''
  if (passage) parts.push(`【对应的剧本片段】\n${passage}`)   // 批次没有固定剧本选区（或选区已失效）就不发剧本，只发手写的分镜稿
  const prev = idx > 0 ? blocks[idx - 1] : null
  if (prev && (prev.optimized || '').trim()) parts.push(`【上一批次的优化稿（本批次要从它的结尾状态继续）】\n${prev.optimized.trim()}`)
  if (refs.length) parts.push(`【参考图】（图片会在文字之后按这个顺序依次附上）\n${refs.map((r, i) => `参考图${i + 1}：${r.name}`).join('\n')}`)
  parts.push(`【手写分镜稿】\n${fixGap(target.text).trim()}`)
  if ((extra || '').trim()) parts.push(`【额外要求】\n${extra.trim()}`)
  return parts.join('\n\n')
}
const PHASE_LABEL ={ running: '生成中', done: '已完成', stopped: '已停止', error: '出错' }

// 分镜稿里的「@名称」→ 引用到了资源库里的哪些图（按在分镜稿里第一次出现的顺序），以及找不到对应资产的 @名称。
// 名称有长有短（@林舟 / @林舟_2），先按长名字匹配并把命中的部分抹掉，避免短名字误认。
function resolveMentions(board, assets) {
  let rest = board || ''
  const used = []
  for (const a of [...assets].sort((x, y) => y.name.length - x.name.length)) {
    const tag = `@${a.name}`
    if (rest.includes(tag)) { used.push(a); rest = rest.split(tag).join(' ') }
  }
  used.sort((x, y) => (board || '').indexOf(`@${x.name}`) - (board || '').indexOf(`@${y.name}`))
  const missing = []
  for (const m of rest.matchAll(/(?<![A-Za-z0-9])@([^\s@＠，。,.!?！？、；;：:（）()「」『』“”"']{1,20})/g)) {
    if (!missing.includes(m[1])) missing.push(m[1])
  }
  return { used, missing }
}

// 自己用 requestAnimationFrame 做的平滑滚动（先慢、中间快、再慢）。
// 不用 scrollTo({behavior:'smooth'})：它是否真的有动画取决于系统「显示动画」的设置，关掉时会瞬间跳过去。
// 距离越远用时越长（380 ~ 900 毫秒）；你自己滚动滚轮 / 按下鼠标时会立刻停止。
const scrollAnims = new WeakMap()
function animateScroll(el, target) {
  const max = Math.max(0, el.scrollHeight - el.clientHeight)
  const to = Math.min(Math.max(0, target), max)
  const from = el.scrollTop
  const dist = to - from
  const old = scrollAnims.get(el)
  if (old) old.cancel()
  if (Math.abs(dist) < 2) { el.scrollTop = to; return }
  const duration = Math.min(900, Math.max(380, 260 + Math.abs(dist) * 0.45))
  const start = performance.now()
  let raf = 0
  const stop = () => {
    cancelAnimationFrame(raf)
    el.removeEventListener('wheel', stop)
    el.removeEventListener('mousedown', stop)
    scrollAnims.delete(el)
  }
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2)
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration)
    el.scrollTop = from + dist * ease(t)
    if (t < 1) raf = requestAnimationFrame(tick)
    else stop()
  }
  el.addEventListener('wheel', stop, { passive: true })
  el.addEventListener('mousedown', stop)
  scrollAnims.set(el, { cancel: stop })
  raf = requestAnimationFrame(tick)
}

const MAX_AI_IMAGES = 12   // 一次 AI 优化最多附带几张资产图

export default function App() {
  const [draft, setDraft] = useState(EMPTY)            // 当前打开的这份分镜稿
  const [ready, setReady] = useState(false)
  const [list, setList] = useState([])                 // 所有分镜稿的摘要
  const [savedAt, setSavedAt] = useState(null)         // 当前这份最近一次保存的时间
  const [saveInfo, setSaveInfo] = useState({ state: 'idle', at: null })
  const [settings, setSettings] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [ai, setAi] = useState({ phase: 'idle', text: '', error: '', extra: '', target: '' })   // target：这次优化针对的批次 id
  const [optView, setOptView] = useState('preview')     // AI 稿：preview Markdown 预览 / edit 编辑
  const [boardMode, setBoardMode] = useState('src')       // 分镜稿页当前批次：src 手写分镜稿 / opt AI 优化稿
  const [confirmDel, setConfirmDel] = useState(null)   // 正在弹窗确认删除的分镜稿 {id, title}
  const [menuOpen, setMenuOpen] = useState(false)      // 分镜稿下拉是否展开
  const menuRef = useRef(null)
  const titleRef = useRef(null)
  const [page, setPage] = useState('home')            // home 首页 / editor 编辑页
  const [leaving, setLeaving] = useState(null)         // 正在滑出的页面（滑动期间两页同时存在）
  const [dir, setDir] = useState('fwd')                // fwd：首页 → 编辑页（往左滑）；back：编辑页 → 首页（往右滑）
  const [reveal, setReveal] = useState(false)          // 滑动停下后，编辑页文字从上到下渐隐出现
  const pageRef = useRef('home')
  const slideT = useRef(null)
  const revealT = useRef(null)
  const [scriptView, setScriptView] = useState('preview')    // 剧本页（默认 Markdown 预览）：edit 编辑 / preview Markdown 预览
  const [activeBlockId, setActiveBlockId] = useState('')   // 分镜稿页当前显示的批次
  const [confirmBlock, setConfirmBlock] = useState(null)      // 正在弹窗确认删除的批次
  const panesRef = useRef(null)
  const [rightTab, setRightTab] = useState('board')    // 右侧标签页：board 分镜稿 / ai AI 优化
  const [toast, setToast] = useState(null)
  const [thumbs, setThumbs] = useState({})            // 资产图缩略图缓存：「分镜稿id/资产id」→ data URL
  const thumbsRef = useRef({})
  const [adding, setAdding] = useState(false)           // 正在处理要加进资源库的图片
  const [confirmAsset, setConfirmAsset] = useState(null) // 正在弹窗确认删除的资产 {id, name}
  const [dropHot, setDropHot] = useState(null)         // 正被拖着文件悬停的区域：home / script / board / ai
  const [confirmReplace, setConfirmReplace] = useState(null)   // 拖入文件但目标页已有内容时，询问是否替换 {field, name, text}
  const scriptRef = useRef(null)
  const boardRef = useRef(null)
  const dropRef = useRef(null)
  const addRef = useRef(null)
  const scrollRef = useRef(null)
  const viewRef = useRef('board')
  const pageRef2 = useRef('home')

  const draftRef = useRef(EMPTY)
  const aiRef = useRef(ai)
  const saveT = useRef(null)
  const toastT = useRef(null)
  aiRef.current = ai

  const notify = useCallback((text, isError = false) => {
    clearTimeout(toastT.current)
    setToast({ text, isError, key: Date.now() })
    if (!isError) toastT.current = setTimeout(() => setToast(null), 3200)
  }, [])

  // 切换页面：整页（除顶上两个按钮）滑动；进入编辑页时，滑完后文字再渐隐出现
  const go = useCallback((to) => {
    const from = pageRef.current
    if (to === from) return
    pageRef.current = to
    setDir(to === 'editor' ? 'fwd' : 'back')
    setLeaving(from)
    setPage(to)
    clearTimeout(slideT.current)
    slideT.current = setTimeout(() => setLeaving(null), 440)
    if (to === 'editor') {
      setReveal(true)
      clearTimeout(revealT.current)
      // 滑动 → 文字渐隐出现（和滑动同时开始，约 0.9 秒）→ 再让剧本里固定的蓝色区块（和连线）淡入，并把剧本滚到那一段
      revealT.current = setTimeout(() => { setReveal(false); scrollRef.current?.() }, 1000)
    }
  }, [])

  // 打开一份分镜稿：换上内容，AI优化也跟着换成它自己保存的那份
  const applyDoc = useCallback((raw) => {
    const doc = normDoc(raw)
    draftRef.current = doc
    setDraft(doc)
    setActiveBlockId(doc.blocks[0]?.id || '')
    setSavedAt(doc.updatedAt || null)
    setAi((p) => ({ ...p, phase: 'idle', text: '', error: '', target: '' }))
    setBoardMode('src')
    setRightTab('board')
    setScriptView('preview')
  }, [])

  // ---------- 启动：读当前分镜稿、列表、设置 ----------
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [d, s] = await Promise.all([api.invoke('doc:get'), api.invoke('settings:get')])
        if (!alive) return
        if (d.doc) applyDoc(d.doc)   // 一份分镜稿都没有时不自动建空项目，首页只显示「空白分镜稿」
        setList(d.list)
        setSettings(s)
      } catch (e) { notify(`读取分镜稿失败：${e.message}`, true) }
      setReady(true)
    })()
    return () => { alive = false }
  }, [applyDoc, notify])

  // ---------- 自动保存：只是覆盖保存当前这份 ----------
  const persist = useCallback(async (doc) => {
    const r = await api.invoke('doc:save', doc)
    setList(r.list)
    if (draftRef.current.id === doc.id) setSavedAt(r.updatedAt)
    setSaveInfo({ state: 'saved', at: Date.now() })
  }, [])

  const scheduleSave = useCallback((next) => {
    clearTimeout(saveT.current)
    setSaveInfo((p) => ({ ...p, state: 'saving' }))
    saveT.current = setTimeout(async () => {
      try { await persist(next) } catch (e) { notify(`自动保存失败：${e.message}`, true) }
    }, SAVE_DELAY)
  }, [persist, notify])

  const edit = (field, value) => {
    const next = { ...draftRef.current, [field]: value }
    draftRef.current = next
    setDraft(next)
    scheduleSave(next)
  }

  // 切换 / 新建 / 删除前，先把当前这份存好
  const flushSave = async () => {
    clearTimeout(saveT.current)
    if (!draftRef.current.id) return
    await persist(draftRef.current)
  }

  // 页面被关/刷新前尽量落一次盘
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && draftRef.current.id) api.invoke('doc:save', draftRef.current).catch(() => { })
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [])

  // 下拉：点空白处或按 Esc 关闭
  useEffect(() => {
    if (!menuOpen) return undefined
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  // ---------- 分镜稿：切换 / 新建 / 删除 ----------
  const guardRunning = () => {
    if (aiRef.current.phase !== 'running') return false
    notify('AI 正在生成，请先停止再操作', true)
    return true
  }

  const openDoc = async (id) => {
    setMenuOpen(false)
    if (!id) return
    if (id === draftRef.current.id) { go('editor'); return }
    if (guardRunning()) return
    try {
      await flushSave()
      applyDoc(await api.invoke('doc:open', id))
      go('editor')
    } catch (e) { notify(e.message, true) }
  }

  const newDoc = async () => {
    setMenuOpen(false)
    if (guardRunning()) return
    try {
      await flushSave()
      const r = await api.invoke('doc:new')
      applyDoc(r.doc)
      setList(r.list)
      go('editor')
      setTimeout(() => titleRef.current?.focus(), 0)
    } catch (e) { notify(e.message, true) }
  }

  // 删除要先弹窗确认
  const askDelete = (id) => {
    setMenuOpen(false)
    const item = list.find((x) => x.id === id)
    if (item) setConfirmDel({ id, title: item.title })
  }

  // 导出为 Markdown（当前这份先存盘，保证导出的是最新内容）；成功后才继续删除
  const exportThenDelete = async (id) => {
    setConfirmDel(null)
    try {
      if (id === draftRef.current.id) await flushSave()
      const r = await api.invoke('doc:export', id)
      await deleteDoc(id, `已导出到 ${r.path}，并删除了这份分镜稿`)
    } catch (e) { notify(`导出失败，没有删除：${e.message}`, true) }
  }

  const deleteDoc = async (id, doneText = '已删除这份分镜稿') => {
    setConfirmDel(null)
    if (id === draftRef.current.id && guardRunning()) return
    try {
      if (id !== draftRef.current.id) await flushSave()
      else clearTimeout(saveT.current)
      const r = await api.invoke('doc:delete', id)
      setList(r.list)
      if (!r.doc) {
        // 删光了：回到首页，只剩「空白分镜稿」
        draftRef.current = EMPTY
        setDraft(EMPTY)
        setSavedAt(null)
        setAi((p) => ({ ...p, phase: 'idle', text: '', error: '' }))
        go('home')
      } else if (r.doc.id !== draftRef.current.id) applyDoc(r.doc)
      notify(doneText)
    } catch (e) { notify(e.message, true) }
  }

  // 首页按钮：在编辑页 → 回首页；已经在首页 → 平滑滚回顶部
  const goHome = () => {
    if (page !== 'home') { go('home'); return }
    document.querySelector('.home')?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // ---------- 分镜稿的批次 ----------
  const blocks = draft.blocks || []
  const active = blocks.find((b) => b.id === activeBlockId) || blocks[0] || null
  const activeRef = useRef(null)
  activeRef.current = active

  const commitBlocks = (nextBlocks) => {
    const next = { ...draftRef.current, blocks: nextBlocks }
    draftRef.current = next
    setDraft(next)
    scheduleSave(next)
  }

  const editBlock = (id, patch) => {
    commitBlocks((draftRef.current.blocks || []).map((b) => (b.id === id ? { ...b, ...patch } : b)))
  }

  // 新建批次：默认不关联剧本（要关联：在剧本里选中一段话，点选区角上的图钉）
  const addBlock = (init = {}) => {
    const b = { id: newBlockId(), title: '', text: '', link: null, ...init }
    commitBlocks([...(draftRef.current.blocks || []), b])
    setActiveBlockId(b.id)
    setRightTab('board')
    setTimeout(() => boardRef.current?.focus(), 0)
  }

  // 选中某个批次后，把剧本滚动到它固定的那一段，并保证整段都看得见：
  // 已经完整可见就不动；放得下就居中；比剧本页还高就让它的开头贴近上沿。
  // 等一小会儿再量：切换批次后蓝色块要先按新的关联重新画出来。
  const scrollScriptToLink = () => {
    // 不再人为延迟：等 React 把新区块画出来（两帧）就立刻开始滚，和区块的淡入淡出同时进行
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const body = document.querySelector('.panes .folder-body.solid')
      const region = body?.querySelector('.sel-svg path.sel-fade-in, .md-sel path.sel-fade-in')
      if (!body || !region) return
      const scroller = body.querySelector('.md-view') || body.querySelector('textarea')
      if (!scroller || scroller.offsetParent === null) return
      const sr = scroller.getBoundingClientRect()
      const rr = region.getBoundingClientRect()
      const margin = 28
      const fully = rr.top >= sr.top + margin && rr.bottom <= sr.bottom - margin
      if (fully) return
      const room = sr.height - margin * 2
      const wanted = rr.height <= room ? rr.top - sr.top - (sr.height - rr.height) / 2 : rr.top - sr.top - margin
      animateScroll(scroller, scroller.scrollTop + wanted)
    }))
  }

  scrollRef.current = scrollScriptToLink

  const selectBlock = (id) => {
    if (!blocks.some((x) => x.id === id)) return
    setActiveBlockId(id)   // 剧本里会自动显示这个批次固定了的那一段（没有关联就没有）
    scrollScriptToLink()
  }

  const deleteBlockNow = (id) => {
    setConfirmBlock(null)
    const list = draftRef.current.blocks || []
    const i = list.findIndex((b) => b.id === id)
    if (i < 0) return
    const rest = list.filter((b) => b.id !== id)
    commitBlocks(rest)
    if (activeRef.current?.id === id) {
      const nb = rest[Math.min(i, rest.length - 1)] || null
      setActiveBlockId(nb?.id || '')
      if (nb?.link) scrollScriptToLink()
    }
  }
  const askDeleteBlock = (b) => {
    setConfirmBlock({ id: b.id, title: (b.title || '').trim() || '（未命名）' })   // 不管有没有内容，一律弹窗确认
  }

  // 在剧本里选中一段文字，点选区角上的图钉：把它固定下来，并关联到当前批次。
  // 还没有任何批次的话，顺手建一个。固定了的选区不影响继续选中、复制剧本里的别的文字。
  const handleFix = (anchor) => {
    const cur = activeRef.current
    if (!cur) { addBlock({ link: anchor }); return }
    editBlock(cur.id, { link: anchor })
  }
  const unfixActive = () => { if (activeRef.current) editBlock(activeRef.current.id, { link: null }) }

  // 当前批次的关联在现在的剧本里还找不找得到
  const linkState = useMemo(() => {
    if (!active?.link) return 'none'
    return resolveAnchor(draft.script, active.link) ? 'ok' : 'broken'
  }, [active?.link, draft.script])
  const linkVisible = linkState === 'ok'

  // ---------- 拖入文件 ----------
  // 用 execCommand('insertText') 写入：这样 Ctrl+Z 能把替换前的内容撤销回来；失败时退回直接改 state
  const setFieldText = (field, text) => {
    const el = (field === 'script' ? scriptRef : boardRef).current
    if (el) {
      el.focus()
      el.select()
      try { if (document.execCommand('insertText', false, text)) return } catch { /* 退回下面的写法 */ }
    }
    if (field === 'script') edit('script', text)
    else if (activeRef.current) editBlock(activeRef.current.id, { text })
  }

  // 首页拖入文件：文件内容当作剧本，新建一份分镜稿
  const importAsNewDoc = async (title, text) => {
    if (guardRunning()) return
    try {
      await flushSave()
      const r = await api.invoke('doc:new')
      const next = { ...r.doc, title, script: text }
      applyDoc(next)
      setList(r.list)
      await persist(next)
      go('editor')
      notify(`已用「${title || '文件'}」新建分镜稿，文件内容作为剧本`)
    } catch (e) { notify(e.message, true) }
  }

  const isMarkdownFile = (name) => /\.(md|markdown)$/i.test(name || '')

  const fieldLabel = (f) => (f === 'script' ? '剧本' : '这个批次')

  const handleDrop = async (target, files) => {
    if (!files.length || !target) return
    if (target === 'lib') { await addAssets(files); return }
    if (target === 'ai') { notify('AI优化页不接收文件：请拖到「分镜稿」页，或左边的剧本页', true); return }
    const file = files[0]
    let text
    try {
      if (file.path) {
        // 桌面版拖进来的只有路径：让后端读出来，再交给同一套编码判断
        const r = await api.invoke('file:read', file.path)
        const bin = atob(r.base64)
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
        text = await readTextFile(new File([bytes], r.name || file.name))
      } else text = await readTextFile(file)
    } catch (e) { notify(e.message, true); return }
    if (target === 'home') {
      if (files.length > 1) notify('一次只会用第一个文件新建分镜稿，其余的已忽略')
      await importAsNewDoc(fileTitle(file.name), text)
      if (isMarkdownFile(file.name)) setScriptView('preview')   // 拖进来的是 .md：直接按 Markdown 显示
      return
    }
    if (target === 'board' && !activeRef.current) {
      // 分镜稿里还没有批次：用文件内容新建一个批次（名称取文件名）
      addBlock({ title: fileTitle(file.name), text })
      notify(`已用「${file.name}」新建了一个批次`)
      return
    }
    const current = target === 'script' ? draftRef.current.script : (activeRef.current?.text || '')
    if (current.trim()) {
      setConfirmReplace({ field: target, name: file.name, text })   // 已有内容：先问一声
    } else {
      setFieldText(target, text)
      if (target === 'script' && isMarkdownFile(file.name)) setScriptView('preview')
      notify(`已把「${file.name}」的内容放进${fieldLabel(target)}`)
    }
  }
  dropRef.current = handleDrop

  // 整个窗口都要拦住文件拖放：否则拖到没有处理的地方，浏览器会直接把窗口导航成那个文件
  useEffect(() => {
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')
    const targetOf = (e) => e.target?.closest?.('[data-drop]')?.dataset.drop || null
    const onOver = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const t = targetOf(e)
      e.dataTransfer.dropEffect = t ? 'copy' : 'none'
      setDropHot((prev) => (prev === t ? prev : t))
    }
    const onLeave = (e) => { if (e.relatedTarget === null) setDropHot(null) }
    const onDrop = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDropHot(null)
      dropRef.current(targetOf(e), Array.from(e.dataTransfer.files))
    }
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  // 桌面版：文件拖放由 Tauri 接管（只有这样才拿得到文件的真实路径，资产图才能「引用」而不是复制）。
  // 位置是物理像素，换算成页面坐标后，找到鼠标下面带 data-drop 的区域。
  useEffect(() => {
    if (isMock) return undefined
    let off = null
    let dead = false
    const baseName = (p) => p.split(/[\\/]/).pop() || p
    const targetAt = (pos) => {
      const r = window.devicePixelRatio || 1
      return document.elementFromPoint(pos.x / r, pos.y / r)?.closest?.('[data-drop]')?.dataset.drop || null
    }
    import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload
      if (p.type === 'enter' || p.type === 'over') {
        const t = targetAt(p.position)
        setDropHot((prev) => (prev === t ? prev : t))
      } else if (p.type === 'leave') {
        setDropHot(null)
      } else if (p.type === 'drop') {
        setDropHot(null)
        dropRef.current(targetAt(p.position), (p.paths || []).map((path) => ({ name: baseName(path), path })))
      }
    })).then((fn) => { if (dead) fn(); else off = fn }).catch(() => { })
    return () => { dead = true; if (off) off() }
  }, [])

  const confirmReplaceNow = () => {
    const { field, name, text } = confirmReplace
    setConfirmReplace(null)
    setFieldText(field, text)
    if (field === 'script' && /\.(md|markdown)$/i.test(name || '')) setScriptView('preview')
    notify(`已用「${name}」替换${fieldLabel(field)}；按 Ctrl+Z 可以撤销`)
  }

  // ---------- 资源库 ----------
  // 缩略图：当前这份分镜稿的资产图按需从后端读出来（并缓存）
  useEffect(() => {
    const docId = draft.id
    ;(draft.assets || []).forEach((a) => {
      const key = `${docId}/${a.id}`
      if (thumbsRef.current[key] !== undefined) return
      thumbsRef.current[key] = ''           // 先占位，避免重复请求
      api.invoke('asset:thumb', docId, a.id)
        .then((url) => { thumbsRef.current[key] = url; setThumbs((p) => ({ ...p, [key]: url })) })
        .catch(() => { delete thumbsRef.current[key] })
    })
  }, [draft.id, draft.assets])

  // 资产的增删改都由后端落盘；这里只把后端返回的最新资产列表换进当前稿（不依赖 doc:save）
  const applyAssets = (docId, assets) => {
    if (draftRef.current.id !== docId) return
    const next = { ...draftRef.current, assets }
    draftRef.current = next
    setDraft(next)
  }

  const addAssets = async (files) => {
    const docId = draftRef.current.id
    if (!docId) return
    const imgs = files.filter(isImageFile)
    if (!imgs.length) { notify('这里只接收图片文件（jpg / png / webp / gif）', true); return }
    setAdding(true)
    let ok = 0
    const fails = []
    for (const f of imgs.slice(0, 30)) {
      try {
        let r
        let thumb
        if (f.path) {
          // 有原文件路径：只引用原图，不复制；这边生成一张缩略图存起来用于显示
          const src = await api.invoke('asset:readPath', f.path)
          thumb = await makeThumb(src.dataUrl)
          r = await api.invoke('asset:addRef', docId, f.path, thumb)
        } else {
          // 没有路径（剪贴板粘贴、浏览器预览）：图片本身存一份
          const img = await prepareImage(f)
          thumb = await makeThumb(img.dataUrl)
          r = await api.invoke('asset:add', docId, img.name, img.dataUrl, thumb)
        }
        const key = `${docId}/${r.asset.id}`
        thumbsRef.current[key] = thumb
        setThumbs((p) => ({ ...p, [key]: thumb }))
        applyAssets(docId, r.assets)
        ok += 1
      } catch (e) { fails.push(`「${f.name}」${e.message}`) }
    }
    setAdding(false)
    if (fails.length) notify(`${ok ? `已加入 ${ok} 张；` : ''}有 ${fails.length} 张没加进去：${fails[0]}`, true)
    else notify(`已把 ${ok} 张图片加入资源库${imgs.length > 30 ? '（一次最多 30 张，其余的没有处理）' : ''}`)
  }
  addRef.current = addAssets

  // 桌面版：原生选择对话框拿到路径（引用原图）；浏览器预览里 AssetLibrary 自己用 <input type=file>
  const pickNative = async () => {
    try {
      const paths = await api.invoke('asset:pick')
      if (paths && paths.length) await addAssets(paths.map((p) => ({ name: p.split(/[\\/]/).pop() || p, path: p })))
    } catch (e) { notify(e.message || String(e), true) }
  }

  // 资源库里勾选了几张图：一次性把它们的「@名称」加到当前批次末尾（没有批次就新建一个）
  const insertAssets = (list) => {
    if (!list.length) return
    const tokens = list.map((a) => `@${a.name}${MENTION_GAP}`).join('')
    const cur = activeRef.current
    setBoardMode('src')
    setRightTab('board')
    if (!cur) { addBlock({ text: tokens }); notify(`已新建一个批次，并加入 ${list.length} 张图的 @ 标签`); return }
    const lead = cur.text && !cur.text.endsWith('\n') ? '\n' : ''
    const add = `${lead}${tokens}`
    // 等分镜稿页显示出来后，走编辑命令插入（Ctrl+Z 能撤销）；不行就直接改文字
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const ed = boardRef.current
      let ok = false
      try { ok = !!ed?.insertMentions(list, !!lead) } catch { ok = false }
      if (!ok) editBlock(cur.id, { text: cur.text + add })
    }))
    notify(`已把 ${list.length} 张图的 @ 标签加入「${cur.title.trim() || '当前批次'}」`)
  }

  const renameAsset = async (id, name) => {
    const docId = draftRef.current.id
    try { applyAssets(docId, (await api.invoke('asset:rename', docId, id, name)).assets) } catch (e) { notify(e.message, true) }
  }

  const removeAsset = async (id) => {
    setConfirmAsset(null)
    const docId = draftRef.current.id
    try { applyAssets(docId, (await api.invoke('asset:remove', docId, id)).assets) } catch (e) { notify(e.message, true) }
  }

  // 资源库页里直接 Ctrl+V 粘贴图片
  viewRef.current = rightTab
  pageRef2.current = page
  useEffect(() => {
    const onPaste = (e) => {
      if (pageRef2.current !== 'editor' || viewRef.current !== 'lib') return
      const files = Array.from(e.clipboardData?.files || []).filter(isImageFile)
      if (!files.length) return
      e.preventDefault()
      addRef.current(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  // AI 优化会附带分镜稿里 @ 引用到的资产图
  const aiRefs = useMemo(() => {
    const { used, missing } = resolveMentions(active?.text || '', draft.assets || [])
    return {
      used: used.map((a) => ({ id: a.id, name: a.name, url: thumbs[`${draft.id}/${a.id}`] })),
      missing,
      total: (draft.assets || []).length,
    }
  }, [active?.text, draft.assets, draft.id, thumbs])

  // ---------- 复制 ----------
  const copyText = async (text, what) => {
    if (!text || !text.trim()) { notify(`${what}还是空的，没有可复制的内容`, true); return }
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // 剪贴板接口被拒绝时的兜底：临时文本框 + execCommand
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      if (!ok) { notify('复制失败，请手动选中文字再复制', true); return }
    }
    notify(`已复制${what}（${countChars(text).toLocaleString()} 字）`)
  }

  // ---------- AI ----------
  useEffect(() => api.onAi((ev) => {
    setAi((p) => {
      if (p.phase !== 'running') return p
      switch (ev.type) {
        case 'chunk': return { ...p, text: p.text + ev.text }
        case 'done': return { ...p, phase: 'done' }
        case 'stopped': return { ...p, phase: 'stopped' }
        case 'error': return { ...p, phase: 'error', error: ev.message }
        default: return p
      }
    })
  }), [])

  // 生成完成后，把优化结果单独存进它针对的那个批次（optimized），刷新后仍在；不会动批次里手写的文字
  useEffect(() => {
    if (ai.phase !== 'done' || !ai.target) return
    const t = ai.text.replace(/\s+$/, '')
    const blk = (draftRef.current.blocks || []).find((b) => b.id === ai.target)
    if (!blk || (blk.optimized || '') === t) return
    const next = { ...draftRef.current, blocks: draftRef.current.blocks.map((b) => (b.id === ai.target ? { ...b, optimized: t } : b)) }
    draftRef.current = next
    setDraft(next)
    scheduleSave(next)
  }, [ai.phase, ai.text, ai.target, scheduleSave])

  const startAi = async () => {
    if (!aiConfigured(settings)) { notify('还没配置 AI 接口，请先填写地址和模型名', true); setShowSettings(true); return }
    const d = draftRef.current
    const target = activeRef.current
    if (!target || !(target.text || '').trim()) { notify('当前批次还是空的，请先在「分镜稿」里写，再来优化', true); return }
    // 当前批次里 @ 引用到的资产图随请求一起发出去
    const { used, missing } = resolveMentions(target.text, d.assets || [])
    const picked = used.slice(0, MAX_AI_IMAGES)
    const images = []
    for (const a of picked) {
      let url
      try { url = await shrinkForAi(await api.invoke('asset:data', d.id, a.id)) }   // 读的是原图（引用的原文件），太大就缩小再发
      catch (e) { notify(`读取资产图「@${a.name}」失败：${e.message}`, true); return }
      images.push({ name: a.name, dataUrl: url })
    }
    const notes = []
    if (used.length > picked.length) notes.push(`一次最多附带 ${MAX_AI_IMAGES} 张资产图，其余 ${used.length - picked.length} 张这次没带上`)
    if (missing.length) notes.push(`资源库里找不到 ${missing.map((m) => `@${m}`).join('、')}，这次不会附带它们的图`)
    if (notes.length) notify(notes.join('；'))
    clearTimeout(saveT.current)
    await persist(d).catch(() => { })
    setAi((p) => ({ ...p, phase: 'running', text: '', error: '', target: target.id }))
    const message = buildAiMessage({ script: d.script || '', blocks: d.blocks || [], target, assets: d.assets || [], refs: picked, extra: aiRef.current.extra })
    try { await api.invoke('ai:start', message, images) }
    catch (e) { setAi((p) => ({ ...p, phase: 'error', error: e.message })) }
  }

  const stopAi = () => api.invoke('ai:stop').catch(() => { })

  // AI 页里直接切换预设（不用进设置）：把选中的预设设为正在使用的，顶层字段换成它的副本
  const switchPreset = async (id) => {
    const cur = settings
    const p = (cur?.presets || []).find((x) => x.id === id)
    if (!p) return
    try {
      const saved = await api.invoke('settings:set', { baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey, temperature: p.temperature, presets: cur.presets, activePreset: id })
      setSettings(saved)
      notify(`已切换到「${p.name}」`)
    } catch (e) { notify(e.message, true) }
  }

  // ---------- 渲染 ----------
  const toggleMax = async () => {
    if (isMock) return
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().toggleMaximize()
  }

  const saveText = saveInfo.state === 'saving' ? '保存中…'
    : saveInfo.state === 'saved' ? `已自动保存 ${fmtClock(saveInfo.at)}`
      : ready ? '内容会自动保存' : '读取中…'

  const view = rightTab
  const showOptView = view === 'board' && boardMode === 'opt' && !!active
  // AI 优化页只跟「当前选中的批次」打交道：别的批次的上一次结果不在这里显示（正在生成的除外）
  const aiShown = ai.target && active && ai.target !== active.id && ai.phase !== 'running' ? { ...ai, phase: 'idle', text: '', error: '' } : ai
  const aiBatch = active ? { num: String(blocks.indexOf(active) + 1).padStart(2, '0'), title: active.title.trim(), hasOpt: !!(active.optimized || '').trim() } : null
  const aiRunningFor = ai.phase === 'running' && active && ai.target !== active.id ? blocks.find((b) => b.id === ai.target) : null

  return (
    <div className={`app frameless dir-${dir}${isMock ? ' preview' : ''}`}>
      {/* 顶部：左 logo / 中间「标题＝改名输入框＋历史下拉」/ 右 设置与窗口按钮 */}
      <header className="topbar" data-tauri-drag-region onDoubleClick={toggleMax}>
        <button className={`brand-orb ${page === 'home' ? 'on' : ''}`} onClick={goHome} onDoubleClick={(e) => e.stopPropagation()} title="首页：所有分镜稿" aria-label="首页">
          <IconHome size={16} />
        </button>

        {(page === 'editor' || leaving === 'editor') && (
          <div className={`titlebox ${page === 'editor' ? 'is-in' : 'is-out'}${leaving ? ' moving' : ''}`} ref={menuRef} onDoubleClick={(e) => e.stopPropagation()}>
            <IconStar4 size={26} className="title-star" />
            {savedAt && (
              <button className="time-pill" onClick={() => setMenuOpen((v) => !v)} title={`这份分镜稿最近一次保存的时间 · ${saveText}`}>
                <IconClock size={13} />{fmtShort(savedAt)}
              </button>
            )}
            <div className="title-line">
              <input
                className="big-title"
                key={draft.id}
                ref={titleRef}
                value={draft.title}
                onChange={(e) => edit('title', e.target.value)}
                placeholder={draftTitle(draft)}
                title={`点这里直接给分镜稿改名（留空则取剧本第一行）· ${saveText}`}
                maxLength={40}
                disabled={!ready}
                spellCheck={false}
              />
              <div className="caret-wrap">
              <button
                className="title-caret"
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={menuOpen}
                title="切换分镜稿"
                aria-label="切换分镜稿"
              >
                <IconChevron size={22} />
              </button>
              {menuOpen && (
                <div className="menu-anchor">
                  <ul className="hm-panel" role="listbox">
                    <li className="hm-head" aria-hidden="true">分镜稿 <b>{list.length} 份</b></li>
                    <li className="hm-new" role="option" onClick={newDoc}><span className="plus">＋</span>新建分镜稿</li>
                    {list.map((h) => (
                      <li
                        key={h.id}
                        role="option"
                        aria-selected={h.id === draft.id}
                        className={`hm-item ${h.id === draft.id ? 'sel' : ''}`}
                        onClick={() => openDoc(h.id)}
                      >
                        <span className="hm-text">
                          <span className="hm-title">{h.title}</span>
                          <span className="hm-meta">{fmtShort(h.updatedAt)} · 分镜 {h.boardLen.toLocaleString()} 字</span>
                        </span>
                        {(
                          <button
                            className="hm-del"
                            onClick={(e) => { e.stopPropagation(); askDelete(h.id) }}
                            title="删除这份分镜稿"
                            aria-label="删除这份分镜稿"
                          >
                            <IconClose size={11} />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              </div>
              <div className="tag" title="分镜稿字数"><IconPencil size={12} />{countChars(blocksText(draft.blocks)).toLocaleString()} 字</div>
            </div>
          </div>
        )}

        <div className="actions" onDoubleClick={(e) => e.stopPropagation()}>
          <button className="icon-btn ring big" onClick={() => setShowSettings(true)} title="AI 接口设置" aria-label="AI 接口设置">
            <IconGear size={15} />
          </button>
        </div>
        <WinControls />
      </header>

      <div className="stage">
        {(page === 'home' || leaving === 'home') && (
          <div className={`view home-view ${page === 'home' ? 'is-in' : 'is-out'}${leaving ? ' moving' : ''}${dropHot === 'home' ? ' drop-hot' : ''}`} data-drop="home">
            <Home list={list} currentId={draft.id} onOpen={openDoc} onNew={newDoc} onDelete={askDelete} />
            {dropHot === 'home' && <div className="drop-hint page">松开鼠标，用这个文件新建分镜稿（文件内容作为剧本）</div>}
          </div>
        )}
        {(page === 'editor' || leaving === 'editor') && (
          <div className={`view editor-view ${page === 'editor' ? 'is-in' : 'is-out'}${leaving ? ' moving' : ''}${reveal ? ' reveal' : ''}`}>
          <main className="panes" ref={panesRef}>
            {/* 左栏：同样是凸起的标签页，只是目前只有「剧本」一页 */}
            <section className={`folder${dropHot === 'script' ? ' drop-hot' : ''}`} data-drop="script">
              <div className="folder-tabs" role="tablist">
                <div className="ftab first active script">
                  <span className="ftab-main" role="tab" aria-selected="true">剧本</span>
                </div>
              </div>
              <div className="folder-body solid sq-left has-fab">
                <button
                  className={`copy-fab md-fab${scriptView === 'preview' ? ' on' : ''}`}
                  onClick={() => setScriptView((v) => (v === 'preview' ? 'edit' : 'preview'))}
                  title={scriptView === 'preview' ? '回到编辑' : '按 Markdown 预览剧本（标题、粗体、列表、引用等）'}
                  aria-label="切换 Markdown 预览"
                  aria-pressed={scriptView === 'preview'}
                >
                  MD
                </button>
                {scriptView === 'preview' && <MarkdownView source={draft.script} pinAnchor={active?.link || null} onPinChange={() => unfixActive()} onFix={handleFix} />}
                {dropHot === 'script' && (
                  <div className="drop-hint">{draft.script.trim() ? '松开鼠标，用文件内容替换剧本（会先确认）' : '松开鼠标，把文件内容放进剧本'}</div>
                )}
                <MarkedTextarea
                  key={draft.id}
                  ref={scriptRef}
                  pinSelection
                  pinAnchor={active?.link || null}
                  onPinChange={() => unfixActive()}
                  onFix={handleFix}
                  hidden={scriptView === 'preview'}
                  value={draft.script}
                  onChange={(e) => edit('script', e.target.value)}
                  placeholder={'在这里粘贴或编写剧本…\n\n例如：\n第一场　雨夜·旧书店门口\n夜，大雨。林舟撑着黑伞站在门口……'}
                  spellCheck={false}
                  disabled={!ready}
                />
              </div>
            </section>

            {/* 右栏：只有两个标签——分镜稿（你手写的，AI 不会改）| AI优化（既是提交页，也是结果展示页） */}
            <section className={`folder${dropHot === 'board' || dropHot === 'ai' || dropHot === 'lib' ? ' drop-hot' : ''}`} data-drop={view}>
              {view !== 'board' && <i className="corner-fill" aria-hidden="true" />}
              {view !== 'lib' && <i className="corner-fill r" aria-hidden="true" />}
              <div className="folder-tabs" role="tablist">
                <div className={`ftab first board ${view === 'board' ? 'active' : ''}`}>
                  <button className="ftab-main" role="tab" aria-selected={view === 'board'} onClick={() => setRightTab('board')}>
                    分镜稿{blocks.length > 0 && <small className="ftab-count">{blocks.length}</small>}
                  </button>
                </div>
                <div className={`ftab ai ${view === 'ai' ? 'active' : ''}`}>
                  <button
                    className="ftab-main"
                    role="tab"
                    aria-selected={view === 'ai'}
                    onClick={() => setRightTab('ai')}
                    title={`AI优化${PHASE_LABEL[ai.phase] ? `：${PHASE_LABEL[ai.phase]}` : ''}`}
                  >
                    {ai.phase !== 'idle' && <i className={`state-dot ${ai.phase}`} />}AI优化
                  </button>
                </div>
                {/* 资源库：靠右排列，用原来剧本的蓝色 */}
                <div className={`ftab lib last ${view === 'lib' ? 'active' : ''}`}>
                  <button className="ftab-main" role="tab" aria-selected={view === 'lib'} onClick={() => setRightTab('lib')} title="这份分镜稿的图片资产库">
                    资源库{draft.assets?.length > 0 && <small className="ftab-count">{draft.assets.length}</small>}
                  </button>
                </div>
              </div>

              <div className={`folder-body ${view === 'board' ? 'sq-left ' : ''}${view === 'lib' ? 'sq-right blue' : view === 'ai' ? 'kraft' : 'light'}`}>
                {(dropHot === 'board' || dropHot === 'ai' || dropHot === 'lib') && (
                  <div className="drop-hint">
                    {dropHot === 'lib' ? '松开鼠标，把图片加入资源库'
                      : dropHot === 'ai' ? '这一页不接收文件，请切到「分镜稿」再拖'
                        : !active ? '松开鼠标，用文件内容新建一个批次' : (active.text || '').trim() ? '松开鼠标，用文件内容替换这个批次（会先确认）' : '松开鼠标，把文件内容放进这个批次'}
                  </div>
                )}
                {view === 'board' && (
                  <BlockBar
                    blocks={blocks}
                    activeId={active?.id || ''}
                    onSelect={selectBlock}
                    onAdd={() => addBlock()}
                    onTitle={(t) => active && editBlock(active.id, { title: t })}
                    onDelete={askDeleteBlock}
                    linkState={linkState}
                    onUnlink={unfixActive}
                    mode={boardMode}
                    onMode={setBoardMode}
                  />
                )}
                {showOptView && (
                  <div className="opt-wrap">
                    {/* 和剧本页一样的 MD 按钮：亮着 = Markdown 预览，灭了 = 编辑 */}
                    <button
                      className={`copy-fab md-fab${optView === 'preview' ? ' on' : ''}`}
                      onClick={() => setOptView((v) => (v === 'preview' ? 'edit' : 'preview'))}
                      title={optView === 'preview' ? '回到编辑' : '按 Markdown 预览 AI 稿'}
                      aria-label="切换 Markdown 预览"
                      aria-pressed={optView === 'preview'}
                    >
                      MD
                    </button>
                    {optView === 'edit'
                      ? (
                        <div className="editor-wrap">
                          <textarea
                            key={`${draft.id}/${active.id}/opt`}
                            className="editor opt-editor"
                            value={active.optimized || ''}
                            onChange={(e) => editBlock(active.id, { optimized: e.target.value })}
                            placeholder="AI 稿还是空的：可以直接在这里写，或到「AI优化」页让 AI 生成"
                            spellCheck={false}
                          />
                        </div>
                      )
                      : (active.optimized || '').trim()
                        ? <MarkdownView source={active.optimized} light />
                        : <div className="opt-view"><div className="opt-empty">这个批次还没有 AI 稿。到右上角的「AI优化」页，点「开始优化」：AI 会按「W.分镜脚本大师」的方式，把你手写的分镜和这个批次引用的参考图一起理解，写出完整的分镜提示词。只处理当前选中的这个批次；结果存在这里，你手写的分镜稿不会被改动。也可以点右上角的 MD 切到编辑，自己写。</div></div>}
                  </div>
                )}
                {view === 'board' && !active && (
                  <div className="block-empty">
                    <p>分镜稿由很多个独立的小批次组成，一个批次就是一段独立的文字。</p>
                    <p className="dim">先建一个批次。再在左边剧本里选中一段话，点选区右上角的图钉，把它固定下来：它就和当前批次关联了，并连一根线过来。不固定也可以，只是没有那根连线。</p>
                    <button className="btn primary" onClick={() => addBlock()}>＋ 新建第一个批次</button>
                  </div>
                )}
                {active && (
                  <BoardEditor
                    key={`${draft.id}/${active.id}`}
                    ref={boardRef}
                    hidden={view !== 'board' || boardMode === 'opt'}
                    mentionItems={(draft.assets || []).map((a) => ({ id: a.id, name: a.name, url: thumbs[`${draft.id}/${a.id}`] }))}
                    mentionEmpty="资源库还是空的：先到右上角的「资源库」页添加图片"
                    value={active.text}
                    onChange={(text) => editBlock(active.id, { text })}
                    placeholder={'在这里写这个批次的分镜…\n\n例如：\n镜头1｜全景｜雨夜街头，林舟撑伞走近旧书店\n镜头2｜中景｜林舟在门口站定，片刻后推门'}
                    spellCheck={false}
                    disabled={!ready}
                  />
                )}
                {view === 'lib' && (
                  <AssetLibrary
                    assets={draft.assets || []}
                    thumbs={thumbs}
                    docId={draft.id}
                    adding={adding}
                    onFiles={addAssets}
                    onPickNative={isMock ? null : pickNative}
                    onInsert={insertAssets}
                    batchLabel={active ? (active.title.trim() || `批次 ${String(blocks.indexOf(active) + 1).padStart(2, '0')}`) : ''}
                    onRename={renameAsset}
                    onRemove={(a) => setConfirmAsset({ id: a.id, name: a.name })}
                  />
                )}
                {view === 'ai' && (
                  <AiPanel
                    refs={aiRefs}
                    ai={aiShown}
                    batch={aiBatch}
                    presets={settings?.presets || []}
                    activePreset={settings?.activePreset || ''}
                    onPreset={switchPreset}
                    runningFor={aiRunningFor ? (aiRunningFor.title.trim() || '（未命名）') : ''}
                    setExtra={(v) => setAi((p) => ({ ...p, extra: v }))}
                    onStart={startAi}
                    onStop={stopAi}
                  />
                )}
              </div>
            </section>
            <LinkLine key={active?.id || ''} active={linkVisible && view === 'board'} hostRef={panesRef} />
          </main>
          </div>
        )}
      </div>

      {showSettings && (
        <SettingsModal settings={settings} onClose={() => setShowSettings(false)} onSaved={setSettings} notify={notify} />
      )}

      {confirmBlock && (
        <ConfirmDialog title="删除这个批次？" confirmText="删除" onConfirm={() => deleteBlockNow(confirmBlock.id)} onCancel={() => setConfirmBlock(null)}>
          「{confirmBlock.title}」和它里面的内容会被删除（它和剧本的关联也一起没了），删除后无法恢复。
        </ConfirmDialog>
      )}

      {confirmAsset && (
        <ConfirmDialog title="删除这张资产图？" confirmText="删除" onConfirm={() => removeAsset(confirmAsset.id)} onCancel={() => setConfirmAsset(null)}>
          「{confirmAsset.name}」会从资源库里删除。分镜稿里已经引用它的 @{confirmAsset.name} 文字不会被改动，但它会变回普通文字，之后 AI 优化也带不上这张图。
        </ConfirmDialog>
      )}

      {confirmReplace && (
        <ConfirmDialog
          title={`替换${fieldLabel(confirmReplace.field)}？`}
          confirmText="替换"
          onConfirm={confirmReplaceNow}
          onCancel={() => setConfirmReplace(null)}
        >
          「{confirmReplace.name}」的内容会替换当前{fieldLabel(confirmReplace.field)}里已有的文字。替换后可以按 Ctrl+Z 撤销。
        </ConfirmDialog>
      )}

      {confirmDel && (
        <ConfirmDialog title="删除分镜稿" confirmText="删除" extraText="导出再删除" onExtra={() => exportThenDelete(confirmDel.id)} onConfirm={() => deleteDoc(confirmDel.id)} onCancel={() => setConfirmDel(null)}>
          确定要删除「{confirmDel.title}」吗？它的剧本、分镜稿和 AI 优化结果都会一起删除，删除后无法恢复。
        </ConfirmDialog>
      )}

      {toast && (
        <div key={toast.key} className={`toast ${toast.isError ? 'error' : ''}`} role="status">
          <span>{toast.text}</span>
          {toast.isError && (
            <button className="toast-close" onClick={() => setToast(null)} aria-label="关闭提示"><IconClose size={12} /></button>
          )}
        </div>
      )}
    </div>
  )
}
