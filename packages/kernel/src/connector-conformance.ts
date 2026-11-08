import { existsSync, readFileSync } from 'node:fs';
import dns from 'node:dns';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { alertTypeDefaults, ruleTypeOf } from './governance-rules.ts';
import { CONNECTOR_FRESHNESS_RULE_TYPE, assertConnectorDescriptor, connectorAlertTypes, connectorDescriptor, connectorDescriptors } from './connector-hub.ts';
import type { ConnectorDescriptor } from './connector-hub.ts';

/**
 * The connector conformance helper (HUB-1): what any connector lane calls in its own tests to prove that its descriptor is valid and that the connector respects the rules of the hub. It reads only files and the
 * registries; it opens nothing. Use it like this in a jest or vitest file of the connector:
 *
 *   registerAllGovernanceRules(); registerConnector(MY_DESCRIPTOR);
 *   expect(connectorConformanceProblems(MY_DESCRIPTOR)).toEqual([]);
 *   expect(await runWithNetworkWatch(async () => { ...run the adapter... })).toEqual([]);   // only when the egress is NONE
 *
 * The static check reports, one text per problem: a descriptor that fails its own validation; a connector that is not in the registry (or whose registry entry is another object); a layout without a version; a
 * freshness rule code that the rule type CONNECTOR_FRESHNESS does not know; an alert type the connector names that ALERT_TYPE does not know (the owner, expected action and consequence live there); a source
 * file that does not exist; and, while the egress is NONE, a source file that imports a module able to open a connection or calls a network client.
 */

/** The modules whose import in the code of a connector means it can open a connection or start another program. */
export const NETWORK_MODULES = ['net', 'tls', 'http', 'https', 'http2', 'dns', 'dgram', 'child_process', 'cluster', 'worker_threads'] as const;

