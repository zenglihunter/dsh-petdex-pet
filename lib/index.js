// dsh-petdex-pet Node half: renders a petdex pet (e.g. ~/.petdex/pets/gon/)
// inside the DSH web GUI. Reads pets from ~/.petdex/pets/<slug>/, derives a
// petdex state from DSH session events, and serves state/assets to the client
// half (which floats the sprite bottom-right and animates the petdex 8-column
// sprite grid). Zero runtime deps.
//
// State mapping follows the petdex ecosystem conventions:
//   turn/start → jumping; step/tool/workflow/goal/compaction → running;
//   approval asked → waiting; turn completed → waving; turn failed/blocked →
//   failed/waiting; otherwise idle. A human-readable text synced with DSH
//   (e.g. "正在使用工具: pwsh") rides alongside the state.
//
// Routes (single source of truth, mirrored by the client half):
//   GET  /petdex-pet/state       → { pet, displayName, state, text, enabled, ... }
//   GET  /petdex-pet/pets        → [{ slug, displayName, hasSprite, spriteFile }]
//   POST /petdex-pet/pet         → { pet: slug } switch | { enabled: bool } close/open
//   GET  /petdex-pet/available   → petdex gallery manifest (for "add pet")
//   POST /petdex-pet/install     → { slug } install from gallery
//   GET  /petdex-pet/assets/<slug>/<file>  → spritesheet.webp | pet.json
//   GET  /petdex-pet/events      → SSE (state changed → client refreshes)
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'

// watch-touch
export const name = 'dsh-petdex-pet'
export const inject = ['webServer', 'settings']

/** Route prefix (single source of truth; client mirrors it as a constant). */
export const ROUTE_PREFIX = '/petdex-pet'
export const STATE_PATH = `${ROUTE_PREFIX}/state`
export const PETS_PATH = `${ROUTE_PREFIX}/pets`
export const PET_PATH = `${ROUTE_PREFIX}/pet`
export const AVAILABLE_PATH = `${ROUTE_PREFIX}/available`
export const INSTALL_PATH = `${ROUTE_PREFIX}/install`
export const ASSETS_PATH = `${ROUTE_PREFIX}/assets`
export const PREVIEW_PATH = `${ROUTE_PREFIX}/preview`
export const EVENTS_PATH = `${ROUTE_PREFIX}/events`

const PETS_ROOT = join(homedir(), '.petdex', 'pets')
const DEFAULT_PET = 'gon'
/** Package-bundled starter pets (seeded into ~/.petdex/pets on first activation). */
const BUNDLED_PETS_DIR = fileURLToPath(new URL('../pets/', import.meta.url))
/** Records which bundled slugs were seeded, so later deletions stay deleted. */
const BUNDLE_MARKER_PATH = join(homedir(), '.petdex', '.dsh-petdex-bundled.json')
/** petdex gallery manifest endpoint. */
const MANIFEST_URL = 'https://petdex.dev/api/manifest'
const MANIFEST_TTL_MS = 5 * 60 * 1000
/** petdex canonical state rows (from petdex src/lib/pet-states.ts). */
const PET_STATES = [
  { id: 'idle', row: 0, frames: 6, durationMs: 1100 },
  { id: 'running-right', row: 1, frames: 8, durationMs: 1060 },
  { id: 'running-left', row: 2, frames: 8, durationMs: 1060 },
  { id: 'waving', row: 3, frames: 4, durationMs: 700 },
  { id: 'jumping', row: 4, frames: 5, durationMs: 840 },
  { id: 'failed', row: 5, frames: 8, durationMs: 1220 },
  { id: 'waiting', row: 6, frames: 6, durationMs: 1010 },
  { id: 'running', row: 7, frames: 6, durationMs: 820 },
  { id: 'review', row: 8, frames: 6, durationMs: 1030 },
]
/** Human-readable status text per petdex state (synced with DSH activity). */
const STATE_TEXT = {
  idle: '空闲',
  'running-right': '运行中…',
  'running-left': '运行中…',
  waving: '任务完成 ✓',
  jumping: '开始执行任务',
  failed: '任务失败',
  waiting: '等待你的批准',
  running: '运行中…',
  review: '思考中…',
}
/** DSH event type → petdex state (petdex-dsh-plugin normalize.js conventions). */
const EVENT_STATE = new Map([
  ['turn/start', 'jumping'],
  ['step/start', 'running'],
  ['step/end', 'running'],
  ['tool/call', 'running'],
  ['tool/result', 'running'],
  ['tool-workflow/run-start', 'running'],
  ['tool-workflow/agent-start', 'running'],
  ['tool-workflow/agent-end', 'running'],
  ['tool-workflow/run-end', 'running'],
  ['goal/change', 'running'],
  ['compaction/start', 'running'],
  ['compaction/end', 'running'],
])
/** Transient state duration windows (ms). */
const WINDOWS = {
  jumping: 1200,
  waving: 1200,
  failed: 1600,
  waiting: 1400,
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra })
  res.end(JSON.stringify(body))
}

