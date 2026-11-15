// Makes the authority file of the signing of a DEMONSTRATION installation (src/modules/doc/demo-signing.ts): a throw-away authority, its timestamp authority and one
// identity for each signer. Run on the machine of the operator, from apps/api:
//   node --import ./scripts/ts-register.mjs scripts/demo-pki.ts --out <file> --authority "Demo CA" --signer "leader|Tran Thi Bich|UBND tinh Ca Mau" --signer "organization|UBND tinh Ca Mau"
// A signer is `name|common name[|organization]` (ASCII). The file holds the private keys of the demonstration identities: it goes to secrets\api\demo_pki of the installation
// (host\demo-signing.ps1) and is deleted here. `--certificates <file>` also writes the public certificates alone (name, PEM), which is what the product registers.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createDemoPki } from '../src/modules/doc/demo-signing';

const { values } = parseArgs({ options: { out: { type: 'string' }, certificates: { type: 'string' }, authority: { type: 'string', default: 'Demonstration Root CA' }, signer: { type: 'string', multiple: true }, days: { type: 'string', default: '400' } } });
const signers = (values.signer ?? []).map((text) => {
  const [name, commonName, organization] = text.split('|').map((part) => part.trim());
  if (name === undefined || name === '' || commonName === undefined || commonName === '') throw new Error(`a signer is "name|common name[|organization]": ${text}`);
  return { name, commonName, ...(organization === undefined || organization === '' ? {} : { organization }) };
});
if (values.out === undefined || signers.length === 0) {
  process.stderr.write('demo-pki: --out <file> and at least one --signer "name|common name[|organization]" are required\n');
  process.exit(2);
}
const file = await createDemoPki(signers, { authorityName: values.authority, days: Number(values.days) });
writeFileSync(values.out, `${JSON.stringify(file)}\n`, { encoding: 'utf8', mode: 0o600 });
if (values.certificates !== undefined) writeFileSync(values.certificates, `${JSON.stringify({ schema: 'demo-pki-certificates/1', authority: file.authority, identities: file.identities.map((entry) => ({ name: entry.name, certificate: entry.certificate })) }, null, 2)}\n`, 'utf8');
process.stdout.write(`demo-pki: an authority and ${file.identities.length} identities written to ${values.out}\n`);
