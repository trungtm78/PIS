import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';

export type FundingStructure = components['schemas']['LeaderFundingStructure'];
export type StructureClassRow = FundingStructure['classes'][number];

/** Nothing frozen yet (404) or a right the reader lacks (403) is a state to say, not an error with a retry. */
export const structureRefused = (error: unknown): boolean => error instanceof ApiError && (error.status === 403 || error.status === 404);
