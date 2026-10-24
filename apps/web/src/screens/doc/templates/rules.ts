const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MIN_REFERENCE = 3;
export const MAX_REFERENCE = 50;
export const MAX_NOTE = 1000;
export const MIN_REASON = 10;
export const MAX_REASON = 2000;

/** What a form field can be wrong with; the screen words each in the active language. */
export type FieldProblem = 'required' | 'tooShort' | 'tooLong' | 'uuid';

export interface ConfirmationValues {
  reference: string;
  evidenceDocumentId: string;
  note: string;
}

export const EMPTY_CONFIRMATION: ConfirmationValues = { reference: '', evidenceDocumentId: '', note: '' };

export type ConfirmationErrors = Partial<Record<keyof ConfirmationValues, FieldProblem>>;

/** The reference of the confirmation, the evidence document and the optional note, checked as the server checks them. */
export function validateConfirmation(values: ConfirmationValues): ConfirmationErrors {
  const errors: ConfirmationErrors = {};
  const reference = values.reference.trim();
  if (reference === '') errors.reference = 'required';
  else if (reference.length < MIN_REFERENCE) errors.reference = 'tooShort';
  else if (reference.length > MAX_REFERENCE) errors.reference = 'tooLong';
  const evidence = values.evidenceDocumentId.trim();
  if (evidence === '') errors.evidenceDocumentId = 'required';
  else if (!UUID.test(evidence)) errors.evidenceDocumentId = 'uuid';
  if (values.note.trim().length > MAX_NOTE) errors.note = 'tooLong';
  return errors;
}

export interface ConfirmationBody {
  legal_confirmation_ref: string;
  evidence_document_id: string;
  note?: string;
}

export function confirmationBody(values: ConfirmationValues): ConfirmationBody {
  const note = values.note.trim();
  return {
    legal_confirmation_ref: values.reference.trim(),
    evidence_document_id: values.evidenceDocumentId.trim().toLowerCase(),
    ...(note === '' ? {} : { note }),
  };
}

/** The reason of a retirement, 10 to 2000 characters. */
export function reasonProblem(reason: string): FieldProblem | undefined {
  const text = reason.trim();
  if (text === '') return 'required';
  if (text.length < MIN_REASON) return 'tooShort';
  if (text.length > MAX_REASON) return 'tooLong';
  return undefined;
}
