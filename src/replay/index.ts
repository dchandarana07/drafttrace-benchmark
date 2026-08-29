/**
 * REPLAY — operation trace => genuine ProseMirror transactions => the exact
 * event stream a browser recorder would have sent.
 *
 * Positions are computed from the same paragraph model the composer uses, so
 * an insert "at char 57 of paragraph 2" becomes a ReplaceStep at the real
 * document position. The final document is then read back and compared with
 * the composer's final text — the replay's own correctness oracle, and the
 * reason a step trace produced here is meaningful to any other ProseMirror
 * system that starts from the same base document.
 */
import { EditorState, type Transaction } from '@tiptap/pm/state'
import { schema } from './schema'
import type { Op } from '../compose'
import type { SessionEvent } from '../types'

export { schema } from './schema'
export { templateDoc, templateWordCount, type TemplateQuestion, type TemplateJSON } from './quizTemplate'

/** PM position of (paragraph index, char offset) in a doc of plain paragraphs. */
export function pmPos(paraLens: number[], para: number, at: number): number {
  let pos = 1 // inside the first paragraph
  for (let i = 0; i < para; i++) pos += paraLens[i] + 2 // close + open tokens
  return pos + at
}

export type Replayed = { events: SessionEvent[]; finalText: string; paragraphs: string[] }

export function replayOps(ops: Op[], opts: { source?: string } = {}): Replayed {
  let state = EditorState.create({ schema })
  const events: SessionEvent[] = []
  const lens: number[] = [0]
  const emit = (tr: Transaction, ts: number) => {
    const before = state.doc.nodeSize
    state = state.apply(tr)
    events.push({
      ts: Math.round(ts),
      source: opts.source ?? 'input',
      delta: state.doc.nodeSize - before,
      steps: tr.steps.map((s) => s.toJSON() as Record<string, unknown>),
    })
  }
  for (const op of ops) {
    if (op.op === 'insert') {
      const pos = pmPos(lens, op.para, op.at)
      emit(state.tr.insertText(op.text, pos), op.t)
      lens[op.para] += op.text.length
    } else if (op.op === 'delete') {
      const from = pmPos(lens, op.para, op.from)
      const to = pmPos(lens, op.para, op.to)
      emit(state.tr.delete(from, to), op.t)
      lens[op.para] -= op.to - op.from
    } else {
      const pos = pmPos(lens, op.para, op.at)
      emit(state.tr.split(pos), op.t)
      const tail = lens[op.para] - op.at
      lens[op.para] = op.at
      lens.splice(op.para + 1, 0, tail)
    }
  }
  const paragraphs: string[] = []
  state.doc.forEach((node) => { paragraphs.push(node.textContent) })
  return { events, finalText: paragraphs.join('\n'), paragraphs }
}
