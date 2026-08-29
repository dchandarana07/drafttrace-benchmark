/**
 * PROCESS METRICS — a generic, engine-free implementation.
 *
 * Everything here is computed from a plain event log (src/types.ts) in a
 * single pass. There is no dependency on any particular product, database or
 * editor: give it events, get numbers. That is deliberate — a benchmark whose
 * scores can only be reproduced inside one vendor's engine is not a benchmark.
 *
 * DEFINITIONS AND THRESHOLDS come from the keystroke-logging literature, not
 * from tuning:
 *
 *   - 2000 ms pause threshold. The Inputlog default, following the pause
 *     analyses of Chenoweth & Hayes (2001) and the review in Wengelin (2006).
 *     Any threshold in the 1-3 s range is defensible; 2 s is the one most
 *     often reported, so it is what makes numbers comparable across papers.
 *     (Leijten & Van Waes 2013, "Keystroke Logging in Writing Research: Using
 *     Inputlog to Analyze and Visualize Writing Processes", Written
 *     Communication 30(3).)
 *   - P-BURSTS: a production burst is a run of text production terminated by
 *     a pause at or above that threshold ("P-burst" = pause-bounded burst, as
 *     against R-bursts, bounded by revisions). Reported as count, mean and max
 *     characters. (Chenoweth & Hayes 2001; used at scale in e.g. Crossley et
 *     al., EDM 2024.)
 *   - PAUSE LOCATION: pauses are classified by where in the text they fall —
 *     within a word, before a word, before a sentence, before a paragraph.
 *     Higher-level boundaries read as planning; pauses WITHIN words read as
 *     transcription or spelling effort, or as chunked copying.
 *     (Wengelin 2006; Van Waes & Leijten's pause-location analysis.)
 *   - NON-LINEAR EDITS: a change whose position jumped away from the previous
 *     change — Inputlog's "trailing"/distant revisions, as opposed to editing
 *     at the leading edge. The 12-character jump threshold is a convention of
 *     this benchmark, not a literature value; it is stated so it can be
 *     changed and reported (`options.jumpChars`).
 *   - PRODUCTION RATE: characters/5 per active minute (Inputlog's CPM/WPM over
 *     process text, not over the final product).
 *   - RELIABILITY FLOOR: rate and variance metrics are unstable on very short
 *     sessions, so `measurable` gates on a minimum of typed characters and
 *     active time (keystroke-logging studies typically use 20-30 minute
 *     tasks; e.g. Allen et al. 2016 used 25-minute essays).
 *
 * The inter-key-interval statistics at the bottom (`ikiStats`) are the timing
 * side: mean/median, the overall coefficient of variation, the MOTOR-RHYTHM CV
 * (the CV of sub-second intervals only, i.e. the rhythm with the thinking
 * pauses removed), and the 5 ms mode share (what fraction of intervals fall in
 * the single most popular 5 ms bucket). A metronomic script has a motor CV
 * near zero and a mode share near one; see docs/HUMAN_BASELINE.md for the
 * measured human distribution.
 */
import type { SessionEvent, StepJSON } from '../types'

// ── thresholds ────────────────────────────────────────────────────────────
export type MetricOptions = {
  /** Pause length that counts as cognitive and closes a P-burst (ms). */
  pauseMs: number
  /** Gaps longer than this are not "active writing" time (ms). */
  activeGapCapMs: number
  /** Gaps longer than this start a new sitting and are not pauses (ms). */
  sittingGapMs: number
  /** Cursor jump (characters) that makes an edit non-linear. */
  jumpChars: number
  /** Reliability floor: typed characters. */
  floorTypedChars: number
  /** Reliability floor: active milliseconds. */
  floorActiveMs: number
}

export const DEFAULT_OPTIONS: MetricOptions = {
  pauseMs: 2000,
  activeGapCapMs: 30_000,
  sittingGapMs: 180_000,
  jumpChars: 12,
  floorTypedChars: 150,
  floorActiveMs: 120_000,
}

export type PauseLocation = 'withinWord' | 'beforeWord' | 'beforeSentence' | 'beforeParagraph'

export type ProcessMetrics = {
  /** Enough typing and time for the rates and variances to mean anything. */
  measurable: boolean
  typedChars: number
  pastedChars: number
  /** Events that removed text (delta < 0) plus undo/redo events. */
  revisions: number
  /** Whole-session active time: the sum of gaps under `activeGapCapMs`. */
  activeMs: number
  /** The part of `activeMs` that ended on a typed character — the WPM denominator. */
  typingMs: number
  /** Last timestamp minus first. */
  elapsedMs: number
  /** typedChars / 5 per typing minute. */
  wpm: number
  pBurstCount: number
  pBurstMeanChars: number
  pBurstMaxChars: number
  /** Pauses >= `pauseMs` after which the writer went on typing. */
  planningPauses: number
  pauseLocations: Record<PauseLocation, number>
  nonLinearEdits: number
  /** 1 + the number of gaps >= `sittingGapMs`. */
  sittings: number
  longestGapMs: number
}

