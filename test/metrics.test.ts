/**
 * The process metrics, definition by definition, on hand-built event logs.
 *
 * Each test states the definition it is pinning: the 2 s pause threshold, what
 * closes a P-burst, how a pause is located, what counts as a revision or a
 * non-linear edit, and how the rates are normalised. If you change a
 * threshold, these are the tests that should have to change with it.
 */
import { describe, it, expect } from 'vitest'
import {
  computeProcessMetrics,
  interKeyIntervals,
  ikiStats,
  modeShare,
  insertedText,
  stepFrom,
  DEFAULT_OPTIONS,
} from '../src/metrics'
import type { SessionEvent } from '../src/types'

const ins = (ts: number, from: number, text: string): SessionEvent => ({
  ts, source: 'input', delta: text.length,
  steps: [{ stepType: 'replace', from, to: from, slice: { content: [{ type: 'text', text }] } }],
})
const del = (ts: number, from: number, n = 1): SessionEvent => ({
  ts, source: 'input', delta: -n,
  steps: [{ stepType: 'replace', from, to: from + n }],
})
const enter = (ts: number, from: number): SessionEvent => ({
  ts, source: 'input', delta: 2, steps: [{ stepType: 'replace', from, to: from, structure: true }],
})
const paste = (ts: number, from: number, text: string): SessionEvent => ({
  ts, source: 'paste', delta: text.length, pastedTextLen: text.length,
  steps: [{ stepType: 'replace', from, to: from, slice: { content: [{ type: 'text', text }] } }],
})
const undo = (ts: number, from: number): SessionEvent => ({
  ts, source: 'history', delta: -3, steps: [{ stepType: 'replace', from, to: from + 3 }],
})
/** `n` characters typed at a steady `everyMs`, starting at `t0`/`pos`. */
const run = (t0: number, pos: number, n: number, everyMs: number): SessionEvent[] =>
  Array.from({ length: n }, (_, i) => ins(t0 + i * everyMs, pos + i, 'x'))

describe('step introspection', () => {
  it('reads inserted text, including from nested content', () => {
    expect(insertedText({ slice: { content: [{ type: 'text', text: 'hi' }] } })).toBe('hi')
    expect(insertedText({ slice: { content: [{ type: 'paragraph', content: [{ type: 'text', text: 'deep' }] }] } })).toBe('deep')
    expect(insertedText({ stepType: 'replace', from: 3, to: 4 })).toBe('')
    expect(insertedText(null)).toBe('')
  })
  it('reads the step position', () => {
    expect(stepFrom({ from: 12 })).toBe(12)
    expect(stepFrom({})).toBe(null)
  })
})

describe('production and revision counts', () => {
  it('counts typed characters from the inserted text, not from the delta', () => {
    const m = computeProcessMetrics([ins(0, 1, 'a'), ins(100, 2, 'bc'), enter(200, 4)])
    expect(m.typedChars).toBe(3) // the Enter inserts no text
  })
  it('counts a revision for every input event that removed text, and every undo', () => {
    const m = computeProcessMetrics([ins(0, 1, 'a'), del(100, 1), del(200, 1), undo(300, 1)])
    expect(m.revisions).toBe(3)
  })
  it('keeps pasted characters out of the typed count', () => {
    const m = computeProcessMetrics([ins(0, 1, 'a'), paste(100, 2, 'a long pasted passage')])
    expect(m.typedChars).toBe(1)
    expect(m.pastedChars).toBe('a long pasted passage'.length)
  })
})

describe('the 2 s pause threshold', () => {
  it('a gap just under the threshold is not a pause', () => {
    const m = computeProcessMetrics([ins(0, 1, 'a'), ins(1999, 2, 'b')])
    expect(m.planningPauses).toBe(0)
    expect(m.pBurstCount).toBe(1)
  })
  it('a gap at the threshold is a pause and closes the burst', () => {
    const m = computeProcessMetrics([ins(0, 1, 'a'), ins(2000, 2, 'b')])
    expect(m.planningPauses).toBe(1)
    expect(m.pBurstCount).toBe(2)
  })
  it('is configurable', () => {
    const events = [ins(0, 1, 'a'), ins(1500, 2, 'b')]
    expect(DEFAULT_OPTIONS.pauseMs).toBe(2000)
    expect(computeProcessMetrics(events).planningPauses).toBe(0)
    expect(computeProcessMetrics(events, { pauseMs: 1000 }).planningPauses).toBe(1)
  })
  it('a pause the writer never returned from is not a planning pause', () => {
    // the last thing that happens is a paste, not more typing
    const m = computeProcessMetrics([ins(0, 1, 'a'), paste(5000, 2, 'text')])
    expect(m.planningPauses).toBe(0)
  })
})

