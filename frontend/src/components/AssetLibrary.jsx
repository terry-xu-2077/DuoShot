import React, { useEffect, useRef, useState } from 'react'
import { IconClose, IconPlusBig } from './Icons.jsx'

// 「资源库」标签页：这份分镜稿专属的图片资产。
// 图片只是「引用」原文件（不复制），这里显示的是生成好的缩略图。
// 每张图有一个名字，在分镜稿里输入 @ 就能选中并插入「@名称」；也可以在这里勾选几张，一次性加到当前批次。
// 被引用到的图会随 AI 优化请求一起发出去（只发批次里引用到的，不是整个资源库）。
function Tile({ asset, url, selected, onToggle, onRename, onRemove }) {
  const [name, setName] = useState(asset.name)
  const [editing, setEditing] = useState(false)
  const commit = () => {
    setEditing(false)
    const next = name.trim()
    if (next && next !== asset.name) onRename(asset.id, next)
    else setName(asset.name)
  }
  return (
    <div className={`asset-tile${selected ? ' selected' : ''}`}>
      <div className="asset-img" onClick={() => onToggle(asset.id)} role="checkbox" aria-checked={selected} aria-label={`选择 ${asset.name}`} title={selected ? '点击取消选择' : '点击选择'}>
        {url ? <img src={url} alt={asset.name} draggable={false} /> : <span className="asset-loading" />}
        <span className="asset-check" aria-hidden="true">{selected ? '✓' : ''}</span>
        <button className="asset-del" onClick={(e) => { e.stopPropagation(); onRemove(asset) }} title="从资源库删除" aria-label="从资源库删除">
          <IconClose size={12} />
        </button>
      </div>
      <label className="asset-name" title="资产名：分镜稿里输入 @ 就能选它">
        <input
          value={editing ? name : asset.name}
          onFocus={() => { setName(asset.name); setEditing(true) }}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') { setName(asset.name); setEditing(false); e.currentTarget.blur() }
          }}
          maxLength={20}
          spellCheck={false}
        />
      </label>
    </div>
  )
}

export default function AssetLibrary({ assets, thumbs, docId, adding, onFiles, onPickNative, onInsert, batchLabel, onRename, onRemove }) {
  const fileRef = useRef(null)
  const [picked, setPicked] = useState(() => new Set())   // 勾选的资产 id

  // 资产被删掉后，把已经不存在的勾选去掉
  useEffect(() => {
    setPicked((prev) => {
      const alive = new Set(assets.map((a) => a.id))
      const next = new Set([...prev].filter((id) => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [assets])

  const pick = () => { if (onPickNative) onPickNative(); else fileRef.current?.click() }
  const onPicked = (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length) onFiles(files)
  }
  const toggle = (id) => setPicked((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const chosen = assets.filter((a) => picked.has(a.id))     // 按资源库里的顺序
  const insert = () => { onInsert(chosen); setPicked(new Set()) }

  return (
    <div className="asset-lib">
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onPicked} />
      <div className="asset-head">
        <div className="asset-title">这份分镜稿的资源库</div>
        <div className="asset-sub">
          放角色、场景、道具的参考图（只引用原文件，不会复制）。点图片勾选，可以一次性加到当前批次；也可以在「分镜稿」里输入 <b>@</b> 选一张。
          只有批次里引用到的图会随「AI优化」发给 AI。
        </div>
      </div>
      {chosen.length > 0 && (
        <div className="asset-bar">
          <span>已选 <b>{chosen.length}</b> 张</span>
          <button className="btn primary sm" onClick={insert}>添加到{batchLabel ? `「${batchLabel}」` : '分镜稿'}</button>
          <button className="btn sm" onClick={() => setPicked(new Set())}>取消选择</button>
        </div>
      )}
      <div className="asset-grid">
        {assets.map((a) => (
          <Tile key={a.id} asset={a} url={thumbs[`${docId}/${a.id}`]} selected={picked.has(a.id)} onToggle={toggle} onRename={onRename} onRemove={onRemove} />
        ))}
        <button className="asset-add" onClick={pick} disabled={adding}>
          <IconPlusBig size={34} />
          <span>{adding ? '正在处理图片…' : '添加图片'}</span>
          <small>点击选择，或把图片拖进来，也可以直接粘贴（Ctrl+V）</small>
        </button>
      </div>
    </div>
  )
}
