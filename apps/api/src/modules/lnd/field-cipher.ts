import { DomainError, FieldCipher, fieldKeysFromEnvironment } from '@machvon/kernel';
import type { FieldKeyProvider } from '@machvon/kernel';

/** The keys of a process that was given none: sealing or opening is refused (503) before anything personal is stored in the clear or read from a seal that cannot be opened. */
const withoutKeys: FieldKeyProvider = {
  current: () => {
    throw new DomainError('PROVIDER_UNAVAILABLE', 503);
  },
  byId: () => {
    throw new DomainError('PROVIDER_UNAVAILABLE', 503);
  },
};

/** The cipher of this process, from `FIELD_ENCRYPTION_KEYS`; with no keys it fails closed on first use, so the API still starts and serves everything that holds no personal data. */
export function createFieldCipher(env: Readonly<Record<string, string | undefined>> = process.env): FieldCipher {
  return new FieldCipher(fieldKeysFromEnvironment(env) ?? withoutKeys);
}
