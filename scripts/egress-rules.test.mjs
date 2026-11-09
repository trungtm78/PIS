import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEgressScript, egressVerdict, parseEgressRules } from './infra-security.mjs';

// HSKT YCK.07: a negative test of the egress allowlist. The script that limits the egress network is run with a resolver of the test's own, the rules it prints are parsed, and
// a connection from the egress network to a destination that is not on the allowlist is judged by the same first-match rule the firewall applies: it must be dropped.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'infra', 'onprem', 'config', 'egress-firewall.sh');
const cleanups = [];
process.on('exit', () => cleanups.forEach((clean) => clean()));

function printedRules() {
  const bin = mkdtempSync(join(tmpdir(), 'machvon-egress-'));
  cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, 'getent'), '#!/bin/sh\ncase "$2" in\n  store.example.test) printf "10.1.1.5 STREAM store\\n10.1.1.6 STREAM store\\n" ;;\n  directory.example.test) printf "10.2.2.9 STREAM directory\\n" ;;\n  *) exit 2 ;;\nesac\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
  const run = spawnSync('sh', [SCRIPT, 'store.example.test', '443', 'directory.example.test', '636'], { encoding: 'utf8', env });
  return run.error !== undefined || run.status !== 0 ? undefined : parseEgressRules(run.stdout);
}

test('a service on the egress network reaches the object store and the directory on their ports, and nothing else', (context) => {
  const rules = printedRules();
  if (rules === undefined) return context.skip('no POSIX shell on this host');
  // Allowed: the destinations the operator named, on the ports they named.
  assert.equal(egressVerdict(rules, '10.1.1.5', 443), 'ACCEPT');
  assert.equal(egressVerdict(rules, '10.1.1.6', 443), 'ACCEPT');
  assert.equal(egressVerdict(rules, '10.2.2.9', 636), 'ACCEPT');
  // Allowed: the other services of the egress network itself (Keycloak to the database).
  assert.equal(egressVerdict(rules, '172.29.250.17', 5432), 'ACCEPT');
  // Negative: a host that is not on the allowlist, on the allowed port, on another port, and the allowed host on a port nobody asked for.
  assert.equal(egressVerdict(rules, '203.0.113.50', 443), 'DROP');
  assert.equal(egressVerdict(rules, '198.51.100.7', 80), 'DROP');
  assert.equal(egressVerdict(rules, '10.1.1.5', 22), 'DROP');
  assert.equal(egressVerdict(rules, '10.2.2.9', 443), 'DROP');
  assert.equal(egressVerdict(rules, '10.1.1.7', 443), 'DROP', 'a neighbour address of the object store is not the object store');
  assert.equal(egressVerdict(rules, '8.8.8.8', 53), 'DROP');
});

test('the allowlist is exact: no rule allows every destination, every ACCEPT names a destination, and the chain ends in DROP', (context) => {
  const rules = printedRules();
  if (rules === undefined) return context.skip('no POSIX shell on this host');
  assert.equal(rules.at(-1).target, 'DROP');
  assert.equal(rules.at(-1).destination, undefined);
  for (const rule of rules.filter((entry) => entry.target === 'ACCEPT')) assert.ok(rule.conntrack || rule.destination !== undefined, 'an ACCEPT without a destination');
  // The destinations that are allowed are exactly the three resolved addresses and the egress subnet.
  const allowed = rules.filter((entry) => entry.target === 'ACCEPT' && !entry.conntrack).map((entry) => `${entry.destination}:${entry.port ?? 'any'}`).sort();
  assert.deepEqual(allowed, ['10.1.1.5/32:443'.replace('/32', ''), '10.1.1.6:443', '10.2.2.9:636', '172.29.250.0/24:any'].sort());
});

test('the evaluator itself: first match wins, answers to established connections do not decide a new one, an empty chain does not pretend to drop', () => {
  const rules = parseEgressRules(['iptables -A MACHVON-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT', 'iptables -A MACHVON-EGRESS -d 10.0.0.0/8 -p tcp --dport 443 -j DROP', 'iptables -A MACHVON-EGRESS -d 10.0.0.1 -p tcp --dport 443 -j ACCEPT'].join('\n'));
  assert.equal(egressVerdict(rules, '10.0.0.1', 443), 'DROP');
  assert.equal(egressVerdict(rules, '192.0.2.1', 443), 'NO_MATCH');
  assert.deepEqual(parseEgressRules('iptables -F MACHVON-EGRESS\nnoise'), []);
  const open = parseEgressRules('iptables -A MACHVON-EGRESS -d 0.0.0.0/0 -j ACCEPT');
  assert.equal(egressVerdict(open, '203.0.113.50', 443), 'ACCEPT', 'a rule that allows everything is seen as allowing everything');
});

test('the static rules of the script hold, and each rule fails on a mutated copy', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  const subnet = '172.29.250.0/24';
  assert.deepEqual(checkEgressScript(text, subnet), []);
  const failing = (mutate, pattern) => assert.match(checkEgressScript(mutate(text), subnet).join(' | '), pattern);
  failing((t) => t.replace('-A MACHVON-EGRESS -j DROP', '-A MACHVON-EGRESS -j ACCEPT'), /end in -j DROP/);
  failing((t) => t.replace('-d ${address} -p tcp --dport ${STORE_PORT} -j ACCEPT', '-p tcp --dport ${STORE_PORT} -j ACCEPT'), /names no destination/);
  failing((t) => t.replace('-d ${SUBNET} -j ACCEPT', '-d 0.0.0.0/0 -j ACCEPT'), /every destination/);
  failing((t) => t.replaceAll('DOCKER-USER', 'FORWARD'), /DOCKER-USER/);
  failing((t) => t.replace('SUBNET=172.29.250.0/24', 'SUBNET=10.0.0.0/8'), /differs from the egress network/);
  failing((t) => t.replace('getent ahostsv4', 'nslookup'), /resolved/);
  assert.match(checkEgressScript(text, '172.30.0.0/16').join(' '), /differs from the egress network/);
});
