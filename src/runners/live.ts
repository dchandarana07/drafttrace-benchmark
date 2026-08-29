/**
 * LIVE CLASSROOM RUNNER (API tier) — N simulated students writing a real quiz,
 * in real time, with human-like keystrokes, against a RUNNING system.
 *
 *   API=http://<host> ADMIN_TOKEN=<admin token> \
 *   npx tsx src/runners/live.ts --token <entryToken> --students 100 --minutes 3 \
 *       [--timescale 1] [--askai 0] [--offline 0.1] [--nosubmit 0.1] [--bots 0.05]
 *       [--skew 10] [--wait-sweeper] [--seed 1] [--out report.json]
 *   npx tsx src/runners/live.ts --recording bundle.json [--timescale 2]
 *
 * The system under test must implement the HTTP + ProseMirror-step protocol in
 * docs/PROTOCOL.md. Nothing here is specific to any one product: it speaks the
 * documented endpoints and checks the documented invariants.
 *
 * Each student is a composed writing session (src/compose: a human-typing
 * keystroke model under a writer layer with pauses, mid-text insertions,
 * deletions, rewrites) played back at wall-clock speed through an emulation of
 * a browser recorder: real ProseMirror transactions on the quiz's template
 * document, event batches every 2 s (or at 200 buffered), snapshots every 30 s
 * or 400 events, client_seq idempotency, a durable buffer that survives a
 * Wi-Fi outage and drains afterwards, an optional assistant exchange, a
 * deliberate non-submit for some (the server-side sweeper's job) and a manual
 * submit for the rest — followed by the checks that matter:
 *
 *   - every event batch acknowledged (sent == ingested + duplicates)
 *   - the SERVER's replayed document (GET /doc) equals the client's document
 *     text, exactly, for every student — the whole point of a recorder
 *   - submits succeed; exports contain the text; no 4xx/5xx anywhere
 *   - instructor list: eventCount == sent, lateEvents == 0, lateArrivals == 0
 *   - latency percentiles per phase, and assistant success rate
 *
 * Speeds are drawn per student (default 30-110 WPM) so fast typists produce
 * proportionally more text in the same minutes — the event rate scales with
 * real speed, not with a fixed script.
 *
 * --recording replays a bundle of REAL recorded sessions at their original
 * timing instead of synthetic writers (docs/RECORDING_FORMAT.md). No such
 * bundle ships with this repository.
 */
import { EditorState, type Transaction } from '@tiptap/pm/state'
import { Step } from '@tiptap/pm/transform'
import { readFileSync } from 'node:fs'
import { Node as PMNode } from '@tiptap/pm/model'
import { compose, type Op } from '../compose'
import { schema } from '../replay'
import { rng, uniform, type ModelName } from '../models'
import { templateDoc } from '../replay/quizTemplate'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d }
const API = flag('api') ?? process.env.API ?? 'http://localhost:3001'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ''
const TOKEN = flag('token')
const STUDENTS = Number(flag('students', '50'))
const MINUTES = Number(flag('minutes', '3'))
const TIMESCALE = Number(flag('timescale', '1'))
const ASKAI = Number(flag('askai', '0'))
const OFFLINE = Number(flag('offline', '0.1'))
const NOSUBMIT = Number(flag('nosubmit', '0.1'))
const BOTS = Number(flag('bots', '0.05'))
const SEED = Number(flag('seed', '1'))
const OUT = flag('out')
// Clock skew: each student's browser clock is offset by a fixed amount drawn
// from ±SKEW minutes — the late-event / receipt-time machinery only exists
// for wrong clocks, and a runner on the server's own clock never tests it.
const SKEW_MIN = Number(flag('skew', '0'))
// Wait for the sweeper to seal every non-submitter (deadline + 15 min ingest
// grace + a sweep) and verify metrics — the only way to prove that path.
const WAIT_SWEEPER = args.includes('--wait-sweeper')
// --recording file.json: replay REAL recorded students at their original
// timing instead of synthetic writers (docs/RECORDING_FORMAT.md). The runner
// recreates a quiz from the bundle's questions (needs ADMIN_TOKEN) so every
// step lands at the position it was recorded at.
const RECORDING = flag('recording')
type Recorded = { id: string; submitted: boolean; durationMs: number; base?: unknown; events: Array<{ t: number; source: string; delta: number; steps: unknown[]; pastedTextLen?: number }> }
type RecordingBundle = { quiz: { title: string; questions: Array<{ prompt: string }>; timeLimitMin: number | null; wordTarget: number | null }; students: Recorded[] }
const recording: RecordingBundle | null = RECORDING ? (JSON.parse(readFileSync(RECORDING, 'utf8')) as RecordingBundle) : null
let TOKEN_EFFECTIVE = TOKEN
if (!TOKEN && !args.includes('--recording')) { console.error('usage: live.ts --token <entryToken> [--students N] [--minutes M] ... | --recording file.json'); process.exit(2) }