// ── step introspection (no schema needed) ─────────────────────────────────

/**
 * The plain text a ReplaceStep-shaped step inserts. Walks the slice content
 * recursively so a multi-paragraph insert still yields its text.
 */
export function insertedText(step: StepJSON | unknown): string {
  const content = (step as { slice?: { content?: unknown } } | null)?.slice?.content
  return collectText(content)
}

function collectText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const node of content) {
    if (!node || typeof node !== 'object') continue
    const n = node as { type?: string; text?: string; content?: unknown }
    if (n.type === 'text' && typeof n.text === 'string') out += n.text
    else if (n.content) out += collectText(n.content)
  }
  return out
}

/** Where a step starts, in document positions — `null` if the step has no `from`. */
export function stepFrom(step: StepJSON | unknown): number | null {
  const from = (step as { from?: unknown } | null)?.from
  return typeof from === 'number' ? from : null
}

// ── the single pass ───────────────────────────────────────────────────────

const emptyLocations = (): Record<PauseLocation, number> => ({
  withinWord: 0,
  beforeWord: 0,
  beforeSentence: 0,
  beforeParagraph: 0,
})

/** Classify a pause by the character that sat before the cursor when it began. */
export function pauseLocation(charBeforeCursor: string): PauseLocation {
  if (charBeforeCursor === '\n') return 'beforeParagraph'
  if (charBeforeCursor === '.' || charBeforeCursor === '!' || charBeforeCursor === '?') return 'beforeSentence'
  if (charBeforeCursor === ' ' || charBeforeCursor === '\t') return 'beforeWord'
  return 'withinWord'
}

export function computeProcessMetrics(
  events: SessionEvent[],
  options: Partial<MetricOptions> = {},
): ProcessMetrics {
  const o: MetricOptions = { ...DEFAULT_OPTIONS, ...options }

  const m: ProcessMetrics = {
    measurable: false,
    typedChars: 0,
    pastedChars: 0,
    revisions: 0,
    activeMs: 0,
    typingMs: 0,
    elapsedMs: 0,
    wpm: 0,
    pBurstCount: 0,
    pBurstMeanChars: 0,
    pBurstMaxChars: 0,
    planningPauses: 0,
    pauseLocations: emptyLocations(),
    nonLinearEdits: 0,
    sittings: 1,
    longestGapMs: 0,
  }
  if (events.length === 0) return m

  const log = [...events].sort((a, b) => a.ts - b.ts)

  const bursts: number[] = []
  let burstChars = 0
  const closeBurst = () => {
    if (burstChars > 0) bursts.push(burstChars)
    burstChars = 0
  }

  let prevTs: number | null = null
  let prevFrom: number | null = null
  // The document opens on a fresh paragraph, so the first pause (if any) is a
  // paragraph-level one.
  let charBefore = '\n'

  for (const e of log) {
    const steps: StepJSON[] = Array.isArray(e.steps) ? (e.steps as StepJSON[]) : []
    const typing = e.source === 'input'
    const text = typing ? steps.map(insertedText).join('') : ''
    const from = steps.length ? stepFrom(steps[0]) : null
    const gap = prevTs === null ? null : e.ts - prevTs

    // ── time ──
    if (gap !== null) {
      if (gap >= o.sittingGapMs) {
        // Away from the keyboard: a new sitting, not a pause, and it ends the
        // current production burst without being counted as one.
        m.sittings += 1
        if (gap > m.longestGapMs) m.longestGapMs = gap
        closeBurst()
      } else {
        if (gap < o.activeGapCapMs) {
          m.activeMs += gap
          if (typing) m.typingMs += gap
        }
        if (gap >= o.pauseMs) {
          closeBurst() // P-burst definition: a >= 2 s pause terminates the burst
          if (typing) {
            // ...and the writer resumed, so it was a pause IN writing, which we
            // can locate.
            m.planningPauses += 1
            m.pauseLocations[pauseLocation(charBefore)] += 1
          }
        }
      }
    }

    // ── production and revision ──
    if (typing) {
      if (text) {
        // Count characters from the inserted TEXT, not from the nodeSize delta:
        // typing over a selection has delta <= 0 but still produces text, and a
        // structural insert (Enter) has delta > 0 but produces none.
        m.typedChars += text.length
        burstChars += text.length
      }
      if (e.delta < 0) m.revisions += 1
      if (prevFrom !== null && from !== null && Math.abs(from - prevFrom) > o.jumpChars) {
        m.nonLinearEdits += 1
      }
      // Track what sits before the cursor, for the next pause's location.
      if (text) charBefore = text[text.length - 1]
      else if (e.delta > 0) charBefore = '\n' // structural insert (Enter / new block)
      else if (e.delta < 0) charBefore = '' // deletion: unknown, reads as within-word
    } else if (e.source === 'paste' || e.source === 'drop') {
      // Prefer the real pasted-text length: `delta` is a nodeSize delta,
      // inflated by block tokens on a multi-paragraph paste.
      m.pastedChars += e.pastedTextLen ?? Math.max(0, e.delta)
      closeBurst()
    } else if (e.source === 'history') {
      m.revisions += 1
    }

    if (from !== null) prevFrom = from
    prevTs = e.ts
  }
  closeBurst()

  m.elapsedMs = log[log.length - 1].ts - log[0].ts
  m.pBurstCount = bursts.length
  m.pBurstMeanChars = bursts.length ? Math.round(bursts.reduce((s, v) => s + v, 0) / bursts.length) : 0
  m.pBurstMaxChars = bursts.length ? Math.max(...bursts) : 0
  const typingMinutes = m.typingMs / 60_000
  m.wpm = typingMinutes > 0 ? Math.round(m.typedChars / 5 / typingMinutes) : 0
  m.measurable = m.typedChars >= o.floorTypedChars && m.activeMs >= o.floorActiveMs
  return m
}

