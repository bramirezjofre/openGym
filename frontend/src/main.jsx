import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { MOBILE } from './lib/mobile.js'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode><App /></StrictMode>
)

// Service worker registration — PWA-grade.
//   - Skipped on the Capacitor (mobile) build: the native shell already serves
//     everything from disk and registers its own push handler.
//   - Skipped in dev mode (Vite serves modules unbundled, a precached SW would
//     hand back stale code on every reload).
//   - Otherwise registers on both https and http://localhost. Production over
//     HTTP / non-localhost is left to a reverse proxy that terminates TLS —
//     the browser will refuse to register a SW over plain HTTP from a remote
//     origin anyway.
//   - On a new SW taking over, posts a "new version" toast the user can act on.
//     The SW itself already skipWaiting()s + claims clients; the toast is the
//     user UX, not a flow control signal.
if (!MOBILE && import.meta.env.PROD && 'serviceWorker' in navigator
    && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // If a new SW has installed while this tab is open, ask it to take over.
    // The SW's own activate handler also tries to claim; this is the page-side
    // half of the dance so the new version is live immediately.
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' })
    reg.addEventListener('updatefound', () => {
      const next = reg.installing
      if (!next) return
      next.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) {
          // New SW installed and waiting — surface it. The toast reads "SW_UPDATED"
          // from the SW's own postMessage below; this listener covers the case
          // where the SW updated without sending the message yet.
          showUpdateToast(() => reg.waiting && reg.waiting.postMessage({ type: 'SKIP_WAITING' }))
        }
      })
    })
  }).catch(() => { /* SW disabled by user / third-party blocker / private mode — silent */ })

  // The SW posts this when it activates. Showing a toast that the user can
  // dismiss is friendlier than a hard reload and survives the rare case where
  // the page is open in the background and would otherwise reload on focus.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'SW_UPDATED') {
      showUpdateToast(() => navigator.serviceWorker.getRegistration().then((r) => r && r.waiting && r.waiting.postMessage({ type: 'SKIP_WAITING' })))
    }
  })
}

// One-shot toast wired up by the store + UI module. Kept inline here so the
// SW registration code is self-contained and works even before the rest of
// the app has booted (e.g. on the very first paint, before StrictMode mounts).
function showUpdateToast(reload) {
  const existing = document.getElementById('sw-update-toast')
  if (existing) return
  const t = document.createElement('div')
  t.id = 'sw-update-toast'
  t.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;background:var(--acc,#30d158);color:#000;padding:10px 14px;border-radius:10px;font:600 14px/1.2 system-ui;box-shadow:0 4px 14px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center;'
  const label = document.createElement('span')
  label.textContent = 'New version available'
  const btn = document.createElement('button')
  btn.textContent = 'Reload'
  btn.style.cssText = 'background:#000;color:#fff;border:0;padding:6px 10px;border-radius:7px;font:600 13px/1 system-ui;cursor:pointer'
  btn.onclick = () => { reload(); location.reload() }
  const close = document.createElement('button')
  close.textContent = '×'
  close.style.cssText = 'background:transparent;color:#000;border:0;font:600 18px/1 system-ui;cursor:pointer;padding:0 4px'
  close.onclick = () => t.remove()
  t.append(label, btn, close)
  document.body.appendChild(t)
  // Auto-dismiss after 30s — the SW has already claimed clients, so the next
  // navigation will pick up the new version whether the user clicks or not.
  setTimeout(() => t.remove(), 30000)
}