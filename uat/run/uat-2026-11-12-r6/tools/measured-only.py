#!/usr/bin/env python3
"""Keeps the records of a tier file that carry a measurement (PASS or FAIL) and moves the KHONG_CHAY ones to <out>.notrun.json. Used for the deep tiers (perf, db, role matrix): a tier that
could not measure a case says so in the report, and the case keeps the result of the layer that did run it, instead of being pulled down to KHONG_CHAY by a tier that never looked at it.
usage: measured-only.py <in.json> <out.json>"""
import json, sys
doc = json.load(open(sys.argv[1], encoding='utf-8'))
keep = [c for c in doc['checks'] if c['status'] in ('PASS', 'FAIL')]
rest = [c for c in doc['checks'] if c['status'] not in ('PASS', 'FAIL')]
json.dump({'checks': keep}, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
json.dump({'checks': rest}, open(sys.argv[2].replace('.json', '.notrun.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(sys.argv[1], 'measured', len(keep), 'not measured', len(rest))
