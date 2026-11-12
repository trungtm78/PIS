#!/usr/bin/env python3
"""Counts of a run by module and by platform from <OUT>/results.json and <OUT>/cases.json (markdown on stdout). usage: tally.py <OUT>"""
import json, sys, collections
out = sys.argv[1]
cases = {c['tc_id']: c for c in json.load(open(f'{out}/cases.json', encoding='utf-8'))['cases']}
rows = json.load(open(f'{out}/results.json', encoding='utf-8'))['results']
raw = {c['tc_id']: c for c in json.load(open(f'{out}/cases-input.json', encoding='utf-8'))['test_cases']}
mod = collections.defaultdict(collections.Counter)
plat = collections.defaultdict(collections.Counter)
reasons = collections.Counter()
for r in rows:
    c = cases.get(r['tc_id'], {})
    m = c.get('module') or r['tc_id'].split('-')[1]
    st = r['status']
    mod[m][st] += 1; mod[m]['total'] += 1
    plat[r.get('platform') or c.get('platform')][st] += 1; plat[r.get('platform') or c.get('platform')]['total'] += 1
    if st == 'KHONG_CHAY': reasons[r.get('reason') or '?'] += 1
print('| Module | Cases | PASS | FAIL | NOT RUN |'); print('| --- | ---: | ---: | ---: | ---: |')
for m in sorted(mod):
    c = mod[m]; print(f"| {m} | {c['total']} | {c['PASS']} | {c['FAIL']} | {c['KHONG_CHAY']} |")
print(); print('| Platform | Cases | PASS | FAIL | NOT RUN |'); print('| --- | ---: | ---: | ---: | ---: |')
for p in sorted(plat):
    c = plat[p]; print(f"| {p} | {c['total']} | {c['PASS']} | {c['FAIL']} | {c['KHONG_CHAY']} |")
print(); print('not-run reasons:', dict(reasons))
auto = collections.Counter()
for r in rows:
    c = raw.get(r['tc_id'], {}); a = (c.get('automation') or {}).get('state')
    if a: auto[(a, r['status'])] += 1
print('automation (8 enterprise modules):', dict(auto))