const FLUSH_MS = 2000, FLUSH_AT = 200, MAX_PER_POST = 500, SNAPSHOT_MS = 30_000, SNAPSHOT_EVERY = 400
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── http client with cookie jar + latency samples ──────────────────────────
type Sample = { kind: string; ms: number; status: number }
const samples: Sample[] = []
function client() {
  const jar = new Map<string, string>()
  return async (path: string, init: { method?: string; body?: string; kind?: string; raw?: boolean } = {}) => {
    const t0 = performance.now()
    let status = -1
    try {
      const res = await fetch(API + path, {
        method: init.method ?? 'GET', redirect: 'manual', body: init.body,
        headers: { 'content-type': 'application/json', ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
      })
      status = res.status
      for (const c of res.headers.getSetCookie?.() ?? []) { const p = c.split(';')[0]; const i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i), p.slice(i + 1)) }
      if (init.raw) { samples.push({ kind: init.kind ?? path, ms: performance.now() - t0, status }); return { status, res } }
      const txt = await res.text()
      samples.push({ kind: init.kind ?? path, ms: performance.now() - t0, status })
      let json: unknown = null; try { json = JSON.parse(txt) } catch { json = txt }
      return { status, json: json as Record<string, unknown> & string }
    } catch {
      samples.push({ kind: init.kind ?? path, ms: performance.now() - t0, status: -1 })
      return { status: -1, json: null as unknown as Record<string, unknown> & string }
    }
  }
}

// ── the student's editor: template doc + ops applied at real positions ─────
class LiveDoc {
  state: EditorState
  constructor(questions: Array<{ prompt: string }>, base?: unknown) {
    const doc = PMNode.fromJSON(schema, (base as Record<string, unknown> | undefined) ?? templateDoc(questions))
    this.state = EditorState.create({ schema, doc })
  }
  /** Composition paragraph i lives at top-level node 1 + i (node 0 is the
   *  Question 1 block; answer paragraphs are inserted after it in order). */
  private pos(para: number, at: number) {
    const node = 1 + para
    let p = 0
    for (let i = 0; i < node; i++) p += this.state.doc.child(i).nodeSize
    return p + 1 + at
  }
  applyStepJson(stepJson: unknown): { tr: Transaction; delta: number } | null {
    let step: Step
    try { step = Step.fromJSON(schema, stepJson as Record<string, unknown>) } catch { return null }
    let tr: Transaction
    try { tr = this.state.tr.step(step) } catch { return null }
    const before = this.state.doc.nodeSize
    this.state = this.state.apply(tr)
    return { tr, delta: this.state.doc.nodeSize - before }
  }
  apply(op: Op): { tr: Transaction; delta: number } {
    let tr: Transaction
    if (op.op === 'insert') tr = this.state.tr.insertText(op.text, this.pos(op.para, op.at))
    else if (op.op === 'delete') tr = this.state.tr.delete(this.pos(op.para, op.from), this.pos(op.para, op.to))
    else tr = this.state.tr.split(this.pos(op.para, op.at))
    const before = this.state.doc.nodeSize
    this.state = this.state.apply(tr)
    return { tr, delta: this.state.doc.nodeSize - before }
  }
  text() { return this.state.doc.textBetween(0, this.state.doc.content.size, '\n') }
  json() { return this.state.doc.toJSON() }
}

type StudentReport = {
  i: number; name: string; model: string; wpm: number; sid?: string
  opsPlanned: number; opsPlayed: number; sent: number; acked: number; duplicates: number; batches: number
  snapshots: number; offline: boolean; askai?: 'ok' | 'fail' | 'skipped'; askaiMs?: number; skewMs?: number; hitDeadline?: boolean
  submitted: boolean; wantedSubmit: boolean; docMatch?: boolean; exportOk?: boolean
  errors: string[]; finalWords: number
}

