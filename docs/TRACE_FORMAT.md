# The op trace

The op trace is what the writer layer (`src/compose`) produces and everything
else consumes. It is deliberately simpler than a ProseMirror step log: a
position in a plain-paragraph document, a timestamp, and what happened there.
Steps are derived from it (`src/replay`); keyboard actions for a real browser
are derived from it (`src/runners/browser.ts`); the ground truth is derived
from it. If you want to plug your own writer generator into this benchmark,
emit this and everything downstream works.

## Document model

A document is an array of paragraphs of plain text. Paragraph indices are
zero-based and stable: a `split` inserts a new paragraph immediately after the
one it split. Character offsets are into the paragraph's own string.

That is the entire model. It has no marks, no lists, no tables, no nested
blocks — see "Limits" below.

## Operations

```ts
type Op =
  | { t: number; op: 'insert'; para: number; at: number; text: string }
  | { t: number; op: 'delete'; para: number; from: number; to: number }
  | { t: number; op: 'split';  para: number; at: number }
```

| Field | Meaning |
|---|---|
| `t` | Milliseconds since the session started. Sessions start at `t = 1000`. |
| `para` | Index of the paragraph the operation applies to. |
| `at` | Character offset the text is inserted at / the paragraph is split at. |
| `from`, `to` | Half-open character range removed (`to` exclusive). |
| `text` | The inserted text. One character per op when it came from a keystroke. |

Invariants, all checked by `test/compose.test.ts`:

- `t` is non-decreasing.
- Every op is applicable to the document as it stands at that moment: offsets
  are within the paragraph, and `from < to`.
- Applying the whole trace to `['']` reproduces the composer's final text —
  `applyOps(ops).join('\n') === truth.finalText`.
- A keystroke insert carries exactly one character. Multi-character inserts
  exist only where a *real* editor would produce one (an imported human trace
  with an autocorrect or paste event).

## Ground truth

Every composition ships with what actually happened, so a measurement can be
checked rather than believed:

```ts
type Truth = {
  finalParagraphs: string[]
  finalText: string
  typedChars: number       // characters typed, INCLUDING ones later deleted
  deletions: number        // ops that removed text (backspaces + phrase deletes)
  cognitivePauses: number  // gaps >= 2 s and < 3 min between consecutive ops
  nonLinearEdits: number   // edits that jumped away from the writing point
  words: number            // words in the final text
  midInsertions: number    // sentences inserted mid-paragraph after the fact
  phraseDeletions: number  // phrases selected and deleted somewhere earlier
  tailRewrites: number     // "backspace the last few words and say it differently"
  wordSwaps: number        // a word replaced by a synonym earlier in the text
  wallMs: number
  model: ModelName
  nominalWpm: number
}
```

`cognitivePauses` is computed from the finished trace, not counted as the
session was generated: two sub-threshold gaps with no keystroke between them (a
planning pause followed by a slow first keystroke) are one gap, which is what a
recorder would see.

## From op trace to events

`replayOps(ops)` applies each op to a real ProseMirror document and emits one
event per op:

```ts
{ ts, source: 'input', delta /* nodeSize change */, steps: [ step.toJSON() ] }
```

The mapping from `(para, at)` to a document position is
`pmPos(paragraphLengths, para, at)` — one token for the paragraph's own open
tag, plus two tokens per preceding paragraph boundary. Because the replay
carries the paragraph lengths forward as it goes, an op recorded against
paragraph 2 lands where the writer meant it even after earlier paragraphs have
changed length.

## Determinism

`compose(options)` is a pure function of its options, including `seed`. The
same options give a byte-identical trace on any machine and any Node version;
`replayOps` is likewise deterministic. This is what makes a benchmark result
reproducible rather than merely repeatable.

## Limits

The writer layer models the operations a student performs in a plain prose
answer. It does NOT produce:

- paragraph joins (backspace at the start of a paragraph);
- marks, lists, tables or any other structure;
- typing over a selection (select-then-type), or undo/redo;
- multi-paragraph pastes.

A production recorder therefore ingests a superset of the step shapes this
benchmark exercises. Say so when reporting a result. (Imported human traces —
`tools/kupa` — do add multi-character inserts and selection replacement, which
is part of why they are worth converting.)