describe('P-bursts', () => {
  it('counts, means and maxima over pause-bounded bursts', () => {
    const events = [...run(0, 1, 10, 100), ...run(5000, 11, 30, 100), ...run(40_000, 41, 20, 100)]
    const m = computeProcessMetrics(events)
    expect(m.pBurstCount).toBe(3)
    expect(m.pBurstMaxChars).toBe(30)
    expect(m.pBurstMeanChars).toBe(20)
  })
  it('a paste ends the burst it interrupts', () => {
    const m = computeProcessMetrics([...run(0, 1, 10, 100), paste(1100, 11, 'imported'), ...run(1200, 20, 5, 100)])
    expect(m.pBurstCount).toBe(2)
  })
  it('going away for more than three minutes ends the burst without counting a pause', () => {
    const m = computeProcessMetrics([...run(0, 1, 10, 100), ...run(400_000, 11, 10, 100)])
    expect(m.sittings).toBe(2)
    expect(m.planningPauses).toBe(0)
    expect(m.pBurstCount).toBe(2)
    expect(m.longestGapMs).toBeGreaterThan(180_000)
  })
})

describe('pause location', () => {
  it('classifies by what sat before the cursor', () => {
    const m = computeProcessMetrics([
      ins(0, 1, 'w'), ins(3000, 2, 'x'),          // within a word
      ins(3100, 3, ' '), ins(6100, 4, 'y'),        // before a word
      ins(6200, 5, '.'), ins(9200, 6, 'z'),        // before a sentence
      enter(9300, 7), ins(12_300, 9, 'q'),         // before a paragraph
    ])
    expect(m.planningPauses).toBe(4)
    expect(m.pauseLocations).toEqual({ withinWord: 1, beforeWord: 1, beforeSentence: 1, beforeParagraph: 1 })
  })
})

describe('non-linear edits', () => {
  it('a jump longer than the threshold counts; a shorter one does not', () => {
    expect(computeProcessMetrics([ins(0, 100, 'a'), ins(100, 113, 'b')]).nonLinearEdits).toBe(1)
    expect(computeProcessMetrics([ins(0, 100, 'a'), ins(100, 112, 'b')]).nonLinearEdits).toBe(0)
  })
  it('counts jumps in both directions, and the jump back', () => {
    const m = computeProcessMetrics([ins(0, 200, 'a'), ins(100, 20, 'b'), ins(200, 201, 'c')])
    expect(m.nonLinearEdits).toBe(2)
  })
})

describe('time and rate', () => {
  it('active time ignores gaps above the cap; typing time only counts gaps that ended on a keystroke', () => {
    const m = computeProcessMetrics([ins(0, 1, 'a'), ins(1000, 2, 'b'), ins(50_000, 3, 'c')])
    expect(m.activeMs).toBe(1000)
    expect(m.typingMs).toBe(1000)
    expect(m.elapsedMs).toBe(50_000)
  })
  it('wpm is typed characters over five, per typing minute', () => {
    // 300 characters at 200 ms each = 59.8 s of typing time
    const m = computeProcessMetrics(run(0, 1, 300, 200))
    expect(m.typedChars).toBe(300)
    expect(m.wpm).toBe(Math.round(300 / 5 / (m.typingMs / 60_000)))
    expect(m.wpm).toBeGreaterThan(55)
    expect(m.wpm).toBeLessThan(65)
  })
  it('flags short sessions as not measurable', () => {
    expect(computeProcessMetrics(run(0, 1, 50, 200)).measurable).toBe(false)
    expect(computeProcessMetrics(run(0, 1, 900, 200)).measurable).toBe(true)
  })
  it('an empty log is all zeroes, not a crash', () => {
    const m = computeProcessMetrics([])
    expect(m.typedChars).toBe(0)
    expect(m.wpm).toBe(0)
    expect(m.measurable).toBe(false)
  })
  it('is order-independent: the log is sorted by timestamp first', () => {
    const ordered = [ins(0, 1, 'a'), ins(100, 2, 'b'), ins(200, 3, 'c')]
    const shuffled = [ordered[2], ordered[0], ordered[1]]
    expect(computeProcessMetrics(shuffled)).toEqual(computeProcessMetrics(ordered))
  })
})

describe('inter-key intervals', () => {
  it('only single-character typed inserts produce an interval', () => {
    const events = [ins(0, 1, 'a'), ins(100, 2, 'b'), ins(250, 3, 'multi'), paste(400, 8, 'p'), ins(500, 9, 'c')]
    expect(interKeyIntervals(events)).toEqual([100, 100])
  })
  it('motor CV drops the thinking pauses; overall CV keeps them', () => {
    const steady = run(0, 1, 60, 120)
    const withThinking = [...steady, ins(9000, 61, 'z'), ...run(9120, 62, 40, 120)]
    const all = ikiStats(interKeyIntervals(withThinking))
    expect(all.cv).toBeGreaterThan(all.motorCv)
    expect(all.motorCv).toBeLessThan(0.05)
  })
  it('mode share sees a metronome', () => {
    expect(modeShare(new Array(100).fill(50))).toBe(1)
    expect(modeShare([1, 20, 40, 60, 80, 100, 120, 140, 160, 180])).toBeLessThan(0.3)
  })
  it('reports n, mean and median', () => {
    const s = ikiStats(interKeyIntervals(run(0, 1, 11, 100)))
    expect(s.n).toBe(10)
    expect(s.meanMs).toBe(100)
    expect(s.medianMs).toBe(100)
  })
})
