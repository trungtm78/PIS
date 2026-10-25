import { randomBytes } from 'node:crypto';
import type { DomainError } from '../src/errors';
import { FieldCipher, fieldKeysFromEnvironment, maskAddress, maskName, maskNationalId, maskPhone, maskTail, normalizeNationalId, normalizePhone, staticKeyProvider } from '../src/field-encryption';
import type { FieldPlace } from '../src/field-encryption';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const KEY_1 = randomBytes(32);
const KEY_2 = randomBytes(32);
const place: FieldPlace = { tenantId: 'tenant-a', table: 'affected_household', column: 'national_id_enc', rowId: 'row-1' };
const cipherOf = (...ids: number[]) => new FieldCipher(staticKeyProvider(new Map(ids.map((id) => [id, id === 1 ? KEY_1 : KEY_2]))));

describe('the envelope encryption of the personal fields (ST-LND-002, NFR-PRIVACY-01)', () => {
  it('opens what it sealed, never seals the same value the same way twice, and keeps the value out of the ciphertext', () => {
    const cipher = cipherOf(1);
    const first = cipher.seal(place, '012345678901');
    const second = cipher.seal(place, '012345678901');
    expect(first.equals(second)).toBe(false);
    expect(cipher.open(place, first)).toBe('012345678901');
    expect(cipher.open(place, second)).toBe('012345678901');
    expect(first.toString('utf8')).not.toContain('012345678901');
    expect(first.toString('hex')).not.toContain(Buffer.from('012345678901').toString('hex'));
    expect(cipher.open(place, cipher.seal(place, 'Nguyễn Văn An — 12 Lê Lợi'))).toBe('Nguyễn Văn An — 12 Lê Lợi');
    expect(cipher.open(place, cipher.seal(place, ''))).toBe('');
  });

  it('does not open a ciphertext moved to another row, another column or another tenant, or one that was changed', () => {
    const cipher = cipherOf(1);
    const sealed = cipher.seal(place, '012345678901');
    for (const other of [
      { ...place, rowId: 'row-2' },
      { ...place, column: 'phone_enc' },
      { ...place, table: 'other' },
      { ...place, tenantId: 'tenant-b' },
    ]) {
      expect(() => cipher.open(other, sealed)).toThrow('does not open here');
    }
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 1;
    expect(() => cipher.open(place, flipped)).toThrow('does not open here');
    const wrongTag = Buffer.from(sealed);
    wrongTag[14] = (wrongTag[14] as number) ^ 1;
    expect(() => cipher.open(place, wrongTag)).toThrow('does not open here');
  });

  it('does not open what another master key sealed, and says why when it is not held or the format is not known', () => {
    const sealed = cipherOf(1).seal(place, 'secret');
    expect(() => new FieldCipher(staticKeyProvider(new Map([[1, KEY_2]]))).open(place, sealed)).toThrow('does not open here');
    expect(() => new FieldCipher(staticKeyProvider(new Map([[2, KEY_2]]))).open(place, sealed)).toThrow('master key that sealed a field is not held');
    expect(() => cipherOf(1).open(place, Buffer.alloc(8))).toThrow('not in a format');
    const odd = Buffer.from(sealed);
    odd[0] = 9;
    expect(() => cipherOf(1).open(place, odd)).toThrow('not in a format');
  });

  it('seals with the newest master key and still opens what an older one sealed', () => {
    const old = cipherOf(1).seal(place, 'before the rotation');
    const rotated = cipherOf(1, 2);
    const fresh = rotated.seal(place, 'after the rotation');
    expect(fresh[1]).toBe(2);
    expect(old[1]).toBe(1);
    expect(rotated.open(place, old)).toBe('before the rotation');
    expect(rotated.open(place, fresh)).toBe('after the rotation');
  });

  it('refuses a provider with no key, a key of the wrong size or an id that is not one', () => {
    expect(() => staticKeyProvider(new Map())).toThrow('no master key');
    expect(() => staticKeyProvider(new Map([[1, Buffer.alloc(16)]]))).toThrow('32 bytes');
    expect(() => staticKeyProvider(new Map([[0, KEY_1]]))).toThrow('from 1 to 255');
    expect(() => staticKeyProvider(new Map([[256, KEY_1]]))).toThrow('from 1 to 255');
  });

  it('reads the master keys from the environment, the highest id sealing, and says nothing when there are none', () => {
    expect(fieldKeysFromEnvironment({})).toBeUndefined();
    expect(fieldKeysFromEnvironment({ FIELD_ENCRYPTION_KEYS: '  ' })).toBeUndefined();
    const provider = fieldKeysFromEnvironment({ FIELD_ENCRYPTION_KEYS: `1:${KEY_1.toString('base64')}, 3:${KEY_2.toString('base64')}` });
    expect(provider?.current().id).toBe(3);
    expect(provider?.byId(1)?.equals(KEY_1)).toBe(true);
    expect(provider?.byId(2)).toBeUndefined();
    expect(() => fieldKeysFromEnvironment({ FIELD_ENCRYPTION_KEYS: '1:AAAA' })).toThrow('32 bytes');
    expect(() => fieldKeysFromEnvironment({ FIELD_ENCRYPTION_KEYS: 'x' })).toThrow();
  });

  it('makes a blind index that is the same for the same value in the same scope and different for any other, and is not the value', () => {
    const cipher = cipherOf(1);
    const index = cipher.blindIndex('tenant-a', 'project-1', '012345678901');
    expect(index).toMatch(/^[0-9a-f]{64}$/);
    expect(cipher.blindIndex('tenant-a', 'project-1', '012345678901')).toBe(index);
    expect(cipher.blindIndex('tenant-a', 'project-2', '012345678901')).not.toBe(index);
    expect(cipher.blindIndex('tenant-b', 'project-1', '012345678901')).not.toBe(index);
    expect(cipher.blindIndex('tenant-a', 'project-1', '012345678902')).not.toBe(index);
    expect(cipherOf(2).blindIndex('tenant-a', 'project-1', '012345678901')).not.toBe(index);
    expect(index).not.toContain('012345678901');
    expect(FieldCipher.sameIndex(index, cipher.blindIndex('tenant-a', 'project-1', '012345678901'))).toBe(true);
    expect(FieldCipher.sameIndex(index, cipher.blindIndex('tenant-a', 'project-1', '999999999999'))).toBe(false);
    expect(FieldCipher.sameIndex(index, index.slice(2))).toBe(false);
  });

  it('shows a name, a number, a telephone and an address masked', () => {
    expect(maskName(' Nguyễn  Văn An ')).toBe('N***** V** A*');
    expect(maskName('Lê')).toBe('L*');
    expect(maskName('X')).toBe('X');
    expect(maskNationalId('012345678901')).toBe('********8901');
    expect(maskNationalId('123')).toBe('***');
    expect(maskPhone('0912345678')).toBe('*******678');
    expect(maskTail('12', 3)).toBe('**');
    expect(maskAddress('12 Lê Lợi, Phường 3, Quận 1')).toBe('***, Quận 1');
    expect(maskAddress('Thôn 4')).toBe('***');
    expect(maskAddress(' , ')).toBe('***');
  });

  it('keeps an identity number of nine or twelve digits and a telephone number of nine to eleven, in the form it is compared in', () => {
    expect(normalizeNationalId('012 345-678 901')).toBe('012345678901');
    expect(normalizeNationalId('123456789')).toBe('123456789');
    for (const bad of ['', '12345678', '1234567890', '1234567890123', '01234567890a'])
      expect(failure(() => normalizeNationalId(bad))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'national_id' });
    expect(normalizePhone('091 234.5678')).toBe('0912345678');
    expect(normalizePhone('+84912345678')).toBe('0912345678');
    expect(normalizePhone('(028) 3812-3456')).toBe('02838123456');
    for (const bad of ['', '12345678', '123456789012', 'abc', '+8491234']) expect(failure(() => normalizePhone(bad))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'phone' });
  });
});
