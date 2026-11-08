import type { Translator } from '../../../i18n';
import { camel } from '../shared/vnd-model';

type T = Translator['t'];

export const invitationStatusLabel = (t: T, code: string): string => t(`po2.invitationStatus.${camel(code)}.name`);
export const contactBasisLabel = (t: T, code: string): string => t(`po2.contactBasis.${camel(code)}.name`);
export const uploadPurposeLabel = (t: T, code: string): string => t(`po2.purpose.${camel(code)}.name`);
