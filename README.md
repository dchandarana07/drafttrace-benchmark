# drafttrace-benchmark

An open benchmark for **writing-process recorders**: systems that record how a
document was written — keystroke by keystroke, revision by revision — rather
than only what it ended up saying.

It answers two questions that such a system has to be able to answer, and gives
you the apparatus to ask them of *your* system:

1. **Is the recording lossless?** Under a real class's load, with outages,
   retries, wrong clocks and closed tabs, does every keystroke reach the server,
   exactly once, in a form the server can replay back into the student's exact
   document?
2. **Do the process metrics mean what they say?** Do "typed characters",
   "revisions", "planning pauses" and the rest match what the writer actually
   did — checked against ground truth, not against a plausible-looking chart?

It also contains the uncomfortable third result: a well-built typing humanizer
is **not** separable from real writers by timing, and this benchmark ships the
humanizer so you can confirm that for yourself.

Everything is synthetic. No student writing is included, anywhere.

---

## Quick start

```bash
npm install
npm test                                  # 59 tests, a few seconds
npx tsx src/runners/run.ts --model markov --n 3 --words 200
```

The last command composes three writing sessions, replays them through real
ProseMirror, measures them with the engine-free metrics, prints the table, and
ends with:

```
ALL GROUND-TRUTH CHECKS PASSED
```

The whole model comparison:

```bash
npx tsx src/runners/run.ts --compare --n 10 --words 300
```

```
label                    words   wall   wpm   revs pburst pbmean  pbmax pause  inW preW preS preP nonlin ikiMean ikiMed ikiCV motCV mode5
MEAN(10)                 329.1   9.79  44.2  189.7   14.8  149.7  420.3  15.4  1.8  0.8 12.1  0.7   10.4   237.3  190.2  1.31  0.65  0.02   <- markov
MEAN(10)                 348.2   8.75  49.3   81.8   22.2   97.4  302.1  21.6  8.3  3.3  9.9  0.1   12.1   227.3  188.4  1.55  0.29  0.05   <- personality
MEAN(10)                 338.7   8.48  48.2     30   12.9  164.6  447.2  12.7  1.5  0.7 10.3  0.2    9.8   238.6  215.3   1.2  0.22  0.07   <- profile:human
MEAN(10)                 335.6   8.58  47.9     37   12.9  162.7  401.3  12.5    1  0.7 10.5  0.3   10.8   243.5  216.8  1.04  0.28  0.07   <- profile:nervous
MEAN(10)                 339.5   8.35  49.5   28.4   13.8  150.4    369  13.7  1.6    1 10.9  0.2   12.8   232.4  214.3  1.15  0.02  0.89   <- robotic
```

Read the last two columns: `motCV` is the variability of sub-second inter-key
intervals, `mode5` the share of intervals in one 5 ms bucket. The fixed-delay
bot is a metronome (0.02 / 0.89). The humanizer (0.65 / 0.02) sits inside the
range measured on 151 real writers.

---

## What is in the box

| Path | What it is |
|---|---|
| `src/models/` | Three seeded human-typing models, ported from public MIT projects (credited below). Same seed, same keystrokes. |
| `src/compose/` | The writer layer: planning pauses, mid-paragraph insertions, phrase deletions, tail rewrites, word swaps — and the exact ground truth of everything it did. Format: `docs/TRACE_FORMAT.md`. |
| `src/replay/` | Op trace → real ProseMirror transactions → the event stream a recorder would send. Minimal schema (doc/paragraph/blockquote/text/bold) built from `@tiptap/starter-kit`. |
| `src/metrics/` | Engine-free process metrics: typed characters, revisions, P-bursts, located planning pauses, non-linear edits, active time and rate, inter-key interval statistics. Definitions cited in the source. |
| `src/runners/run.ts` | Offline: compose → replay → measure → check against ground truth. |
| `src/runners/live.ts` | An API-level classroom against a running system. |
| `src/runners/browser.ts` | The same class in real Chrome, with real key events. |
| `tools/` | Cross-check against the original Python model; converter for a real human keystroke corpus. |
| `docs/` | The protocol, the formats, the scenario matrix, the human baseline. |
| `results/` | One implementation's runs, failures included. |
| `archive/kappa/` | An earlier, separately-scoped study kept because published work cites it. |

---

## Measuring your own system

The benchmark talks to a system under test over a documented HTTP +
ProseMirror-step protocol — **`docs/PROTOCOL.md`**, which is written to be
implementable by a tool with no connection to this project. In short: enter,
start (seeding the documented template document), post batches of events with a
`clientSeq` for idempotent retries, post snapshots, expose a server-side replay
at `GET /doc`, accept a submit, and expose an export.

```bash
# API tier: 100 students, 3 real minutes, 10 % network outages, ±10 min clock skew
API=https://your-host ADMIN_TOKEN=… npx tsx src/runners/live.ts \
  --token <entryToken> --students 100 --minutes 3 --offline 0.1 --skew 10

# Real browsers (needs Chrome/Chromium on the driving machine)
API=https://your-host npx tsx src/runners/browser.ts \
  --token <entryToken> --students 20 --minutes 3 --ui my-ui-profile.json
```

