import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { validatePassword } from '../lib/password.js'
import { fmtDate, fmtNum, fmtVol, fmtDur } from '../lib/format.js'
import { workoutVolume, setsDone } from '../lib/history.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

// Admin-only operator dashboard (owner passkey + admin flag; guarded again server-side).
// Deliberately English-only — it isn't part of the translated end-user surface, so it stays
// out of the per-language string packs.

const rel = ts => {
  if (!ts) return 'never'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}
const dur = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60) + 'm' }

function UserDetail({ id, onChanged, close, onResetPassword }) {
  const [d, setD] = useState(null)
  const toast = useUI(s => s.toast)
  useEffect(() => { api('/api/admin/user?id=' + encodeURIComponent(id)).then(setD).catch(e => toast(e.message)) }, [id])
  if (!d) return <div className="muted small">Loading…</div>
  const u = d.user
  const setDisabled = disabled => {
    api('/api/admin/user/disable', { method: 'POST', body: JSON.stringify({ id: u.id, disabled }) })
      .then(() => { toast(disabled ? 'User disabled' : 'User enabled'); onChanged(); close() })
      .catch(e => toast(e.message))
  }
  return <>
    <h3 className="capitalize">{u.name}</h3>
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '8px 0 12px' }}>
      {u.admin && <span className="tag acc">admin</span>}
      {u.disabled && <span className="tag" style={{ color: 'var(--red)' }}>disabled</span>}
      {u.invitedBy && <span className="tag">invite {u.invitedBy}</span>}
      <span className="tag">joined {u.created ? fmtDate(u.created.slice(0, 10)) : '—'}</span>
    </div>
    <div className="tiles" style={{ textAlign: 'left' }}>
      <div className="tile"><div className="l">Workouts</div><div className="v" style={{ fontSize: '1.1rem' }}>{d.workouts.length}</div></div>
      <div className="tile"><div className="l">Weigh-ins</div><div className="v" style={{ fontSize: '1.1rem' }}>{d.bodyweight.length}</div></div>
      <div className="tile"><div className="l">Routines</div><div className="v" style={{ fontSize: '1.1rem' }}>{d.routines.length}</div></div>
      <div className="tile"><div className="l">Last sync</div><div className="v" style={{ fontSize: '.95rem' }}>{rel(d.lastSync)}</div></div>
    </div>
    {!u.admin && <button className={'btn ' + (u.disabled ? 'primary' : 'danger')} style={{ margin: '12px 0 4px' }}
      onClick={() => u.disabled ? setDisabled(false)
        : confirmSheet({ title: 'Disable ' + u.name + '?', message: 'They are signed out everywhere and can no longer sync or log in until re-enabled.', confirmText: 'Disable', danger: true, onConfirm: () => setDisabled(true) })}>
      {u.disabled ? 'Enable account' : 'Disable account'}</button>}
    <button className="btn" style={{ margin: '8px 0 4px' }} onClick={() => onResetPassword(u)}>
      <Icon name="key" /><span>Reset password</span>
    </button>
    <h4 className="sec">Workout history</h4>
    {d.workouts.length ? <div className="list" style={{ gap: 0 }}>
      {d.workouts.slice(0, 60).map(w => <div key={w.id} className="row between" style={{ padding: '9px 2px', borderBottom: '1px solid var(--sep)' }}>
        <div><div className="small" style={{ fontWeight: 600 }}>{w.name}</div>
          <div className="dim" style={{ fontSize: '.72rem' }}>{fmtDate(w.d, true)} · {fmtDur((w.end || w.start) - w.start)} · {setsDone(w)} sets{w.prs?.length ? ' · ' + w.prs.length + ' PR' : ''}</div></div>
        <span className="small muted">{fmtVol(w.vol ?? workoutVolume(w), d.unit)}</span>
      </div>)}
    </div> : <div className="empty small">No workouts logged.</div>}
  </>
}

