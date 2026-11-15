import { X509Certificate, randomUUID } from 'node:crypto';
import { fingerprintOf } from '../../src/modules/doc/cms-verification';
import { createDemoPki, demoSigningOfEnvironment, loadDemoSigning } from '../../src/modules/doc/demo-signing';

jest.setTimeout(60_000);

const DIGEST = 'b'.repeat(64);
const NAMES = [
  { name: 'leader', commonName: 'Tran Thi Bich', organization: 'UBND tinh Ca Mau' },
  { name: 'organization', commonName: 'UBND tinh Ca Mau' },
];

async function messageOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'NO_ERROR';
}

describe('the signing of a demonstration installation', () => {
  it('makes an authority file of PEM texts, one identity for each name, with certificates the authority issued', async () => {
    const file = await createDemoPki(NAMES, { authorityName: 'Demo Root CA' });
    expect(file.schema).toBe('demo-pki/1');
    expect(file.identities.map((entry) => entry.name)).toEqual(['leader', 'organization']);
    const authority = new X509Certificate(file.authority);
    for (const entry of [...file.identities, file.timestamp]) {
      expect(entry.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
      expect(new X509Certificate(entry.certificate).checkIssued(authority)).toBe(true);
    }
    expect(new X509Certificate(file.identities[0]?.certificate ?? '').subject).toContain('Tran Thi Bich');
  });

  it('signs with the identity whose fingerprint the request names, approved at once, and trusts its own authority only', async () => {
    const file = await createDemoPki(NAMES, { authorityName: 'Demo Root CA' });
    const signing = await loadDemoSigning(file);
    const leader = fingerprintOf(new X509Certificate(file.identities[0]?.certificate ?? ''));
    expect(signing.fingerprints).toContain(leader);
    expect(signing.anchor.regime).toBe('PUBLIC_CA');
    expect(Buffer.compare(signing.anchor.certificate, new X509Certificate(file.authority).raw)).toBe(0);
    const ref = await signing.port.startSession({ digestSha256: DIGEST, certificateFingerprint: leader, correlationId: randomUUID() });
    // Nobody approves on a device: the payload is there at the first collect.
    const payload = await signing.port.collect(ref);
    expect(payload).not.toBe('PENDING');
    expect(await messageOf(signing.port.startSession({ digestSha256: DIGEST, certificateFingerprint: 'f'.repeat(64), correlationId: randomUUID() }))).toContain('CERTIFICATE_NOT_ACTIVE');
    expect(await messageOf(loadDemoSigning({ ...file, schema: 'other' as 'demo-pki/1' }))).toContain('not a demo-pki/1 file');
  });

  it('is off unless the environment says true, and then only for an installation that declares itself a demonstration', async () => {
    const file = JSON.stringify(await createDemoPki(NAMES, { authorityName: 'Demo Root CA' }));
    const read = (): string => file;
    const warnings: string[] = [];
    const warn = (line: string): void => void warnings.push(line);
    expect(await demoSigningOfEnvironment({}, read, warn)).toBeUndefined();
    expect(await demoSigningOfEnvironment({ MACHVON_DEMO_SIGNING: 'false', MACHVON_DEPLOYMENT_PURPOSE: 'demo' }, read, warn)).toBeUndefined();
    // The declaration alone switches nothing on.
    expect(await demoSigningOfEnvironment({ MACHVON_DEPLOYMENT_PURPOSE: 'demo', MACHVON_DEMO_PKI_FILE: 'x' }, read, warn)).toBeUndefined();
    expect(warnings).toEqual([]);
    const on = { MACHVON_DEMO_SIGNING: 'true', MACHVON_DEPLOYMENT_PURPOSE: 'demo', MACHVON_DEMO_PKI_FILE: 'C:\\run\\secrets\\demo_pki' };
    const signing = await demoSigningOfEnvironment(on, read, warn);
    expect(signing?.fingerprints).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^WARNING: MACHVON_DEMO_SIGNING is on\./);
    // An image hands the content of the secret file over in the variable without the suffix: no file is read then.
    const loaded = await demoSigningOfEnvironment({ MACHVON_DEMO_SIGNING: 'true', MACHVON_DEPLOYMENT_PURPOSE: 'demo', MACHVON_DEMO_PKI: file }, () => { throw new Error('no file must be read'); }, warn);
    expect(loaded?.fingerprints).toEqual(signing?.fingerprints);
    // The private keys never reach the log.
    expect(warnings[0]).not.toContain('PRIVATE KEY');
  });

  it('stops the start, naming the variable, on a wrong word, a missing declaration, a production environment and an unreadable file', async () => {
    const read = (): string => '{ not json';
    const quiet = (): void => undefined;
    for (const word of ['1', 'yes', 'TRUE', 'on']) expect(await messageOf(demoSigningOfEnvironment({ MACHVON_DEMO_SIGNING: word, MACHVON_DEPLOYMENT_PURPOSE: 'demo' }, read, quiet))).toBe('MACHVON_DEMO_SIGNING must be true or false');
    expect(await messageOf(demoSigningOfEnvironment({ MACHVON_DEMO_SIGNING: 'true' }, read, quiet))).toContain('MACHVON_DEPLOYMENT_PURPOSE must be demo');
    expect(await messageOf(demoSigningOfEnvironment({ MACHVON_DEMO_SIGNING: 'true', MACHVON_DEPLOYMENT_PURPOSE: 'production' }, read, quiet))).toContain('MACHVON_DEPLOYMENT_PURPOSE must be demo');
    for (const environment of ['production', 'dr']) {
      expect(await messageOf(demoSigningOfEnvironment({ MACHVON_DEMO_SIGNING: 'true', MACHVON_DEPLOYMENT_PURPOSE: 'demo', MACHVON_ENVIRONMENT: environment, MACHVON_DEMO_PKI_FILE: 'x' }, read, quiet))).toContain('MACHVON_DEMO_SIGNING must be false');
    }
    expect(await messageOf(demoSigningOfEnvironment({ MACHVON_DEMO_SIGNING: 'true', MACHVON_DEPLOYMENT_PURPOSE: 'demo' }, read, quiet))).toContain('MACHVON_DEMO_PKI_FILE must name');
    const unreadable = await messageOf(demoSigningOfEnvironment({ MACHVON_DEMO_SIGNING: 'true', MACHVON_DEPLOYMENT_PURPOSE: 'demo', MACHVON_DEMO_PKI_FILE: 'x' }, read, quiet));
    expect(unreadable).toBe('MACHVON_DEMO_PKI_FILE cannot be read as a demonstration authority file');
  });
});
