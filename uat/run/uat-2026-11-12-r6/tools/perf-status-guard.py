#!/usr/bin/env python3
"""A latency PASS only counts when the answer was a real answer. run_perf.py of the skill counts a 4xx as a fast answer (only 5xx and no answer are errors), so a budget
case whose URL still holds a placeholder ({id}) or lacks the credential of its port would pass on a 422 or a 401. This guard re-sends each perf case once with the same
headers and turns a PASS into KHONG_CHAY(thieu-du-lieu) when the status is not 2xx. It never turns anything into PASS, and keeps the original file as <out>.raw.json.
usage: perf-status-guard.py --cases <cases.json with headers> --checks <perf.json> --base-url <url> --out <perf.json>"""
import argparse, json, shutil, urllib.request, urllib.error
ap = argparse.ArgumentParser()
ap.add_argument('--cases'); ap.add_argument('--checks'); ap.add_argument('--base-url'); ap.add_argument('--out')
a = ap.parse_args()
cases = {c['tc_id']: c for c in json.load(open(a.cases, encoding='utf-8'))['cases']}
doc = json.load(open(a.checks, encoding='utf-8'))
shutil.copyfile(a.checks, a.out.replace('.json', '.raw.json'))
for check in doc['checks']:
    budget = (cases.get(check['tc_id']) or {}).get('perf_budget')
    if not budget or check['status'] != 'PASS':
        continue
    req = urllib.request.Request(a.base_url + budget['url'], method=budget.get('method') or 'GET', headers=budget.get('headers') or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            status = r.status
    except urllib.error.HTTPError as e:
        status = e.code
    except Exception:
        status = 0
    check['http_status_probe'] = status
    if not 200 <= status < 300:
        check.update(status='KHONG_CHAY', reason='thieu-du-lieu', reasons=[f"the budget url answers {status} (a placeholder or a credential of its port is missing): the latency of an error answer is not the latency of the function; raw: " + '; '.join(check.get('reasons') or [])])
json.dump(doc, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print({c['tc_id']: c['status'] for c in doc['checks']})
