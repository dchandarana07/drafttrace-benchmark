/**
 * The benchmark's self-test: the metrics must agree with what the writer
 * actually did, exactly, for every model and many seeds. This is the check the
 * offline runner prints as ALL GROUND-TRUTH CHECKS PASSED; if it fails, no
 * score produced by this harness means anything.
 */
import { describe, it, expect } from 'vitest'
import { runOne } from '../src/runners/run'
import type { ModelName } from '../src/models'

const MODELS: ModelName[] = ['markov', 'personality', 'profile:human', 'profile:nervous', 'robotic']

describe('ground truth', () => {
  it.each(MODELS)('every check holds for %s across seeds and temperaments', (model) => {
    for (let seed = 1; seed <= 8; seed++) {
      const r = runOne({ model, words: 240, seed: 300 + seed, revising: 0.2 + (seed % 5) * 0.2 })
      const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)
      expect(failed, `${model} seed ${300 + seed}`).toEqual([])
    }
  })

  it('a fully linear writer produces no non-linear edits beyond the model’s own corrections', () => {
    const r = runOne({ model: 'robotic', words: 200, seed: 42, revising: 0 })
    expect(r.composition.truth.midInsertions).toBe(0)
    expect(r.composition.truth.phraseDeletions).toBe(0)
    expect(r.measured.revisions).toBe(0) // the robotic profile never backspaces
  })

  it('measured typed characters exceed the final text: revision was recorded, not just the product', () => {
    const r = runOne({ model: 'markov', words: 300, seed: 9, revising: 0.9 })
    expect(r.measured.typedChars).toBeGreaterThan(r.replayed.finalText.length)
    expect(r.measured.revisions).toBeGreaterThan(0)
  })
})
