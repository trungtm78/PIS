import type { AdapterStatus, LookupOutcome } from '@machvon/db';

/** Where an answer about a tax id came from. NONE: no lookup is bound. */
export type IdentityProvider = 'NONE' | 'MOCK' | 'NATIONAL_REGISTER';

export interface IdentityAnswer {
  outcome: LookupOutcome;
  checkedAt: Date;
}

/**
 * The port to an official lookup of a tax id (the business register or the national procurement network). The registry never claims a
 * tax id was confirmed by a lookup on the strength of the answer alone: the answer counts only through an adapter whose own status is
 * VERIFIED, that is, one whose format and behaviour the agency that owns it has confirmed. Until D05-D07 deliver such a contract, the
 * adapter that is bound says MISSING (nothing is bound) or MOCK (a test double), and a person verifies the tax id on the evidence document.
 */
export interface ContractorIdentityPort {
  readonly provider: IdentityProvider;
  /** The verdict on the adapter, not on any contractor. */
  readonly adapterStatus: AdapterStatus;
  /** A register that cannot be reached is answered UNAVAILABLE; a caller treats an adapter that throws the same way. */
  lookup(taxIdentifier: string, legalName: string): Promise<IdentityAnswer>;
}

/** The adapter of a platform where no lookup is bound: it asks nobody and says so (MISSING), so verification rests on the evidence document. */
export class UnboundIdentityPort implements ContractorIdentityPort {
  readonly provider = 'NONE' as const;
  readonly adapterStatus = 'MISSING' as const;

  lookup(): Promise<IdentityAnswer> {
    return Promise.resolve({ outcome: 'UNAVAILABLE', checkedAt: new Date() });
  }
}

/** A test double of the lookup: it knows the tax ids it was given, with the name each is registered under. Its status is MOCK. */
export class MockIdentityPort implements ContractorIdentityPort {
  readonly provider = 'MOCK' as const;
  /** A test double can stand in for an adapter of any status, so a test sets the status it wants to see handled. */
  adapterStatus: AdapterStatus;
  private readonly registered = new Map<string, string>();
  private reachable = true;

  constructor(adapterStatus: AdapterStatus = 'MOCK') {
    this.adapterStatus = adapterStatus;
  }

  register(taxIdentifier: string, legalName: string): this {
    this.registered.set(taxIdentifier, legalName);
    return this;
  }

  /** Whether the register can be reached; when it cannot, a lookup fails the way a call to a register that is down does. */
  setReachable(reachable: boolean): this {
    this.reachable = reachable;
    return this;
  }

  lookup(taxIdentifier: string, legalName: string): Promise<IdentityAnswer> {
    const checkedAt = new Date();
    if (!this.reachable) return Promise.reject(new Error('the register cannot be reached'));
    const name = this.registered.get(taxIdentifier);
    const outcome: LookupOutcome = name === undefined ? 'NOT_FOUND' : name.trim().toLowerCase() === legalName.trim().toLowerCase() ? 'MATCH' : 'NAME_MISMATCH';
    return Promise.resolve({ outcome, checkedAt });
  }
}
