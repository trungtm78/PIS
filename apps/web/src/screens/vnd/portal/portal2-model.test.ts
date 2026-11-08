import { describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import { contactBasisLabel, invitationStatusLabel, uploadPurposeLabel } from './portal2-labels';
import { CONTACT_BASES, INVITATION_STATUSES, UPLOAD_PURPOSES, basisNeedsReference, invitationIcon, invitationTone, isEmail, sizeText, titleOfFile, uploadProblem } from './portal2-model';

const LIMITS = { max_bytes: 1024 * 1024, mimes: ['application/pdf', 'image/png'] };

describe('the checks made before a portal upload (VND-24)', () => {
  it('refuses an empty file, a file above the limit and a type the server does not accept, and lets a good one go', () => {
    expect(uploadProblem({ size: 0, type: 'application/pdf' }, LIMITS)).toBe('EMPTY');
    expect(uploadProblem({ size: LIMITS.max_bytes + 1, type: 'application/pdf' }, LIMITS)).toBe('TOO_LARGE');
    expect(uploadProblem({ size: 10, type: 'application/zip' }, LIMITS)).toBe('TYPE');
    expect(uploadProblem({ size: LIMITS.max_bytes, type: 'image/png' }, LIMITS)).toBeNull();
  });

  it('says a size in the unit a person reads and offers the name of the file without its extension as the title', () => {
    expect(sizeText(100)).toBe('1 KB');
    expect(sizeText(204800)).toBe('200 KB');
    expect(sizeText(10 * 1024 * 1024)).toBe('10.0 MB');
    expect(titleOfFile('bao-cao.2025.pdf')).toBe('bao-cao.2025');
    expect(titleOfFile('noext')).toBe('noext');
    expect(titleOfFile(`${'a'.repeat(300)}.pdf`)).toHaveLength(200);
  });
});

describe('the proposal of an invitation (VND-23)', () => {
  it('asks for a paper reference unless the proof is the registry e-mail, and checks the shape of the address', () => {
    expect(basisNeedsReference('REGISTRY_EMAIL')).toBe(false);
    expect(basisNeedsReference('')).toBe(false);
    expect(basisNeedsReference('REPRESENTATIVE_LETTER')).toBe(true);
    expect(isEmail('lienhe@example.vn')).toBe(true);
    expect(isEmail('lienhe@')).toBe(false);
    expect(isEmail('a b@example.vn')).toBe(false);
  });

  it('draws every status in words and in a mark, so that colour is never the only sign', () => {
    for (const status of INVITATION_STATUSES) {
      expect(invitationIcon(status)).not.toBe('');
      expect(invitationTone(status)).toBeTruthy();
    }
    expect(new Set(INVITATION_STATUSES.map((status) => invitationIcon(status))).size).toBe(INVITATION_STATUSES.length);
  });
});

describe('the words of the closed lists of PORTAL-2', () => {
  const walk = (label: (t: typeof translator.t, code: string) => string, codes: readonly string[]): void => {
    for (const code of codes) {
      for (const locale of ['vi', 'en'] as const) {
        translator.setLocale(locale);
        const text = label(translator.t, code);
        expect(text, `${locale} ${code}`).not.toBe('');
        expect(text.startsWith('po2.'), `${locale} ${code}`).toBe(false);
      }
    }
    translator.setLocale('vi');
  };
  it('has a name for every status, basis and purpose in both languages', () => {
    walk(invitationStatusLabel, INVITATION_STATUSES);
    walk(contactBasisLabel, CONTACT_BASES);
    walk(uploadPurposeLabel, UPLOAD_PURPOSES);
  });
});
