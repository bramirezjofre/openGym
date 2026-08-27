#!/usr/bin/env node
// Stamp the service worker with a build identifier so the activate step can
// wipe the previous cache. Reads VERSION from env, falls back to a timestamp.
//
//   node scripts/inject-sw-version.mjs           # default: timestamp
//   VERSION=2026.08.27-abc1234 node scripts/...
//
// Idempotent — running twice produces the same stamped file. We patch in place
// after Vite has copied public/ into dist/, so Vite does not need a custom
// plugin. CI / docker build calls this right before the nginx image is built.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// Stamp the dist/ copy with a real build id. We deliberately do NOT touch
// public/sw.js — that copy must keep the __BUILD_ID__ placeholder so the next
// build also produces a fresh stamp. Touching public/ was a bug in the first
// iteration: it would mean the source file ended up committed with a real id,
// and the placeholder logic that detects "needs stamping" would silently stop
// working the next time someone tried it.
const targets = [
  join(here, '..', 'dist', 'sw.js'),
]

const buildId = (process.env.VERSION && String(process.env.VERSION)) ||
  new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')

let touched = 0
for (const f of targets) {
  if (!existsSync(f)) continue
  const src = readFileSync(f, 'utf8')
  if (!src.includes('__BUILD_ID__')) continue
  writeFileSync(f, src.replace(/__BUILD_ID__/g, buildId))
  console.log('stamped', f, '→', buildId)
  touched++
}

if (touched === 0) {
  console.error('inject-sw-version: no sw.js with __BUILD_ID__ placeholder found')
  process.exit(1)
}