const FIRST = ['Alex', 'Sam', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Avery', 'Quinn', 'Dana', 'Reese', 'Priya', 'Wei', 'Amara', 'Diego', 'Noor', 'Yuki']
const LAST = ['Nguyen', 'Patel', 'Garcia', 'Kim', 'Okafor', 'Smith', 'Chen', 'Lopez', 'Haddad', 'Ivanov', 'Silva', 'Brown', 'Tanaka', 'Meyer']

async function student(i: number, questions: Array<{ prompt: string }>, r: () => number): Promise<StudentReport> {
  const call = client()
  const rec = recording ? recording.students[i % recording.students.length] : null
  const isBot = !rec && r() < BOTS
  const model: ModelName = rec ? 'markov' : isBot ? 'robotic' : r() < 0.65 ? 'markov' : r() < 0.8 ? 'personality' : 'profile:nervous'
  // speed: mostly 30–80, a fast tail up to 110 (the founder types ~100)
  const wpm = rec ? Math.round((rec.events.length / 5) / Math.max(1, rec.durationMs / 60_000)) : Math.round(r() < 0.15 ? uniform(r, 85, 110) : uniform(r, 30, 80))
  const words = Math.max(60, Math.round(wpm * MINUTES * 0.75))
  // Synthetic writer, or the recorded student's own event stream as a list of
  // step-ops at their original relative timing.
  const comp = rec
    ? { ops: rec.events.map((e) => ({ t: 1000 + e.t, op: 'step' as const, para: 0, at: 0, steps: e.steps, source: e.source, pastedTextLen: e.pastedTextLen })), label: rec.id, truth: null }
    : compose({ model, words, wpm, seed: SEED * 1000 + i, revising: uniform(r, 0.3, 0.9) })
  const name = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]} ${i}`
  const rep: StudentReport = { i, name: rec ? `${rec.id} replay ${i}` : name, model: rec ? `recording:${rec.id}` : model, wpm, opsPlanned: comp.ops.length, opsPlayed: 0, sent: 0, acked: 0, duplicates: 0, batches: 0, snapshots: 0, offline: r() < OFFLINE, submitted: false, wantedSubmit: r() >= NOSUBMIT, errors: [], finalWords: 0 }

  // stagger arrival over the first 20 s, like a class opening a link
  await sleep(uniform(r, 0, 20_000) / TIMESCALE)
  const enter = await call(`/api/quiz/${TOKEN_EFFECTIVE}/enter`, { method: 'POST', body: '{}', kind: 'enter' })
  if (enter.status !== 200) { rep.errors.push(`enter ${enter.status}`); return rep }
  const started = await call(`/api/quiz/${TOKEN_EFFECTIVE}/start`, { method: 'POST', body: JSON.stringify({ name }), kind: 'start' })
  const sid = (started.json?.session as { id?: string } | undefined)?.id
  if (!sid) { rep.errors.push(`start ${started.status}`); return rep }
  rep.sid = sid
  // The real page locks the editor at the server deadline (corrected for its
  // own clock via serverNow). Students who reach it stop typing; the ones who
  // "press Submit" auto-submit at the bell, the rest are the sweeper's.
  const deadlineAtMs = Date.parse(String((started.json?.session as { deadlineAt?: string } | undefined)?.deadlineAt ?? '')) || Infinity
  const clockSkewMs = SKEW_MIN ? Math.round(uniform(r, -SKEW_MIN, SKEW_MIN) * 60_000) : 0
  rep.skewMs = clockSkewMs

  const doc = new LiveDoc(questions, rec?.base ?? undefined)
  if (rec?.base) {
    // Make the server's replay start from the same document the recording
    // did: a snapshot older than every event (but newer than the quiz's own
    // 24 h-backdated anchor) becomes the replay base.
    await call(`/api/sessions/${sid}/snapshots`, { method: 'POST', body: JSON.stringify({ ts: Date.now() - 3_600_000, content: rec.base }), kind: 'snapshot' })
  }
  const seqBase = Math.floor(r() * 2 ** 40)
  let seq = 0
  type Ev = { ts: number; source: string; delta: number; steps: unknown[]; clientSeq: number; pastedTextLen?: number }
  const buffer: Ev[] = []
  let flushing = false
  let online = true
  let eventsSinceSnap = 0
  let dead = false

  const flush = async () => {
    if (flushing || dead || !online || buffer.length === 0) return
    flushing = true
    try {
      while (buffer.length > 0 && online && !dead) {
        const chunk = buffer.slice(0, MAX_PER_POST)
        const res = await call(`/api/sessions/${sid}/events`, { method: 'POST', body: JSON.stringify({ events: chunk }), kind: 'ingest' })
        if (res.status === 200) {
          rep.acked += Number(res.json?.ingested ?? 0)
          rep.duplicates += Number(res.json?.duplicates ?? 0)
          rep.batches += 1
          buffer.splice(0, chunk.length)
        } else if (res.status === 403 || res.status === 404 || res.status === 409) {
          rep.errors.push(`ingest terminal ${res.status}`); dead = true
        } else {
          rep.errors.push(`ingest ${res.status} (retry)`); break // network / 5xx: keep buffer, retry next tick
        }
      }
    } finally { flushing = false }
  }
  const snapshot = async () => {
    if (dead || !online) return
    const res = await call(`/api/sessions/${sid}/snapshots`, { method: 'POST', body: JSON.stringify({ ts: Date.now() + clockSkewMs, content: doc.json() }), kind: 'snapshot' })
    if (res.status === 200) rep.snapshots += 1
    else rep.errors.push(`snapshot ${res.status}`)
    eventsSinceSnap = 0
  }

  const flushTimer = setInterval(() => void flush(), FLUSH_MS / TIMESCALE)
  const snapTimer = setInterval(() => { if (eventsSinceSnap > 0) void snapshot() }, SNAPSHOT_MS / TIMESCALE)

  // Wi-Fi outage window for the unlucky: 25–45 s somewhere in the middle
  const offAt = rep.offline ? uniform(r, 0.3, 0.6) * MINUTES * 60_000 : Infinity
  const offFor = uniform(r, 25_000, 45_000)
  // Ask AI moment for some students
  const askAt = r() < ASKAI ? uniform(r, 0.2, 0.7) * MINUTES * 60_000 : Infinity
  let asked = false

  const t0 = performance.now()
  const deadlineMs = MINUTES * 60_000
  let played = 0
  let lastOpT = comp.ops[0]?.t ?? 0
  for (const op of comp.ops) {
    const wait = (op.t - lastOpT) / TIMESCALE
    lastOpT = op.t
    if (wait > 0) await sleep(wait)
    const elapsed = (performance.now() - t0) * TIMESCALE
    if (elapsed >= deadlineMs) break
    if (Date.now() >= deadlineAtMs) { rep.hitDeadline = true; break }
    if (!asked && elapsed >= askAt) {
      asked = true
      void (async () => {
        const ta = performance.now()
        const { status, res } = await call('/api/chat', { method: 'POST', kind: 'askai', raw: true, body: JSON.stringify({ sessionId: sid, messages: [{ role: 'user', content: 'What is this question actually asking?' }], docContent: doc.text().slice(0, 2000) }) })
        if (status === 200 && res) {
          try { await res.text(); rep.askai = 'ok' } catch { rep.askai = 'fail' }
        } else rep.askai = 'fail'
        rep.askaiMs = Math.round(performance.now() - ta)
        // A failed ask FAILS the run: the harness must never report PASS on a
        // dead assistant (it did once — 29/29 failures behind a green light).
        if (rep.askai === 'fail') rep.errors.push(`askai ${status} after ${rep.askaiMs} ms`)
      })()
    }
    if (online && elapsed >= offAt) { online = false; setTimeout(() => { online = true; void flush() }, offFor / TIMESCALE) }
    const opAny = op as unknown as { op: string; steps?: unknown[]; source?: string; pastedTextLen?: number }
    let applied: { tr: Transaction; delta: number } | null
    if (opAny.op === 'step') {
      // recorded event: replay its steps verbatim (positions were recorded
      // against the same template), keeping its source label
      const trs = (opAny.steps ?? []).map((sj) => doc.applyStepJson(sj)).filter((x): x is { tr: Transaction; delta: number } => !!x)
      if (!trs.length) continue
      applied = { tr: trs[trs.length - 1].tr, delta: trs.reduce((s, x) => s + x.delta, 0) }
      buffer.push({ ts: Date.now() + clockSkewMs, source: opAny.source ?? 'input', delta: applied.delta, steps: trs.flatMap((x) => x.tr.steps.map((s) => s.toJSON())), clientSeq: seqBase + seq++, ...(opAny.pastedTextLen != null ? { pastedTextLen: opAny.pastedTextLen } : {}) } as Ev)
    } else {
      const { tr, delta } = doc.apply(op as Op)
      buffer.push({ ts: Date.now() + clockSkewMs, source: 'input', delta, steps: tr.steps.map((s) => s.toJSON()), clientSeq: seqBase + seq++ })
    }
    rep.sent += 1
    played += 1
    eventsSinceSnap += 1
    if (buffer.length >= FLUSH_AT) void flush()
    if (eventsSinceSnap >= SNAPSHOT_EVERY) void snapshot()
  }
  rep.opsPlayed = played
  if (rec) rep.errors.push(...(comp.ops.length && played === 0 ? ['no recorded ops played'] : []))
  clearInterval(flushTimer); clearInterval(snapTimer)
  if (rep.askai === undefined) rep.askai = 'skipped'

  // drain (wait out an outage if one is running), like the quiz page's finish()
  for (let a = 0; a < 60 && buffer.length > 0 && !dead; a++) { await flush(); if (buffer.length > 0) await sleep(1500 / TIMESCALE) }
  if (buffer.length > 0) rep.errors.push(`undrained ${buffer.length} events`)
  await snapshot()

  // the server's replay must equal this editor, exactly
  const d = await call(`/api/sessions/${sid}/doc`, { kind: 'doc' })
  const serverText = (d.json as { plainText?: string } | null)?.plainText
  rep.docMatch = serverText === doc.text()
  if (!rep.docMatch) rep.errors.push(`server replay differs (server ${serverText?.length ?? 'n/a'} chars vs client ${doc.text().length})`)
  rep.finalWords = doc.text().split(/\s+/).filter(Boolean).length

  if (rep.wantedSubmit) {
    const sub = await call(`/api/sessions/${sid}/submit`, { method: 'POST', body: JSON.stringify({ content: doc.json(), plainText: doc.text() }), kind: 'submit' })
    rep.submitted = sub.status === 200
    if (!rep.submitted) rep.errors.push(`submit ${sub.status}`)
    const exp = await call(`/api/sessions/${sid}/export?format=txt`, { kind: 'export' })
    rep.exportOk = exp.status === 200 && typeof exp.json === 'string' && exp.json.includes(doc.text().slice(-40))
    if (!rep.exportOk) rep.errors.push('export missing the document tail')
  }
  return rep
}

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }

async function main() {
  const r = rng(SEED)
  console.log(`live classroom → ${API}  students=${STUDENTS} minutes=${MINUTES} timescale=${TIMESCALE} askai=${ASKAI} offline=${OFFLINE} nosubmit=${NOSUBMIT} bots=${BOTS}${recording ? ` recording=${RECORDING} (${recording.students.length} recorded students)` : ''}`)
  if (recording) {
    // recreate the recorded quiz so every step's position is valid
    if (!ADMIN_TOKEN) { console.error('--recording needs ADMIN_TOKEN to recreate the quiz'); process.exit(2) }
    const admin = client()
    await admin(`/api/auth/admin-login?token=${encodeURIComponent(ADMIN_TOKEN)}`, { kind: 'admin' })
    const created = await admin('/api/instructor/assignments', { method: 'POST', kind: 'create', body: JSON.stringify({ title: `Replay — ${recording.quiz.title}`, mode: 'quiz', timeLimitMin: recording.quiz.timeLimitMin ?? 15, wordTarget: recording.quiz.wordTarget ?? 300, blind: true, published: true, questions: recording.quiz.questions }) })
    const tok = (created.json?.assignment as { entryToken?: string } | undefined)?.entryToken
    if (!tok) { console.error('could not recreate the quiz:', created.status, JSON.stringify(created.json).slice(0, 200)); process.exit(1) }
    TOKEN_EFFECTIVE = tok
    console.log(`recreated quiz "${recording.quiz.title}" as token ${tok}`)
  }
  const info = await client()(`/api/quiz/${TOKEN_EFFECTIVE}`, { kind: 'quiz' })
  const quiz = info.json?.quiz as { questions?: Array<{ prompt: string }>; state?: string; timeLimitMin?: number } | undefined
  if (!quiz?.questions) { console.error('quiz not open / no questions:', info.status, JSON.stringify(info.json).slice(0, 200)); process.exit(1) }
  console.log(`quiz open, ${quiz.questions.length} questions, ${quiz.timeLimitMin} min limit\n`)

  const t0 = performance.now()
  const reports = await Promise.all(Array.from({ length: STUDENTS }, (_, i) => student(i, quiz.questions!, rng(SEED * 7919 + i))))
  const wall = (performance.now() - t0) / 1000

  // ── report ──
  console.log('latency by phase (ms)')
  console.log('  phase      n     p50    p95    p99    max  err')
  const kinds = ['enter', 'start', 'ingest', 'snapshot', 'askai', 'doc', 'submit', 'export']
  for (const k of kinds) {
    const s = samples.filter((x) => x.kind === k); if (!s.length) continue
    const ms = s.map((x) => x.ms)
    console.log(`  ${k.padEnd(8)} ${String(s.length).padStart(5)}  ${pct(ms, 50).toFixed(0).padStart(6)} ${pct(ms, 95).toFixed(0).padStart(6)} ${pct(ms, 99).toFixed(0).padStart(6)} ${Math.max(...ms).toFixed(0).padStart(6)} ${String(s.filter((x) => x.status < 0 || x.status >= 400).length).padStart(4)}`)
  }
  const totalSent = reports.reduce((s, x) => s + x.sent, 0)
  const totalAcked = reports.reduce((s, x) => s + x.acked + x.duplicates, 0)
  const withErrors = reports.filter((x) => x.errors.length)
  const docMismatch = reports.filter((x) => x.sid && x.docMatch === false)
  const wanted = reports.filter((x) => x.wantedSubmit)
  const submitted = wanted.filter((x) => x.submitted)
  const asked = reports.filter((x) => x.askai && x.askai !== 'skipped')
  const askOk = asked.filter((x) => x.askai === 'ok')
  const offline = reports.filter((x) => x.offline)
  console.log(`\nwall ${wall.toFixed(0)}s · students ${reports.length} · words written ${reports.reduce((s, x) => s + x.finalWords, 0)} · wpm range ${Math.min(...reports.map((x) => x.wpm))}–${Math.max(...reports.map((x) => x.wpm))}`)
  console.log(`events sent ${totalSent} · acknowledged ${totalAcked} (${totalAcked === totalSent ? 'ALL' : 'MISSING ' + (totalSent - totalAcked)}) · batches ${reports.reduce((s, x) => s + x.batches, 0)} · snapshots ${reports.reduce((s, x) => s + x.snapshots, 0)}`)
  const withSid = reports.filter((x) => x.sid)
  console.log(`server replay == client doc: ${withSid.filter((x) => x.docMatch === true).length}/${withSid.length}`)
  console.log(`submitted ${submitted.length}/${wanted.length} wanted · left for the sweeper ${reports.length - wanted.length} · offline-outage students ${offline.length} (all drained: ${offline.every((x) => !x.errors.some((e) => e.startsWith('undrained')))})`)
  console.log(`Ask AI: ${askOk.length}/${asked.length} ok` + (asked.length ? ` (p50 ${pct(asked.map((x) => x.askaiMs ?? 0), 50).toFixed(0)} ms, max ${Math.max(...asked.map((x) => x.askaiMs ?? 0))} ms)` : ''))
  const byModel = new Map<string, number>(); for (const x of reports) byModel.set(x.model, (byModel.get(x.model) ?? 0) + 1)
  console.log(`models: ${[...byModel].map(([k, v]) => `${k}×${v}`).join(', ')}`)
  if (withErrors.length) { console.log(`\nstudents with errors: ${withErrors.length}`); for (const x of withErrors.slice(0, 12)) console.log(`  #${x.i} ${x.name} (${x.model}@${x.wpm}): ${x.errors.join('; ')}`) }

  // instructor-side verification (needs ADMIN_TOKEN on the target)
  let listOk: string | null = null
  if (ADMIN_TOKEN) {
    const admin = client()
    await admin(`/api/auth/admin-login?token=${encodeURIComponent(ADMIN_TOKEN)}`, { kind: 'admin' })
    // wait for the metrics queue to drain
    for (let a = 0; a < 60; a++) {
      const rd = await admin('/api/readiness', { kind: 'readiness' })
      const m = (rd.json as { metrics?: { queued: number; active: number } } | null)?.metrics
      if (m && m.queued === 0 && m.active === 0) break
      await sleep(2000)
    }
    const list = await admin('/api/instructor/sessions', { kind: 'list' })
    const sessions = ((list.json as { sessions?: Array<Record<string, unknown>> } | null)?.sessions ?? [])
    const bySid = new Map(sessions.map((s) => [s.id as string, s]))
    // With skewed clocks, students whose clock runs AHEAD stamp events after
    // the deadline they were still allowed to type up to — expected, and
    // exactly what the instructor list must show. Anything else is a bug.
    const expectLateStamped = new Set(reports.filter((x) => x.sid && x.hitDeadline && (x.skewMs ?? 0) > 0).map((x) => x.sid))
    let countMismatch = 0, late = 0, lateArr = 0, noMetrics = 0
    for (const x of reports) {
      if (!x.sid) continue
      const s = bySid.get(x.sid)
      if (!s) { countMismatch++; continue }
      if (Number(s.eventCount) !== x.sent) countMismatch++
      if (Number(s.lateEvents) > 0 && !expectLateStamped.has(x.sid)) late++
      if (Number(s.lateArrivals) > 0) lateArr++
      if (x.submitted && !s.categoryWords) noMetrics++
    }
    listOk = `instructor list: eventCount==sent for ${reports.filter((x) => x.sid).length - countMismatch}/${reports.filter((x) => x.sid).length} · late-stamped ${late} · late-arrived ${lateArr} · submitted without metrics ${noMetrics}`
    console.log(listOk)
  } else console.log('(set ADMIN_TOKEN to verify the instructor list)')

  // Sweeper proof: every non-submitter must end up sealed with metrics.
  let sweeperOk: boolean | null = null
  if (WAIT_SWEEPER && ADMIN_TOKEN) {
    const admin = client()
    await admin(`/api/auth/admin-login?token=${encodeURIComponent(ADMIN_TOKEN)}`, { kind: 'admin' })
    const pendingSids = new Set(reports.filter((x) => x.sid && !x.submitted).map((x) => x.sid!))
    console.log(`\nwaiting for the sweeper to seal ${pendingSids.size} unsubmitted session(s) (deadline + 15 min grace)…`)
    const until = Date.now() + 25 * 60_000
    while (Date.now() < until && pendingSids.size) {
      await sleep(30_000)
      const list = await admin('/api/instructor/sessions', { kind: 'list' })
      const rows = ((list.json as { sessions?: Array<Record<string, unknown>> } | null)?.sessions ?? [])
      for (const s of rows) if (pendingSids.has(s.id as string) && s.submittedAt && s.autoSubmitted && s.categoryWords) pendingSids.delete(s.id as string)
      console.log(`  ${pendingSids.size} still open`)
    }
    sweeperOk = pendingSids.size === 0
    console.log(sweeperOk ? 'sweeper sealed every non-submitter with metrics' : `sweeper FAILED to seal ${pendingSids.size} session(s) in time`)
  }
  const pass = totalAcked === totalSent && docMismatch.length === 0 && submitted.length === wanted.length && withErrors.length === 0 && askOk.length === asked.length && sweeperOk !== false && (!ADMIN_TOKEN || /eventCount==sent for (\d+)\/\1 · late-stamped 0 · late-arrived 0 · submitted without metrics 0/.test(listOk ?? ''))
  console.log(pass ? '\nPASS — every expectation held' : '\nFAIL — see above')
  if (OUT) writeFileSync(OUT, JSON.stringify({ api: API, students: STUDENTS, minutes: MINUTES, wall, reports, samples }, null, 1))
  process.exit(pass ? 0 : 1)
}
main()
