import type { ScanStatus } from '@machvon/kernel';

/**
 * What the platform does with a file by its scan status (HSKT YCK.07): CLEAN is released; PENDING is held, which also covers a scanner that is not configured or not reachable (nothing can link
 * or download the file, and a later scan can release it); INFECTED is quarantined for good (the verdict is final, the bytes are never served).
 */
export type QuarantineState = 'RELEASED' | 'HELD' | 'QUARANTINED';

export function quarantineStateOf(status: ScanStatus): QuarantineState {
  if (status === 'CLEAN') return 'RELEASED';
  if (status === 'INFECTED') return 'QUARANTINED';
  return 'HELD';
}
