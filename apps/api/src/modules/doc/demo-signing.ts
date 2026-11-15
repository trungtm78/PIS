import { X509Certificate, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TrustAnchor } from './cms-verification';
import { fingerprintOf } from './cms-verification';
import { MockCertificateAuthority, MockTimestampAuthority, OID } from './mock-pki';
import type { Identity } from './mock-pki';
import { MockSigningDirectory } from './signing-adapters';
import { MockSigningPort } from './signing-port';
import type { SessionRef, SigningPort, SigningRequest } from './signing-port';

/**
 * The signing of a DEMONSTRATION installation. The product has no adapter of a certification authority yet (DOC-SPK-01): on an installation, a leader cannot sign and the
 * organisation cannot seal, so no document is ever issued and nothing that needs an issued decision goes on. An installation that only SHOWS the product may bind this
 * stand-in instead: the MOCK adapter of the test suites, with the identities of a file the operator made (a throw-away authority, its timestamp authority and the
 * certificates of the people and organisations that sign), and a session that is approved the moment it opens (nobody holds a signing device at a demonstration).
 * The certificates are registered through the product's own command (registerSigningCertificate), like real ones.
 *
 * It is never on by accident: `MACHVON_DEMO_SIGNING` must be exactly `true`, the installation must declare itself a demonstration (`MACHVON_DEPLOYMENT_PURPOSE=demo`), an
 * environment named production or dr refuses it, and the file (`MACHVON_DEMO_PKI_FILE`, a secret file of the installation) must be there. Anything else stops the start, naming the variable.
 * A signature made here proves nothing outside the demonstration: the authority is trusted by this installation alone.
 */

const subtle = webcrypto.subtle;
const DAY_MS = 86_400_000;
const PRODUCTION_ENVIRONMENTS = ['production', 'dr'];

export interface DemoPkiEntry {
  /** What the certificate is for, in the words of the operator (never read by the product). */
  name: string;
  certificate: string;
  privateKey: string;
}

/** The file of a demonstration authority: PEM texts only. It holds private keys of the DEMONSTRATION identities and is kept with the secrets of the installation. */
export interface DemoPkiFile {
  schema: 'demo-pki/1';
  authority: string;
  timestamp: DemoPkiEntry;
  identities: DemoPkiEntry[];
}

export interface DemoSigning {
  port: SigningPort;
  anchor: TrustAnchor;
  /** SHA-256 fingerprints of the identities that can sign. */
  fingerprints: string[];
}

