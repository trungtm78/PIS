#!/usr/bin/env python3
"""Turns the Maestro runs of apps/mobile/qa/device/flows into `checks` for merge_results.py. The flow -> case mapping is the one the flows state themselves in their `Supports:` header
(06_sign_in_test_idp: MOB-02, MOB-03, MOB-04, MOB-07; 20_cold_start_main_content: UAT-NFR-PERFORMANCE-02; 30_flapping_and_kill_during_submit: UAT-AC502). The status of a flow is read from
the line `[Passed]` / `[Failed]` of its Maestro log (the worst over the logs given for it); a flow with no log is KHONG_CHAY with the reason given.
usage: mobile-to-checks.py <out.json> <spec.json>   spec = [{"tc_ids":[...], "logs":[...], "not_run":"reason or null", "note":"..."}]"""
import json, re, sys
spec = json.load(open(sys.argv[2], encoding='utf-8'))
checks = []
for item in spec:
    if item.get('not_run'):
        status, why = 'KHONG_CHAY', item['not_run']
        reasons = [item.get('note') or item['not_run']]
    else:
        verdicts = []
        for log in item['logs']:
            text = open(log, encoding='utf-8', errors='replace').read()
            verdicts.append('PASS' if re.search(r'\[Passed\]', text) else 'FAIL')
        status = 'FAIL' if 'FAIL' in verdicts else 'PASS'
        why = 'failed' if status == 'FAIL' else ''
        reasons = [f"{len(verdicts)} run(s): {', '.join(verdicts)}. " + (item.get('note') or '')]
    for tc in item['tc_ids']:
        checks.append({'tc_id': tc, 'name': ','.join(item.get('flows', [])) or tc, 'status': status, 'reason': why, 'reasons': reasons, 'duration_ms': 0, 'log': item['logs'][0] if item.get('logs') else ''})
json.dump({'checks': checks}, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print({c['tc_id']: c['status'] for c in checks})
