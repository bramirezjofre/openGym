/* opengym-api — passkey (WebAuthn) auth + per-user state storage for openGym
   No framework, no SQL in this file, signed session cookies.            */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import webpush from 'web-push';
import { openDb } from './db.js';
import { createRepo } from './repo.js';
import { schemaFor } from './schema.js';
import { migrateLegacyJson } from './migrate.js';

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const RP_NAME = process.env.RP_NAME || 'openGym';
// Admin dashboard (issue): admins are matched by uid; INVITE_ONLY gates new signups behind a
// code the admin generates. Both default off so a fresh self-hosted instance stays open.
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
// 90 days keeps someone who trains a few times a week permanently signed in without a stolen
// cookie staying good for a year. Overridable because a family instance and one on the open
// internet don't want the same number. Only affects cookies minted from now on — the expiry is
// baked into each cookie when it's issued, so lowering this never cuts an existing session short.
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
const MAX_BODY = 5 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';

fs.mkdirSync(DATA, { recursive: true });

/* ---------- secret + db ---------- */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));

/* ---------- store ---------- */
// The store is a real database behind a repository (see repo.js): every query
// lives there, and this file never sees SQL. SQLite ships in the Node
// standard library, so this adds no dependency, no container and no RAM to
// the host — and the repository keeps the door open for Postgres later
// without touching a single handler below.
const db = openDb({ file: path.join(DATA, 'gym.db') });
db.exec(schemaFor(db.driver));
const repo = createRepo(db);

// One-time import of the previous JSON store. Idempotent: it only runs when
// the database has no users and the legacy file does, so a restart never
// re-imports and the legacy files stay on disk as the rollback.
const migrated = migrateLegacyJson({ dataDir: DATA, repo });
if (migrated.imported) {
  console.log('migrated legacy JSON store: ' + JSON.stringify(migrated));
}

/* ---------- push notifications (Web Push / VAPID) ---------- */
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); }
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

async function sendPush(userId, payload) {
  const subs = repo.subs.byUser(userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async sub => {
    // urgency 'high' is the one lever we have over delivery speed — iOS/Android throttle
    // low-urgency background push more aggressively under battery-saving modes. TTL is left
    // at the library default (long) so a briefly-offline device still gets it once reconnected,
    // rather than risking it being dropped for the sake of shaving off latency that TTL doesn't
    // actually control anyway.
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' }); }
    catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) {
        repo.subs.deleteByEndpoint(sub.endpoint); dirty = true;
      }
    }
  }));
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
const restTimers = new Map(); // userId -> Timeout
function scheduleRestTimer(userId, sec) {
  const t = restTimers.get(userId);
  if (t) clearTimeout(t);
  restTimers.set(userId, setTimeout(() => {
    restTimers.delete(userId);
    sendPush(userId, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' });
  }, sec * 1000));
}
function cancelRestTimer(userId) {
  const t = restTimers.get(userId);
  if (t) { clearTimeout(t); restTimers.delete(userId); }
}

// "Workout planned today" reminder — one per user per day, at their chosen time.
// Duplicated (not imported) from frontend/src/lib/history.js effectiveRoutineId — tiny pure helper, not worth sharing across the two runtimes.
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}
// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${g('hour')}:${g('minute')}` };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}
setInterval(() => {
  for (const user of repo.users.list()) {
    if (!repo.subs.hasForUser(user.id)) continue;
    const S = repo.state.get(user.id);
    if (!S?.reminder?.on) continue;
    const now = userNow(S.reminder.tz || 'UTC');
    if (!now || S.reminder.time !== now.hhmm) continue;
    if (user.lastReminder === now.date) continue;
    if ((S.workouts || []).some(w => w.d === now.date)) continue;
    const rid = effectiveRoutineId(S, now.date);
    if (!rid) continue; // rest day — nothing planned
    const routine = (S.routines || []).find(r => r.id === rid);
    console.log('reminder firing', user.id, rid);
    user.lastReminder = now.date;
    repo.users.update(user);
    sendPush(user.id, {
      title: routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    });
  }
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
}, 10000).unref();

