/**
 * REAL-BROWSER CLASSROOM RUNNER — N students in N real Chrome contexts,
 * driving an actual quiz page with real keyboard events, against a running
 * system.
 *
 *   API=http://<host> npx tsx src/runners/browser.ts \
 *     --token <entryToken> --students 30 --minutes 3 [--headless 1] [--channel chrome]
 *     [--offline 0.1] [--background 0.2] [--reopen 0.1] [--skew 10] [--slow 0.2]
 *     [--wifi hall|none] [--askai 0] [--nosubmit 0.1] [--loss 0.02]
 *     [--stagger 20] [--ui my-ui-profile.json] [--seed 1] [--out report.json]
 *     [--browsers 4]   contexts are spread over this many Chrome processes
 *
 * Where src/runners/live.ts emulates a recorder over HTTP, this one goes
 * through everything a student's laptop goes through: the cold page load, the
 * front-end framework, the editor's own keyboard handling, the recorder's
 * offline queue, beacons on hide/unload, a background tab, a closed-and-
 * reopened tab, a wrong system clock, a slow machine, lecture-hall Wi-Fi.
 * Every keystroke is a real key event timed by the human-typing models
 * (src/models via src/compose).
 *
 * Page selectors are NOT hard-coded: they live in src/runners/ui-profile.ts
 * and can be replaced with `--ui profile.json` for another system's UI. The
 * network contract it checks is the one in docs/PROTOCOL.md.
 *
 * Expectations checked per student: the page reached the editor; every
 * /events POST the browser made was acknowledged (read from the browser's own
 * network log); the server's replayed document (GET /doc) equals the editor's
 * text at submit time; submit reached the done screen; no console errors.
 * Aggregates: latency percentiles of the browser's own requests, cold-load
 * time, per-scenario pass/fail.
 *
 * KNOWN LIMITS of this tier — state them in any write-up:
 *   - the tab-hidden scenario is a SHIM (Chrome's real background timer
 *     throttling cannot be induced through CDP); it exercises the app's
 *     visibilitychange/beacon path only;
 *   - request loss is injected at the Playwright route level, not on a real
 *     network;
 *   - every context shares one machine, one NIC and one IP, so this is not a
 *     test of a real access point;
 *   - the client box becomes the bottleneck well before the server does; cold
 *     load times above ~30 real browsers describe the CLIENT, not the system
 *     under test.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { writeFileSync } from 'node:fs'
import { compose, type Op } from '../compose'
import { rng, uniform, type ModelName } from '../models'
import { loadUiProfile, name as uiName } from './ui-profile'

const args = process.argv.slice(2)
const flag = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d }
const API = flag('api') ?? process.env.API ?? 'http://localhost:8088'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ''
const TOKEN = flag('token')
const STUDENTS = Number(flag('students', '10'))
const MINUTES = Number(flag('minutes', '3'))
const HEADLESS = flag('headless', '1') !== '0'
const CHANNEL = flag('channel', 'chrome')
const OFFLINE = Number(flag('offline', '0.1'))
const BACKGROUND = Number(flag('background', '0.2'))
const REOPEN = Number(flag('reopen', '0.1'))
const SKEW_MIN = Number(flag('skew', '0'))
const SLOW = Number(flag('slow', '0.2'))
const WIFI = flag('wifi', 'hall')
const ASKAI = Number(flag('askai', '0'))
const UI = loadUiProfile(flag('ui'))
const quizUrl = () => `${API}${UI.quizPath.replace('{token}', String(TOKEN))}`
const NOSUBMIT = Number(flag('nosubmit', '0.1'))
const SEED = Number(flag('seed', '1'))
const BROWSERS = Number(flag('browsers', '4'))
// Arrival window in seconds: 20 = a class trickling in; 2 = the thundering
// herd (everyone scans the QR at once) — the case the API tier never ran.
const STAGGER_S = Number(flag('stagger', '20'))
// Random request loss on /api (CDP's packetLoss only affects WebRTC).
const LOSS = Number(flag('loss', '0'))
const SHOTS = flag('shots', '')
const MODELS = flag('models', 'markov')
const OUT = flag('out')
// When the assistant provider is known to be out of quota, a failed ask is
// expected and must not mask everything else; default strict.
const ALLOW_ASKAI_FAIL = args.includes('--allow-askai-fail')
if (!TOKEN) { console.error('usage: browser.ts --token <entryToken> [--students N] [--minutes M] …'); process.exit(2) }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

type Report = {
  i: number; name: string; model: string; wpm: number; sid?: string
  coldLoadMs?: number; reachedEditor: boolean; keysTyped: number
  eventPosts: number; eventPostsOk: number; eventPostsFailed: number
  scenarios: string[]; askai?: 'ok' | 'fail' | 'skipped'
  submitted: boolean; wantedSubmit: boolean; docMatch?: boolean; consoleErrors: string[]
  errors: string[]; latencies: number[]
}

const FIRST = ['Alex', 'Sam', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Avery', 'Quinn', 'Dana', 'Reese', 'Priya', 'Wei', 'Amara', 'Diego', 'Noor', 'Yuki']
const LAST = ['Nguyen', 'Patel', 'Garcia', 'Kim', 'Okafor', 'Smith', 'Chen', 'Lopez', 'Haddad', 'Ivanov', 'Silva', 'Brown', 'Tanaka', 'Meyer']

/** Convert the composer's positioned ops into keyboard actions relative to
 *  a caret the student moves with arrow keys — what a person actually does. */
