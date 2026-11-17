import React, { useState } from 'react'
import { api, DEFAULT_SETTINGS, prefsOf } from '../api.js'
import { IconEye, IconEyeOff, IconChevron, IconClose } from './Icons.jsx'
import Dropdown from './Dropdown.jsx'

// 「使用习惯」页的开关：key 对应 settings.prefs，默认值见 api.js 的 DEFAULT_PREFS
const PREF_ITEMS = [
  { key: 'resumeLastBatch', title: '打开项目时回到最近编辑的批次', hint: '关掉后，打开项目总是从第一个批次开始' },
  { key: 'wheelSwitch', title: '在批次栏上滚动滚轮切换批次', hint: '鼠标放在分镜稿顶部的批次名上，向下滚是下一个批次，向上滚是上一个' },
  { key: 'chipPeek', title: '鼠标放到资产缩略图上显示大图预览', hint: '只作用于分镜稿里 @ 引用标签上的小缩略图' },
  { key: 'enterToSend', title: '在「额外要求」里按回车开始优化', hint: '关掉后，回车只是换行，改用 Ctrl+回车 开始优化' },
]

function Switch({ on, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`pref-switch${on ? ' on' : ''}`} onClick={() => onChange(!on)}><i /></button>
  )
}

const GEMINI = { name: 'Google AI Studio', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' }
// 一个预设可以存多个模型名（models），其中选中的那个是正在用的（model）
const modelsOf = (p) => {
  const list = Array.isArray(p.models) ? p.models.map((m) => String(m || '').trim()).filter(Boolean) : []
  const cur = String(p.model || '').trim()
  if (cur && !list.includes(cur)) list.unshift(cur)
  return [...new Set(list)]
}

// 模型名「折叠篮」：折叠时只显示正在用的那个，展开后可以增删条目、点一条切换正在用的
function ModelBasket({ models, model, onChange }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const add = () => {
    const name = draft.trim()
    if (!name) return
    const next = models.includes(name) ? models : [...models, name]
    onChange(next, name)       // 新加的条目直接设为正在用的
    setDraft('')
  }
  const remove = (name) => {
    const next = models.filter((m) => m !== name)
    onChange(next, model === name ? (next[0] || '') : model)
  }
  return (
    <div className={`model-basket${open ? ' open' : ''}`}>
      <button type="button" className="mb-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`mb-current mono${model ? '' : ' empty'}`}>{model || '还没有选模型：展开后添加'}</span>
        <span className="mb-count">{models.length} 个</span>
        <span className="mb-chev"><IconChevron size={16} /></span>
      </button>
      {open && (
        <div className="mb-body">
          {models.length === 0 && <div className="mb-empty">还没有模型名，在下面输入一个再点「添加」</div>}
          {models.map((m) => (
            <div key={m} className={`mb-item${m === model ? ' on' : ''}`}>
              <button type="button" className="mb-pick mono" onClick={() => onChange(models, m)} title={m === model ? '正在使用' : '点一下，改用这个模型'}>
                <i className="mb-dot" />{m}
              </button>
              <button type="button" className="mb-del" onClick={() => remove(m)} title="删除这条" aria-label={`删除 ${m}`}><IconClose size={11} /></button>
            </div>
          ))}
          <div className="mb-add">
            <input className="text-input mono" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} placeholder="例如：gemini-3.5-flash-lite"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
            <button type="button" className="btn" onClick={add} disabled={!draft.trim()}>添加</button>
          </div>
        </div>
      )}
    </div>
  )
}

const newPresetId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

// 把设置整理成预设列表：旧版只有一套接口设置，当成一个叫「默认」的预设
function initialPresets(settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) }
  if (Array.isArray(s.presets) && s.presets.length) return s.presets.map((p) => ({ ...DEFAULT_SETTINGS, ...p, models: modelsOf(p), temperature: String(p.temperature ?? DEFAULT_SETTINGS.temperature) }))
  return [{ id: 'default', name: '默认', baseUrl: s.baseUrl, model: s.model, models: modelsOf(s), apiKey: s.apiKey, temperature: String(s.temperature) }]
}

