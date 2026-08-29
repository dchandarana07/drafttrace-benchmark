/**
 * The other half of the Markov-port cross-check (see tools/xcheck_py.py).
 * Prints the same summary line for the TypeScript port so the two can be
 * compared directly.
 *
 *   npx tsx tools/xcheck_ts.ts [runs=300] [wpm=60]
 */
import { rng, markovTyper } from '../src/models'

const RUNS = Number(process.argv[2] ?? 300)
const WPM = Number(process.argv[3] ?? 60)
const TEXT = 'A prompt is the instruction given to a language model. The wording matters because small changes in phrasing change what the model attends to, and therefore what it produces. Precise prompts state the task, the audience, the constraints and the format.'

const times: number[] = [], errs: number[] = [], bks: number[] = [], ikis: number[] = []
for (let s = 1; s <= RUNS; s++) {
  const tr = markovTyper(TEXT, { wpm: WPM }, rng(s))
  times.push(tr.totalMs / 1000)
  errs.push(tr.errors)
  bks.push(tr.backspaces)
  for (let i = 1; i < tr.keys.length; i++) ikis.push((tr.keys[i].t - tr.keys[i - 1].t) / 1000)
}
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length
const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(mean(x.map((v) => (v - m) ** 2))) }
console.log(
  `ts port:         mean total ${mean(times).toFixed(2)}s sd ${sd(times).toFixed(2)} | ` +
  `errors/run ${mean(errs).toFixed(2)} | backspaces/run ${mean(bks).toFixed(2)} | ` +
  `IKI mean ${(mean(ikis) * 1000).toFixed(0)}ms CV ${(sd(ikis) / mean(ikis)).toFixed(2)} | ` +
  `eff wpm ${(TEXT.length / 5 / (mean(times) / 60)).toFixed(1)}`,
)
