import { ApiError } from '@machvon/api-client';
import base from '../../../../i18n/vi.json';

export const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
export const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
export const problem = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });
export const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
export const labelOf = (label: string): RegExp => new RegExp(escaped(label));
