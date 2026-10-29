import { DomainError } from '@machvon/kernel';
import type { ReorganizationProjectPort } from '@machvon/db';

/** Injection token of the port through which the reorganisation saga moves a project to the successor unit (XM-ADM-02). */
export const REORGANIZATION_PROJECT_PORT = Symbol('REORGANIZATION_PROJECT_PORT');

/**
 * The port until PRJ accepts a transfer from a service actor with the reorganisation's id (cross-module request XM-ADM-02): it stops the saga at the first project, so a unit that holds projects is not reorganised on a guess.
 * The saga is carried on when it is decided again after PRJ is bound.
 */
export class UnboundProjectTransferPort implements ReorganizationProjectPort {
  transfer(): Promise<void> {
    return Promise.reject(new DomainError('PROJECT_TRANSFER_UNAVAILABLE', 503));
  }
}
