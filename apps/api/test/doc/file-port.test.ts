import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryDocumentFilePort, MockDocumentFilePort, documentFilePortOfEnvironment } from '../../src/modules/doc/file-port';
import { runDocumentFilePortContract } from './file-port.contract';

runDocumentFilePortContract('MOCK', () => new MockDocumentFilePort());
runDocumentFilePortContract('DIRECTORY', () => new DirectoryDocumentFilePort(mkdtempSync(join(tmpdir(), 'doc-files-'))));

describe('the file port of a process', () => {
  it('keeps the files of DOC in a directory of the object root when the installation names one, and in memory otherwise', () => {
    expect(documentFilePortOfEnvironment({})).toBeInstanceOf(MockDocumentFilePort);
    expect(documentFilePortOfEnvironment({ MACHVON_OBJECT_ROOT: ' ' })).toBeInstanceOf(MockDocumentFilePort);
    expect(documentFilePortOfEnvironment({ MACHVON_OBJECT_ROOT: mkdtempSync(join(tmpdir(), 'object-root-')) })).toBeInstanceOf(DirectoryDocumentFilePort);
  });

  it('gives a second process on the same directory what the first one stored (a restart, the workers)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-files-'));
    await new DirectoryDocumentFilePort(root).put('t/a/doc/1.pdf', new Uint8Array(Buffer.from('%PDF-kept')), 'application/pdf');
    const later = await new DirectoryDocumentFilePort(root).get('t/a/doc/1.pdf');
    expect(Buffer.from(later?.bytes ?? []).toString('utf8')).toBe('%PDF-kept');
    expect(later?.mime).toBe('application/pdf');
  });
});
