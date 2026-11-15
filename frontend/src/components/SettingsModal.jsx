import React, { useState } from 'react'
import { api, DEFAULT_SETTINGS } from '../api.js'
import { IconEye, IconEyeOff } from './Icons.jsx'

export default function SettingsModal({ settings, onClose, onSaved, notify }) {
  const init = { ...DEFAULT_SETTINGS, ...(settings || {}) }
  const [baseUrl, setBaseUrl] = useState(init.baseUrl)
  const [model, setModel] = useState(init.model)
  const [apiKey, setApiKey] = useState(init.apiKey)
  const [temperature, setTemperature] = useState(String(init.temperature))
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState(null) // {ok, text}

  const collect = () => ({
    baseUrl: baseUrl.trim().replace(/\/+$/, ''),
    model: model.trim(),
    apiKey: apiKey.trim(),
    temperature: Math.min(2, Math.max(0, Number(temperature) || 0)),
  })

  const test = async () => {
    const s = collect()
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
      const saved = await api.invoke('settings:set', collect())
      onSaved(saved)
      onClose()
      notify('AI 设置已保存')
    } catch (e) { notify(e.message, true) }
    setSaving(false)
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>AI 接口设置</h3>
          <div className="modal-sub">支持任何兼容 OpenAI 格式的服务：本地 Ollama、LM Studio，或在线 API</div>
        </div>

        <div className="modal-body">
          <div className="field">
            <label>接口地址（Base URL）</label>
            <input className="text-input mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false}
              placeholder="http://127.0.0.1:11434/v1" />
            <div className="field-hint">程序会在后面自动加上 /chat/completions</div>
          </div>

          <div className="field">
            <label>模型名</label>
            <input className="text-input mono" value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false}
              placeholder="例如：qwen2.5:14b" />
          </div>

          <div className="field">
            <label>API Key（本地模型可留空）</label>
            <div className="field-row">
              <input className="text-input mono" type={showKey ? 'text' : 'password'} value={apiKey}
                onChange={(e) => setApiKey(e.target.value)} spellCheck={false} placeholder="sk-…" autoComplete="off" />
              <button className="icon-btn boxed" onClick={() => setShowKey((v) => !v)} title={showKey ? '隐藏' : '显示'}>
                {showKey ? <IconEyeOff /> : <IconEye />}
              </button>
            </div>
            <div className="field-hint">Key 只保存在本机程序旁边的 settings.json 里，请不要把这个文件夹发给别人</div>
          </div>

          <div className="field">
            <label>温度（0 到 2，越低越严谨，修改措辞建议 0.2 到 0.4）</label>
            <input className="text-input narrow" value={temperature}
              onChange={(e) => setTemperature(e.target.value.replace(/[^\d.]/g, ''))} />
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