/** List petdex pets on disk: [{ slug, displayName, hasSprite, spriteFile }]. */
export function listPets() {
  try {
    const out = []
    for (const entry of readdirSync(PETS_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const slug = entry.name
      const dir = join(PETS_ROOT, slug)
      let displayName = slug
      let spriteFile = null
      try {
        const pet = JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf8'))
        if (typeof pet?.displayName === 'string' && pet.displayName !== '') displayName = pet.displayName
      } catch {
        // incomplete pet dir — still listable but flagged
      }
      for (const f of ['spritesheet.webp', 'spritesheet.png']) {
        try {
          if (statSync(join(dir, f)).isFile()) { spriteFile = f; break }
        } catch {}
      }
      out.push({ slug, displayName, hasSprite: spriteFile !== null, spriteFile })
    }
    return out
  } catch {
    return []
  }
}

/** Resolve a pet asset file path; returns null for unsafe/absent paths. */
export function resolveAsset(slug, file) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null
  if (!/^(spritesheet\.(webp|png)|pet\.json)$/.test(file)) return null
  const dir = join(PETS_ROOT, slug)
  try {
    const st = statSync(join(dir, file))
    return st.isFile() ? join(dir, file) : null
  } catch {
    return null
  }
}

/** Delete an installed pet directory. Returns true when removed. */
export function deletePet(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return false
  try {
    rmSync(join(PETS_ROOT, slug), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Seed the package-bundled starter pets into a pets root, once per slug.
 *
 * A marker file records every slug that has been seeded; a pet the user later
 * deletes is therefore never resurrected. Pets already present in the root are
 * left untouched (they just get stamped in the marker). Returns seeded slugs.
 */
export function seedBundledPets(petsRoot = PETS_ROOT, markerPath = BUNDLE_MARKER_PATH, bundledDir = BUNDLED_PETS_DIR) {
  const seeded = []
  try {
    const markers = new Set()
    try {
      const raw = JSON.parse(readFileSync(markerPath, 'utf8'))
      if (Array.isArray(raw?.seeded)) for (const s of raw.seeded) markers.add(String(s))
    } catch {
      // first run — no marker yet
    }
    let entries = []
    try {
      entries = readdirSync(bundledDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    } catch {
      return seeded // no bundled pets in this package
    }
    let changed = false
    for (const entry of entries) {
      const slug = entry.name
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) continue
      if (markers.has(slug)) continue
      const src = join(bundledDir, slug)
      const dest = join(petsRoot, slug)
      try {
        if (!existsSync(dest)) {
          mkdirSync(petsRoot, { recursive: true })
          cpSync(src, dest, { recursive: true })
        }
        markers.add(slug)
        seeded.push(slug)
        changed = true
      } catch {
        // unreadable source or unwritable target: skip this slug
      }
    }
    if (changed) {
      try {
        mkdirSync(dirname(markerPath), { recursive: true })
        writeFileSync(markerPath, JSON.stringify({ seeded: [...markers] }, null, 2) + '\n')
      } catch {}
    }
  } catch {}
  return seeded
}

/** Fetch the petdex gallery manifest with a short TTL cache. */
async function fetchManifest() {
  const now = Date.now()
  if (fetchManifest.cache && now - fetchManifest.at < MANIFEST_TTL_MS) return fetchManifest.cache
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(MANIFEST_URL, { signal: controller.signal, headers: { 'user-agent': 'dsh-petdex-pet' } })
    if (!res.ok) throw new Error(`manifest ${res.status}`)
    const data = await res.json()
    fetchManifest.cache = data
    fetchManifest.at = now
    return data
  } finally {
    clearTimeout(timer)
  }
}

/** Download and install a gallery pet into ~/.petdex/pets/<slug>/. */
export async function installPet(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('invalid slug')
  const manifest = await fetchManifest()
  const entry = (manifest?.pets ?? []).find((p) => p.slug === slug)
  if (!entry) throw new Error(`pet not in gallery: ${slug}`)
  const dir = join(PETS_ROOT, slug)
  mkdirSync(dir, { recursive: true })
  const dl = async (url) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-petdex-pet' } })
      if (!res.ok) throw new Error(`download ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } finally {
      clearTimeout(timer)
    }
  }
  // spritesheet: keep the extension the gallery serves.
  let spriteExt = 'webp'
  try {
    const u = new URL(entry.spritesheetUrl)
    const m = /\.(webp|png)$/i.exec(u.pathname)
    if (m) spriteExt = m[1].toLowerCase()
  } catch {}
  const spriteBuf = await dl(entry.spritesheetUrl)
  writeFileSync(join(dir, `spritesheet.${spriteExt}`), spriteBuf)
  let petJson = { id: slug, displayName: entry.displayName ?? slug, spritesheetPath: `spritesheet.${spriteExt}` }
  try {
    const j = await dl(entry.petJsonUrl)
    petJson = JSON.parse(j.toString('utf8'))
    if (typeof petJson.spritesheetPath !== 'string') petJson.spritesheetPath = `spritesheet.${spriteExt}`
  } catch {
    // fall back to generated pet.json
  }
  writeFileSync(join(dir, 'pet.json'), JSON.stringify(petJson, null, 2) + '\n')
  return { slug, displayName: petJson.displayName ?? entry.displayName ?? slug, spriteFile: `spritesheet.${spriteExt}` }
}

function contentTypeFor(file) {
  if (file.endsWith('.webp')) return 'image/webp'
  if (file.endsWith('.png')) return 'image/png'
  return 'application/json; charset=utf-8'
}

export function apply(ctx) {
  // Seed the bundled starter pets (全職獵人 x4) into ~/.petdex/pets before any
  // route can serve them. Runs every activation but is a no-op once a slug has
  // been seeded (marker file), so deletions are respected.
  seedBundledPets()
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined

  // Config (optional settings service; fallback to defaults). Uses a schemastery
  // schema so the DSH settings UI renders proper fields for this plugin.
  let config = { pet: DEFAULT_PET, size: 100, enabled: true }
  let configRevision = 0
  let settingsScope = null
  const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
  if (settings !== undefined && typeof settings.register === 'function') {
    try {
      settingsScope = settings.register('dsh-petdex-pet', z.object({
        pet: z.string().default(DEFAULT_PET),
        size: z.number().min(40).max(150).default(100), // percentage scale; 100% ≈ 110px rendered
        enabled: z.boolean().default(true),
      }), { applies: 'live' })
      config = { ...config, ...settingsScope.get() }
      configRevision += 1
      settingsScope.watch((next) => {
        config = { ...config, ...next }
        configRevision += 1
        broadcastEvent()
      })
    } catch {
      // settings register failed (e.g. duplicate) → keep defaults
      settingsScope = null
    }
  }
  /** Persist one config field through the settings scope (survives restart). */
  const persistConfig = (field, value) => {
    config = { ...config, [field]: value }
    configRevision += 1
    try {
      // Host settings scope exposes `update`/`replace` (not `set`).
      if (settingsScope !== null && typeof settingsScope.update === 'function') settingsScope.update({ [field]: value }).catch(() => {})
    } catch {}
  }

  // ---- session state machine ----
  let state = 'idle'
  let activeTurns = 0
  const transients = new Map() // state id → { at, ms }
  let lastEventAt = 0
  let currentTool = null // last tool/call name, for the synced text

  const setTransient = (id, ms) => {
    transients.set(id, { at: Date.now(), ms })
  }

  const derive = () => {
    const now = Date.now()
    // Most-recently-triggered active transient wins (event recency, not window
    // length): a turn/end or approval is a terminal signal that must override
    // lingering activity windows regardless of their duration.
    let bestId = null
    let bestAt = -1
    for (const [id, t] of transients) {
      if (t.at + t.ms > now && (bestId === null || t.at > bestAt)) {
        bestId = id
        bestAt = t.at
      }
    }
    if (bestId !== null) return bestId
    if (activeTurns > 0 || now - lastEventAt < 2500) return 'running'
    return 'idle'
  }

  /** Human text synced with DSH activity (state + current tool). */
  const deriveText = (st) => {
    if (st === 'running' && currentTool !== null && currentTool !== '') return `正在使用工具: ${currentTool}`
    return STATE_TEXT[st] ?? st
  }

  // ---- SSE broadcast ----
  const sseClients = new Set()
  const broadcastEvent = () => {
    const line = 'data: {"type":"event"}\n\n'
    for (const res of sseClients) {
      try { res.write(line) } catch { sseClients.delete(res) }
    }
  }

  // ---- session events (mirrors petdex-dsh-plugin normalize mapping) ----
  ctx.on('session/event', (session, event) => {
    const type = typeof event?.type === 'string' ? event.type : null
    if (type === null) return
    lastEventAt = Date.now()
    if (type === 'turn/start') {
      activeTurns += 1
      currentTool = null
      setTransient('jumping', WINDOWS.jumping)
    } else if (type === 'turn/end') {
      activeTurns = Math.max(0, activeTurns - 1)
      currentTool = null
      const reason = event?.data?.reason?.kind
      if (reason === 'completed') setTransient('waving', WINDOWS.waving)
      else if (reason === 'blocked' || reason === 'max-tokens') setTransient('waiting', WINDOWS.waiting)
      else setTransient('failed', WINDOWS.failed)
    } else if (type === 'approval/asked') {
      setTransient('waiting', WINDOWS.waiting)
    } else if (type === 'approval/decided') {
      setTransient('running', 1500)
    } else if (type === 'tool/call') {
      const name = event?.data?.name
      if (typeof name === 'string' && name !== '') currentTool = name
      setTransient('running', 2500)
    } else if (EVENT_STATE.has(type)) {
      setTransient('running', 2500)
    }
    broadcastEvent()
  })

  // Decay timer keeps /state fresh even without events.
  const decayTimer = setInterval(() => { broadcastEvent() }, 1000)

  ctx.effect(() => {
    const disposers = []

    if (webServer !== undefined) {
      disposers.push(webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') { json(res, 405, { error: 'use GET' }); return }
          const pets = listPets()
          const slug = pets.some((p) => p.slug === config.pet) ? config.pet : (pets[0]?.slug ?? DEFAULT_PET)
          const petMeta = pets.find((p) => p.slug === slug) ?? { slug, displayName: slug, hasSprite: false, spriteFile: 'spritesheet.webp' }
          const st = derive()
          json(res, 200, {
            pet: slug,
            displayName: petMeta.displayName,
            state: st,
            text: deriveText(st),
            spriteFile: petMeta.spriteFile ?? 'spritesheet.webp',
            activeTurns,
            configRevision,
            enabled: config.enabled,
            size: config.size,
            petStates: PET_STATES,
            pets: pets.map((p) => p.slug),
          }, { 'cache-control': 'no-store' })
        },
      }))

      disposers.push(webServer.register({
        kind: 'exact',
        path: PETS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') { json(res, 405, { error: 'use GET' }); return }
          json(res, 200, listPets(), { 'cache-control': 'no-store' })
        },
      }))

      // ---- delete one installed pet ----
      // NOTE: the prefix must NOT end with '/'. The webServer prefix matcher
      // accepts `<prefix>/<anything>`, so a trailing slash would require
      // `/petdex-pet/pets//<slug>` and the route would never match.
      disposers.push(webServer.register({
        kind: 'prefix',
        path: PETS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'DELETE') { res.writeHead(405); res.end(); return }
          let pathname
          try {
            pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://dsh.internal').pathname)
          } catch { res.writeHead(400); res.end(); return }
          const rest = pathname.slice(PETS_PATH.length + 1)
          const slash = rest.indexOf('/')
          const slug = slash === -1 ? rest : rest.slice(0, slash)
          if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) { json(res, 400, { error: 'invalid slug' }); return }
          const pets = listPets()
          if (!pets.some((p) => p.slug === slug)) { json(res, 404, { error: `pet not installed: ${slug}` }); return }
          if (!deletePet(slug)) { json(res, 500, { error: `failed to delete: ${slug}` }); return }
          let current = config.pet
          if (current === slug) {
            const remaining = listPets()
            current = remaining[0]?.slug ?? DEFAULT_PET
            persistConfig('pet', current)
          }
          broadcastEvent()
          json(res, 200, { slug, deleted: true, pet: current, pets: listPets() }, { 'cache-control': 'no-store' })
        },
      }))

      disposers.push(webServer.register({
        kind: 'exact',
        path: PET_PATH,
        handler: async (req, res) => {
          if (req.method === 'GET') {
            json(res, 200, { pet: config.pet, enabled: config.enabled }, { 'cache-control': 'no-store' })
            return
          }
          if (req.method !== 'POST') { json(res, 405, { error: 'use GET or POST' }); return }
          let body = ''
          for await (const chunk of req) {
            body += chunk
            if (body.length > 512) { json(res, 413, { error: 'body too large' }); return }
          }
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { json(res, 400, { error: 'invalid JSON' }); return }
          // size percentage (40–150)
          if (typeof parsed?.size === 'number') {
            const size = Math.min(150, Math.max(40, Math.round(parsed.size)))
            persistConfig('size', size)
            broadcastEvent()
            json(res, 200, { size }, { 'cache-control': 'no-store' })
            return
          }
          // enabled toggle (close/open the pet)
          if (typeof parsed?.enabled === 'boolean') {
            persistConfig('enabled', parsed.enabled)
            broadcastEvent()
            json(res, 200, { enabled: parsed.enabled }, { 'cache-control': 'no-store' })
            return
          }
          // pet switch
          const slug = typeof parsed?.pet === 'string' ? parsed.pet : null
          if (slug === null) { json(res, 400, { error: 'missing pet slug or enabled' }); return }
          const pets = listPets()
          if (!pets.some((p) => p.slug === slug)) { json(res, 404, { error: `pet not installed: ${slug}` }); return }
          persistConfig('pet', slug)
          broadcastEvent()
          json(res, 200, { pet: slug }, { 'cache-control': 'no-store' })
        },
      }))

      // ---- petdex gallery: list available pets (for "add pet") ----
      disposers.push(webServer.register({
        kind: 'exact',
        path: AVAILABLE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') { json(res, 405, { error: 'use GET' }); return }
          try {
            const manifest = await fetchManifest()
            const installed = new Set(listPets().map((p) => p.slug))
            const pets = (manifest?.pets ?? [])
              .map((p) => ({
                slug: p.slug,
                displayName: p.displayName ?? p.slug,
                kind: p.kind ?? 'character',
                submittedBy: p.submittedBy ?? '',
                // browser-side sprite preview for gallery rows
                spritesheetUrl: typeof p.spritesheetUrl === 'string' ? p.spritesheetUrl : null,
              }))
              .filter((p) => !installed.has(p.slug))
            json(res, 200, { total: manifest?.total ?? pets.length, pets }, { 'cache-control': 'no-store' })
          } catch (error) {
            json(res, 502, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }))

      // ---- petdex gallery: install one pet ----
      disposers.push(webServer.register({
        kind: 'exact',
        path: INSTALL_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'use POST' }); return }
          let body = ''
          for await (const chunk of req) {
            body += chunk
            if (body.length > 512) { json(res, 413, { error: 'body too large' }); return }
          }
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { json(res, 400, { error: 'invalid JSON' }); return }
          const slug = typeof parsed?.slug === 'string' ? parsed.slug : null
          if (slug === null) { json(res, 400, { error: 'missing slug' }); return }
          try {
            const result = await installPet(slug)
            // installing a new pet switches to it
            persistConfig('pet', slug)
            broadcastEvent()
            json(res, 200, result, { 'cache-control': 'no-store' })
          } catch (error) {
            json(res, 502, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }))

      // ---- petdex gallery: same-origin sprite preview proxy ----
      // Browsers hotlinking assets.petdex.dev can be refused (referer/hotlink
      // protection), so thumbnails are fetched server-side and cached briefly.
      const previewCache = new Map() // slug → { at, body, type }
      const PREVIEW_TTL_MS = 15 * 60 * 1000
      const PREVIEW_MAX = 600
      disposers.push(webServer.register({
        kind: 'prefix',
        path: PREVIEW_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
          let pathname
          try {
            pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://dsh.internal').pathname)
          } catch { res.writeHead(400); res.end(); return }
          // /petdex-pet/preview/<slug>
          const slug = pathname.slice(PREVIEW_PATH.length + 1)
          const serve = (type, body) => {
            res.writeHead(200, {
              'content-type': type,
              'cache-control': 'public, max-age=900',
              'access-control-allow-origin': '*',
            })
            if (req.method === 'HEAD') { res.end(); return }
            res.end(body)
          }
          const cached = previewCache.get(slug)
          if (cached !== undefined && Date.now() - cached.at < PREVIEW_TTL_MS) {
            serve(cached.type, cached.body)
            return
          }
          if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) { res.writeHead(404); res.end(); return }
          let url = null
          try {
            const manifest = await fetchManifest()
            const entry = (manifest?.pets ?? []).find((p) => p.slug === slug)
            if (entry && typeof entry.spritesheetUrl === 'string' && entry.spritesheetUrl !== '') url = entry.spritesheetUrl
          } catch {}
          if (url === null) { res.writeHead(404); res.end(); return }
          let body
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 20000)
          try {
            const r = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-petdex-pet' } })
            if (!r.ok) { res.writeHead(502); res.end(); return }
            body = Buffer.from(await r.arrayBuffer())
          } catch {
            res.writeHead(502); res.end(); return
          } finally {
            clearTimeout(timer)
          }
          const type = /\.png$/i.test(url) ? 'image/png' : 'image/webp'
          if (previewCache.size >= PREVIEW_MAX) {
            const oldest = previewCache.keys().next().value
            if (oldest !== undefined) previewCache.delete(oldest)
          }
          previewCache.set(slug, { at: Date.now(), body, type })
          serve(type, body)
        },
      }))

      disposers.push(webServer.register({
        kind: 'prefix',
        path: ASSETS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
          let pathname
          try {
            pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://dsh.internal').pathname)
          } catch { res.writeHead(400); res.end(); return }
          // /petdex-pet/assets/<slug>/<file>
          const rest = pathname.slice(ASSETS_PATH.length + 1)
          const slash = rest.indexOf('/')
          if (slash <= 0) { res.writeHead(404); res.end(); return }
          const slug = rest.slice(0, slash)
          const file = rest.slice(slash + 1)
          const abs = resolveAsset(slug, file)
          if (abs === null) { res.writeHead(404); res.end(); return }
          try {
            const data = readFileSync(abs)
            res.writeHead(200, {
              'content-type': contentTypeFor(file),
              'cache-control': 'no-cache',
              'access-control-allow-origin': '*',
            })
            res.end(data)
          } catch { res.writeHead(404); res.end() }
        },
      }))

      disposers.push(webServer.register({
        kind: 'exact',
        path: EVENTS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          if (typeof res.flushHeaders === 'function') res.flushHeaders()
          res.write('retry: 3000\n\n')
          sseClients.add(res)
          let heartbeat = null
          if (typeof res.on === 'function') {
            res.on('close', () => {
              clearInterval(heartbeat)
              sseClients.delete(res)
            })
          }
          heartbeat = setInterval(() => {
            try { res.write(': ping\n\n') } catch { /* close cleans up */ }
          }, 25000)
        },
      }))
    }

    return () => {
      clearInterval(decayTimer)
      for (const dispose of disposers) dispose()
      for (const res of sseClients) { try { res.end() } catch {} }
      sseClients.clear()
    }
  }, 'dsh-petdex-pet: state/assets/events routes')
}

