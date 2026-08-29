/**
 * OFFLINE RUNNER — the fast suite. No server, no network, seconds to run.
 *
 *   npx tsx src/runners/run.ts [--model markov|personality|robotic|profile:human|...]
 *        [--n 20] [--words 400] [--wpm 55] [--revising 0.6] [--seed 1]
 *        [--out sessions.json] [--quiet]
 *   npx tsx src/runners/run.ts --compare        # every model side by side
 *   npx tsx src/runners/run.ts --compare --kupa data/kupa-sessions.json
 *
 * For each simulated writer: compose (writer layer) -> replay through real
 * ProseMirror -> compute the engine-free process metrics -> CHECK against the
 * composer's ground truth:
 *
 *   - the replayed document equals the composer's final text, exactly
 *   - typed characters, revisions, planning pauses and words agree EXACTLY
 *   - non-linear edits are at least the number of structural revisions the
 *     writer actually made (mid-paragraph insertions, phrase deletions, word
 *     swaps) — the metric is a lower bound on them by construction
 *
 * and prints the measured process metrics, so a model's "human-likeness" can
 * be read directly and compared with real human keystroke data
 * (docs/HUMAN_BASELINE.md).
 *
 * The ground-truth checks are the reason this file exists: they are the
 * self-test of the benchmark itself. If they fail, no score computed from this
 * harness means anything.
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { compose, type Composition } from '../compose'
import { replayOps, type Replayed } from '../replay'
import type { ModelName } from '../models'
import type { SessionEvent } from '../types'
import { computeProcessMetrics, interKeyIntervals, ikiStats, mean } from '../metrics'

const args = process.argv.slice(2)
const flag = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d }
const has = (k: string) => args.includes(`--${k}`)

export type Measured = {
  label: string
  model: string
  words: number
  wallMin: number
  wpm: number
  typedChars: number
  revisions: number
  pBursts: number
  pBurstMean: number
  pBurstMax: number
  planningPauses: number
  pauseWithinWord: number
  pauseBeforeWord: number
  pauseBeforeSentence: number
  pauseBeforeParagraph: number
  nonLinear: number
  activeMin: number
  ikiMeanMs: number
  ikiMedianMs: number
  ikiCV: number
  /** CV of sub-second gaps only — the motor rhythm with the thinking removed. */
  ikiCVmotor: number
  ikiModeShare: number
}

const round2 = (x: number) => Math.round(x * 100) / 100

/** Measure one session's event log with the generic metrics. */
export function measure(label: string, model: string, events: SessionEvent[], finalText?: string): Measured {
  const p = computeProcessMetrics(events)
  const iki = ikiStats(interKeyIntervals(events))
  const words = (finalText ?? '').split(/\s+/).filter(Boolean).length
  return {
    label, model, words,
    wallMin: Math.round(p.elapsedMs / 6000) / 10,
    wpm: p.wpm,
    typedChars: p.typedChars,
    revisions: p.revisions,
    pBursts: p.pBurstCount,
    pBurstMean: p.pBurstMeanChars,
    pBurstMax: p.pBurstMaxChars,
    planningPauses: p.planningPauses,
    pauseWithinWord: p.pauseLocations.withinWord,
    pauseBeforeWord: p.pauseLocations.beforeWord,
    pauseBeforeSentence: p.pauseLocations.beforeSentence,
    pauseBeforeParagraph: p.pauseLocations.beforeParagraph,
    nonLinear: p.nonLinearEdits,
    activeMin: Math.round(p.activeMs / 6000) / 10,
    ikiMeanMs: iki.meanMs,
    ikiMedianMs: iki.medianMs,
    ikiCV: iki.cv,
    ikiCVmotor: iki.motorCv,
    ikiModeShare: iki.modeShare,
  }
}

export type Check = { name: string; ok: boolean; detail: string }

export function checkAgainstTruth(c: Composition, replayed: Replayed, m: Measured): Check[] {
  const t = c.truth
  const structural = t.midInsertions + t.phraseDeletions + t.wordSwaps
  return [
    { name: 'final text == replayed document', ok: replayed.finalText === t.finalText, detail: `${replayed.finalText.length} vs ${t.finalText.length} chars` },
    { name: 'typed chars', ok: m.typedChars === t.typedChars, detail: `measured ${m.typedChars} / truth ${t.typedChars}` },
    // Revisions count EVENTS with delta < 0 — one per backspace, one per
    // phrase deletion — the same unit as the composer's `deletions`.
    { name: 'revisions', ok: m.revisions === t.deletions, detail: `measured ${m.revisions} / truth ${t.deletions}` },
    // Planning pauses: >= 2 s gaps that were followed by more typing. Every
    // event in an offline replay is typing, so this is exact.
    { name: 'planning pauses', ok: m.planningPauses === t.cognitivePauses, detail: `measured ${m.planningPauses} / truth ${t.cognitivePauses}` },
    // Non-linear edits are jumps of more than `jumpChars` between consecutive
    // edit positions; every structural revision produces at least one.
    { name: 'non-linear edits >= structural revisions', ok: m.nonLinear >= structural, detail: `measured ${m.nonLinear} / structural ${structural}` },
    { name: 'words', ok: m.words === t.words, detail: `measured ${m.words} / truth ${t.words}` },
  ]
}

export function runOne(o: { model: ModelName; words: number; wpm?: number; revising?: number; seed: number; label?: string }) {
  const composition = compose(o)
  const replayed = replayOps(composition.ops)
  const measured = measure(composition.label, o.model, replayed.events, replayed.finalText)
  return { composition, replayed, measured, checks: checkAgainstTruth(composition, replayed, measured) }
}

