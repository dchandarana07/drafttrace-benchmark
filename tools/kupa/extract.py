"""
Extract per-participant key traces from the KUPA-KEYS keystroke corpus.

    python3 tools/kupa/extract.py <keystrokes.csv> <out.json> <maxParticipants> <participants.csv>

Reads the corpus's raw keystroke log (one row per key event) plus the
participant metadata table, and writes a compact intermediate JSON that
tools/kupa/convert.ts turns into this benchmark's event format. Participants
with fewer than 150 words or fewer than 400 key events are dropped.

Each retained participant becomes {id, native, layout, words, cefr, keys},
where every key is [timeMs, kind, text, caret, selStart, selEnd] and kind is
one of: i(nput), b(ackspace), d(elete), m(ove), c(lick).

The corpus itself is NOT redistributed with this benchmark; obtain it from its
own source under its own licence. See docs/HUMAN_BASELINE.md.
"""
import csv, json, sys, collections
src = sys.argv[1]; out = sys.argv[2]; maxp = int(sys.argv[3])
meta = {r['id']: r for r in csv.DictReader(open(sys.argv[4], newline='', encoding='utf-8'))}
# pick participants with a complete essay (>=150 words) — first N by file order
traces = collections.OrderedDict()
cur = None
last_sel = (None, None)
with open(src, newline='', encoding='utf-8') as f:
    rd = csv.DictReader(f)
    for r in rd:
        pid = r['id']
        if pid != cur:
            if len(traces) >= maxp: break
            cur = pid
            m = meta.get(pid, {})
            traces[pid] = {'id': pid, 'native': (m.get('nativelang') == 'English'), 'layout': m.get('layoutnow'), 'words': int(float(m.get('task2_words') or 0)), 'cefr': m.get('cefr_h1'), 'keys': []}
        t = float(r['time'])
        typ = r['type']
        if typ == 'down':
            try: last_sel = (int(float(r['range_start'])), int(float(r['range_end'])))
            except: last_sel = (None, None)
        if typ == 'input':
            rs = r['range_start']; re_ = r['range_end']
            txt = r['text']
            try: pos = int(float(rs))
            except: pos = None
            ss, se = last_sel
            traces[pid]['keys'].append([round(t), 'i', txt, pos, ss, se])
            last_sel = (None, None)
        elif typ == 'down' and r['key'] in ('Backspace', 'Delete'):
            ss, se = last_sel
            try: pos = int(float(r['range_start']))
            except: pos = None
            traces[pid]['keys'].append([round(t), 'b' if r['key']=='Backspace' else 'd', '', pos, ss, se])
        elif typ == 'down' and r['key'] in ('ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'):
            traces[pid]['keys'].append([round(t), 'm', r['key'], None])
        elif typ == 'click':
            try: pos = int(float(r['range_start']))
            except: pos = None
            traces[pid]['keys'].append([round(t), 'c', '', pos])
keep = [v for v in traces.values() if v['words'] >= 150 and len(v['keys']) > 400]
json.dump(keep, open(out, 'w'))
print(f"participants scanned={len(traces)} kept={len(keep)} native={sum(1 for v in keep if v['native'])}")