function InvitesCard({ invites, reload }) {
  const toast = useUI(s => s.toast)
  const gen = () => api('/api/admin/invites/new', { method: 'POST', body: '{}' })
    .then(({ invite }) => { navigator.clipboard?.writeText(invite.code).catch(() => {}); toast('Code ' + invite.code + ' created & copied'); reload() })
    .catch(e => toast(e.message))
  const revoke = code => api('/api/admin/invites/revoke', { method: 'POST', body: JSON.stringify({ code }) })
    .then(() => { toast('Code revoked'); reload() }).catch(e => toast(e.message))
  const open = (invites || []).filter(i => !i.usedBy)
  const used = (invites || []).filter(i => i.usedBy)
  return <div className="card">
    <div className="row between"><h2 style={{ margin: 0 }}>Invite codes</h2>
      <Button variant="primary" size="sm" onClick={gen} icon="plus">Generate</Button></div>
    <div className="small muted" style={{ margin: '6px 0 10px' }}>{open.length} unused · {used.length} redeemed</div>
    {open.map(i => <div key={i.code} className="row between" style={{ padding: '7px 2px', borderBottom: '1px solid var(--sep)' }}>
      <span style={{ fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontWeight: 500, letterSpacing: '.06em' }}
        onClick={() => { navigator.clipboard?.writeText(i.code).catch(() => {}); toast('Copied ' + i.code) }}>{i.code}</span>
      <button className="iconbtn" style={{ width: 32, height: 30, borderRadius: 8, fontSize: 15, color: 'var(--red)' }} onClick={() => revoke(i.code)} aria-label="revoke"><Icon name="trash" /></button>
    </div>)}
    {used.map(i => <div key={i.code} className="row between dim" style={{ padding: '7px 2px', fontSize: '.8rem' }}>
      <span style={{ fontFamily: 'monospace' }}>{i.code}</span><span>→ {i.usedByName || 'used'}</span>
    </div>)}
    {!open.length && !used.length && <div className="dim small">No codes yet — generate one to invite someone.</div>}
  </div>
}


// Create an account with a name and a password. English-only like the rest of this
// operator dashboard — it is not part of the translated end-user surface.
function CreateUserSheet({ close, onCreated }) {
  const toast = useUI(s => s.toast)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [show, setShow] = useState(false)
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  const submit = async () => {
    if (!name.trim()) { toast('Name is required'); return }
    const invalid = validatePassword(password, password)
    if (invalid) { toast(invalid); return }
    setBusy(true)
    try {
      const res = await api('/api/admin/user/create', { method: 'POST', body: JSON.stringify({ name: name.trim(), password, admin: isAdmin }) })
      toast('User ' + res.user.name + ' created')
      close()
      onCreated && onCreated()
    } catch (e) { toast(e.message) }
    finally { setBusy(false) }
  }
  return <>
    <h3>Create user</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>The user signs in with this name and password. They can add a passkey later.</div>
    <input ref={ref} className="input" placeholder="Name" maxLength={40} value={name} onChange={e => setName(e.target.value)} />
    <div style={{ height: 10 }} />
    <div className="row" style={{ gap: 8 }}>
      <input className="input" type={show ? 'text' : 'password'} placeholder="Password" autoComplete="new-password" maxLength={200}
        value={password} onChange={e => setPassword(e.target.value)} />
      <button className="iconbtn" style={{ flex: 'none', width: 44, height: 44 }} onClick={() => setShow(s => !s)} aria-label="show password">
        <Icon name={show ? 'key' : 'lock'} />
      </button>
    </div>
    <div className="row" style={{ gap: 10, marginTop: 14 }}>
      <button className={'chip nocap' + (isAdmin ? ' on' : '')} onClick={() => setIsAdmin(a => !a)} style={{ cursor: 'pointer' }}>
        {isAdmin ? 'admin' : 'not admin'}
      </button>
      <span className="dim small">Grant admin rights</span>
    </div>
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create user'}</Button>
  </>
}

