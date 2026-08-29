/**
 * Print the motor-rhythm CV and 5 ms mode-share distribution of every model —
 * the table in docs/HUMAN_BASELINE.md and the constants in
 * src/metrics/baseline.ts.
 *
 *   npx tsx tools/motor-cv.ts [sessionsPerModel=24]
 *   npx tsx tools/motor-cv.ts 24 data/kupa-sessions.json   # add the humans
 */
import { existsSync, readFileSync } from 'node:fs'
import { runOne, measure } from '../src/runners/run'
import { quantile } from '../src/metrics'
import type { SessionEvent } from '../src/types'
import type { ModelName } from '../src/models'

const N = Number(process.argv[2] ?? 24)
const HUMANS = process.argv[3]

const show = (label: string, rows: Array<{ ikiCVmotor: number; ikiModeShare: number }>) => {
  const cv = rows.map((r) => r.ikiCVmotor)
  const ms = rows.map((r) => r.ikiModeShare)
  console.log(
    `${label.padEnd(18)} n=${String(rows.length).padStart(3)}  ` +
    `motorCV min ${quantile(cv, 0).toFixed(2)} p5 ${quantile(cv, 0.05).toFixed(2)} p50 ${quantile(cv, 0.5).toFixed(2)} max ${quantile(cv, 1).toFixed(2)}   ` +
    `mode5 min ${quantile(ms, 0).toFixed(2)} p50 ${quantile(ms, 0.5).toFixed(2)} max ${quantile(ms, 1).toFixed(2)}`,
  )
}

if (HUMANS && existsSync(HUMANS)) {
  const humans = JSON.parse(readFileSync(HUMANS, 'utf8')) as Array<{ id: string; events: SessionEvent[]; finalText: string }>
  show('humans', humans.map((h) => measure(h.id, 'human', h.events, h.finalText)))
}
const MODELS: ModelName[] = ['markov', 'personality', 'profile:human', 'profile:nervous', 'profile:casual', 'profile:expert', 'robotic']
for (const model of MODELS) {
  const rows = Array.from({ length: N }, (_, i) => runOne({ model, words: 250, seed: 500 + i, revising: 0.2 + (i % 5) * 0.2 }).measured)
  show(model, rows)
}
