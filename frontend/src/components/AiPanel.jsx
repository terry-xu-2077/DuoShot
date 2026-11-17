import React, { useEffect, useRef, useState } from 'react'
import { IconChevron, IconStar4, IconStop } from './Icons.jsx'
import Dropdown from './Dropdown.jsx'

// 「AI优化」标签页：只是跟 AI 沟通的界面（底部填额外要求、点开始 / 停止，生成过程在这里实时显示）。
// AI 一次只处理「分镜稿」里当前选中的那个批次；优化完的结果存进这个批次，在分镜稿页顶上切到「AI优化稿」查看。
// 你手写的分镜稿永远不会被改动。
export default function AiPanel({ ai, batch, runningFor, refs, setExtra, onStart, onStop, presets = [], activePreset = '', onPreset }) {
  const bodyRef = useRef(null)
  const thinkRef = useRef(null)
  const { phase, text, error, extra } = ai
  const think = ai.think || ''
  const running = phase === 'running'
  const hasResult = !!text
  // 思考过程：模型在想的时候自动展开，正文一开始出来就自动收起；你点过标题以后就按你点的来（下次优化重新自动）
  const [thinkOpen, setThinkOpen] = useState(null)
  const thinkShown = thinkOpen ?? (running && !hasResult)
  useEffect(() => { if (running && !text && !think) setThinkOpen(null) }, [running, text, think])
  // 生成中自动跟到最新一行，但只有滚动条本来就在底部时才跟；你往上滚去看前面的内容，就不再抢你的滚动位置，滚回底部又会继续跟
  const bodyStick = useRef(true)
  const thinkStick = useRef(true)
  const lastAuto = useRef(new WeakMap())   // 程序自己滚到的位置：它触发的 scroll 事件不算「用户滚动」（事件到来时内容可能又长高了，会被误判成离开了底部）
  const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 24
  const follow = (el, stick) => {
    if (!el || !stick.current) return
    el.scrollTop = el.scrollHeight
    lastAuto.current.set(el, el.scrollTop)
  }
  const onUserScroll = (stick) => (e) => {
    const el = e.currentTarget
    if (Math.abs(el.scrollTop - (lastAuto.current.get(el) ?? -1)) < 2) return
    stick.current = atBottom(el)
  }
  useEffect(() => { if (running && !text && !think) { bodyStick.current = true; thinkStick.current = true } }, [running, text, think])
  useEffect(() => { thinkStick.current = true }, [thinkShown])
  useEffect(() => { if (running) follow(thinkRef.current, thinkStick) }, [think, running, thinkShown])
  useEffect(() => { if (running) follow(bodyRef.current, bodyStick) }, [text, think, thinkShown, running])

  return (
    <div className={`ai-view phase-${phase}`}>
      <div className="ai-body" ref={bodyRef} onScroll={onUserScroll(bodyStick)}>
        <div className="ai-target">
          {runningFor
            ? <>正在优化批次「{runningFor}」，切换批次不影响它。</>
            : batch
              ? <>当前批次：<b>{batch.num}{batch.title ? ` · ${batch.title}` : ''}</b>{batch.hasOpt && phase !== 'running' ? '（已有优化稿，重新优化会覆盖它）' : ''}</>
              : '还没有批次：先到「分镜稿」新建一个批次。'}
        </div>
        {think && (
          <div className={`ai-think${thinkShown ? ' open' : ''}${running && !hasResult ? ' live' : ''}`}>
            <button className="ai-think-head" onClick={() => setThinkOpen(!thinkShown)} aria-expanded={thinkShown}>
              <span className="ai-think-title">思考过程</span>
              <span className="ai-think-meta">{think.trim().length.toLocaleString()} 字{running && !hasResult ? ' · 思考中…' : ''}</span>
              <span className="ai-think-chev"><IconChevron size={16} /></span>
            </button>
            {thinkShown && <div className="ai-think-body" ref={thinkRef} onScroll={onUserScroll(thinkStick)}>{think.trim()}</div>}
          </div>
        )}
        {hasResult && <pre className="ai-text">{text}{running && <span className="caret" />}</pre>}

        {!hasResult && running && !think && <div className="ai-wait">正在连接模型，等待第一段输出…</div>}

        {!hasResult && !think && !running && phase !== 'error' && (
          <div className="ai-idle-box">
            <div className="ai-idle-text">
              AI 只处理当前选中的这个批次：把你手写的分镜、这个批次引用的参考图、固定的剧本片段（没固定就不发剧本）和上一批次的优化稿一起交给它，写成可直接用于视频生成的完整分镜提示词。
              你手写的分镜稿不会被改动；结果存在这个批次里，在「分镜稿」页顶上把开关切到「AI稿」查看和复制。
            </div>
            <div className="sticker-pile" aria-hidden="true">
              <span className="sticker"><i className="ico">✓</i>镜头</span>
              <span className="sticker"><i className="ico">✓</i>声音</span>
              <span className="sticker"><i className="ico">✓</i>连续性</span>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="ai-error">
            <strong>优化没有完成</strong>
            <span>{error}</span>
            <em>你的分镜稿没有被改动。</em>
          </div>
        )}
        {phase === 'stopped' && <div className="ai-note">已停止。上面是已生成的部分（不会存进批次），可以重新优化。</div>}
        {phase === 'done' && <div className="ai-note">已完成，结果已存进这个批次：在「分镜稿」页顶上切到「AI优化稿」查看。</div>}
      </div>

      <div className="ai-composer">
      {/* 这次会随请求附带的资产图：分镜稿里用 @ 引用到的 */}
      <div className="ai-refs">
        {refs && refs.used.length > 0 ? (
          <>
            <span className="ai-refs-label">将附带 {refs.used.length} 张资产图</span>
            {refs.used.map((r) => (
              <span className="ai-ref" key={r.id} title={`@${r.name}`}>
                {r.url ? <img src={r.url} alt="" draggable={false} /> : <i className="mi-ph" />}{r.name}
              </span>
            ))}
          </>
        ) : (
          <span className="ai-refs-label dim">
            {refs && refs.total > 0 ? '当前批次里还没有用 @ 引用资产图；引用的图会随请求一起发给 AI。' : '资源库是空的；在「资源库」页加图，再在批次里用 @ 引用，图会随请求一起发给 AI。'}
          </span>
        )}
        {refs && refs.missing.length > 0 && (
          <span className="ai-refs-warn">找不到：{refs.missing.map((m) => `@${m}`).join('、')}</span>
        )}
      </div>

      <textarea
        className="ai-input"
        rows={2}
        value={extra}
        onChange={(e) => setExtra(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !running) { e.preventDefault(); onStart() } }}
        disabled={running}
        placeholder="额外要求（可选），例如：总时长压到 12 秒、第二镜改成手持跟拍"
      />
      <div className="ai-bar">
        {presets.length > 1 && (
          <Dropdown className="preset-select" value={activePreset} onChange={onPreset} disabled={running} title="切换 AI 接口预设（在右上角设置里管理）"
            options={presets.map((p) => ({ value: p.id, label: p.name }))} minWidth={180} />
        )}
        <span className="ai-bar-gap" />
        {running
          ? <button className="btn glow" onClick={onStop} title="点击停止生成"><span className="glow-ring" aria-hidden="true"><i /><i /></span><span className="glow-ring soft" aria-hidden="true"><i /><i /></span><IconStop />停止生成</button>
          : <button className="btn primary" onClick={onStart} disabled={!batch}><IconStar4 />{hasResult || batch?.hasOpt ? '重新优化' : '开始优化'}</button>}
      </div>
      </div>
    </div>
  )
}
