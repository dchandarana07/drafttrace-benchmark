/**
 * Real human keystrokes -> the benchmark's event format.
 *
 * Takes the intermediate JSON from tools/kupa/extract.py and replays each
 * participant's key trace through the SAME ProseMirror path the simulator uses
 * (src/replay), so a real writer and a simulated one are measured by exactly
 * the same code. That is what makes the human baseline in
 * docs/HUMAN_BASELINE.md comparable with the model numbers.
 *
 *   npx tsx tools/kupa/convert.ts <traces.json> [out=data/kupa-sessions.json] [max=160]
 *
 * FIDELITY NOTES — say these out loud in any write-up:
 *   - the corpus is a plain textarea, so a session is replayed as ONE
 *     paragraph (newlines become spaces); there is no paragraph structure to
 *     recover and none is invented;
 *   - a selection present at keydown is applied as a delete followed by the
 *     input, when the log makes the selection visible;
 *   - anything that would put the caret outside the text is clamped, and a
 *     participant whose trace needs clamping more than 5 % of the time is
 *     dropped rather than silently repaired;
 *   - multi-character inputs (autocorrect, IME commits, paste) stay as ONE
 *     insert event, exactly as a recorder would see them — and are therefore
 *     excluded from the inter-key-interval series by src/metrics.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { replayOps } from '../../src/replay'
import type { Op } from '../../src/compose'

type Raw = {
  id: string
  native: boolean
  layout: string
  words: number
  cefr: string
  keys: Array<[number, string, string, number | null, number | null | undefined, number | null | undefined]>
}

const src = process.argv[2]
const out = process.argv[3] ?? 'data/kupa-sessions.json'
const max = Number(process.argv[4] ?? 160)
if (!src) { console.error('usage: convert.ts <traces.json> [out] [max]'); process.exit(2) }

const raws = JSON.parse(readFileSync(src, 'utf8')) as Raw[]
const sessions: Array<{ id: string; native: boolean; layout: string; cefr: string; events: unknown[]; finalText: string; keyCount: number }> = []
let skipped = 0

for (const raw of raws.slice(0, max)) {
  const ops: Op[] = []
  let text = ''
  let cursor = 0
  let t0: number | null = null
  let bad = 0
  for (const [tAbs, kind, payload, pos, selS, selE] of raw.keys) {
    if (t0 === null) t0 = tAbs
    const t = 1000 + (tAbs - t0)
    // A selection present at keydown is replaced by the input / removed by the delete.
    const hasSel = typeof selS === 'number' && typeof selE === 'number' && selE > selS && selS >= 0 && selE <= text.length
    if (hasSel && (kind === 'i' || kind === 'b' || kind === 'd')) {
      ops.push({ t, op: 'delete', para: 0, from: selS!, to: selE! })
      text = text.slice(0, selS!) + text.slice(selE!)
      cursor = selS!
      if (kind !== 'i') continue
      const ins = payload.replace(/\r?\n/g, ' ')
      if (!ins) continue
      ops.push({ t: t + 1, op: 'insert', para: 0, at: cursor, text: ins })
      text = text.slice(0, cursor) + ins + text.slice(cursor)
      cursor += ins.length
      continue
    }
    if (kind === 'c' && pos !== null) { cursor = Math.max(0, Math.min(text.length, pos)); continue }
    if (kind === 'm') {
      if (payload === 'ArrowLeft') cursor = Math.max(0, cursor - 1)
      else if (payload === 'ArrowRight') cursor = Math.min(text.length, cursor + 1)
      else if (payload === 'Home') cursor = 0
      else if (payload === 'End') cursor = text.length
      continue
    }
    if (kind === 'i') {
      const ins = payload.replace(/\r?\n/g, ' ')
      if (!ins) continue
      // the log's range_start is the caret AFTER the input; before = after - len
      let at = pos !== null ? pos - ins.length : cursor
      if (at < 0 || at > text.length) { at = Math.max(0, Math.min(text.length, at)); bad++ }
      ops.push({ t, op: 'insert', para: 0, at, text: ins })
      text = text.slice(0, at) + ins + text.slice(at)
      cursor = at + ins.length
    } else if (kind === 'b') {
      const at = pos !== null ? pos : cursor
      if (at < 1 || at > text.length) { bad++; continue }
      ops.push({ t, op: 'delete', para: 0, from: at - 1, to: at })
      text = text.slice(0, at - 1) + text.slice(at)
      cursor = at - 1
    } else if (kind === 'd') {
      const at = pos !== null ? pos : cursor
      if (at < 0 || at >= text.length) { bad++; continue }
      ops.push({ t, op: 'delete', para: 0, from: at, to: at + 1 })
      text = text.slice(0, at) + text.slice(at + 1)
      cursor = at
    }
  }
  if (ops.length < 300 || bad > ops.length * 0.05) { skipped++; continue }
  const rep = replayOps(ops)
  sessions.push({ id: raw.id, native: raw.native, layout: raw.layout, cefr: raw.cefr, events: rep.events, finalText: rep.finalText, keyCount: ops.length })
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(sessions))
console.log(`converted ${sessions.length} human sessions (skipped ${skipped}) -> ${out}`)
