#!/usr/bin/env node
// Registers the certificates of the DEMONSTRATION signers of an installation through the product's own command (registerSigningCertificate, ADM-08), as the tenant owner:
//   ssh <server> "type ...\demo-credentials.json" | node scripts/demo-signing-register.mjs --dataset camau --api https://host:8443/api --credentials - --certificates <file>
// `--certificates` is the public half apps/api/scripts/demo-pki.ts wrote (name and PEM of each identity). The identity named `leader` is registered as the personal
// certificate of the person who signs documents in the seed layer (capApprover), the one named `organization` as the certificate of the root unit of the dataset.
// A certificate that is registered already (same fingerprint) is left alone. No private key is read or sent.
import { X509Certificate, createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brokerOf, credentialProblems, readCredentials } from './clip-seed-auth.mjs';
import { ApiReader } from './clip-seed-client.mjs';
import { loadDataset } from './clip-seed.mjs';

/** The person of the seed layer who signs as the leader, and the kind of each named identity. */
export const LEADER = 'capApprover';

/** The registrations to make: the body of each command, without the ones whose fingerprint the installation holds already. Pure. */
export function registrationsOf({ identities, leaderMembershipId, rootUnitId, known }) {
  const have = new Set(known.map((row) => String(row.fingerprint_sha256).toLowerCase()));
  const out = [];
  for (const identity of identities) {
    if (identity.name !== 'leader' && identity.name !== 'organization') throw new Error(`the identity ${identity.name} is neither leader nor organization`);
    if (/PRIVATE KEY/.test(identity.certificate)) throw new Error(`the identity ${identity.name} holds a private key: give the certificates file, not the authority file`);
    const fingerprint = createHash('sha256').update(new X509Certificate(identity.certificate).raw).digest('hex');
    if (have.has(fingerprint)) continue;
    out.push(identity.name === 'leader' ? { kind: 'PERSONAL', holder_membership_id: leaderMembershipId, certificate_pem: identity.certificate, provider_code: 'MOCK' } : { kind: 'ORGANIZATION', organization_unit_id: rootUnitId, certificate_pem: identity.certificate, provider_code: 'MOCK' });
  }
  return out;
}

export async function main(argv, { log = (line) => process.stdout.write(`${line}\n`), fetchImpl = fetch } = {}) {
  const { values } = parseArgs({ args: argv, options: { dataset: { type: 'string', default: 'camau' }, api: { type: 'string' }, credentials: { type: 'string' }, certificates: { type: 'string' } }, allowPositionals: false });
  if (!values.api || !values.credentials || !values.certificates) {
    log('demo-signing-register: --api, --credentials <file|-> and --certificates <file> are required');
    return 2;
  }
  const dataset = loadDataset(values.dataset);
  const credentials = readCredentials(values.credentials);
  const problems = credentialProblems(credentials, ['owner', LEADER]);
  if (problems.length > 0) throw new Error(`the credentials cannot be used:\n${problems.join('\n')}`);
  const broker = brokerOf(credentials, {});
  const reader = new ApiReader({ base: values.api, tokenOf: (person) => broker.token(person), fetchImpl });
  const units = await reader.list('owner', '/resources/organization_unit');
  const rootCode = dataset.tenant.units.find((unit) => unit.parent === undefined).code;
  const root = units.find((unit) => unit.code === rootCode);
  if (root === undefined) throw new Error(`the installation has no unit ${rootCode}`);
  const known = await reader.list('owner', '/resources/signing_certificate');
  const identities = JSON.parse(readFileSync(values.certificates, 'utf8')).identities;
  const bodies = registrationsOf({ identities, leaderMembershipId: credentials.people[LEADER].membershipId, rootUnitId: root.id, known: known.filter((row) => row.status === 'Active') });
  for (const body of bodies) {
    const response = await fetchImpl(`${values.api.replace(/\/+$/u, '')}/signing-certificates`, { method: 'POST', headers: { authorization: `Bearer ${await broker.token('owner')}`, 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`registering the ${body.kind} certificate answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    log(`demo-signing-register: ${body.kind} certificate registered`);
  }
  log(`demo-signing-register: ${bodies.length} registered, ${identities.length - bodies.length} were there`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`demo-signing-register: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
