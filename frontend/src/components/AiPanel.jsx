import React, { useEffect, useRef } from 'react'
import { IconStar4, IconStop } from './Icons.jsx'

// 「AI优化」标签页：只是跟 AI 沟通的界面（底部填额外要求、点开始 / 停止，生成过程在这里实时显示）。
// AI 一次只处理「分镜稿」里当前选中的那个批次；优化完的结果存进这个批次，在分镜稿页顶上切到「AI优化稿」查看。
// 你手写的分镜稿永远不会被改动。
export default function AiPanel({ ai, batch, runningFor, refs, setExtra, onStart, onStop, presets = [], activePreset = '', onPreset }) {
  const bodyRef = useRef(null)
  const { phase, text, error, extra } = ai
  const running = phase === 'running'
  const hasResult = !!text

  // 生成中让结果始终滚到最新一行
  useEffect(() => {
    if (running && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [text, running])

  return (
    <div className={`ai-view phase-${phase}`}>
      <div className="ai-body" ref={bodyRef}>
        <div className="ai-target">
          {runningFor
            ? <>正在优化批次「{runningFor}」，切换批次不影响它。</>
            : batch
              ? <>当前批次：<b>{batch.num}{batch.title ? ` · ${batch.title}` : ''}</b>{batch.hasOpt && phase !== 'running' ? '（已有优化稿，重新优化会覆盖它）' : ''}</>
              : '还没有批次：先到「分镜稿」新建一个批次。'}
        </div>
        {hasResult && <pre className="ai-text">{text}{running && <span className="caret" />}</pre>}

        {!hasResult && running && <div className="ai-wait">正在连接模型，等待第一段输出…</div>}

        {!hasResult && !running && phase !== 'error' && (
          <>
            <div className="ai-idle-text">
              AI 以「<mark>W.分镜脚本大师</mark>」的方式工作，只处理当前选中的这个批次：把你手写的分镜、这个批次引用的参考图、固定的剧本片段（没固定就不发剧本）和上一批次的优化稿一起交给它，写成可直接用于视频生成的完整分镜提示词。
              你手写的分镜稿不会被改动；结果存在这个批次里，在「分镜稿」页顶上把开关切到「AI稿」查看和复制。
            </div>
            <div className="sticker-pile" aria-hidden="true">
              <span className="sticker"><i className="ico">✓</i>镜头</span>
              <span className="sticker"><i className="ico">✓</i>声音</span>
              <span className="sticker"><i className="ico">✓</i>连续性</span>
            </div>
          </>
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

      <footer className="ai-foot">
        {presets.length > 1 && (
          <select className="text-input preset-select" value={activePreset} onChange={(e) => onPreset?.(e.target.value)} disabled={running} title="切换 AI 接口预设（在右上角设置里管理）">
            {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <input
          className="text-input"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !running) onStart() }}
          disabled={running}
          placeholder="额外要求（可选），例如：总时长压到 12 秒、第二镜改成手持跟拍"
        />
        {running
          ? <button className="btn danger-ghost" onClick={onStop}><IconStop />停止生成</button>
          : <button className="btn primary" onClick={onStart} disabled={!batch}><IconStar4 />{hasResult || batch?.hasOpt ? '重新优化' : '开始优化'}</button>}
      </footer>
    </div>
  )
}