const pem = (label: string, der: Uint8Array): string => `-----BEGIN ${label}-----\n${(Buffer.from(der).toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;
const derOf = (text: string): Buffer => Buffer.from(text.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');

async function entryOf(name: string, identity: Identity): Promise<DemoPkiEntry> {
  return { name, certificate: pem('CERTIFICATE', identity.certificate), privateKey: pem('PRIVATE KEY', new Uint8Array(await subtle.exportKey('pkcs8', identity.privateKey))) };
}

async function identityOf(entry: DemoPkiEntry): Promise<Identity> {
  const der = derOf(entry.privateKey);
  const privateKey = await subtle.importKey('pkcs8', der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { certificate: derOf(entry.certificate), privateKey, chain: [] };
}

/** A new demonstration authority with one identity for each name (`commonName` and, optionally, `organization`), valid from yesterday for `days` days. */
export async function createDemoPki(names: ReadonlyArray<{ name: string; commonName: string; organization?: string }>, options: { authorityName: string; now?: Date; days?: number }): Promise<DemoPkiFile> {
  const now = options.now ?? new Date();
  const notBefore = new Date(now.getTime() - DAY_MS);
  const notAfter = new Date(now.getTime() + (options.days ?? 400) * DAY_MS);
  const root = await MockCertificateAuthority.createRoot({ commonName: options.authorityName, notBefore, notAfter: new Date(now.getTime() + 3650 * DAY_MS) });
  const stamper = await root.issue({ commonName: `${options.authorityName} TSA`, notBefore, notAfter, extendedKeyUsage: [OID.timeStamping] });
  const identities: DemoPkiEntry[] = [];
  for (const entry of names) identities.push(await entryOf(entry.name, await root.issue({ commonName: entry.commonName, ...(entry.organization === undefined ? {} : { organization: entry.organization }), notBefore, notAfter })));
  return { schema: 'demo-pki/1', authority: pem('CERTIFICATE', root.certificate), timestamp: await entryOf('timestamp authority', stamper), identities };
}

/** The signer approves the moment a session opens: nobody holds a signing device at a demonstration. */
class ApprovingDirectory extends MockSigningDirectory {
  override async startSession(request: SigningRequest): Promise<SessionRef> {
    const ref = await super.startSession(request);
    this.approve(ref);
    return ref;
  }
}

/** The signing port and the trust anchor of a demonstration authority file. */
export async function loadDemoSigning(file: DemoPkiFile, clock: () => Date = () => new Date()): Promise<DemoSigning> {
  if (file.schema !== 'demo-pki/1' || !Array.isArray(file.identities)) throw new Error('the demonstration authority file is not a demo-pki/1 file');
  const timestamps = new MockTimestampAuthority(await identityOf(file.timestamp), clock);
  const directory = new ApprovingDirectory();
  const fingerprints: string[] = [];
  for (const entry of file.identities) {
    const identity = await identityOf(entry);
    const fingerprint = fingerprintOf(new X509Certificate(identity.certificate));
    directory.register(fingerprint, new MockSigningPort({ identity, clock, timestamps }));
    fingerprints.push(fingerprint);
  }
  return { port: directory, anchor: { regime: 'PUBLIC_CA', certificate: new X509Certificate(file.authority).raw }, fingerprints };
}

/**
 * The demonstration signing of this process, from its environment: undefined when it is off. Throws, naming the variable, on a value that is not `true` or `false`, on an
 * installation that does not declare itself a demonstration, on an environment named production or dr, and on a file that is missing or cannot be read.
 */
export async function demoSigningOfEnvironment(env: NodeJS.ProcessEnv, read: (path: string) => string = (path) => readFileSync(path, 'utf8'), warn: (line: string) => void = (line) => void process.stderr.write(`${line}\n`)): Promise<DemoSigning | undefined> {
  const word = (env.MACHVON_DEMO_SIGNING ?? '').trim();
  if (word === '' || word === 'false') return undefined;
  if (word !== 'true') throw new Error('MACHVON_DEMO_SIGNING must be true or false');
  if (env.MACHVON_DEPLOYMENT_PURPOSE !== 'demo') throw new Error('MACHVON_DEPLOYMENT_PURPOSE must be demo, because MACHVON_DEMO_SIGNING is true (the stand-in of the certification authority exists for demonstrations only)');
  if (PRODUCTION_ENVIRONMENTS.includes(env.MACHVON_ENVIRONMENT ?? '')) throw new Error('MACHVON_DEMO_SIGNING must be false where MACHVON_ENVIRONMENT names production or dr');
  // The images load a secret file into the variable without the suffix (NAME_FILE=<path> becomes NAME=<content>, infra/*/docker/secret-env): the content is taken from
  // MACHVON_DEMO_PKI when it is there, and read from the file MACHVON_DEMO_PKI_FILE names otherwise (a process started without that loader).
  const content = env.MACHVON_DEMO_PKI ?? '';
  const path = (env.MACHVON_DEMO_PKI_FILE ?? '').trim();
  if (content === '' && path === '') throw new Error('MACHVON_DEMO_PKI_FILE must name the demonstration authority file, because MACHVON_DEMO_SIGNING is true');
  let file: DemoPkiFile;
  try {
    file = JSON.parse(content === '' ? read(path) : content) as DemoPkiFile;
  } catch {
    // The path identifies the problem; the content (private keys) is never echoed.
    throw new Error('MACHVON_DEMO_PKI_FILE cannot be read as a demonstration authority file');
  }
  const signing = await loadDemoSigning(file);
  warn(`WARNING: MACHVON_DEMO_SIGNING is on. Documents are signed by a demonstration authority (${signing.fingerprints.length} identities) that only this installation trusts; a signature made here proves nothing. This installation is a DEMONSTRATION and must not hold real data.`);
  return signing;
}
