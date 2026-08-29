/**
 * The keystroke models' hard invariants: a trace replays to the target text
 * exactly, the same seed gives the same trace, and each port keeps the
 * behaviour of the project it was ported from (error rate, effective speed,
 * inter-key variability, the robotic profile's metronome).
 */
import { describe, it, expect } from 'vitest'
import { rng, markovTyper, personalityTyper, randomPersonality, profileTyper, PROFILE_PRESETS, replayTrace, typeWith } from '../src/models'

const TEXT = 'A prompt is the instruction given to a language model. The wording matters because small changes in phrasing change what the model attends to, and therefore what it produces. Precise prompts state the task, the audience, the constraints and the format.'
const ikis = (keys: { t: number }[]) => keys.slice(1).map((k, i) => k.t - keys[i].t)
const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length

describe('markov typer (HumanTyping port)', () => {
  it('always reproduces the target exactly, across seeds', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const tr = markovTyper(TEXT, { wpm: 60 }, rng(seed))
      expect(replayTrace(tr.keys)).toBe(TEXT)
    }
  })
  it('is deterministic per seed', () => {
    const a = markovTyper(TEXT, { wpm: 60 }, rng(42)), b = markovTyper(TEXT, { wpm: 60 }, rng(42))
    expect(a.keys).toEqual(b.keys)
  })
  it('makes and corrects errors at roughly the configured rate', () => {
    let errors = 0, chars = 0, backspaces = 0
    for (let seed = 1; seed <= 100; seed++) {
      const tr = markovTyper(TEXT, { wpm: 60 }, rng(seed))
      errors += tr.errors; backspaces += tr.backspaces; chars += TEXT.length
    }
    const rate = errors / chars
    expect(rate).toBeGreaterThan(0.02) // config: 4% base, halved on common words, x1.5 on complex, +swaps
    expect(rate).toBeLessThan(0.08)
    expect(backspaces).toBeGreaterThanOrEqual(errors) // every wrong char is removed (plus over-deletions)
  })
  it('honours the target speed within the model’s own variance (wpm ±10 per session)', () => {
    const wpms: number[] = []
    for (let seed = 1; seed <= 60; seed++) {
      const tr = markovTyper(TEXT, { wpm: 60, wpmStd: 0 }, rng(seed))
      wpms.push((TEXT.length / 5) / (tr.totalMs / 60000))
    }
    const m = mean(wpms)
    // Effective speed is ~0.8× nominal: errors, corrections, reaction and
    // space pauses eat the bigram/common-word boosts (the Python original
    // measures 48.4 effective WPM at nominal 60 on this text; the port 48.0).
    expect(m).toBeGreaterThan(40)
    expect(m).toBeLessThan(60)
  })
  it('has human-grade inter-key variability (CV well above the scripted-bot floor)', () => {
    const tr = markovTyper(TEXT, { wpm: 60 }, rng(7))
    const g = ikis(tr.keys)
    const m = mean(g), sd = Math.sqrt(mean(g.map((x) => (x - m) ** 2)))
    expect(sd / m).toBeGreaterThan(0.3)
  })
})

describe('personality typer (human-typer port)', () => {
  it('reproduces the target exactly, across personalities', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed)
      const tr = personalityTyper(TEXT + '\nSecond paragraph, with a question? Yes!', randomPersonality(r), r)
      expect(replayTrace(tr.keys)).toBe(TEXT + '\nSecond paragraph, with a question? Yes!')
    }
  })
  it('typos are corrected with backspaces and retyped', () => {
    const r = rng(3)
    const tr = personalityTyper(TEXT, randomPersonality(r, { typoRate: 0.1 }), r)
    expect(tr.errors).toBeGreaterThan(0)
    expect(tr.backspaces).toBeGreaterThanOrEqual(tr.errors)
  })
  it('a zero-typo personality never backspaces', () => {
    const r = rng(9)
    const tr = personalityTyper(TEXT, randomPersonality(r, { typoRate: 0 }), r)
    expect(tr.backspaces).toBe(0)
  })
})

describe('profile typer (Type-Simulator port)', () => {
  it('robotic profile is metronomic: identical gaps, no errors', () => {
    const tr = profileTyper(TEXT, PROFILE_PRESETS.robotic, rng(1))
    const g = ikis(tr.keys)
    expect(new Set(g).size).toBe(1)
    expect(tr.errors).toBe(0)
    expect(replayTrace(tr.keys)).toBe(TEXT)
  })
  it('registry dispatches every model and keeps the invariant', () => {
    for (const m of ['markov', 'personality', 'robotic', 'profile:human', 'profile:expert', 'profile:nervous', 'profile:casual'] as const) {
      const tr = typeWith(m, TEXT, rng(5), { wpm: 55 })
      expect(replayTrace(tr.keys)).toBe(TEXT)
      expect(tr.keys.every((k, i) => i === 0 || k.t >= tr.keys[i - 1].t)).toBe(true)
    }
  })
})