// Reset an account's password. The old one stops working immediately and every
// existing session for that account is signed out.
function ResetPasswordSheet({ user, close, onChanged }) {
  const toast = useUI(s => s.toast)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const invalid = validatePassword(password, password)
    if (invalid) { toast(invalid); return }
    setBusy(true)
    try {
      await api('/api/admin/user/password', { method: 'POST', body: JSON.stringify({ id: user.id, password }) })
      toast('Password updated — ' + user.name + ' was signed out')
      close()
      onChanged && onChanged()
    } catch (e) { toast(e.message) }
    finally { setBusy(false) }
  }
  return <>
    <h3>New password</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>For {user.name}. Their current password stops working and all their sessions are signed out.</div>
    <input className="input" type="password" placeholder="Password" autoComplete="new-password" maxLength={200}
      value={password} onChange={e => setPassword(e.target.value)} />
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Set password'}</Button>
  </>
}

export default function Admin() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)
  const [users, setUsers] = useState(null)
  const [invites, setInvites] = useState(null)
  const [inviteOnly, setInviteOnly] = useState(false)
  // A live count is a more useful UX cue than a spinner, and it stops a poll that just
  // refreshed the data from re-flickering the whole list. Bumped from /api/admin/users
  // which ships the whole users[] every 15s — we only need the change signal here.
  const [lastPollAt, setLastPollAt] = useState(null)

  const loadUsers = () => api('/api/admin/users').then(d => { setUsers(d.users); setInviteOnly(d.invite_only); setLastPollAt(Date.now()) }).catch(e => toast(e.message || 'Failed to load'))
  const loadInvites = () => api('/api/admin/invites').then(d => setInvites(d.invites)).catch(() => {})
  // Polling strategy:
  //  - 20s when the tab is visible (matches the 20s heartbeat the workout view sends
  //    to /api/activity, so the "training now" section can't lag by more than one tick).
  //  - paused when the tab is hidden — the admin is not looking, no need to spend
  //    bandwidth or read every state-<uid>.json from disk every 20s.
  //  - resumes with an immediate fetch on visibilitychange → visible, so the screen
  //    does not have to wait up to 20s after switching back to the tab.
  //  - cleaned up on unmount and on user/admin change. The empty dep array was right;
  //    `user?.admin` is what gates the whole effect.
  useEffect(() => {
    if (!user?.admin) return
    let iv = null
    let stopped = false
    const tick = () => { if (!stopped && document.visibilityState === 'visible') loadUsers() }
    const loadAll = () => { if (!stopped && document.visibilityState === 'visible') { loadUsers(); loadInvites() } }
    const onVis = () => { if (document.visibilityState === 'visible') loadAll() }
    loadAll()
    iv = setInterval(tick, 20000)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stopped = true
      clearInterval(iv)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [user?.admin])
  if (!user?.admin) return null

  const openUser = id => openSheet(close => <UserDetail id={id} onChanged={loadUsers} close={close}
    onResetPassword={u => openSheet(c2 => <ResetPasswordSheet user={u} close={c2} onChanged={loadUsers} />)} />)
  const createUser = () => openSheet(close => <CreateUserSheet close={close} onCreated={() => { loadUsers(); loadInvites() }} />)
  const liveUsers = (users || []).filter(u => u.live)
  const activeCount = (users || []).filter(u => u.lastSync && Date.now() - u.lastSync < 7 * 86400000).length
  const disabledCount = (users || []).filter(u => u.disabled).length
  // Relative "updated Ns ago" — same shape Settings uses for `gym_dirty` so the admin
  // knows whether the numbers they are looking at are fresh. Without a tick the label
  // would freeze at the moment of the last poll; a tiny interval bumps it forward every
  // 5s until 60s, then every 30s — enough granularity for "is this live" without burning
  // a re-render every second forever.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (lastPollAt == null) return
    const age = now - lastPollAt
    const ms = age < 60000 ? 5000 : 30000
    const t = setTimeout(() => setNow(Date.now()), ms)
    return () => clearTimeout(t)
  }, [now, lastPollAt])
  const pollAge = lastPollAt ? Math.max(0, Math.floor((now - lastPollAt) / 1000)) : null

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/settings')} aria-label="Back"><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 8 }}><h1 style={{ margin: 0 }}>Admin</h1>
        <div className="sub">{users ? users.length + ' users · ' + activeCount + ' active this week' : 'Loading…'}{pollAge != null ? ' · ' + (pollAge < 5 ? 'just now' : pollAge + 's ago') : ''}</div></div>
      <button className="iconbtn" onClick={() => { loadUsers(); loadInvites() }} aria-label="refresh">↻</button>
    </div>

    <div className="tiles" style={{ marginBottom: 12 }}>
      <div className="tile"><div className="l">Users</div><div className="v">{users ? users.length : '—'}</div></div>
      <div className="tile"><div className="l">Training now</div><div className="v" style={{ color: liveUsers.length ? 'var(--acc)' : undefined }}>{users ? liveUsers.length : '—'}</div></div>
      <div className="tile"><div className="l">Active 7d</div><div className="v">{users ? activeCount : '—'}</div></div>
      <div className="tile"><div className="l">Disabled</div><div className="v">{users ? disabledCount : '—'}</div></div>
    </div>

    {liveUsers.length > 0 && <div className="card" style={{ borderColor: 'var(--acc)' }}>
      <h2 className="row" style={{ margin: '0 0 8px', gap: 6 }}><Icon name="dot" style={{ fontSize: 10, color: 'var(--green)' }} />Training now</h2>
      {liveUsers.map(u => <div key={u.id} className="row between" style={{ padding: '8px 2px', borderBottom: '1px solid var(--sep)' }} onClick={() => openUser(u.id)}>
        <div><div className="small" style={{ fontWeight: 600 }}>{u.name}</div>
          <div className="dim" style={{ fontSize: '.72rem' }}>{u.live.name} · ex {u.live.exIdx}/{u.live.exTotal} · {u.live.setsDone}/{u.live.setsTotal} sets</div></div>
        <span className="tag acc">{dur(Date.now() - u.live.startedAt)}</span>
      </div>)}
    </div>}

    <InvitesCard invites={invites} reload={loadInvites} />

    <div className="row between" style={{ marginBottom: 8 }}>
      <h4 className="sec" style={{ margin: 0 }}>Users</h4>
      <Button variant="primary" size="sm" onClick={createUser} icon="plus">Create user</Button>
    </div>
    <div className="list">
      {(users || []).map(u => <div key={u.id} className="item" onClick={() => openUser(u.id)} style={u.disabled ? { opacity: .55 } : null}>
        <div className="grow"><div className="tt">{u.live && <Icon name="dot" style={{ fontSize: 9, color: 'var(--green)', display: 'inline-block', marginRight: 5 }} />}{u.name} {u.admin && <span className="tag acc" style={{ marginLeft: 4 }}>admin</span>}{u.hasPassword && <span className="tag" style={{ marginLeft: 4 }}>password</span>}{u.disabled && <span className="tag" style={{ marginLeft: 4, color: 'var(--red)' }}>off</span>}</div>
          <div className="ss">{u.live ? 'training now · ' + u.live.name : u.workouts + ' workouts' + (u.lastWorkout ? ' · last ' + fmtDate(u.lastWorkout) : '') + ' · synced ' + rel(u.lastSync)}</div></div>
        {u.hasPush && <Icon name="bell" title="push enabled" style={{ fontSize: 15, color: 'var(--label-3)' }} />}<Icon name="chevronRight" className="chev" />
      </div>)}
      {users && !users.length && <div className="empty">No users yet.</div>}
    </div>
  </div>
}
