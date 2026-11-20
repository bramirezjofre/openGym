import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { webauthnOK, passkeyLogin, passkeyRegister, passwordLogin, api, BIO } from '../lib/api.js'
import { validatePassword } from '../lib/password.js'
import { hasData } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { DEMO, REPO } from '../lib/demo.js'
import { useState, useRef, useEffect } from 'react'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

function RegisterSheet({ close }) {
  const { setUser, pushState, pullState } = useStore()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [inviteOnly, setInviteOnly] = useState(false)
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  useEffect(() => { api('/api/config').then(c => setInviteOnly(!!c.invite_only)).catch(() => {}) }, [])
  const go = async () => {
    const n = name.trim()
    if (!n) { useUI.getState().toast(t('Enter a name')); return }
    if (inviteOnly && !code.trim()) { useUI.getState().toast(t('An invite code is required')); return }
    try {
      const u = await passkeyRegister(n, code.trim())
      setUser(u); close()
      if (hasData(useStore.getState().S)) { await pushState(); useUI.getState().toast(t('Profile created — data from this device moved into it')) }
      else { await pullState(); useUI.getState().toast(t('Welcome, {0}', u.name)) }
    } catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') useUI.getState().toast(e.message || t('Registration failed')) }
  }
  return <>
    <h3>{t('Create your profile')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name, then confirm with {0}. The passkey is saved in your device — no password needed.', BIO)}</div>
    <input ref={ref} className="input" placeholder={t('Your name')} maxLength={40} value={name} onChange={e => setName(e.target.value)} />
    {inviteOnly && <>
      <div style={{ height: 10 }} />
      <input className="input" placeholder={t('Invite code')} maxLength={40} value={code}
        onChange={e => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
      <div className="dim small" style={{ marginTop: 6 }}>{t('This app is invite-only — enter the code you were given.')}</div>
    </>}
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={go}>{t('Create passkey')}</Button>
  </>
}


function PasswordSheet({ close }) {
  const { setUser, pullState } = useStore()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  const go = async () => {
    const n = name.trim()
    if (!n) { useUI.getState().toast(t('Enter a name')); return }
    const invalid = validatePassword(password, confirm)
    if (invalid) { useUI.getState().toast(t(invalid)); return }
    setBusy(true)
    try {
      const res = await api('/api/register/password', { method: 'POST', body: JSON.stringify({ name: n, password }) })
      setUser(res.user); close()
      await pullState()
      useUI.getState().toast(t('Welcome, {0}', res.user.name))
    } catch (e) { useUI.getState().toast(e.message || t('Registration failed')) }
    finally { setBusy(false) }
  }
  return <>
    <h3>{t('Create your profile')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name and a password. You can add a passkey later if you want.')}</div>
    <input ref={ref} className="input" placeholder={t('Your name')} maxLength={40} value={name} onChange={e => setName(e.target.value)} />
    <div style={{ height: 10 }} />
    <input className="input" type="password" placeholder={t('Password')} autoComplete="new-password" maxLength={200} value={password} onChange={e => setPassword(e.target.value)} />
    <div style={{ height: 10 }} />
    <input className="input" type="password" placeholder={t('Repeat password')} autoComplete="new-password" maxLength={200} value={confirm} onChange={e => setConfirm(e.target.value)} />
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={go} disabled={busy}>{busy ? t('Creating…') : t('Create profile')}</Button>
  </>
}



// First account on an empty instance — it becomes the admin. Shown only while the
// instance has no users at all (GET /api/config -> needs_bootstrap), so it cannot be
// used to make a second admin.
function BootstrapSheet({ close }) {
  const { setUser, pullState } = useStore()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  const go = async () => {
    const n = name.trim()
    if (!n) { useUI.getState().toast(t('Enter a name')); return }
    const invalid = validatePassword(password, password)
    if (invalid) { useUI.getState().toast(t(invalid)); return }
    setBusy(true)
    try {
      const res = await api('/api/admin/bootstrap', { method: 'POST', body: JSON.stringify({ name: n, password }) })
      setUser(res.user); close()
      await pullState()
      useUI.getState().toast(t('Welcome, {0}', res.user.name))
    } catch (e) { useUI.getState().toast(e.message || t('Registration failed')) }
    finally { setBusy(false) }
  }
  return <>
    <h3>{t('Create the admin account')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('This is the first account on this instance, so it gets admin rights. Use it to create the other profiles.')}</div>
    <input ref={ref} className="input" placeholder={t('Your name')} maxLength={40} value={name} onChange={e => setName(e.target.value)} />
    <div style={{ height: 10 }} />
    <input className="input" type="password" placeholder={t('Password')} autoComplete="new-password" maxLength={200} value={password} onChange={e => setPassword(e.target.value)} />
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={go} disabled={busy}>{busy ? t('Creating…') : t('Create admin account')}</Button>
  </>
}

// Password sign-in, collapsed behind a link so the passkey button stays the primary
// action on a device that supports it. Same visual language as the rest of the app:
// .input fields, .btn, the standard row/small/dim helpers.
function PasswordSignIn({ onSigned }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    if (!name.trim() || !password) { useUI.getState().toast(t('Enter your name and password')); return }
    setBusy(true)
    try {
      const u = await passwordLogin(name.trim(), password)
      setPassword('')
      onSigned(u)
    } catch (e) { useUI.getState().toast(e.message || t('Sign-in failed')) }
    finally { setBusy(false) }
  }
  if (!open) {
    return <button className="btn ghost dim" onClick={() => setOpen(true)} style={{ width: '100%' }}>
      {t('Sign in with a password')}
    </button>
  }
  return <div style={{ textAlign: 'left' }}>
    <input className="input" placeholder={t('Your name')} autoComplete="username" maxLength={40}
      value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
    <div style={{ height: 10 }} />
    <input className="input" type="password" placeholder={t('Password')} autoComplete="current-password" maxLength={200}
      value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={go} disabled={busy}>{busy ? t('Signing in…') : t('Sign in')}</Button>
    <div style={{ height: 6 }} />
    <Button variant="ghost" className="dim" onClick={() => { setOpen(false); setPassword('') }}>{t('Use a passkey instead')}</Button>
  </div>
}

export default function Login() {
  const { setUser, pullState, setGuest } = useStore()
  const [needsBootstrap, setNeedsBootstrap] = useState(false)
  useEffect(() => { api('/api/config').then(c => setNeedsBootstrap(!!c.needs_bootstrap)).catch(() => {}) }, [])
  const signIn = async () => {
    try { const u = await passkeyLogin(); setUser(u); await pullState(); useUI.getState().toast(t('Welcome back, {0}', u.name)) }
    catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') useUI.getState().toast(e.message || t('Sign-in failed')) }
  }
  const head = <>
    <div style={{ fontSize: 54, display: 'flex', justifyContent: 'center', color: 'var(--acc)' }}><Icon name="dumbbell" /></div>
    <h1 style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-.028em', margin: '10px 0 4px' }}>openGym</h1>
  </>
  const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }

  // Demo build: no backend to sign in against — the only way in is the local guest profile.
  if (DEMO) return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 30 }}>{t('Live demo — everything stays in this browser.')}</div>
      <Button variant="primary" icon="sparkles" onClick={() => setGuest(true)}>{t('Start the demo')}</Button>
      <div className="card small muted" style={{ textAlign: 'left', marginTop: 16 }}>
        {t('This demo runs entirely in your browser on example data — nothing is sent anywhere. Passkey sign-in and sync across your devices come with the openGym server, which you get by self-hosting it.')}
      </div>
      <div className="dim small" style={{ marginTop: 22, lineHeight: 1.6 }}>
        <a href={REPO} target="_blank" rel="noopener">{t('Self-host it in a minute →')}</a>
      </div>
    </div>
  )

  return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 34 }}>{t('Your workouts. Your weights. Your profile.')}</div>
      {webauthnOK() ? <>
        <Button variant="primary" icon="person" onClick={signIn}>{t('Sign in with passkey')}</Button>
        <div style={{ height: 10 }} />
      </> : <div className="card small muted" style={{ textAlign: 'left' }}>{t("This browser doesn't support passkeys — you can still use openGym locally on this device.")}</div>}
      <PasswordSignIn onSigned={u => { setUser(u); pullState().then(() => useUI.getState().toast(t('Welcome back, {0}', u.name))) }} />
      <div style={{ height: 10 }} />
      {needsBootstrap
        ? <Button variant="primary" icon="person" onClick={() => useUI.getState().openSheet(close => <BootstrapSheet close={close} />)}>{t('Create the admin account')}</Button>
        : <Button icon="sparkles" onClick={() => useUI.getState().openSheet(close => <RegisterSheet close={close} />)}>{t('Create new profile')}</Button>}
      <div style={{ height: 10 }} />
      <Button variant="ghost" className="dim" onClick={() => setGuest(true)}>{t('Continue without account')}</Button>
      <div className="dim small" style={{ marginTop: 26, lineHeight: 1.5 }}>{t('Passkeys use {0} — no passwords.', BIO)}<br />{t('Each profile keeps its own plan, workouts & body weight.')}</div>
    </div>
  )
}
