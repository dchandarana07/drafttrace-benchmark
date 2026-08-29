/**
 * WRITER LAYER — how a person composes a text, not just how they type it.
 *
 * The keystroke models (src/models) know how a hand types a given string. A
 * writer does more than type: they plan, pause to think, re-read, go back and
 * insert a sentence in the middle of a paragraph, delete a phrase, rewrite the
 * tail of what they just wrote, swap a word. This module composes an essay of
 * a requested length out of a sentence bank and produces a time-stamped
 * OPERATION TRACE of the whole writing session — every keystroke placed at a
 * real character position — plus the EXACT ground truth of what happened
 * (final text, typed chars, deletions, pauses, non-linear edits), so a system
 * under test can be compared against what was actually done.
 *
 * The op trace is the benchmark's portable interchange format; it is specified
 * in docs/TRACE_FORMAT.md. Output is model-agnostic: any keystroke model plugs
 * in for the typing of each chunk; the composer owns the structure and the
 * long pauses. Same options + same seed => byte-identical trace.
 */
import { type Rng, rng, uniform, pick, typeWith, type ModelName, type KeystrokeTrace } from '../models'

// ── operation trace ───────────────────────────────────────────────────────
export type Op =
  | { t: number; op: 'insert'; para: number; at: number; text: string }
  | { t: number; op: 'delete'; para: number; from: number; to: number }
  | { t: number; op: 'split'; para: number; at: number } // Enter → new paragraph after `para` at char `at`
export type Truth = {
  finalParagraphs: string[]
  finalText: string
  /** characters typed (including ones later deleted) */
  typedChars: number
  /** keystrokes that removed text (backspaces + phrase deletions) */
  deletions: number
  /** pauses >= 2000 ms between consecutive ops */
  cognitivePauses: number
  /** revisions that jumped away from the writing point (insert mid-text, delete elsewhere) */
  nonLinearEdits: number
  /** words in the final text */
  words: number
  /** sentences inserted mid-paragraph after the fact */
  midInsertions: number
  phraseDeletions: number
  tailRewrites: number
  wordSwaps: number
  wallMs: number
  model: ModelName
  nominalWpm: number
}
export type Composition = { ops: Op[]; truth: Truth; label: string }

// ── sentence bank (topic: prompting, to match the pilot quiz) ─────────────
const BANK = [
  'A prompt is the instruction a person gives to a language model.',
  'The wording of a prompt matters because the model attends to the exact words it is given.',
  'Small changes in phrasing can change the format, the length and the focus of the answer.',
  'A precise prompt names the task, the audience, the constraints and the expected output.',
  'Vague prompts leave the model to guess, and the guesses are rarely the ones we wanted.',
  'Giving an example of the desired output is often more effective than describing it.',
  'Telling the model what to avoid is useful, but telling it what to do is more reliable.',
  'Breaking a large request into steps makes each step easier to check.',
  'Context that the model cannot see must be stated explicitly in the prompt.',
  'Asking for a specific length keeps the answer from drifting into a lecture.',
  'When the first answer misses, rewording the question is faster than arguing with it.',
  'A good prompt reads like a clear brief to a capable but literal colleague.',
  'Specifying the role, such as a tutor or an editor, changes the tone of the response.',
  'It helps to say who the reader is and what they already know.',
  'Constraints such as a word limit or a required structure reduce ambiguity.',
  'Asking the model to show its reasoning makes mistakes easier to spot.',
  'A prompt that mixes several questions usually gets a shallow answer to each.',
  'Iterating on a prompt is normal; the first draft is a starting point, not a verdict.',
  'The model does not know what you meant, only what you wrote.',
  'Ambiguous pronouns and undefined terms are the most common sources of confusion.',
  'Providing the input data in a clean format prevents the model from misreading it.',
  'Requesting a particular output format, like a table or a list, makes the result easier to use.',
  'A rewritten prompt should keep the original goal while removing the guesswork.',
  'Each change to a prompt should have a reason that can be explained in one sentence.',
  'Testing a prompt on a few varied inputs reveals whether it generalises.',
  'Clarity, not cleverness, is what makes a prompt work.',
  'The best prompts are boring to read and precise about what they want.',
  'Explaining the purpose behind a request helps the model make sensible trade-offs.',
  'Negative examples show the model what a wrong answer looks like.',
  'A short checklist at the end of a prompt is an easy way to enforce requirements.',
  'Models are sensitive to the order of instructions, so the most important ones should come first.',
  'Repeating a critical constraint once is fine; repeating it five times adds noise.',
  'If the task needs facts the model may not have, the prompt should supply them.',
  'Setting the expected level of detail avoids both one-line answers and essays.',
  'Reviewing the output against the original request closes the loop.',
  'In practice, prompting is a conversation, and the prompt is only the opening move.',
]
const ALT_WORDS: Record<string, string[]> = {
  precise: ['specific', 'exact'], vague: ['unclear', 'fuzzy'], model: ['system', 'assistant'], answer: ['response', 'output'],
  useful: ['helpful', 'handy'], reliable: ['dependable', 'consistent'], easier: ['simpler'], clear: ['plain', 'explicit'],
  small: ['minor', 'tiny'], good: ['strong', 'solid'], normal: ['expected', 'usual'], common: ['frequent', 'typical'],
}

