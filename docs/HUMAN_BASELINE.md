# The human baseline

The models in `src/models` are supposed to type like people. That claim is only
worth something against real keystroke data, measured by the same code. This
document says which corpus, how to obtain it, how to convert it, what was
measured, and — at the end — what the measurement does not license you to
claim.

---

## The corpus: KUPA-KEYS

**KUPA-KEYS** is a keystroke corpus collected by the ALTA Institute at the
University of Cambridge: adults writing short essays in a browser textarea,
with every key event logged (timestamp, type, text, caret position, selection).

- Hugging Face: <https://huggingface.co/datasets/ALTACambridge/KUPA-KEYS>
- Licence: the dataset's own (Creative Commons). Read it and comply with it;
  **this benchmark does not redistribute the corpus or any part of it.**

```bash
pip install -U huggingface_hub
huggingface-cli download ALTACambridge/KUPA-KEYS --repo-type dataset --local-dir data/kupa
```

Everything under `data/` is gitignored.

## Converting it

Two steps: a Python extractor that reads the corpus's CSVs, and a TypeScript
converter that replays each participant through the same ProseMirror path the
simulator uses — so a real writer and a simulated one reach the metrics by
identical code.

```bash
# 1. corpus CSVs -> intermediate per-participant traces
python3 tools/kupa/extract.py \
    data/kupa/keystrokes.csv data/kupa/traces.json 200 data/kupa/participants.csv

# 2. traces -> this benchmark's event format
npx tsx tools/kupa/convert.ts data/kupa/traces.json data/kupa-sessions.json 200

# 3. measure them next to the models
npx tsx tools/motor-cv.ts 24 data/kupa-sessions.json
npx tsx src/runners/run.ts --compare --n 10 --words 300 --kupa data/kupa-sessions.json
```

The extractor keeps participants with at least 150 words and 400 key events.
The converter drops any participant whose trace needs caret clamping more than
5 % of the time, rather than silently repairing it. Column names come from the
corpus's own schema; if a release renames them, `extract.py` is the one file to
edit.

**Fidelity notes**, worth repeating in any write-up: the corpus is a plain
textarea, so a session is replayed as ONE paragraph (newlines become spaces);
selections visible in the log are applied as a delete plus an input;
multi-character inputs (autocorrect, IME commits, paste) stay as one event, as
a recorder would see them, and are therefore excluded from the inter-key
interval series.

---

## What was measured

151 writers converted and measured with `src/metrics`. The statistic is the
**motor-rhythm CV**: the coefficient of variation of inter-key intervals below
one second — the typing rhythm with the thinking pauses removed.

### Real writers

| n | min | p5 | median | max |
|---|---|---|---|---|
| 151 | **0.46** | 0.54 | 0.72 | 0.98 |

The minimum is the number that matters: 0.46 is the least variable *real*
writer in this corpus. Anything below it is unusual for this population.

### The models

24 sessions per model, 250 words, revising 0.2–1.0
(`npx tsx tools/motor-cv.ts`):

| model | motor CV min | median | max | 5 ms mode share (median) | inside the human range? |
|---|---|---|---|---|---|
| `markov` (HumanTyping port) | 0.59 | 0.64 | 0.70 | 0.02 | **yes — every session** |
| `personality` (human-typer port) | 0.25 | 0.28 | 0.36 | 0.05 | no |
| `profile:casual` | 0.23 | 0.33 | 0.42 | 0.04 | no |
| `profile:nervous` | 0.20 | 0.29 | 0.35 | 0.07 | no |
| `profile:human` | 0.15 | 0.21 | 0.29 | 0.07 | no |
| `profile:expert` | 0.01 | 0.02 | 0.12 | 0.49 | no |
| `robotic` (fixed delay) | 0.00 | 0.00 | 0.14 | 0.99 | no |

These constants live in `src/metrics/baseline.ts` and are pinned by
`test/separability.test.ts`, so a change to the models cannot quietly move the
picture.

### The Markov port against its original

The port is a re-implementation, not a binding, so fidelity is a measurement
too (`tools/xcheck_py.py` + `tools/xcheck_ts.ts`, 300 runs each at a nominal
60 WPM):

| | original (Python) | port (TypeScript) |
|---|---|---|
| mean total time | 62.4 s | 63.0 s |
| mean inter-key interval | 218 ms | 217 ms |
| inter-key CV | 0.67 | 0.66 |

---

## How to read this

**The one-line summary:** a fixed-delay or fixed-profile bot is trivially
separable from real writers on timing alone; a well-built humanizer is not
separable at all.

That second half is the useful half. If you are evaluating a system that claims
to detect scripted typing, run it against `--model markov` and report what
happens. The reference implementation does not catch it either, and says so.

## What this does NOT license you to claim

- **Not a false-positive rate.** One corpus, one task, one recording setup,
  151 writers, all typing an essay in a browser textarea. It says nothing about
  a different keyboard layout, a different language, a mobile device, an
  assistive input method, or a writer with a motor impairment. A person can sit
  below 0.46; this corpus simply did not contain one.
- **Not a detector.** Motor-rhythm CV is one statistic. Publishing a threshold
  next to it would invite exactly the misuse this document is trying to
  prevent: a low CV is *evidence that timing is unusually regular*, not
  evidence of misconduct, and no number in this repository should be used to
  accuse anybody of anything.
- **Not an upper bound on humanizers.** The three models here are public
  projects from 2023–2025. The right reading of the table is "the best of these
  three already defeats timing analysis", not "0.46 is where bots stop".
- **In-sample.** The floor was measured on the same corpus used to sanity-check
  the models. Report the margin, not a clean separation.
