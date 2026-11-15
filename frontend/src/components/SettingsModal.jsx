import React, { useState } from 'react'
import { api, DEFAULT_SETTINGS } from '../api.js'
import { IconEye, IconEyeOff } from './Icons.jsx'

const newPresetId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

// 把设置整理成预设列表：旧版只有一套接口设置，当成一个叫「默认」的预设
function initialPresets(settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) }
  if (Array.isArray(s.presets) && s.presets.length) return s.presets.map((p) => ({ ...DEFAULT_SETTINGS, ...p, temperature: String(p.temperature ?? DEFAULT_SETTINGS.temperature) }))
  return [{ id: 'default', name: '默认', baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey, temperature: String(s.temperature) }]
}

export default function SettingsModal({ settings, onClose, onSaved, notify }) {
  const [presets, setPresets] = useState(() => initialPresets(settings))
  const [selId, setSelId] = useState(() => (settings && settings.activePreset && initialPresets(settings).some((p) => p.id === settings.activePreset) ? settings.activePreset : initialPresets(settings)[0].id))
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState(null) // {ok, text}

  const cur = presets.find((p) => p.id === selId) || presets[0]
  const patch = (fields) => setPresets((list) => list.map((p) => (p.id === cur.id ? { ...p, ...fields } : p)))

  const clean = (p) => ({
    id: p.id,
    name: (p.name || '').trim() || '未命名预设',
    baseUrl: (p.baseUrl || '').trim().replace(/\/+$/, ''),
    model: (p.model || '').trim(),
    apiKey: (p.apiKey || '').trim(),
    temperature: Math.min(2, Math.max(0, Number(p.temperature) || 0)),
  })

  const addPreset = () => {
    const p = { id: newPresetId(), name: `预设 ${presets.length + 1}`, baseUrl: '', model: '', apiKey: '', temperature: String(DEFAULT_SETTINGS.temperature) }
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
      const saved = await api.invoke('settings:set', { baseUrl: active.baseUrl, model: active.model, apiKey: active.apiKey, temperature: active.temperature, presets: list, activePreset: active.id })
      onSaved(saved)
      onClose()
      notify(`AI 设置已保存，当前使用「${active.name}」`)
    } catch (e) { notify(e.message, true) }
    setSaving(false)
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>AI 接口设置</h3>
          <div className="modal-sub">支持任何兼容 OpenAI 格式的服务：本地 Ollama、LM Studio，或在线 API。可以建多个预设，切换不同的供应商</div>
        </div>

        <div className="modal-body">
          <div className="field">
            <label>预设（保存后，当前选中的这个就是正在使用的）</label>
            <div className="field-row preset-row">
              <select className="text-input preset-select" value={cur.id} onChange={(e) => choose(e.target.value)}>
                {presets.map((p) => <option key={p.id} value={p.id}>{p.name || '未命名预设'}</option>)}
              </select>
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
            <div className="field-hint">程序会在后面自动加上 /chat/completions</div>
          </div>

          <div className="field">
            <label>模型名</label>
            <input className="text-input mono" value={cur.model} onChange={(e) => patch({ model: e.target.value })} spellCheck={false}
              placeholder="例如：qwen2.5:14b" />
          </div>

          <div className="field">
            <label>API Key（本地模型可留空）</label>
            <div className="field-row">
              <input className="text-input mono" type={showKey ? 'text' : 'password'} value={cur.apiKey}
                onChange={(e) => patch({ apiKey: e.target.value })} spellCheck={false} placeholder="sk-…" autoComplete="off" />
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

        <div className="modal-foot">
          <button className="btn ghost" onClick={test} disabled={testing}>{testing ? '测试中…' : '测试连接'}</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存设置'}</button>
        </div>
      </div>
    </div>
  )
}
