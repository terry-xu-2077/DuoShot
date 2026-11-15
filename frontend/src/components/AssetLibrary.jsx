import React, { useRef, useState } from 'react'
import { IconClose, IconPlusBig } from './Icons.jsx'

// 「资源库」标签页：这份分镜稿专属的图片资产。
// 每张图有一个名字，在分镜稿里输入 @ 就能选中并插入「@名称」；被引用到的图会随 AI 优化请求一起发出去。
function Tile({ asset, url, onRename, onRemove }) {
  const [name, setName] = useState(asset.name)
  const [editing, setEditing] = useState(false)
  const commit = () => {
    setEditing(false)
    const next = name.trim()
    if (next && next !== asset.name) onRename(asset.id, next)
    else setName(asset.name)
  }
  return (
    <div className="asset-tile">
      <div className="asset-img">
        {url ? <img src={url} alt={asset.name} draggable={false} /> : <span className="asset-loading" />}
        <button className="asset-del" onClick={() => onRemove(asset)} title="从资源库删除" aria-label="从资源库删除">
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

export default function AssetLibrary({ assets, thumbs, docId, adding, onFiles, onRename, onRemove }) {
  const fileRef = useRef(null)
  const pick = () => fileRef.current?.click()
  const onPicked = (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length) onFiles(files)
  }
  return (
    <div className="asset-lib">
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onPicked} />
      <div className="asset-head">
        <div className="asset-title">这份分镜稿的资源库</div>
        <div className="asset-sub">
          放角色、场景、道具的参考图。在「分镜稿」里输入 <b>@</b> 选一张，被引用的图会随「AI优化」一起发给 AI。
        </div>
      </div>
      <div className="asset-grid">
        {assets.map((a) => (
          <Tile key={a.id} asset={a} url={thumbs[`${docId}/${a.id}`]} onRename={onRename} onRemove={onRemove} />
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