// ── inter-key intervals ───────────────────────────────────────────────────

export type IkiOptions = {
  /** Ignore intervals below this (autorepeat, coalesced events) — ms. */
  minMs: number
  /** Ignore intervals above this (the writer left) — ms. */
  maxMs: number
  /** Intervals under this are "motor" rhythm, above it is thinking — ms. */
  motorMs: number
  /** Bucket width for the mode share — ms. */
  bucketMs: number
}

export const DEFAULT_IKI_OPTIONS: IkiOptions = { minMs: 1, maxMs: 10_000, motorMs: 1000, bucketMs: 5 }

/**
 * Inter-key intervals, in ms, over SINGLE-CHARACTER typed inputs only.
 *
 * Only single-character inserts are counted, because a multi-character insert
 * is not a keystroke (autocorrect, IME commit, paste-as-input). The interval
 * is measured against the previous event of any kind, which is what a
 * keystroke logger sees.
 */
export function interKeyIntervals(events: SessionEvent[], options: Partial<IkiOptions> = {}): number[] {
  const o = { ...DEFAULT_IKI_OPTIONS, ...options }
  const log = [...events].sort((a, b) => a.ts - b.ts)
  const out: number[] = []
  for (let i = 1; i < log.length; i++) {
    const e = log[i]
    if (e.source !== 'input') continue
    const steps: StepJSON[] = Array.isArray(e.steps) ? (e.steps as StepJSON[]) : []
    if (steps.map(insertedText).join('').length !== 1) continue
    const gap = e.ts - log[i - 1].ts
    if (gap >= o.minMs && gap < o.maxMs) out.push(gap)
  }
  return out
}

export type IkiStats = {
  n: number
  meanMs: number
  medianMs: number
  /** Coefficient of variation over all intervals (thinking included). */
  cv: number
  /** CV over sub-second intervals only: the motor rhythm, thinking removed. */
  motorCv: number
  /** Share of intervals in the single most popular `bucketMs` bucket. */
  modeShare: number
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0)
export const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
export const cv = (xs: number[]) => {
  const m = mean(xs)
  if (!m) return 0
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / m
}
export const quantile = (xs: number[], p: number) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

export function modeShare(intervals: number[], bucketMs = DEFAULT_IKI_OPTIONS.bucketMs): number {
  if (!intervals.length) return 0
  const buckets = new Map<number, number>()
  for (const x of intervals) {
    const b = Math.round(x / bucketMs)
    buckets.set(b, (buckets.get(b) ?? 0) + 1)
  }
  return Math.max(...buckets.values()) / intervals.length
}

export function ikiStats(intervals: number[], options: Partial<IkiOptions> = {}): IkiStats {
  const o = { ...DEFAULT_IKI_OPTIONS, ...options }
  return {
    n: intervals.length,
    meanMs: Math.round(mean(intervals)),
    medianMs: Math.round(median(intervals)),
    cv: round2(cv(intervals)),
    motorCv: round2(cv(intervals.filter((x) => x < o.motorMs))),
    modeShare: round2(modeShare(intervals, o.bucketMs)),
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100

/** Everything at once, for a session's event log. */
export function measureSession(events: SessionEvent[], options: Partial<MetricOptions & IkiOptions> = {}) {
  const process = computeProcessMetrics(events, options)
  const intervals = interKeyIntervals(events, options)
  return { process, iki: ikiStats(intervals, options), intervals }
}