type KeyAction = { t: number; kind: 'type'; text: string } | { t: number; kind: 'key'; key: string; times?: number }
function opsToKeys(ops: Op[]): KeyAction[] {
  const out: KeyAction[] = []
  let para = 0, at = 0
  const paraLens: number[] = [0]
  const moveTo = (p: number, a: number, t: number) => {
    if (p === para && a === at) return
    if (p !== para) {
      // paragraphs: End/Home + Down/Up keeps this simple and deterministic
      const dir = p > para ? 'ArrowDown' : 'ArrowUp'
      out.push({ t, kind: 'key', key: p > para ? 'End' : 'Home' })
      out.push({ t, kind: 'key', key: dir, times: Math.abs(p - para) })
      out.push({ t, kind: 'key', key: 'Home' })
      para = p; at = 0
    }
    if (a !== at) {
      out.push({ t, kind: 'key', key: a > at ? 'ArrowRight' : 'ArrowLeft', times: Math.abs(a - at) })
      at = a
    }
  }
  for (const op of ops) {
    if (op.op === 'insert') {
      moveTo(op.para, op.at, op.t)
      out.push({ t: op.t, kind: 'type', text: op.text })
      at += op.text.length
      paraLens[para] += op.text.length
    } else if (op.op === 'delete') {
      const n = op.to - op.from
      moveTo(op.para, op.to, op.t)
      out.push({ t: op.t, kind: 'key', key: 'Backspace', times: n })
      at -= n
      paraLens[para] -= n
    } else {
      moveTo(op.para, op.at, op.t)
      out.push({ t: op.t, kind: 'key', key: 'Enter' })
      const tail = paraLens[para] - at
      paraLens[para] = at
      paraLens.splice(para + 1, 0, tail)
      para += 1; at = 0
    }
  }
  return out
}