/* ---------- sessions (signed cookie) ---------- */
function sign(payload) {
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}
// Session payload is `<uid>:<expiry>:<version>`, where the version is the user's `sv` counter.
// Bumping `sv` (POST /api/logout/all) makes every cookie ever handed out for that account stop
// verifying, which is the only revocation there was before short of deleting ./data/secret and
// signing out the whole instance. Cookies minted before `sv` existed have no third field and are
// read as version 0, matching a user who has never bumped — they stay valid until they expire.
const sessionVersion = user => user.sv || 0;
function makeSession(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return sign(user.id + ':' + exp + ':' + sessionVersion(user));
}
function readSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const tok = cookies.gymsid;
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = repo.users.byId(uid);
  if (!user) return null;
  if (user.disabled) return null;           // disabled accounts are locked out everywhere
  // Missing third field = pre-versioning cookie = version 0. Anything non-numeric is a malformed
  // payload (it still had to pass the HMAC, so this is belt-and-braces) and is refused outright.
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return user;
}
// Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin.
function requireAdmin(req, res) {
  const user = readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!isAdmin(user)) { json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}
function sessionCookie(user) {
  return `gymsid=${makeSession(user)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
const clearCookie = `gymsid=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;

/* ---------- password credentials (optional, alongside passkeys) ---------- */
// A passkey is the primary credential. A password is the fallback for a browser or device
// that cannot do WebAuthn — a shared family tablet, an old phone, or an account someone
// needs to open from a laptop that has no platform authenticator. It is an ADDITIONAL
// credential: registering one never removes the other, and /api/logout/all still revokes
// every session for the account.
//
// scrypt from node:crypto, not argon2/bcrypt: those are native modules and this image is
// Alpine (musl), where they need a source build with a working node-gyp toolchain.
// node:crypto's scrypt is in the standard library — no dependency, no build step, no
// supply-chain surface. Parameters follow the OWASP baseline (N=2^15, r=8, p=1).
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 };
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
// Cost parameters are stored with the hash so a future change to SCRYPT does not lock
// out existing users — verifyPassword reads the parameters from the stored string.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * 1024 * 1024 });
  return 'scrypt$' + SCRYPT.N + '$' + SCRYPT.r + '$' + SCRYPT.p + '$' +
    salt.toString('base64url') + '$' + key.toString('base64url');
}
function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, keyB64] = parts;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(keyB64, 'base64url');
    const actual = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length,
      { N: +N, r: +r, p: +p, maxmem: 256 * 1024 * 1024 });
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

// Brute-force guard. In-memory, so it resets on restart — that is the right trade for a
// self-hosted instance: a restart is a deliberate admin action, and persisting the counter
// would mean another table and another write path. The window is small and the limit is
// per (ip, user) pair, so one attacker cannot lock a legitimate user out for long.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map();   // key -> { count, first, lockedUntil }
function attemptKey(req, name) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress || '';
  return ip + '|' + String(name || '').toLowerCase();
}
function loginBlocked(key) {
  const rec = loginAttempts.get(key);
  if (!rec) return false;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return true;
  if (rec.first && Date.now() - rec.first > LOGIN_WINDOW_MS) { loginAttempts.delete(key); return false; }
  return false;
}
function noteFailedAttempt(key) {
  const rec = loginAttempts.get(key) || { count: 0, first: Date.now(), lockedUntil: 0 };
  if (!rec.first || Date.now() - rec.first > LOGIN_WINDOW_MS) { rec.count = 0; rec.first = Date.now(); }
  rec.count++;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) rec.lockedUntil = Date.now() + LOGIN_WINDOW_MS;
  loginAttempts.set(key, rec);
}
function clearAttempts(key) { loginAttempts.delete(key); }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) {
    if (now - (v.first || 0) > LOGIN_WINDOW_MS) loginAttempts.delete(k);
  }
}, 60000).unref();

/* ---------- challenge store (in-memory, 5 min TTL) ---------- */
const challenges = new Map(); // cid -> {challenge, name?, uid?, exp}
function putChallenge(data) {
  const cid = crypto.randomBytes(16).toString('base64url');
  challenges.set(cid, { ...data, exp: Date.now() + 5 * 60000 });
  return cid;
}
function takeChallenge(cid) {
  const c = challenges.get(cid);
  challenges.delete(cid);
  if (!c || c.exp < Date.now()) return null;
  return c;
}
setInterval(() => { for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k); }, 60000).unref();

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
const b64uToBuf = s => Buffer.from(s, 'base64url');

