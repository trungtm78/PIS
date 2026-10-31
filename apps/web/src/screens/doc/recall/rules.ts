import type { DocumentStatus, NoticeRow, QueueRow } from './types';
import { RECALLABLE_STATUSES, VOIDABLE_STATUSES } from './types';

/** The shortest reason the server takes for a recall and for voiding a number (the contract asks for ten characters after trimming). */
export const MIN_REASON_CHARS = 10;
export const MAX_RECALL_REASON_CHARS = 2000;
export const MAX_VOID_REASON_CHARS = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReasonProblem = 'required' | 'tooShort' | 'tooLong';

/** What is wrong with a reason as typed, judged on its trimmed text the way the server does; `limit` is the longest the command takes. */
export function reasonProblem(reason: string, limit: number): ReasonProblem | undefined {
  const length = reason.trim().length;
  if (length === 0) return 'required';
  if (length < MIN_REASON_CHARS) return 'tooShort';
  return length > limit ? 'tooLong' : undefined;
}

export const isUuid = (value: string): boolean => UUID.test(value.trim());

/** The documents in force that can be replaced or corrected: the states of a recall, a corrected one included. */
export const canSupersede = (status: DocumentStatus): boolean => RECALLABLE_STATUSES.some((candidate) => candidate === status);

export const MIN_TITLE_CHARS = 3;
export const MAX_TITLE_CHARS = 500;
export const MIN_CORRECTION_CHARS = 5;
export const MAX_CORRECTION_CHARS = 4000;

export type TextProblem = 'required' | 'tooShort' | 'tooLong';

/** What is wrong with a text as typed, judged on its trimmed length the way the server does. */
export function textProblem(value: string, min: number, max: number): TextProblem | undefined {
  const length = value.trim().length;
  if (length === 0) return 'required';
  if (length < min) return 'tooShort';
  return length > max ? 'tooLong' : undefined;
}

export const canRecall = (status: DocumentStatus): boolean => RECALLABLE_STATUSES.some((candidate) => candidate === status);
export const canVoid = (status: DocumentStatus): boolean => VOIDABLE_STATUSES.some((candidate) => candidate === status);

/** The documents that may be named as the basis of a recall: those in force, never the one being recalled. */
export function basisOptions(queue: readonly QueueRow[], selectedDocumentId: string): QueueRow[] {
  return queue.filter((row) => canRecall(row.status) && row.documentId !== selectedDocumentId);
}

export interface NoticeProgress {
  total: number;
  noticed: number;
  calledOff: number;
}

/** How many recipients were told of the recall and how many sendings were called off before anything went out. */
export function noticeProgress(rows: readonly NoticeRow[]): NoticeProgress {
  return {
    total: rows.length,
    noticed: rows.filter((row) => row.recallNoticeAt !== null).length,
    calledOff: rows.filter((row) => row.status === 'CANCELLED').length,
  };
}
