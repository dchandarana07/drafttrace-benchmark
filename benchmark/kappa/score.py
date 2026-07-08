#!/usr/bin/env python3
"""Cohen's kappa: independent adjudicator vs engine, per character, pooled.

Usage: python3 score.py adjudications.json
  adjudications.json = [{id, spans:[{start,end,origin}], ...}, ...]
Engine labels come from benchmark/kappa/docs/<id>.json ("engine" string).
Classes: T (typed) / A (ai) / C (cited) / U (uncited). Engine 'R' (residual)
positions are excluded and counted separately.
"""
import json, sys, os
from collections import Counter

CODE = {'ai': 'A', 'cited': 'C', 'uncited': 'U'}
adj = json.load(open(sys.argv[1]))
docs_dir = os.path.join(os.path.dirname(__file__), 'docs')

conf = Counter()          # (engine, judge) -> count
per_doc = []
residual = 0
for a in adj:
    d = json.load(open(os.path.join(docs_dir, a['id'] + '.json')))
    n = len(d['text'])
    judge = ['T'] * n
    for sp in a['spans']:
        s, e = max(0, sp['start']), min(n, sp['end'])
        for p in range(s, e):
            judge[p] = CODE[sp['origin']]
    agree = 0, 0
    ok = tot = 0
    for p, g in enumerate(d['engine']):
        if g == 'R':
            residual += 1
            continue
        conf[(g, judge[p])] += 1
        tot += 1
        if g == judge[p]:
            ok += 1
    per_doc.append((a['id'], tot, ok / tot if tot else 1.0))

N = sum(conf.values())
po = sum(v for (g, j), v in conf.items() if g == j) / N
classes = 'TACU'
pe = sum(
    (sum(v for (g, j), v in conf.items() if g == c) / N)
    * (sum(v for (g, j), v in conf.items() if j == c) / N)
    for c in classes
)
kappa = (po - pe) / (1 - pe) if pe < 1 else 1.0

print(f'docs={len(adj)}  chars={N}  residual_excluded={residual}')
print(f'observed agreement={po:.4f}  chance={pe:.4f}  Cohen_kappa={kappa:.4f}')
print('\nconfusion (engine rows -> judge cols):')
print('     ' + '  '.join(f'{c:>7}' for c in classes))
for g in classes:
    print(f'  {g}: ' + '  '.join(f'{conf[(g, j)]:>7}' for j in classes))
print('\nworst docs by agreement:')
for i, t, acc in sorted(per_doc, key=lambda x: x[2])[:5]:
    print(f'  {i}: {acc:.4f} over {t} chars')
