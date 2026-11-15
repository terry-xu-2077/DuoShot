import React, { useEffect, useRef } from 'react'
import { IconStar4, IconStop } from './Icons.jsx'

// 「AI优化」标签页：既是提交页（底部填额外要求、点开始），也是结果展示页。
// 你手写的分镜稿永远留在「分镜稿」标签里，这里只显示 AI 给出的优化版本，不会替换任何东西。
export default function AiPanel({ ai, refs, setExtra, onStart, onStop }) {
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
        {hasResult && <pre className="ai-text">{text}{running && <span className="caret" />}</pre>}

        {!hasResult && running && <div className="ai-wait">正在连接模型，等待第一段输出…</div>}

        {!hasResult && !running && phase !== 'error' && (
          <>
            <div className="ai-idle-text">
              AI 会对照左侧剧本，修正「分镜稿」里的错字、措辞和格式，<mark>不会增删镜头</mark>。
              你手写的分镜稿不会被改动，优化结果只显示在这里；有结果后，右上角会出现复制图标。
            </div>
            <div className="sticker-pile" aria-hidden="true">
              <span className="sticker"><i className="ico">✕</i>错字</span>
              <span className="sticker"><i className="ico">✕</i>措辞</span>
              <span className="sticker"><i className="ico">✕</i>格式</span>
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
        {phase === 'stopped' && <div className="ai-note">已停止。上面是已生成的部分，可以重新优化。</div>}
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
            {refs && refs.total > 0 ? '分镜稿里还没有用 @ 引用资产图；引用的图会随请求一起发给 AI。' : '资源库是空的；在「资源库」页加图，再在分镜稿里用 @ 引用，图会随请求一起发给 AI。'}
          </span>
        )}
        {refs && refs.missing.length > 0 && (
          <span className="ai-refs-warn">找不到：{refs.missing.map((m) => `@${m}`).join('、')}</span>
        )}
      </div>

      <footer className="ai-foot">
        <input
          className="text-input"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !running) onStart() }}
          disabled={running}
          placeholder="额外要求（可选），例如：统一成「镜头号｜景别｜画面描述」的格式"
        />
        {running
          ? <button className="btn danger-ghost" onClick={onStop}><IconStop />停止生成</button>
          : <button className="btn primary" onClick={onStart}><IconStar4 />{hasResult ? '重新优化' : '开始优化'}</button>}
      </footer>
    </div>
  )
}