// ── table ─────────────────────────────────────────────────────────────────
const COLUMNS: Array<[string, (m: Measured) => string | number, number]> = [
  ['label', (m) => m.label, -24],
  ['words', (m) => m.words, 5],
  ['wall', (m) => m.wallMin, 6],
  ['wpm', (m) => m.wpm, 5],
  ['revs', (m) => m.revisions, 6],
  ['pburst', (m) => m.pBursts, 6],
  ['pbmean', (m) => m.pBurstMean, 6],
  ['pbmax', (m) => m.pBurstMax, 6],
  ['pause', (m) => m.planningPauses, 5],
  ['inW', (m) => m.pauseWithinWord, 4],
  ['preW', (m) => m.pauseBeforeWord, 4],
  ['preS', (m) => m.pauseBeforeSentence, 4],
  ['preP', (m) => m.pauseBeforeParagraph, 4],
  ['nonlin', (m) => m.nonLinear, 6],
  ['ikiMean', (m) => m.ikiMeanMs, 7],
  ['ikiMed', (m) => m.ikiMedianMs, 6],
  ['ikiCV', (m) => m.ikiCV, 5],
  ['motCV', (m) => m.ikiCVmotor, 5],
  ['mode5', (m) => m.ikiModeShare, 5],
]
const pad = (s: string | number, w: number) => (w < 0 ? String(s).padEnd(-w) : String(s).padStart(w))
const HEADER = COLUMNS.map(([h, , w]) => pad(h, w)).join(' ')
const fmtRow = (m: Measured) => COLUMNS.map(([, f, w]) => pad(f(m), w)).join(' ')

function aggregate(rows: Measured[]): Measured {
  const k = (f: (m: Measured) => number) => round2(mean(rows.map(f)))
  return {
    label: `MEAN(${rows.length})`, model: rows[0]?.model ?? '',
    words: k((m) => m.words), wallMin: k((m) => m.wallMin), wpm: k((m) => m.wpm),
    typedChars: k((m) => m.typedChars), revisions: k((m) => m.revisions),
    pBursts: k((m) => m.pBursts), pBurstMean: k((m) => m.pBurstMean), pBurstMax: k((m) => m.pBurstMax),
    planningPauses: k((m) => m.planningPauses),
    pauseWithinWord: k((m) => m.pauseWithinWord), pauseBeforeWord: k((m) => m.pauseBeforeWord),
    pauseBeforeSentence: k((m) => m.pauseBeforeSentence), pauseBeforeParagraph: k((m) => m.pauseBeforeParagraph),
    nonLinear: k((m) => m.nonLinear), activeMin: k((m) => m.activeMin),
    ikiMeanMs: k((m) => m.ikiMeanMs), ikiMedianMs: k((m) => m.ikiMedianMs),
    ikiCV: k((m) => m.ikiCV), ikiCVmotor: k((m) => m.ikiCVmotor), ikiModeShare: k((m) => m.ikiModeShare),
  }
}

const COMPARE_MODELS: ModelName[] = ['markov', 'personality', 'profile:human', 'profile:nervous', 'robotic']

function main() {
  const n = Number(flag('n', '20'))
  const words = Number(flag('words', '400'))
  const seed = Number(flag('seed', '1'))
  const revising = Number(flag('revising', '0.6'))
  const wpmFlag = flag('wpm')
  const quiet = has('quiet')
  const models: ModelName[] = has('compare') ? COMPARE_MODELS : [flag('model', 'markov') as ModelName]

  console.log(HEADER)
  const sessions: Array<{ label: string; model: string; events: SessionEvent[]; truth: unknown }> = []
  let failures = 0
  for (const model of models) {
    const rows: Measured[] = []
    for (let i = 0; i < n; i++) {
      const r = runOne({ model, words, seed: seed + i, revising, wpm: wpmFlag ? Number(wpmFlag) : undefined })
      rows.push(r.measured)
      sessions.push({ label: r.measured.label, model, events: r.replayed.events, truth: r.composition.truth })
      if (!quiet) console.log(fmtRow(r.measured))
      const bad = r.checks.filter((c) => !c.ok)
      if (bad.length) {
        failures += 1
        console.log(`   !! ${r.measured.label} seed ${seed + i}: ` + bad.map((b) => `${b.name} (${b.detail})`).join('; '))
      }
    }
    console.log(fmtRow(aggregate(rows)) + `   <- ${model}`)
  }

  // Real writers, if a converted human corpus is present (tools/kupa).
  const kupa = flag('kupa', 'data/kupa-sessions.json') as string
  if (has('compare') && existsSync(kupa)) {
    const human = JSON.parse(readFileSync(kupa, 'utf8')) as Array<{ id: string; events: SessionEvent[]; finalText: string }>
    const rows = human.slice(0, Number(flag('humans', '40'))).map((h) => measure(`human:${h.id.slice(-6)}`, 'human', h.events, h.finalText))
    if (!quiet) rows.forEach((m) => console.log(fmtRow(m)))
    console.log(fmtRow(aggregate(rows)) + '   <- real writers (human baseline)')
  }

  const out = flag('out')
  if (out) { writeFileSync(out, JSON.stringify(sessions)); console.log(`wrote ${sessions.length} sessions -> ${out}`) }
  console.log(failures === 0 ? '\nALL GROUND-TRUTH CHECKS PASSED' : `\n${failures} session(s) failed a ground-truth check`)
  process.exit(failures === 0 ? 0 : 1)
}

if (process.argv[1] && /run\.ts$/.test(process.argv[1])) main()
