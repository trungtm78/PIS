#!/usr/bin/env python3
"""Puts back into db.json the cases that db_assert.py could not be given: the ones whose audit_assert names no table (the tool's default `audit_log` does not exist in this product, and
the failed statement poisons the one shared transaction of the tool, which would turn every later case into a false KHONG_CHAY), and the ones whose SQL still holds a `{placeholder}`
(no seeded id). They stay KHONG_CHAY with the reason; nothing is turned into PASS.
usage: db-combine.py <db-run.json> <audit-ids.json> <ph-ids.json> <out db.json>"""
import json, sys
run = json.load(open(sys.argv[1], encoding='utf-8'))['checks']
audit = json.load(open(sys.argv[2]))['audit']
ph = json.load(open(sys.argv[3]))['placeholder']
done = {c['tc_id'] for c in run}
for tc in audit:
    if tc not in done:
        run.append({'tc_id': tc, 'name': tc, 'status': 'KHONG_CHAY', 'reason': 'thieu-bang-audit', 'reasons': ["audit_assert names no table; the default table of the tool (audit_log) does not exist in this database (the audit rows are in machvon.audit_event)"], 'duration_ms': 0})
        done.add(tc)
for tc in ph:
    if tc not in done:
        run.append({'tc_id': tc, 'name': tc, 'status': 'KHONG_CHAY', 'reason': 'thieu-du-lieu-seed', 'reasons': ["the SQL of the case holds a {placeholder} id that no seed of the stack provides"], 'duration_ms': 0})
json.dump({'checks': run}, open(sys.argv[4], 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(len(run), 'checks')
