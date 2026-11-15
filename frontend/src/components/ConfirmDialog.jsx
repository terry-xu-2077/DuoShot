import React, { useEffect, useRef } from 'react'

// 通用确认弹窗：Esc 或点遮罩取消，默认焦点在「取消」上，避免手快误删
export default function ConfirmDialog({ title, children, confirmText = '确认', extraText, onExtra, onConfirm, onCancel }) {
  const cancelRef = useRef(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal confirm" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <div className="modal-sub confirm-text">{children}</div>
        </div>
        <div className="modal-foot">
          {extraText && <button className="btn ghost confirm-extra" onClick={onExtra}>{extraText}</button>}
          <button className="btn ghost" ref={cancelRef} onClick={onCancel}>取消</button>
          <button className="btn danger-ghost" onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  )
}
