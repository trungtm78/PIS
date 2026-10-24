import type { FieldProblem } from '../drafts/rules';
import { MAX_TITLE_CHARS, MIN_TITLE_CHARS, MAX_RECIPIENTS } from '../drafts/rules';
import type { Register } from '../registers/types';
import { MAX_FILE_BYTES } from './types';
import type { FileCheck } from './types';

const SYMBOL_MAX_CHARS = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type FileProblem = 'REQUIRED' | 'EMPTY' | 'NOT_PDF' | 'TOO_LARGE';

/** What is wrong with the file before it is sent: the server judges by the bytes, this only saves a round trip. */
export function fileProblem(file: { name: string; size: number; type: string } | undefined): FileProblem | undefined {
  if (file === undefined) return 'REQUIRED';
  if (file.size === 0) return 'EMPTY';
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) return 'NOT_PDF';
  if (file.size > MAX_FILE_BYTES) return 'TOO_LARGE';
  return undefined;
}

export interface RegistrationForm {
  docTypeCode: string;
  title: string;
  unitId: string;
  registerId: string;
  number: string;
  symbol: string;
  issuedOn: string;
  recipients: string;
}

export const EMPTY_REGISTRATION: RegistrationForm = { docTypeCode: '', title: '', unitId: '', registerId: '', number: '', symbol: '', issuedOn: '', recipients: '' };

/** The names typed one per line, trimmed, empty lines dropped and a repeated name once. */
export function recipientNames(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const name = line.trim();
    if (name === '' || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

export const isWholeNumber = (value: string): boolean => /^[1-9]\d{0,8}$/.test(value.trim());

export function registrationProblems(form: RegistrationForm): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const title = form.title.trim();
  if (form.docTypeCode === '') problems.push({ field: 'docTypeCode', code: 'REQUIRED' });
  if (title === '') problems.push({ field: 'title', code: 'REQUIRED' });
  else if (title.length < MIN_TITLE_CHARS) problems.push({ field: 'title', code: 'TOO_SHORT' });
  else if (title.length > MAX_TITLE_CHARS) problems.push({ field: 'title', code: 'TOO_LONG' });
  if (form.unitId === '') problems.push({ field: 'unitId', code: 'REQUIRED' });
  if (form.registerId === '') problems.push({ field: 'registerId', code: 'REQUIRED' });
  if (form.number.trim() === '') problems.push({ field: 'number', code: 'REQUIRED' });
  else if (!isWholeNumber(form.number)) problems.push({ field: 'number', code: 'INVALID' });
  const symbol = form.symbol.trim();
  if (symbol === '') problems.push({ field: 'symbol', code: 'REQUIRED' });
  else if (symbol.length > SYMBOL_MAX_CHARS) problems.push({ field: 'symbol', code: 'TOO_LONG' });
  if (form.issuedOn === '') problems.push({ field: 'issuedOn', code: 'REQUIRED' });
  else if (!ISO_DATE.test(form.issuedOn)) problems.push({ field: 'issuedOn', code: 'INVALID' });
  if (recipientNames(form.recipients).length > MAX_RECIPIENTS) problems.push({ field: 'recipients', code: 'TOO_LONG' });
  return problems;
}

/** The open outgoing registers that can take the document: the year of its date and, when the register is limited to some types, its type. */
export function registersFor(registers: readonly Register[], form: Pick<RegistrationForm, 'issuedOn' | 'docTypeCode'>): Register[] {
  const year = ISO_DATE.test(form.issuedOn) ? Number(form.issuedOn.slice(0, 4)) : undefined;
  return registers.filter(
    (register) =>
      register.status === 'OPEN' &&
      register.direction === 'OUTGOING' &&
      (year === undefined || register.year === year) &&
      (form.docTypeCode === '' || register.scopeDocTypes.length === 0 || register.scopeDocTypes.includes(form.docTypeCode)),
  );
}

export interface ExternalBody {
  doc_type_code: string;
  title: string;
  file_object_key: string;
  file_sha256: string;
  declared_number: number;
  declared_symbol: string;
  declared_issued_on: string;
  register_id: string;
  drafting_unit_id: string;
  recipients: Array<{ name: string }>;
}

/** The body of registerExternallySignedDocument from the form and the file that was read. */
export function registrationBody(form: RegistrationForm, check: Pick<FileCheck, 'fileObjectKey' | 'fileSha256'>): ExternalBody {
  return {
    doc_type_code: form.docTypeCode,
    title: form.title.trim(),
    file_object_key: check.fileObjectKey,
    file_sha256: check.fileSha256,
    declared_number: Number(form.number.trim()),
    declared_symbol: form.symbol.trim(),
    declared_issued_on: form.issuedOn,
    register_id: form.registerId,
    drafting_unit_id: form.unitId,
    recipients: recipientNames(form.recipients).map((name) => ({ name })),
  };
}

/** The file may be attached only when every signature in it holds; the server judges again, strictly, before it accepts anything. */
export const attachable = (check: FileCheck | undefined): boolean => check !== undefined && check.overall === 'VALID' && check.signatures.length > 0;
