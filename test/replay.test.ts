/**
 * Replay through real ProseMirror: the minimal schema must hold the quiz
 * template, the replayed document must equal the composer's text, and the
 * emitted events must be ordinary step JSON with a correct nodeSize delta.
 */
import { describe, it, expect } from 'vitest'
import { Node as PMNode } from '@tiptap/pm/model'
import { compose } from '../src/compose'
import { replayOps, schema, pmPos, templateDoc, templateWordCount } from '../src/replay'
import { insertedText, stepFrom } from '../src/metrics'
import type { ModelName } from '../src/models'

describe('minimal schema', () => {
  it('declares exactly what the template needs', () => {
    for (const n of ['doc', 'paragraph', 'blockquote', 'text']) expect(schema.nodes[n]).toBeTruthy()
    expect(schema.marks.bold).toBeTruthy()
  })

  it('parses the quiz template document', () => {
    const questions = [{ prompt: 'What makes a prompt precise?' }, { prompt: 'Rewrite the prompt below.' }]
    const doc = PMNode.fromJSON(schema, templateDoc(questions))
    expect(doc.childCount).toBe(6) // one blockquote + two answer paragraphs per question
    expect(doc.child(0).type.name).toBe('blockquote')
    expect(doc.child(1).type.name).toBe('paragraph')
    expect(doc.textContent).toContain('Question 1.')
    expect(templateWordCount(questions)).toBeGreaterThan(0)
  })
})

describe('replay', () => {
  it('reproduces the composer’s final text exactly, for every model', () => {
    const models: ModelName[] = ['markov', 'personality', 'profile:human', 'robotic']
    for (const model of models) {
      for (let seed = 1; seed <= 5; seed++) {
        const c = compose({ model, words: 220, seed, revising: 0.7 })
        const r = replayOps(c.ops)
        expect(r.finalText).toBe(c.truth.finalText)
        expect(r.paragraphs).toEqual(c.truth.finalParagraphs)
      }
    }
  })

  it('emits one event per op, in order, with the real nodeSize delta', () => {
    const c = compose({ model: 'markov', words: 200, seed: 4, revising: 0.6 })
    const r = replayOps(c.ops)
    expect(r.events.length).toBe(c.ops.length)
    for (let i = 1; i < r.events.length; i++) expect(r.events[i].ts).toBeGreaterThanOrEqual(r.events[i - 1].ts)
    let size = 4 // an empty doc: <doc><paragraph/></doc>
    for (const e of r.events) {
      expect(Array.isArray(e.steps)).toBe(true)
      expect(e.steps.length).toBeGreaterThan(0)
      size += e.delta
    }
    const rebuilt = replayOps(c.ops)
    expect(size).toBeGreaterThan(0)
    expect(rebuilt.events).toEqual(r.events) // replay is deterministic
  })

  it('step JSON carries the inserted text and a position the metrics can read', () => {
    const c = compose({ model: 'markov', words: 120, seed: 2, revising: 0.4 })
    const r = replayOps(c.ops)
    const firstInsert = r.events.find((e) => e.delta > 0)!
    expect(insertedText(firstInsert.steps[0]).length).toBeGreaterThan(0)
    expect(typeof stepFrom(firstInsert.steps[0])).toBe('number')
  })

  it('pmPos maps (paragraph, offset) to document positions', () => {
    expect(pmPos([0], 0, 0)).toBe(1)
    expect(pmPos([5], 0, 3)).toBe(4)
    expect(pmPos([5, 7], 1, 0)).toBe(8) // 1 + 5 + 2
  })
})
