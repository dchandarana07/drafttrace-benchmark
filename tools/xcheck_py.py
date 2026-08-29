"""
Cross-check the Markov port against the ORIGINAL Python project.

The TypeScript model in src/models is a re-implementation, not a binding, so
the only honest way to claim fidelity is to run both on the same text and
compare the distributions. This script drives the upstream project; its
companion, tools/xcheck_ts.ts, drives the port. Run both, compare the lines.

    git clone https://github.com/Lax3n/HumanTyping /tmp/HumanTyping
    pip install numpy
    python3 tools/xcheck_py.py /tmp/HumanTyping
    npx tsx tools/xcheck_ts.ts

Reference figures measured with 300 runs at a nominal 60 WPM (see
docs/HUMAN_BASELINE.md): total time 62.4 s (original) vs 63.0 s (port); mean
inter-key interval 218 ms vs 217 ms; interval CV 0.67 vs 0.66.
"""
import sys
import numpy as np

sys.path.insert(0, sys.argv[1])
from humantyping.typer import MarkovTyper  # noqa: E402  (path set above)

TEXT = ('A prompt is the instruction given to a language model. The wording matters because small '
        'changes in phrasing change what the model attends to, and therefore what it produces. '
        'Precise prompts state the task, the audience, the constraints and the format.')

np.random.seed(1)
times, errs, bks, ikis = [], [], [], []
for _ in range(300):
    typer = MarkovTyper(TEXT, target_wpm=60)
    total, hist = typer.run()
    times.append(total)
    errs.append(sum(1 for h in hist if 'ERROR' in h[1] or 'SWAP' in h[1]))
    bks.append(sum(1 for h in hist if 'BACKSPACE' in h[1]))
    ikis += list(np.diff([h[0] for h in hist[1:]]))

ik = np.array(ikis)
print(f"python original: mean total {np.mean(times):.2f}s sd {np.std(times):.2f} | "
      f"errors/run {np.mean(errs):.2f} | backspaces/run {np.mean(bks):.2f} | "
      f"IKI mean {ik.mean() * 1000:.0f}ms CV {ik.std() / ik.mean():.2f} | "
      f"eff wpm {len(TEXT) / 5 / (np.mean(times) / 60):.1f}")
