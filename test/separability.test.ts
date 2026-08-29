/**
 * MOTOR RHYTHM as a separability signal — and its documented blind spot.
 *
 * The claim under test is narrow: the coefficient of variation of sub-second
 * inter-key intervals separates naive scripted typing from real writing, and
 * does NOT separate a good humanizer from real writing.
 *
 * The human reference (`HUMAN_MOTOR_CV`) is a measurement over 151 writers in
 * one corpus, one task — see docs/HUMAN_BASELINE.md, and read the caveat there
 * before quoting the numbers. These tests pin the model side of that
 * comparison so a change in the models cannot silently move the picture.
 */
import { describe, it, expect } from 'vitest'
import { runOne } from '../src/runners/run'
import { HUMAN_MOTOR_CV } from '../src/metrics/baseline'
import type { ModelName } from '../src/models'

const sessions = (model: ModelName, n = 12) =>
  Array.from({ length: n }, (_, i) => runOne({ model, words: 250, seed: 500 + i, revising: 0.2 + (i % 5) * 0.2 }).measured)

describe('naive scripted typing is separable', () => {
  it('a fixed-delay bot has almost no motor variability and a dominant interval', () => {
    for (const m of sessions('robotic')) {
      expect(m.ikiCVmotor).toBeLessThan(0.2)
      expect(m.ikiModeShare).toBeGreaterThan(0.9)
    }
  })

  it('the "expert" fixed-profile bot sits far below the human floor', () => {
    for (const m of sessions('profile:expert')) expect(m.ikiCVmotor).toBeLessThan(HUMAN_MOTOR_CV.min)
  })

  it('every fixed-profile bot sits below the human floor', () => {
    for (const model of ['profile:human', 'profile:nervous', 'profile:casual'] as ModelName[]) {
      for (const m of sessions(model, 8)) expect(m.ikiCVmotor).toBeLessThan(HUMAN_MOTOR_CV.min)
    }
  })

  it('the personality typist is more variable than a profile bot, and still below the human floor', () => {
    const personality = sessions('personality')
    const profile = sessions('profile:human')
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length
    expect(mean(personality.map((m) => m.ikiCVmotor))).toBeGreaterThan(mean(profile.map((m) => m.ikiCVmotor)))
    for (const m of personality) expect(m.ikiCVmotor).toBeLessThan(HUMAN_MOTOR_CV.min)
  })
})

describe('the documented blind spot', () => {
  it('the Markov humanizer lands inside the human range on every session', () => {
    // This is a REPORTED MISS, not a bug: timing alone does not catch a
    // determined humanizer. Any system that claims to detect scripted typing
    // from rhythm should be expected to fail this case too, and to say so.
    for (const m of sessions('markov')) {
      expect(m.ikiCVmotor).toBeGreaterThanOrEqual(HUMAN_MOTOR_CV.min)
      expect(m.ikiCVmotor).toBeLessThanOrEqual(HUMAN_MOTOR_CV.max)
      expect(m.ikiModeShare).toBeLessThan(0.1)
    }
  })

  it('the humanizer makes and corrects its own typos; the fixed-delay bot never does', () => {
    // With the writer layer switched off (revising: 0), every revision left in
    // the log came from the KEYSTROKE model. That difference — a bot that
    // never mistypes — survives where timing does not, which is where the next
    // signal has to come from.
    for (let i = 0; i < 6; i++) {
      expect(runOne({ model: 'markov', words: 250, seed: 600 + i, revising: 0 }).measured.revisions).toBeGreaterThan(0)
      expect(runOne({ model: 'robotic', words: 250, seed: 600 + i, revising: 0 }).measured.revisions).toBe(0)
    }
  })
})
