import React from 'react'

const base = (size) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
})

export const IconGear = ({ size = 17 }) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="3.2" /><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h0a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v0a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></svg>
)
export const IconSpark = ({ size = 16 }) => (
  <svg {...base(size)}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></svg>
)
export const IconDownload = ({ size = 16 }) => (
  <svg {...base(size)}><path d="M12 4v11" /><path d="M7.5 11l4.5 4.5 4.5-4.5" /><path d="M5 19.5h14" /></svg>
)
export const IconTrash = ({ size = 16 }) => (
  <svg {...base(size)}><path d="M4 7h16" /><path d="M9.5 7V4.5h5V7" /><path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12" /></svg>
)
export const IconRestore = ({ size = 16 }) => (
  <svg {...base(size)}><path d="M4 12a8 8 0 1 0 2.6-5.9" /><path d="M4 4.5V8.5h4" /><path d="M12 8v4.2l2.6 1.6" /></svg>
)
export const IconEye = ({ size = 16 }) => (
  <svg {...base(size)}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></svg>
)
export const IconEyeOff = ({ size = 16 }) => (
  <svg {...base(size)}><path d="M4 4l16 16" /><path d="M9.9 5.8A9.4 9.4 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.8M6.2 7.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5c1.4 0 2.7-.3 3.8-.8" /><path d="M9.9 9.9a2.8 2.8 0 0 0 4 4" /></svg>
)
export const IconClose = ({ size = 14 }) => (
  <svg {...base(size)}><path d="M6 6l12 12M18 6L6 18" /></svg>
)
export const IconCheck = ({ size = 15 }) => (
  <svg {...base(size)}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
)
export const IconStop = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
)
export const IconCopy = ({ size = 13 }) => (
  <svg {...base(size)}><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" /><path d="M15.5 8.5V6.5A2 2 0 0 0 13.5 4.5H6.5A2 2 0 0 0 4.5 6.5V13.5A2 2 0 0 0 6.5 15.5H8.5" /></svg>
)
export const IconStar4 = ({ size = 14, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1.5C12.9 8.2 15.8 11.1 22.5 12C15.8 12.9 12.9 15.8 12 22.5C11.1 15.8 8.2 12.9 1.5 12C8.2 11.1 11.1 8.2 12 1.5Z" /></svg>
)
export const IconClock = ({ size = 15 }) => (
  <svg {...base(size)}><circle cx="12" cy="13" r="7.5" /><path d="M12 9v4.2l2.6 1.6" /><path d="M9.5 3.5h5" /></svg>
)
export const IconChevron = ({ size = 22 }) => (
  <svg {...base(size)} strokeWidth="2.4"><path d="M5 9l7 7 7-7" /></svg>
)
export const IconPencil = ({ size = 14 }) => (
  <svg {...base(size)}><path d="M4 20l1-4.5L16.5 4a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8L8.5 19z" /><path d="M14.5 6l3.5 3.5" /></svg>
)
export const IconHome = ({ size = 22 }) => (
  <svg {...base(size)}><path d="M3.5 11L12 4l8.5 7" /><path d="M5.5 9.5V19a1 1 0 0 0 1 1H10v-5.5h4V20h3.5a1 1 0 0 0 1-1V9.5" /></svg>
)
export const IconSearch = ({ size = 15 }) => (
  <svg {...base(size)}><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L20 20" /></svg>
)
export const IconPlusCircle = ({ size = 20 }) => (
  <svg {...base(size)} strokeWidth="1.6"><circle cx="12" cy="12" r="9.2" /><path d="M12 7.8v8.4M7.8 12h8.4" /></svg>
)
export const IconOpen = ({ size = 16 }) => (
  <svg {...base(size)}><path d="M3.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3.6l2 2.3H18A1.5 1.5 0 0 1 19.5 8.3V10" /><path d="M3.2 19.5l1.9-8.2A1.5 1.5 0 0 1 6.6 10.2h13.9a1 1 0 0 1 1 1.2l-1.6 7.2a1.5 1.5 0 0 1-1.5 1.2H4.2a1 1 0 0 1-1-.3z" /></svg>
)
export const IconPlusBig = ({ size = 56 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true"><path d="M12 3.5v17M3.5 12h17" /></svg>
)
export const IconLink = ({ size = 15 }) => (
  <svg {...base(size)}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /></svg>
)
export const IconPin = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.5 2.5l7 7-2 1.2-2.7 2.7.7 4.1-1.9 1.9-3.6-3.6-5.6 5.6-1.4-1.4 5.6-5.6-3.6-3.6L8.9 9.9l4.1.7 2.7-2.7z" /></svg>
)