async function student(i: number, browser: Browser, r: () => number): Promise<Report> {
  // --models markov (default: the most human-like of the three ports) or 'mix'.
  const model: ModelName = MODELS === 'mix' ? (r() < 0.65 ? 'markov' : r() < 0.85 ? 'personality' : 'profile:nervous') : (MODELS as ModelName)
  const wpm = Math.round(r() < 0.15 ? uniform(r, 85, 110) : uniform(r, 30, 80))
  const words = Math.max(60, Math.round(wpm * MINUTES * 0.6))
  const comp = compose({ model, words, wpm, seed: SEED * 1000 + i, revising: uniform(r, 0.3, 0.8) })
  const keys = opsToKeys(comp.ops)
  const name = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]} B${i}`
  const rep: Report = { i, name, model, wpm, reachedEditor: false, keysTyped: 0, eventPosts: 0, eventPostsOk: 0, eventPostsFailed: 0, scenarios: [], submitted: false, wantedSubmit: r() >= NOSUBMIT, consoleErrors: [], errors: [], latencies: [] }
  const skewMs = SKEW_MIN ? Math.round(uniform(r, -SKEW_MIN, SKEW_MIN) * 60_000) : 0
  if (skewMs) rep.scenarios.push(`skew ${Math.round(skewMs / 60000)}m`)
  const doOffline = r() < OFFLINE, doBackground = r() < BACKGROUND, doReopen = r() < REOPEN, doSlow = r() < SLOW, doAsk = UI.assistantOpenButton !== '' && r() < ASKAI
  if (doOffline) rep.scenarios.push('offline'); if (doBackground) rep.scenarios.push('background'); if (doReopen) rep.scenarios.push('reopen'); if (doSlow) rep.scenarios.push('slow-cpu'); if (doAsk) rep.scenarios.push('askai')

  let context: BrowserContext | null = null
  let closed = false
  try {
    context = await browser.newContext({ viewport: { width: 1366, height: 800 }, ignoreHTTPSErrors: true })
    if (skewMs) {
      await context.addInitScript(`(() => { const off = ${skewMs}; const _now = Date.now; Date.now = () => _now() + off; const _D = Date; const P = new Proxy(_D, { construct(t, a) { return a.length === 0 ? new _D(_now() + off) : new _D(...a) } }); Object.setPrototypeOf(P, _D); window.Date = P; })()`)
    }
    // Tab-hidden shim: Chrome's real background throttling cannot be induced
    // through CDP (bringToFront leaves visibilityState 'visible'); this flips
    // document.hidden/visibilityState and fires visibilitychange, which is
    // the app's code path (beacon flush on hide). It does NOT reproduce the
    // scheduler's timer throttling — say so in any write-up.
    await context.addInitScript(`(() => { let hidden = false; Object.defineProperty(Document.prototype, 'hidden', { get: () => hidden, configurable: true }); Object.defineProperty(Document.prototype, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible'), configurable: true }); window.__simHide = (h) => { hidden = !!h; document.dispatchEvent(new Event('visibilitychange')) } })()`)
    if (LOSS > 0) {
      await context.route('**/api/**', (route) => (Math.random() < LOSS ? route.abort('connectionreset') : route.continue()))
    }
    let page: Page = await context.newPage()
    const wire = (p: Page) => {
      p.on('console', (m) => {
        // Messages matching the UI profile's ignoreConsoleRegex are expected noise.
        if (m.type() === 'error' && !(UI.ignoreConsoleRegex && new RegExp(UI.ignoreConsoleRegex).test(m.text()))) rep.consoleErrors.push(m.text().slice(0, 200))
      })
      const started = new WeakMap<object, number>()
      p.on('request', (req) => { if (/\/api\/sessions\/[^/]+\/events$/.test(req.url()) && req.method() === 'POST') started.set(req, performance.now()) })
      p.on('response', (res) => {
        const u = res.url()
        if (/\/api\/sessions\/[^/]+\/events$/.test(u) && res.request().method() === 'POST') {
          rep.eventPosts++
          if (res.status() === 200) rep.eventPostsOk++; else rep.eventPostsFailed++
          const t0 = started.get(res.request())
          if (t0) rep.latencies.push(performance.now() - t0)
        }
      })
      p.on('requestfailed', (req) => { if (/\/api\/sessions\/[^/]+\/events$/.test(req.url())) { rep.eventPosts++; rep.eventPostsFailed++ } })
    }
    wire(page)
    const cdp = await context.newCDPSession(page)
    if (WIFI === 'hall') {
      // A crowded lecture-hall AP: ~8 Mbps down / 3 up, 60–120 ms RTT.
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: Math.round(uniform(r, 60, 120)), downloadThroughput: (8 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 })
    }
    if (doSlow) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })

    // arrive over the stagger window; cold load (fresh context = empty cache)
    await sleep(uniform(r, 0, STAGGER_S * 1000))
    const t0 = performance.now()
    await page.goto(quizUrl(), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const nameBox = page.locator(UI.nameInputCss)
    try {
      await nameBox.waitFor({ timeout: 30_000 })
    } catch {
      // a lost asset leaves a blank page; a student reloads. So do we, once.
      rep.scenarios.push('reloaded-cold')
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
      await nameBox.waitFor({ timeout: 60_000 })
    }
    rep.coldLoadMs = Math.round(performance.now() - t0)
    await nameBox.fill(name)
    await page.getByRole('button', { name: uiName(UI.beginButton) }).click()
    const pm = page.locator(UI.editorCss)
    await pm.waitFor({ timeout: 30_000 })
    rep.reachedEditor = true
    // caret into the first answer paragraph (right after the Question 1 block)
    await page.locator(UI.firstAnswerCss).first().click()

    const deadline = Date.now() + MINUTES * 60_000
    const offlineAt = doOffline ? Date.now() + uniform(r, 0.3, 0.6) * MINUTES * 60_000 : Infinity
    const backgroundAt = doBackground ? Date.now() + uniform(r, 0.25, 0.6) * MINUTES * 60_000 : Infinity
    const reopenAt = doReopen ? Date.now() + uniform(r, 0.4, 0.7) * MINUTES * 60_000 : Infinity
    const askAt = doAsk ? Date.now() + uniform(r, 0.2, 0.6) * MINUTES * 60_000 : Infinity
    let offlineDone = false, backgroundDone = false, reopenDone = false, askDone = false, offlineActive = false
    let lastT = keys[0]?.t ?? 0
    for (const k of keys) {
      const wait = k.t - lastT
      lastT = k.t
      if (wait > 0) await sleep(wait)
      if (Date.now() >= deadline) break
      // ── scenarios woven into the typing ──
      if (!offlineDone && Date.now() >= offlineAt) {
        offlineDone = true
        offlineActive = true
        await context.setOffline(true)
        const back = Date.now() + uniform(r, 25_000, 45_000)
        ;(async () => { while (Date.now() < back && !closed) await sleep(500); if (!closed) await context!.setOffline(false).catch(() => undefined); offlineActive = false })()
      }
      if (!backgroundDone && Date.now() >= backgroundAt) {
        backgroundDone = true
        // the student switches to the syllabus for 30–60 s: the quiz tab goes
        // hidden (visibilitychange → the recorder's beacon flush), then back.
        await page.evaluate(() => (window as unknown as { __simHide: (h: boolean) => void }).__simHide(true))
        await sleep(uniform(r, 30_000, 60_000))
        await page.evaluate(() => (window as unknown as { __simHide: (h: boolean) => void }).__simHide(false))
        await page.locator(UI.editorCss).click({ position: { x: 5, y: 5 } }).catch(() => undefined)
        await page.keyboard.press('Control+End')
      }
      if (!reopenDone && Date.now() >= reopenAt && !offlineActive) {
        reopenDone = true
        // closed the tab by accident; opens the link again
        await page.close()
        await sleep(uniform(r, 3000, 8000))
        page = await context.newPage()
        wire(page)
        await page.goto(quizUrl(), { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.getByRole('button', { name: uiName(UI.continueButton) }).click({ timeout: 30_000 })
        await page.locator(UI.editorCss).waitFor({ timeout: 30_000 })
        await page.locator(UI.editorCss).click({ position: { x: 5, y: 5 } })
        // resume at the end of the text (the composer's caret model assumes the end)
        await page.keyboard.press('Control+End')
      }
      if (!askDone && Date.now() >= askAt) {
        askDone = true
        ;(async () => {
          try {
            await page.getByRole('button', { name: uiName(UI.assistantOpenButton) }).click()
            const side = page.locator(UI.assistantSidebarCss)
            const before = norm(await side.innerText())
            await page.getByRole('button', { name: uiName(UI.assistantPromptButton) }).click({ timeout: 10_000 })
            // wait for the reply (or the calm failure) to appear and settle
            let txt = before, stable = 0
            for (let k = 0; k < 120 && stable < 6; k++) {
              await sleep(500)
              const now = norm(await side.innerText())
              if (now !== txt) { txt = now; stable = 0 } else if (now !== before && now.length > before.length + 40) stable++
            }
            rep.askai = txt === before ? 'fail' : /unavailable|busy|interrupted/.test(txt) ? 'fail' : 'ok'
            await page.getByRole('button', { name: uiName(UI.assistantCloseButton) }).click().catch(() => undefined)
            await page.locator(UI.editorCss).click({ position: { x: 5, y: 5 } }).catch(() => undefined)
            await page.keyboard.press('Control+End')
          } catch { rep.askai = 'fail' }
        })()
      }
      if (k.kind === 'type') {
        await page.keyboard.type(k.text)
        rep.keysTyped += k.text.length
      } else {
        for (let n = 0; n < (k.times ?? 1); n++) { await page.keyboard.press(k.key); if ((k.times ?? 1) > 1) await sleep(25) }
        rep.keysTyped += k.times ?? 1
      }
    }
    if (rep.askai === undefined) rep.askai = doAsk ? 'fail' : 'skipped'
    await context.setOffline(false).catch(() => undefined)

    // Let the recorder drain: it flushes every 2 s and retries lost batches on
    // the next tick, so poll the server's replay until it equals the editor
    // (or 30 s pass — then it is a real discrepancy).
    const editorText = norm(await page.locator(UI.editorCss).innerText())
    const sid = await page.evaluate((prefix) => { const k = Object.keys(localStorage).find((x) => x.startsWith(prefix)); return k ? k.slice(prefix.length) : null }, UI.sessionIdLocalStoragePrefix)
    rep.sid = sid ?? undefined
    if (sid) {
      let serverText: string | null = null
      for (let k = 0; k < 15; k++) {
        await sleep(2000)
        const doc = await page.request.get(`${API}/api/sessions/${sid}/doc`)
        const j = doc.ok() ? (await doc.json()) as { plainText?: string } : null
        serverText = j ? norm(j.plainText ?? '') : null
        if (serverText === editorText) break
      }
      rep.docMatch = serverText === editorText
      if (!rep.docMatch) rep.errors.push(`server replay differs (${serverText?.length ?? 'n/a'} vs ${editorText.length} chars)`)
    } else rep.errors.push('no session id in localStorage')

    if (rep.wantedSubmit) {
      // A student whose submit hits a bad moment sees "Could not submit …
      // try again" and presses Submit again. So do we, up to three times.
      for (let attempt = 0; attempt < 3 && !rep.submitted; attempt++) {
        await page.getByRole('button', { name: uiName(UI.submitButton) }).first().click()
        await page.getByRole('dialog').getByRole('button', { name: uiName(UI.submitConfirmButton) }).click({ timeout: 10_000 })
        const done = page.getByText(uiName(UI.doneText))
        const retry = page.getByText(uiName(UI.submitRetryText))
        await Promise.race([done.waitFor({ timeout: 30_000 }), retry.waitFor({ timeout: 30_000 })]).catch(() => undefined)
        if (await done.isVisible().catch(() => false)) rep.submitted = true
        else { rep.scenarios.push('submit-retry'); await sleep(2000) }
      }
      if (!rep.submitted) rep.errors.push('submit did not reach the done screen after 3 attempts')
      const dl = await page.getByRole('link', { name: uiName(UI.downloadLinkText) }).count()
      if (!dl) rep.errors.push('no download link on the done screen')
    }
    // A failed POST is the recorder's problem to retry — and it did, or the
    // replay would not match. It is an error only when nothing explains it.
    if (rep.eventPostsFailed > 0 && !doOffline && LOSS === 0) rep.errors.push(`${rep.eventPostsFailed} event POSTs failed`)
  } catch (err) {
    rep.errors.push(`exception: ${String((err as Error).message).slice(0, 160)}`)
    if (SHOTS && context) {
      try { const pg = context.pages()[0]; if (pg) await pg.screenshot({ path: `${SHOTS}/student-${i}.png` }) } catch { /* ignore */ }
    }
  } finally {
    closed = true
    await context?.close().catch(() => undefined)
  }
  return rep
}

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }

process.on('unhandledRejection', (e) => console.warn('[browser-sim] unhandled rejection (ignored):', String((e as Error)?.message ?? e).slice(0, 120)))

async function main() {
  console.log(`real-browser classroom → ${API}  students=${STUDENTS} minutes=${MINUTES} headless=${HEADLESS} channel=${CHANNEL} wifi=${WIFI} stagger=${STAGGER_S}s loss=${LOSS} offline=${OFFLINE} background=${BACKGROUND} reopen=${REOPEN} skew=${SKEW_MIN} slow=${SLOW} askai=${ASKAI}`)
  if (SHOTS) { const { mkdirSync } = await import('node:fs'); mkdirSync(SHOTS, { recursive: true }) }
  const browsers: Browser[] = []
  for (let b = 0; b < Math.min(BROWSERS, STUDENTS); b++) {
    browsers.push(await chromium.launch({ headless: HEADLESS, channel: CHANNEL === 'none' ? undefined : CHANNEL, args: ['--disable-dev-shm-usage', '--no-first-run', '--disable-background-timer-throttling=false'] }))
  }
  const t0 = performance.now()
  const reports = await Promise.all(Array.from({ length: STUDENTS }, (_, i) => student(i, browsers[i % browsers.length], rng(SEED * 7919 + i))))
  const wall = (performance.now() - t0) / 1000
  await Promise.all(browsers.map((b) => b.close().catch(() => undefined)))

  const reached = reports.filter((x) => x.reachedEditor)
  const posts = reports.reduce((s, x) => s + x.eventPosts, 0), postsOk = reports.reduce((s, x) => s + x.eventPostsOk, 0)
  const wanted = reports.filter((x) => x.wantedSubmit), submitted = wanted.filter((x) => x.submitted)
  const withSid = reports.filter((x) => x.sid), match = withSid.filter((x) => x.docMatch)
  const asked = reports.filter((x) => x.askai && x.askai !== 'skipped'), askOk = asked.filter((x) => x.askai === 'ok')
  const cold = reports.map((x) => x.coldLoadMs ?? 0).filter(Boolean)
  const lat = reports.flatMap((x) => x.latencies)
  const withErrors = reports.filter((x) => x.errors.length)
  const consoleErr = reports.filter((x) => x.consoleErrors.length)
  console.log(`\nwall ${wall.toFixed(0)}s · reached editor ${reached.length}/${STUDENTS} · keys typed ${reports.reduce((s, x) => s + x.keysTyped, 0)}`)
  console.log(`cold load p50 ${pct(cold, 50)} ms · p95 ${pct(cold, 95)} ms · max ${Math.max(0, ...cold)} ms`)
  console.log(`event POSTs (from the browsers' own network logs): ${postsOk}/${posts} ok · browser-side latency p50 ${pct(lat, 50).toFixed(0)} p95 ${pct(lat, 95).toFixed(0)} p99 ${pct(lat, 99).toFixed(0)} ms`)
  console.log(`server replay == editor text: ${match.length}/${withSid.length} · submitted ${submitted.length}/${wanted.length} · assistant ${askOk.length}/${asked.length}`)
  const scen = new Map<string, number>(); for (const x of reports) for (const s of x.scenarios) scen.set(s.split(' ')[0], (scen.get(s.split(' ')[0]) ?? 0) + 1)
  console.log(`scenarios: ${[...scen].map(([k, v]) => `${k}×${v}`).join(', ')} · console errors on ${consoleErr.length} students`)
  if (withErrors.length) { console.log(`\nstudents with errors: ${withErrors.length}`); for (const x of withErrors.slice(0, 15)) console.log(`  #${x.i} ${x.name} [${x.scenarios.join(',')}]: ${x.errors.join('; ')}`) }
  if (consoleErr.length) { console.log('\nconsole errors (first 5):'); for (const x of consoleErr.slice(0, 5)) console.log(`  #${x.i}: ${x.consoleErrors[0]}`) }
  const pass = reached.length === STUDENTS && match.length === withSid.length && withSid.length === STUDENTS && submitted.length === wanted.length && withErrors.length === 0 && (ALLOW_ASKAI_FAIL || askOk.length === asked.length)
  console.log(pass ? '\nPASS — every expectation held' : '\nFAIL — see above')
  if (OUT) writeFileSync(OUT, JSON.stringify({ api: API, students: STUDENTS, minutes: MINUTES, wall, reports }, null, 1))
  process.exit(pass ? 0 : 1)
}
main()
