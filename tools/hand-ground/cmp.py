# Lead (2026-11-10): python -I cmp.py <a.jsonl[,a2.jsonl]> <b.jsonl[,b2.jsonl]> [min]
# Two netscan runs by stop (road + station): totals over the stops both have, and the stops where b is worse than a
# by more than min (default 20) in any count.
import sys, json
K = ['hole', 'pit', 'zfight', 'gOver', 'hfight', 'hOver', 'xrun', 'xrunF', 'xself', 'xselfF', 'xadj', 'xadjF', 'buried', 'bored', 'hover', 'wall', 'seam', 'float', 'sunk', 'onroad']
def load(arg):
    R = {}
    for f in arg.split(','):
        for l in open(f, encoding='utf-8'):
            l = l.strip()
            if not l: continue
            r = json.loads(l)
            if r.get('cells') is None: continue
            R[(r.get('road'), r.get('st'))] = r
    return R
def n(r, k):
    v = r.get(k)
    return len(v) if isinstance(v, (list, dict)) else (v or 0)
A, B = load(sys.argv[1]), load(sys.argv[2]); mn = float(sys.argv[3]) if len(sys.argv) > 3 else 20
both = [k for k in A if k in B]
print('stops a %d b %d both %d' % (len(A), len(B), len(both)))
print('%-8s %10s %10s' % ('', 'a', 'b'))
for k in K:
    print('%-8s %10d %10d' % (k, sum(n(A[s], k) for s in both), sum(n(B[s], k) for s in both)))
worse = []
for s in both:
    d = {k: n(B[s], k) - n(A[s], k) for k in K}
    bad = {k: v for k, v in d.items() if v > mn or (k in ('hole', 'float', 'onroad') and v > 0)}
    if bad: worse.append((max(bad.values()), s, bad))
worse.sort(key=lambda w: -w[0])
print('b worse at %d stops' % len(worse))
for _, s, bad in worse[:40]:
    print('  %-28s %7s  ' % (str(s[0])[:28], s[1]) + '  '.join('%s %d>%d' % (k, n(A[s], k), n(B[s], k)) for k in bad))
only = [k for k in A if k not in B]
if only: print('only in a:', len(only), [(str(r)[:16], s) for r, s in only[:12]])
