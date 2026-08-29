/**
 * The writer layer and its op trace: the trace must be self-consistent (apply
 * it to empty paragraphs and you get the composer's own final text), the
 * ground truth must describe what the ops actually did, and the same seed must
 * produce the same session.
 */
import { describe, it, expect } from 'vitest'
import { compose, applyOps, type Op } from '../src/compose'
import type { ModelName } from '../src/models'

const MODELS: ModelName[] = ['markov', 'personality', 'profile:human', 'profile:nervous', 'robotic']

describe('op trace', () => {
  it('applying the ops reproduces the composer’s final paragraphs, for every model', () => {
    for (const model of MODELS) {
      for (let seed = 1; seed <= 6; seed++) {
        const c = compose({ model, words: 220, seed, revising: 0.7 })
        expect(applyOps(c.ops)).toEqual(c.truth.finalParagraphs)
        expect(applyOps(c.ops).join('\n')).toBe(c.truth.finalText)
      }
    }
  })

  it('is deterministic per seed and different across seeds', () => {
    const a = compose({ model: 'markov', words: 200, seed: 11, revising: 0.6 })
    const b = compose({ model: 'markov', words: 200, seed: 11, revising: 0.6 })
    const c = compose({ model: 'markov', words: 200, seed: 12, revising: 0.6 })
    expect(a.ops).toEqual(b.ops)
    expect(a.truth).toEqual(b.truth)
    expect(c.ops).not.toEqual(a.ops)
  })

  it('timestamps never go backwards', () => {
    const c = compose({ model: 'personality', words: 250, seed: 3, revising: 0.8 })
    for (let i = 1; i < c.ops.length; i++) expect(c.ops[i].t).toBeGreaterThanOrEqual(c.ops[i - 1].t)
  })

  it('ground truth counts match the ops themselves', () => {
    for (let seed = 20; seed < 26; seed++) {
      const c = compose({ model: 'markov', words: 240, seed, revising: 0.8 })
      const inserts = c.ops.filter((o): o is Extract<Op, { op: 'insert' }> => o.op === 'insert')
      const deletes = c.ops.filter((o) => o.op === 'delete')
      // every insert op is a single character produced by a keystroke
      expect(inserts.every((o) => o.text.length === 1)).toBe(true)
      expect(c.truth.typedChars).toBe(inserts.length)
      expect(c.truth.deletions).toBe(deletes.length)
      // pauses are the >= 2 s gaps between consecutive ops (sittings excluded)
      let gaps = 0
      for (let i = 1; i < c.ops.length; i++) {
        const d = c.ops[i].t - c.ops[i - 1].t
        if (d >= 2000 && d < 180_000) gaps++
      }
      expect(c.truth.cognitivePauses).toBe(gaps)
    }
  })

  it('a restless writer revises more than a linear one', () => {
    const linear = compose({ model: 'markov', words: 300, seed: 5, revising: 0 })
    const restless = compose({ model: 'markov', words: 300, seed: 5, revising: 1 })
    const structural = (c: ReturnType<typeof compose>) =>
      c.truth.midInsertions + c.truth.phraseDeletions + c.truth.tailRewrites + c.truth.wordSwaps
    expect(structural(linear)).toBe(0)
    expect(structural(restless)).toBeGreaterThan(0)
    expect(restless.truth.nonLinearEdits).toBeGreaterThan(linear.truth.nonLinearEdits)
  })

  it('hits roughly the requested length', () => {
    for (const words of [150, 400]) {
      const c = compose({ model: 'markov', words, seed: 7, revising: 0.5 })
      expect(c.truth.words).toBeGreaterThan(words * 0.6)
      expect(c.truth.words).toBeLessThan(words * 1.8)
    }
  })
})