/** Names that a source file of an egress-free connector must not call, whatever the library. */
const NETWORK_CALLS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'fetch(', pattern: /(^|[^A-Za-z0-9_.])fetch\s*\(/ },
  { label: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { label: 'WebSocket', pattern: /\bnew\s+WebSocket\b/ },
  { label: 'EventSource', pattern: /\bnew\s+EventSource\b/ },
  { label: 'axios', pattern: /from\s+['"]axios['"]|require\(\s*['"]axios['"]\s*\)/ },
  { label: 'undici', pattern: /from\s+['"]undici['"]|require\(\s*['"]undici['"]\s*\)/ },
  { label: 'node-fetch', pattern: /from\s+['"]node-fetch['"]/ },
  { label: 'got', pattern: /from\s+['"]got['"]/ },
];

const importedModules = (source: string): string[] => {
  const found: string[] = [];
  const patterns = [/(?:^|\n)\s*import\s+(?:[^'"\n;]*?\s+from\s+)?['"]([^'"]+)['"]/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1] as string);
  return found;
};

const bareModule = (specifier: string): string => specifier.replace(/^node:/, '').split('/')[0] as string;

/** Finds the root of the repository by walking up from a directory until `packages/kernel` is a child. */
function repositoryRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, 'packages', 'kernel', 'package.json'))) return directory;
    const parent = join(directory, '..');
    if (parent === directory) throw new Error(`connector conformance: no repository root above ${start}`);
    directory = parent;
  }
}

export interface ConformanceOptions {
  /** The root of the repository the `sources` paths are relative to; found from the working directory when omitted. */
  root?: string;
  /** Registered by default; set false for a probe descriptor that is checked before registration. */
  requireRegistered?: boolean;
}

/** The problems of the static part of the conformance check; an empty list means the descriptor conforms. */
export function connectorConformanceProblems(descriptor: ConnectorDescriptor, options: ConformanceOptions = {}): string[] {
  const problems: string[] = [];
  try {
    assertConnectorDescriptor(descriptor);
  } catch (error) {
    return [`descriptor: ${(error as Error).message}`];
  }
  if (options.requireRegistered !== false) {
    const registered = connectorDescriptor(descriptor.code);
    if (registered === undefined) problems.push('registry: the connector is not registered (call registerConnector)');
    else if (registered !== descriptor) problems.push('registry: another object is registered under this code');
    for (const other of connectorDescriptors()) {
      if (other.code === descriptor.code) continue;
      const clash = descriptor.ledger.positions.find((position) => other.ledger.positions.includes(position));
      if (clash !== undefined) problems.push(`ledger: position ${clash} is also claimed by ${other.code}`);
    }
  }
  for (const layout of descriptor.layouts) {
    if (layout.version.trim() === '') problems.push(`layout ${layout.code}: no version`);
    if (layout.acceptance === 'ACCEPTED' && /^(WORKING-ASSUMPTION|ASSUMED|DRAFT)/i.test(layout.version)) problems.push(`layout ${layout.code}: version ${layout.version} is a working assumption and cannot be ACCEPTED`);
  }
  if (descriptor.freshness !== null) {
    const known = ruleTypeOf(CONNECTOR_FRESHNESS_RULE_TYPE).defaults[descriptor.freshness.ruleCode];
    if (known === undefined) problems.push(`freshness: rule code ${descriptor.freshness.ruleCode} has no default under ${CONNECTOR_FRESHNESS_RULE_TYPE} (registerRuleDefaults)`);
  }
  const alertDefaults = ruleTypeOf('ALERT_TYPE').defaults;
  for (const code of connectorAlertTypes(descriptor)) {
    if (alertDefaults[code] === undefined) problems.push(`alert: ${code} is not an ALERT_TYPE (owner, expected action and consequence are required)`);
  }
  void alertTypeDefaults;
  const root = options.root ?? repositoryRoot(process.cwd());
  for (const file of descriptor.sources) {
    const path = join(root, file);
    if (!existsSync(path)) {
      problems.push(`source: ${file} does not exist`);
      continue;
    }
    if (descriptor.egress.policy !== 'NONE') continue;
    const text = readFileSync(path, 'utf8');
    for (const specifier of importedModules(text)) {
      if ((NETWORK_MODULES as readonly string[]).includes(bareModule(specifier))) problems.push(`egress: ${file} imports ${specifier} while the egress is NONE`);
    }
    for (const call of NETWORK_CALLS) {
      if (call.pattern.test(text)) problems.push(`egress: ${file} uses ${call.label} while the egress is NONE`);
    }
  }
  return problems;
}

type Patch = { target: Record<string, unknown>; property: string; label: string };

/**
 * Runs `run` with every way out of the machine that Node offers replaced by a function that fails and is counted (fetch, net, tls, http, https, dns, dgram), and returns the list of attempts. A connector with
 * egress NONE must come back with an empty list. The watch proves itself first: each replaced entry point is called once and must be counted, so a watch that stopped working is a failure, not a pass.
 */
export async function runWithNetworkWatch(run: () => Promise<unknown> | unknown): Promise<string[]> {
  const attempts: string[] = [];
  const patches: Patch[] = [
    { target: globalThis as unknown as Record<string, unknown>, property: 'fetch', label: 'fetch' },
    { target: net as unknown as Record<string, unknown>, property: 'connect', label: 'net.connect' },
    { target: net as unknown as Record<string, unknown>, property: 'createConnection', label: 'net.createConnection' },
    { target: net.Socket.prototype as unknown as Record<string, unknown>, property: 'connect', label: 'net.Socket#connect' },
    { target: tls as unknown as Record<string, unknown>, property: 'connect', label: 'tls.connect' },
    { target: http as unknown as Record<string, unknown>, property: 'request', label: 'http.request' },
    { target: http as unknown as Record<string, unknown>, property: 'get', label: 'http.get' },
    { target: https as unknown as Record<string, unknown>, property: 'request', label: 'https.request' },
    { target: https as unknown as Record<string, unknown>, property: 'get', label: 'https.get' },
    { target: dns as unknown as Record<string, unknown>, property: 'lookup', label: 'dns.lookup' },
    { target: dns as unknown as Record<string, unknown>, property: 'resolve', label: 'dns.resolve' },
    { target: dgram as unknown as Record<string, unknown>, property: 'createSocket', label: 'dgram.createSocket' },
  ];
  const saved = patches.map((patch) => patch.target[patch.property]);
  const proof: string[] = [];
  try {
    patches.forEach((patch, index) => {
      if (saved[index] === undefined) return;
      patch.target[patch.property] = (): never => {
        attempts.push(patch.label);
        throw new Error(`network call attempted: ${patch.label}`);
      };
    });
    // The watch proves itself: every replaced entry point, called once, is counted.
    for (const patch of patches) {
      if (patch.target[patch.property] === saved[patches.indexOf(patch)]) continue;
      try {
        (patch.target[patch.property] as () => unknown)();
      } catch {
        proof.push(patch.label);
      }
    }
    const expected = patches.filter((patch, index) => saved[index] !== undefined).map((patch) => patch.label);
    attempts.length = 0;
    if (proof.length !== expected.length) throw new Error('the network watch does not cover every entry point');
    await run();
  } catch (error) {
    if (!/network call attempted|the network watch/.test((error as Error).message)) throw error;
    if (/the network watch/.test((error as Error).message)) throw error;
  } finally {
    patches.forEach((patch, index) => {
      if (saved[index] !== undefined) patch.target[patch.property] = saved[index];
    });
  }
  return attempts;
}
