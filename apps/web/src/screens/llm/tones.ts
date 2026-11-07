import type { Tone } from '../../ui';
import type { ModelStatus, ProviderStatus } from './llm-model';

/** The tone of the pill of a provider state: only an active provider is usable; the state is always written next to the tone. */
const PROVIDER_TONES: Readonly<Record<ProviderStatus, Tone>> = { PROPOSED: 'info', ACTIVE: 'success', SUSPENDED: 'warning', RETIRED: 'neutral' };
/** The tone of the pill of a model state: only an APPROVED model is used. */
const MODEL_TONES: Readonly<Record<ModelStatus, Tone>> = { PROPOSED: 'info', EVAL_PENDING: 'info', APPROVED: 'success', SUSPENDED: 'warning', RETIRED: 'neutral' };

export const providerStatusTone = (status: ProviderStatus): Tone => PROVIDER_TONES[status];
export const modelStatusTone = (status: ModelStatus): Tone => MODEL_TONES[status];