export type ComposeOptions = {
  model: ModelName
  /** target words in the FINAL text */
  words: number
  /** nominal typing speed handed to the keystroke model */
  wpm?: number
  /** writer temperament: how much revising / pausing happens (0 = linear transcription, 1 = restless) */
  revising?: number
  paragraphs?: number
  seed: number
  label?: string
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length

export function compose(o: ComposeOptions): Composition {
  const r = rng(o.seed)
  const revising = o.revising ?? 0.6
  const paraCount = o.paragraphs ?? Math.max(2, Math.round(o.words / 130))
  const model = o.model
  const wpm = o.wpm ?? Math.round(uniform(r, 42, 72))

  // Plan: sentences per paragraph until the word budget is met.
  const plan: string[][] = []
  let budget = o.words
  const used = new Set<number>()
  const nextSentence = () => {
    let i = Math.floor(r() * BANK.length)
    for (let k = 0; k < BANK.length && used.has(i); k++) i = (i + 1) % BANK.length
    used.add(i)
    return BANK[i]
  }
  for (let p = 0; p < paraCount; p++) {
    const sents: string[] = []
    const target = Math.round(budget / (paraCount - p))
    let w = 0
    while (w < target || sents.length < 2) {
      const s = nextSentence()
      sents.push(s)
      w += wordCount(s)
      if (used.size >= BANK.length) { used.clear() }
    }
    budget -= w
    plan.push(sents)
  }

  // Live document state (mirrors what the editor will hold) — paragraphs of plain text.
  const paras: string[] = ['']
  const ops: Op[] = []
  let t = 1000
  let typed = 0, deletions = 0, pauses = 0, nonLinear = 0
  let midInsertions = 0, phraseDeletions = 0, tailRewrites = 0, wordSwaps = 0
  let lastPara = 0, lastAt = 0

  const pause = (ms: number) => { if (ms >= 2000) pauses++; t += ms }
  const noteJump = (para: number, at: number) => {
    if (para !== lastPara || Math.abs(at - lastAt) > 12) nonLinear++
  }

  /** Type `text` at (para, at) through the keystroke model; the model's typos
   *  and backspaces are placed at the cursor. */
  const typeAt = (para: number, at: number, text: string) => {
    const tr: KeystrokeTrace = typeWith(model, text, r, { wpm })
    let cursor = at
    let prev = 0
    for (const k of tr.keys) {
      const dt = k.t - prev
      prev = k.t
      if (dt >= 2000) pauses++
      t += dt
      if (k.kind === 'char') {
        ops.push({ t, op: 'insert', para, at: cursor, text: k.ch })
        paras[para] = paras[para].slice(0, cursor) + k.ch + paras[para].slice(cursor)
        cursor += 1
        typed += 1
      } else {
        ops.push({ t, op: 'delete', para, from: cursor - 1, to: cursor })
        paras[para] = paras[para].slice(0, cursor - 1) + paras[para].slice(cursor)
        cursor -= 1
        deletions += 1
      }
      lastPara = para; lastAt = cursor
    }
    return cursor
  }

  const sentenceStarts = (para: number) => {
    const s = paras[para]
    const starts = [0]
    for (let i = 0; i < s.length - 1; i++) if ('.!?'.includes(s[i]) && s[i + 1] === ' ') starts.push(i + 2)
    return starts
  }

  for (let p = 0; p < plan.length; p++) {
    if (p > 0) {
      // Enter → new paragraph, with a paragraph-planning pause
      pause(uniform(r, 1200, 4500) * (0.6 + revising))
      const at = paras[p - 1].length
      ops.push({ t, op: 'split', para: p - 1, at })
      paras.push('')
      lastPara = p; lastAt = 0
    }
    for (let si = 0; si < plan[p].length; si++) {
      const sentence = plan[p][si]
      // sentence-planning pause: mostly short, sometimes a real think
      const roll = r()
      if (roll < 0.45 * (0.5 + revising)) pause(uniform(r, 700, 2800))
      else if (roll < 0.55 * (0.5 + revising)) pause(uniform(r, 3000, 12000))
      const lead = paras[p].length > 0 ? ' ' : ''
      typeAt(p, paras[p].length, lead + sentence)

      // ── revisions, in proportion to the writer's temperament ──
      // (a) rewrite the tail: backspace the last 1–4 words and retype differently
      if (r() < 0.18 * revising && si > 0) {
        const words = paras[p].split(' ')
        const k = 1 + Math.floor(r() * Math.min(4, words.length - 2))
        const cut = words.slice(-k).join(' ').length
        pause(uniform(r, 600, 2500))
        for (let i = 0; i < cut; i++) {
          t += uniform(r, 60, 140)
          const len = paras[p].length
          ops.push({ t, op: 'delete', para: p, from: len - 1, to: len })
          paras[p] = paras[p].slice(0, -1)
          deletions++
        }
        lastPara = p; lastAt = paras[p].length
        const replacement = pick(r, ['which is the whole point.', 'and that is what matters here.', 'as the examples above show.', 'in most practical cases.'])
        typeAt(p, paras[p].length, replacement.startsWith(' ') ? replacement : ' ' + replacement.replace(/\.$/, '') + '.')
        tailRewrites++
      }
      // (b) go back and insert a sentence in the middle of this paragraph
      if (r() < 0.22 * revising && si >= 1) {
        const starts = sentenceStarts(p)
        const at = starts[1 + Math.floor(r() * (starts.length - 1))] ?? paras[p].length
        pause(uniform(r, 1500, 6000)) // re-read, decide
        noteJump(p, at)
        const extra = nextSentence()
        // insert "Sentence " before the existing sentence at `at`
        const end = typeAt(p, at, extra + ' ')
        void end
        midInsertions++
        // return to the end of the paragraph to continue
        lastPara = p; lastAt = paras[p].length
        nonLinear++ // the jump back to the end
      }
      // (c) delete a phrase somewhere earlier in the paragraph (selection + Delete)
      if (r() < 0.14 * revising && paras[p].length > 80) {
        const s = paras[p]
        const words = s.split(' ')
        if (words.length > 10) {
          const wi = 2 + Math.floor(r() * (words.length - 8))
          const wn = 2 + Math.floor(r() * 4)
          const from = words.slice(0, wi).join(' ').length + 1
          const to = Math.min(s.length, from + words.slice(wi, wi + wn).join(' ').length + 1)
          if (to > from && to < s.length) {
            pause(uniform(r, 1200, 4000))
            noteJump(p, from)
            ops.push({ t, op: 'delete', para: p, from, to })
            paras[p] = s.slice(0, from) + s.slice(to)
            deletions++
            phraseDeletions++
            lastPara = p; lastAt = paras[p].length
            nonLinear++
          }
        }
      }
      // (d) swap a word for a synonym somewhere earlier
      if (r() < 0.16 * revising) {
        const s = paras[p]
        const cands = Object.keys(ALT_WORDS).filter((w) => new RegExp(`\\b${w}\\b`).test(s))
        if (cands.length) {
          const w = pick(r, cands)
          const from = s.search(new RegExp(`\\b${w}\\b`))
          if (from >= 0 && from < s.length - 20) {
            pause(uniform(r, 900, 3000))
            noteJump(p, from)
            ops.push({ t, op: 'delete', para: p, from, to: from + w.length })
            paras[p] = s.slice(0, from) + s.slice(from + w.length)
            deletions++
            typeAt(p, from, pick(r, ALT_WORDS[w]))
            wordSwaps++
            lastPara = p; lastAt = paras[p].length
            nonLinear++
          }
        }
      }
    }
    // re-read the paragraph
    if (r() < 0.35 * revising) pause(uniform(r, 4000, 20000))
  }

  const finalText = paras.join('\n')
  // Cognitive pauses by the METRIC definition (a >=2 s gap between
  // consecutive events), derived from the trace itself rather than counted
  // as they were generated — two sub-threshold gaps with no key between them
  // (a planning pause followed by a slow first keystroke) merge into one.
  let pausesExact = 0
  for (let i = 1; i < ops.length; i++) if (ops[i].t - ops[i - 1].t >= 2000 && ops[i].t - ops[i - 1].t < 180_000) pausesExact++
  pauses = pausesExact
  return {
    ops,
    label: o.label ?? `${model}@${wpm}wpm`,
    truth: {
      finalParagraphs: [...paras], finalText, typedChars: typed, deletions, cognitivePauses: pauses,
      nonLinearEdits: nonLinear, words: wordCount(finalText), midInsertions, phraseDeletions, tailRewrites, wordSwaps,
      wallMs: t - 1000, model, nominalWpm: wpm,
    },
  }
}

/** Apply ops to plain paragraphs — the oracle used by tests to prove the op
 *  trace is self-consistent with the composer's own final text. */
export function applyOps(ops: Op[]): string[] {
  const paras: string[] = ['']
  for (const op of ops) {
    if (op.op === 'insert') paras[op.para] = paras[op.para].slice(0, op.at) + op.text + paras[op.para].slice(op.at)
    else if (op.op === 'delete') paras[op.para] = paras[op.para].slice(0, op.from) + paras[op.para].slice(op.to)
    else {
      const tail = paras[op.para].slice(op.at)
      paras[op.para] = paras[op.para].slice(0, op.at)
      paras.splice(op.para + 1, 0, tail)
    }
  }
  return paras
}