Page selectors for the browser tier are not hard-coded: copy
`src/runners/ui-profile.example.json`, point it at your own markup, and pass it
with `--ui`.

The scenarios, their expectations and how to score them are in
**`docs/SCENARIOS.md`**. There is no aggregate score. A scenario passes only if
every expectation holds, because the failure modes are not commensurable:
losing one keystroke in ten thousand is not "99.99 % good", it is a recorder
that loses keystrokes.

---

## The human baseline

`docs/HUMAN_BASELINE.md` explains how to obtain **KUPA-KEYS** (a keystroke
corpus from the ALTA Institute, University of Cambridge), convert it with
`tools/kupa/`, and measure it with the same code that measures the models. The
corpus is **not** redistributed here.

Motor-rhythm CV — the variability of sub-second inter-key intervals — over 151
real writers:

| n | min | p5 | median | max |
|---|---|---|---|---|
| 151 | **0.46** | 0.54 | 0.72 | 0.98 |

against the models:

| model | min | median | max | inside the human range? |
|---|---|---|---|---|
| `markov` (HumanTyping port) | 0.59 | 0.64 | 0.70 | **yes, every session** |
| `personality` (human-typer port) | 0.25 | 0.28 | 0.36 | no |
| fixed profiles (`profile:*`) | 0.01 | 0.02–0.33 | 0.42 | no |
| `robotic` (fixed delay) | 0.00 | 0.00 | 0.14 | no |

If you are evaluating a system that claims to detect scripted typing, run it
against `--model markov` and publish what happens.

---

## Honest limits

Read these before quoting anything from here.

- **The humanizer is not caught.** Timing alone does not separate a good
  humanizer from a person. The structure of revision is the next lever; this
  harness measures it but does not yet turn it into a discriminator.
- **The human baseline is one corpus, one task, one recording setup.** 151
  writers typing an essay in a browser textarea. It is a measurement of that
  population — not a false-positive rate, and not evidence about a different
  keyboard, language, device, or a writer with a motor impairment. A person can
  sit below the floor; this corpus did not contain one.
- **No number here should be used to accuse anyone of anything.** A low
  variability score is evidence that timing was unusually regular. That is all
  it is.
- **The browser tier has real ceilings.** The hidden-tab scenario is a shim
  (real background timer throttling cannot be induced through the automation
  protocol); request loss is injected in the automation layer, not on a
  network; every browser shares one machine, one NIC and one IP. Above roughly
  30 concurrent browsers, cold-load times describe the *client*, not the system
  under test.
- **No real-room evidence.** 100 cold page loads on one access point,
  backgrounded tabs on real laptops and real laptop clocks need people in a
  room. Nothing here substitutes for that.
- **The document model is narrower than production**: no paragraph joins,
  marks, lists, selection-replace typing or undo (`docs/TRACE_FORMAT.md`). A
  real recorder ingests a superset of what this exercises.
- **`results/` is one implementation measuring itself.** That circularity is
  precisely what this repository exists to let someone else break.

The full list, with the specific things each tier cannot tell you, is at the
end of `docs/SCENARIOS.md`.

---

## Credits

The keystroke models are re-implementations, in TypeScript, of three
MIT-licensed open-source projects. All three are original work by their
authors; the ports exist so that the whole harness is one seeded, deterministic
program.

- **Lax3n/HumanTyping** — <https://github.com/Lax3n/HumanTyping> — the
  semi-Markov model with keyboard distance, bigram bursts, error noticing and
  fatigue. Ported as `markovTyper`; cross-checked against the original with
  `tools/xcheck_py.py` (300 runs each: total time 62.4 s vs 63.0 s, inter-key
  mean 218 ms vs 217 ms, CV 0.67 vs 0.66).
- **Shawn-Falconbury/human-typer** —
  <https://github.com/Shawn-Falconbury/human-typer> — the typist-personality
  layer with grooves, fatigue, thinking pauses and delayed corrections. Ported
  as `personalityTyper`.
- **djeada/Type-Simulator** — <https://github.com/djeada/Type-Simulator> — the
  fixed profiles, including the `robotic` baseline. Ported as
  `PROFILE_PRESETS`.

Metric definitions follow the keystroke-logging literature — the 2 s pause
threshold and pause-location taxonomy, P-bursts, and Inputlog's treatment of
distant revisions and production rate. The citations are in
`src/metrics/index.ts`, next to the code they justify.

The human baseline uses **KUPA-KEYS** (ALTA Institute, University of
Cambridge), obtained and licensed separately.

---

## Citation

<!-- Replace with the published reference once it is available. -->

```bibtex
@misc{drafttrace-benchmark,
  title  = {DraftTrace Benchmark: an open benchmark for writing-process recorders},
  author = {Chandarana, Divyansh},
  year   = {2026},
  url    = {https://github.com/dchandarana07/drafttrace-benchmark}
}
```

## Licence

- **Code** (`src/`, `test/`, `tools/`): MIT — see [`LICENSE`](LICENSE).
- **Data** (`results/`, `archive/`, the measured distributions in `docs/`):
  CC BY 4.0 — see [`LICENSE-DATA`](LICENSE-DATA).

The upstream model projects are MIT and are credited above. KUPA-KEYS is not
redistributed here and carries its own licence.