export default function SettingsModal({ settings, onClose, onSaved, notify }) {
  const [presets, setPresets] = useState(() => initialPresets(settings))
  const [selId, setSelId] = useState(() => (settings && settings.activePreset && initialPresets(settings).some((p) => p.id === settings.activePreset) ? settings.activePreset : initialPresets(settings)[0].id))
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState(null) // {ok, text}
  const [tab, setTab] = useState('ai')               // ai：AI 接口 / prefs：使用习惯
  const [prefs, setPrefs] = useState(() => prefsOf(settings))

  const cur = presets.find((p) => p.id === selId) || presets[0]
  const patch = (fields) => setPresets((list) => list.map((p) => (p.id === cur.id ? { ...p, ...fields } : p)))

  const clean = (p) => ({
    id: p.id,
    name: (p.name || '').trim() || '未命名预设',
    baseUrl: (p.baseUrl || '').trim().replace(/\/+$/, ''),
    model: (p.model || '').trim(),
    models: modelsOf(p),
    apiKey: (p.apiKey || '').trim(),
    temperature: Math.min(2, Math.max(0, Number(p.temperature) || 0)),
  })

  const addPreset = () => {
    const p = { id: newPresetId(), name: `预设 ${presets.length + 1}`, baseUrl: '', model: '', models: [], apiKey: '', temperature: String(DEFAULT_SETTINGS.temperature) }
    setPresets((list) => [...list, p])
    setSelId(p.id)
    setTestResult(null)
  }
  const copyPreset = () => {
    const p = { ...cur, id: newPresetId(), name: `${(cur.name || '预设').trim()} 副本` }
    setPresets((list) => [...list, p])
    setSelId(p.id)
    setTestResult(null)
  }
  const removePreset = () => {
    if (presets.length <= 1) return
    const rest = presets.filter((p) => p.id !== cur.id)
    setPresets(rest)
    setSelId(rest[0].id)
    setTestResult(null)
  }
  // Google AI Studio 的 Gemini API 自带 OpenAI 兼容入口，直接用同一套调用；只需要填地址、模型名和 Key
  const fillGemini = () => {
    const generic = /^预设 \d+$|^默认$|^未命名预设$/.test((cur.name || '').trim())
    const model = cur.model && /gemini/i.test(cur.model) ? cur.model : GEMINI.model
    patch({ baseUrl: GEMINI.baseUrl, model, models: modelsOf({ models: cur.models, model }), name: generic || !(cur.name || '').trim() ? GEMINI.name : cur.name })
    setTestResult(null)
  }
  const choose = (id) => { setSelId(id); setTestResult(null); setShowKey(false) }

  const test = async () => {
    const s = clean(cur)
    if (!s.baseUrl) { setTestResult({ ok: false, text: '请先填写接口地址' }); return }
    if (!s.model) { setTestResult({ ok: false, text: '请先填写模型名' }); return }
    setTesting(true); setTestResult(null)
    try {
      const r = await api.invoke('ai:test', s)
      setTestResult({ ok: true, text: r?.message || '连接成功' })
    } catch (e) { setTestResult({ ok: false, text: e.message }) }
    setTesting(false)
  }

  const save = async () => {
    setSaving(true)
    try {
      const list = presets.map(clean)
      const active = list.find((p) => p.id === selId) || list[0]
      // 顶层字段是「正在用的预设」的副本（保存的那一刻，当前选中的预设就是之后用的）
      const saved = await api.invoke('settings:set', { baseUrl: active.baseUrl, model: active.model, apiKey: active.apiKey, temperature: active.temperature, presets: list, activePreset: active.id, prefs })
      onSaved(saved)
      onClose()
      notify(`设置已保存，当前使用「${active.name}」`)
    } catch (e) { notify(e.message, true) }
    setSaving(false)
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal set-modal" onClick={(e) => e.stopPropagation()}>
        <aside className="set-nav">
          <h3>设置</h3>
          <nav role="tablist" aria-orientation="vertical">
            <button role="tab" aria-selected={tab === 'ai'} className={tab === 'ai' ? 'on' : ''} onClick={() => setTab('ai')}>AI 接口</button>
            <button role="tab" aria-selected={tab === 'prefs'} className={tab === 'prefs' ? 'on' : ''} onClick={() => setTab('prefs')}>使用习惯</button>
          </nav>
        </aside>

        <div className="set-main">
        <div className="set-sub">{tab === 'ai' ? '支持任何兼容 OpenAI 格式的服务：本地 Ollama、LM Studio，或在线 API。可以建多个预设，切换不同的供应商' : '这些开关只影响操作习惯，随时可以改'}</div>

        {tab === 'prefs' && (
          <div className="modal-body">
            {PREF_ITEMS.map((it) => (
              <div className="pref-row" key={it.key}>
                <div className="pref-text">
                  <div className="pref-title">{it.title}</div>
                  <div className="pref-hint">{it.hint}</div>
                </div>
                <Switch on={!!prefs[it.key]} label={it.title} onChange={(v) => setPrefs((p) => ({ ...p, [it.key]: v }))} />
              </div>
            ))}
          </div>
        )}

        {tab === 'ai' && (
        <div className="modal-body">
          <div className="field">
            <label>预设（保存后，当前选中的这个就是正在使用的）</label>
            <div className="field-row preset-row">
              <Dropdown className="preset-select" value={cur.id} onChange={choose}
                options={presets.map((p) => ({ value: p.id, label: p.name || '未命名预设' }))} />
              <button className="btn" onClick={addPreset} title="新建一个空白预设">＋ 新建</button>
              <button className="btn" onClick={copyPreset} title="复制当前预设（连 Key 一起）">复制</button>
              <button className="btn danger-ghost" onClick={removePreset} disabled={presets.length <= 1} title={presets.length <= 1 ? '至少保留一个预设' : '删除当前预设'}>删除</button>
            </div>
          </div>

          <div className="field">
            <label>预设名称</label>
            <input className="text-input" value={cur.name} onChange={(e) => patch({ name: e.target.value })} maxLength={30} spellCheck={false}
              placeholder="例如：本地 Ollama / 某某在线服务" />
          </div>

          <div className="field">
            <label>接口地址（Base URL）</label>
            <input className="text-input mono" value={cur.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} spellCheck={false}
              placeholder="http://127.0.0.1:11434/v1" />
            <div className="field-hint">
              程序会在后面自动加上 /chat/completions。
              <button className="link-btn" type="button" onClick={fillGemini} title={GEMINI.baseUrl}>填入 Google AI Studio（Gemini）</button>
              ，Key 到 aistudio.google.com 的「Get API key」里创建
            </div>
          </div>

          <div className="field">
            <label>模型名（可以存多个，选中的是正在用的）</label>
            <ModelBasket models={modelsOf(cur)} model={(cur.model || '').trim()} onChange={(models, model) => patch({ models, model })} />
          </div>

          <div className="field">
            <label>API Key（本地模型可留空）</label>
            <div className="field-row">
              <input className="text-input mono" type={showKey ? 'text' : 'password'} value={cur.apiKey}
                onChange={(e) => patch({ apiKey: e.target.value })} spellCheck={false} placeholder="sk-… / AIza…" autoComplete="off" />
              <button className="icon-btn boxed" onClick={() => setShowKey((v) => !v)} title={showKey ? '隐藏' : '显示'}>
                {showKey ? <IconEyeOff /> : <IconEye />}
              </button>
            </div>
            <div className="field-hint">Key 只保存在本机程序旁边的 settings.json 里，请不要把这个文件夹发给别人</div>
          </div>

          <div className="field">
            <label>温度（0 到 2，越低越严谨，越高越发散）</label>
            <input className="text-input narrow" value={cur.temperature}
              onChange={(e) => patch({ temperature: e.target.value.replace(/[^\d.]/g, '') })} />
          </div>

          {testResult && (
            <div className={`test-result ${testResult.ok ? 'ok' : 'bad'}`}>
              <span className="test-dot" />{testResult.text}
            </div>
          )}
        </div>
        )}

        <div className="modal-foot">
          {tab === 'ai' ? <button className="btn ghost" onClick={test} disabled={testing}>{testing ? '测试中…' : '测试连接'}</button> : <span />}
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存设置'}</button>
        </div>
        </div>
      </div>
    </div>
  )
}