/* ---------- live presence (in-memory) ---------- */
// Clients heartbeat /api/activity while a workout is on screen; the admin dashboard reads who's
// live. Purely ephemeral — never persisted. Expires shortly after the last ping.
const presence = new Map();               // uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt }
const PRESENCE_TTL = 70000;               // ~3.5× the 20s client heartbeat
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null; }
  return p;
}
setInterval(() => { for (const [k, v] of presence) if (Date.now() - v.updatedAt > PRESENCE_TTL) presence.delete(k); }, 30000).unref();

/* ---------- routes ---------- */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: repo.users.count() }),

  // Public config the login screen needs before anyone is signed in.
  'GET /api/config': async (req, res) => json(res, 200, {
    invite_only: INVITE_ONLY,
    // True only while the instance has no accounts at all. The first account created
    // becomes the admin — see POST /api/admin/bootstrap. Exposes no user data.
    needs_bootstrap: repo.users.count() === 0
  }),

  'GET /api/me': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } });
  },

  'POST /api/register/options': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required' });
    const code = String(body.code || '').trim().toUpperCase();
    if (INVITE_ONLY && !repo.invites.validByCode(code))
      return json(res, 403, { error: 'a valid invite code is required' });
    const uid = crypto.randomBytes(12).toString('base64url');
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: RP_ID,
      userID: Buffer.from(uid), userName: name, userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: []
    });
    const cid = putChallenge({ challenge: options.challenge, name, uid, code });
    json(res, 200, { cid, options });
  },

  'POST /api/register/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (!c || !c.uid) return json(res, 400, { error: 'challenge expired — try again' });
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false
      });
    } catch (e) { return json(res, 400, { error: 'verification failed: ' + e.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    const { credential } = verification.registrationInfo;
    if (repo.creds.byId(credential.id)) return json(res, 409, { error: 'credential already registered' });
    // Re-check the invite at the last moment (it may have been used/revoked since options), then burn it.
    let invite = null;
    if (INVITE_ONLY) {
      invite = repo.invites.validByCode(c.code);
      if (!invite) return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
    }
    const user = { id: c.uid, name: c.name, created: new Date().toISOString() };
    if (invite) { user.invitedBy = invite.code; }
    db.tx(() => {
      repo.users.insert(user);
      repo.creds.insert({
        id: credential.id, userId: user.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter || 0,
        transports: body.credential?.response?.transports || []
      });
      if (invite) { invite.usedBy = user.id; invite.usedAt = user.created; repo.invites.update(invite); }
    });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/login/options': async (req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID, userVerification: 'preferred', allowCredentials: []
    });
    const cid = putChallenge({ challenge: options.challenge });
    json(res, 200, { cid, options });
  },

  'POST /api/login/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (!c) return json(res, 400, { error: 'challenge expired — try again' });
    const cred = repo.creds.byId(body.credential?.id);
    if (!cred) return json(res, 404, { error: 'unknown passkey — create a profile first' });
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false,
        credential: {
          id: cred.id,
          publicKey: b64uToBuf(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports
        }
      });
    } catch (e) { return json(res, 400, { error: 'verification failed: ' + e.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    cred.counter = verification.authenticationInfo.newCounter;
    repo.creds.update(cred);
    const user = repo.users.byId(cred.userId);
    if (!user) return json(res, 500, { error: 'user missing' });
    if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Register an account with a name and a password, without a passkey. This is the
  // path for a device that cannot do WebAuthn. It honours INVITE_ONLY exactly like
  // the passkey registration does — the invite code is the gate either way.
  'POST /api/register/password': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    const code = String(body.code || '').trim().toUpperCase();
    if (!name || name.length > 40) return json(res, 400, { error: 'name is required (max 40 characters)' });
    if (password.length < PASSWORD_MIN) return json(res, 400, { error: 'password must be at least ' + PASSWORD_MIN + ' characters' });
    if (password.length > PASSWORD_MAX) return json(res, 400, { error: 'password is too long' });
    if (repo.users.existsByName(name)) {
      return json(res, 409, { error: 'a user with that name already exists' });
    }
    let invite = null;
    if (INVITE_ONLY) {
      invite = repo.invites.validByCode(code);
      if (!invite) return json(res, 403, { error: 'invite code is required — ask the admin for one' });
    }
    const user = {
      id: crypto.randomBytes(12).toString('base64url'),
      name,
      created: new Date().toISOString(),
      passwordHash: hashPassword(password)
    };
    if (invite) { user.invitedBy = invite.code; }
    db.tx(() => {
      repo.users.insert(user);
      if (invite) { invite.usedBy = user.id; invite.usedAt = user.created; repo.invites.update(invite); }
    });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Password sign-in. Same session cookie as the passkey path — no separate session
  // system, so a password login and a passkey login are interchangeable afterwards.
  'POST /api/login/password': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    if (!name || !password) return json(res, 400, { error: 'name and password are required' });
    const key = attemptKey(req, name);
    if (loginBlocked(key)) {
      return json(res, 429, { error: 'too many failed attempts — try again in a few minutes' });
    }
    const user = repo.users.byName(name);
    // One generic message for every failure mode (unknown user, wrong password, no
    // password set) — anything more specific tells an attacker which accounts exist.
    const fail = () => { noteFailedAttempt(key); return json(res, 401, { error: 'invalid name or password' }); };
    if (!user || !user.passwordHash) return fail();
    if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
    if (!verifyPassword(password, user.passwordHash)) return fail();
    clearAttempts(key);
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Set or change the password for the signed-in account. The current password is
  // required when one is already set, so a stolen session cookie alone cannot take
  // over the account. Also bumps the session version, which signs out every other
  // device — the same revocation /api/logout/all performs.
  'POST /api/password': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const password = String(body.password || '');
    const current = String(body.current || '');
    if (password.length < PASSWORD_MIN) return json(res, 400, { error: 'password must be at least ' + PASSWORD_MIN + ' characters' });
    if (password.length > PASSWORD_MAX) return json(res, 400, { error: 'password is too long' });
    if (user.passwordHash && !verifyPassword(current, user.passwordHash)) {
      return json(res, 403, { error: 'current password is wrong' });
    }
    user.passwordHash = hashPassword(password);
    user.sv = sessionVersion(user) + 1;
    repo.users.update(user);
    json(res, 200, { ok: true, signedOut: true });
  },

  'POST /api/logout': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie }),

  // "Sign out everywhere" — bumps this user's session version, which invalidates every cookie
  // ever issued for the account, on every device, including a copy someone else walked off with.
  // The caller's own cookie is cleared here too, so the browser doing it doesn't sit on a token
  // it no longer accepts. Passkeys are untouched: signing back in works immediately.
  'POST /api/logout/all': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    user.sv = sessionVersion(user) + 1;
    repo.users.update(user);
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  'GET /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { state: repo.state.get(user.id) });
  },

  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    delete body.state.active;              // in-progress workouts stay device-local
    repo.state.set(user.id, body.state);
    json(res, 200, { ok: true, ts: body.state._ts || null });
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  'POST /api/push/subscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    db.tx(() => {
      repo.subs.deleteByEndpoint(sub.endpoint);
      repo.subs.insert({ userId: user.id, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() });
    });
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    repo.subs.deleteByUserEndpoint(user.id, body.endpoint);
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await sendPush(user.id, { title: 'openGym', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    scheduleRestTimer(user.id, sec);
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    cancelRestTimer(user.id);
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      presence.set(user.id, {
        name: String(body.name || '').slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else presence.delete(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- admin dashboard ---------- */
  // One row per user, cheap enough for a personal instance (reads each user's state once).
  // Bootstrap the first admin. An instance with no users yet has no admin, and the
  // ADMIN_UIDS route needs a uid that only exists AFTER a first account is created —
  // a chicken-and-egg the admin dashboard could not be reached through. So: the first
  // account created on an empty instance becomes the admin. Only when the instance has
  // zero users, so it can never hand the admin flag to a later arrival.
  'POST /api/admin/bootstrap': async (req, res) => {
    if (repo.users.count()) return json(res, 409, { error: 'this instance already has users — ask an admin for an account' });
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    if (!name || name.length > 40) return json(res, 400, { error: 'name is required (max 40 characters)' });
    if (password.length < PASSWORD_MIN) return json(res, 400, { error: 'password must be at least ' + PASSWORD_MIN + ' characters' });
    if (password.length > PASSWORD_MAX) return json(res, 400, { error: 'password is too long' });
    const user = {
      id: crypto.randomBytes(12).toString('base64url'),
      name,
      created: new Date().toISOString(),
      admin: true,
      passwordHash: hashPassword(password)
    };
    repo.users.insert(user);
    json(res, 200, { ok: true, user: { id: user.id, name: user.name, admin: true } }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Create an account directly, with a name and a password. The invite-code flow
  // (POST /api/admin/invites/new) is for someone who will register with a passkey
  // on their own device; this is for an account that has to exist now, with a
  // password the admin sets and hands over. The account can also be flagged admin.
  'POST /api/admin/user/create': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    if (!name || name.length > 40) return json(res, 400, { error: 'name is required (max 40 characters)' });
    if (repo.users.existsByName(name)) {
      return json(res, 409, { error: 'a user with that name already exists' });
    }
    if (password.length < PASSWORD_MIN) return json(res, 400, { error: 'password must be at least ' + PASSWORD_MIN + ' characters' });
    if (password.length > PASSWORD_MAX) return json(res, 400, { error: 'password is too long' });
    const user = {
      id: crypto.randomBytes(12).toString('base64url'),
      name,
      created: new Date().toISOString(),
      passwordHash: hashPassword(password)
    };
    if (body.admin === true) { user.admin = true; user.sv = 1; }
    repo.users.insert(user);
    json(res, 200, { ok: true, user: { id: user.id, name: user.name, admin: isAdmin(user) } });
  },

  // Reset an account's password. The old one is replaced outright — there is no
  // "current password" here because the admin is not the account holder. Bumps the
  // session version so every existing cookie for that account stops verifying.
  'POST /api/admin/user/password': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const id = String(body.id || '');
    const password = String(body.password || '');
    const u = repo.users.byId(id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (password.length < PASSWORD_MIN) return json(res, 400, { error: 'password must be at least ' + PASSWORD_MIN + ' characters' });
    if (password.length > PASSWORD_MAX) return json(res, 400, { error: 'password is too long' });
    u.passwordHash = hashPassword(password);
    u.sv = sessionVersion(u) + 1;
    repo.users.update(u);
    json(res, 200, { ok: true });
  },

  'GET /api/admin/users': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = repo.users.list().map(u => {
      const S = repo.state.get(u.id) || {};
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null, hasPassword: !!u.passwordHash,
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: S._ts || null,
        hasPush: repo.subs.hasForUser(u.id),
        live: livePresence(u.id)
      };
    });
    json(res, 200, { users, invite_only: INVITE_ONLY, now: Date.now() });
  },

  // Drill-down: full workout history + body-weight log for one user.
  'GET /api/admin/user': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = repo.users.byId(id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = repo.state.get(u.id) || {};
    json(res, 200, {
      user: { id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse()   // newest first for display
    });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const u = repo.users.byId(body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    u.disabled = !!body.disabled;
    if (u.disabled) presence.delete(u.id);   // drop them off "training now" at once
    repo.users.update(u);
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // resolve usedBy uid → name for display
    const invites = repo.invites.list().map(i => ({
      ...i, usedByName: i.usedBy ? (repo.users.byId(i.usedBy) || {}).name || null : null
    }));
    json(res, 200, { invites, invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    let code;
    // 16 hex chars = 64 bits, up from 8 chars / 32 bits. The app has no rate limiting by design
    // (that's the reverse proxy's job) and /api/register/options tells a caller whether a code is
    // good, so the code itself has to be the thing that isn't worth guessing. Codes already in
    // the store keep working — validation is an exact string compare, never a length or format check.
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (repo.invites.existsByCode(code));
    const invite = { code, note: String(body.note || '').slice(0, 60), createdBy: admin.id, created: new Date().toISOString() };
    repo.invites.insert(invite);
    json(res, 200, { invite });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const inv = repo.invites.byCode(String(body.code || '').toUpperCase());
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.usedBy) return json(res, 400, { error: 'already used — cannot revoke' });
    repo.invites.deleteByCode(inv.code);
    json(res, 200, { ok: true });
  }
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  try { await handler(req, res); }
  catch (e) {
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => console.log(`gym-api on :${PORT} (rpID=${RP_ID}, origin=${ORIGIN})`));
