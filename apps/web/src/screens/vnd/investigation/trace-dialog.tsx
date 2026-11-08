import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { CommandDialog, rowsOf } from '../shared/vnd-form';
import type { FieldSpec, Row, Values } from '../shared/vnd-form';
import { errorText } from '../shared/vnd-labels';
import { failureCode, isUuid } from '../shared/vnd-model';
import { useVendorCommand } from './investigation-hooks';

type T = Translator['t'];

const MAX_FILES = 100;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A file of the proposal with the facts the officer read from it: its version, author, the program that produced it and the stamp of its creation. */
export const blankFile = (): Row => ({ document_version_id: '', author: '', producer: '', created_stamp: '' });

/** The files are acceptable when each names a version (an identifier), none is named twice and the list is not longer than the contract allows. */
export function filesValid(files: readonly Row[]): boolean {
  const ids = files.map((file) => clean(file.document_version_id));
  return files.length <= MAX_FILES && ids.every((id) => isUuid(id)) && new Set(ids.map((id) => id.toLowerCase())).size === ids.length;
}

/** The trace needs at least one fact: an origin, a device, an agent, or one file with an author, a producer or a creation stamp (the server refuses an empty one with 422). */
export function hasTraceFact(values: Values): boolean {
  if (['origin', 'device', 'agent'].some((name) => clean(values[name]) !== '')) return true;
  return rowsOf(values.files).some((file) => ['author', 'producer', 'created_stamp'].some((name) => clean(file[name]) !== ''));
}

/**
 * The instant of the submission: the day and the time of day read in Vietnam (+07:00), sent as the exact instant. A day alone is NOT sent: the server would store it as midnight UTC and that would replace the real
 * submission time that the time-window signals of the screening rest on.
 */
export function submittedInstant(values: Values): string | undefined {
  const day = clean(values.submitted_day);
  const time = clean(values.submitted_time);
  return day !== '' && TIME.test(time) ? `${day}T${time}:00+07:00` : undefined;
}

/** A time of day without a day cannot be placed on the calendar. */
export const timeWithoutDay = (values: Values): boolean => clean(values.submitted_time) !== '' && clean(values.submitted_day) === '';

/** The body of the command: only what was typed, trimmed; a file with nothing but its version keeps only the version. */
export function traceBody(values: Values): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const name of ['origin', 'device', 'agent'] as const) if (clean(values[name]) !== '') body[name] = clean(values[name]);
  const instant = submittedInstant(values);
  if (instant !== undefined) body.submitted_at = instant;
  const files = rowsOf(values.files).map((file) => ({
    document_version_id: clean(file.document_version_id),
    ...(clean(file.author) === '' ? {} : { author: clean(file.author) }),
    ...(clean(file.producer) === '' ? {} : { producer: clean(file.producer) }),
    ...(clean(file.created_stamp) === '' ? {} : { created_stamp: clean(file.created_stamp) }),
  }));
  if (files.length > 0) body.files = files;
  return body;
}

function describe(t: T, error: unknown): string {
  return failureCode(error) === 'SUBMISSION_TRACE_EXISTS' ? t('lookahead.vnd.trace.error.exists') : errorText(t, error);
}

function fieldsOf(t: T): FieldSpec[] {
  return [
    { name: 'proposal', label: t('lookahead.vnd.trace.proposal.label'), kind: 'uuid', required: true, hint: t('lookahead.vnd.trace.proposal.hint') },
    { name: 'origin', label: t('lookahead.vnd.trace.origin.label'), kind: 'text', min: 3, max: 100 },
    { name: 'device', label: t('lookahead.vnd.trace.device.label'), kind: 'text', min: 3, max: 200 },
    { name: 'agent', label: t('lookahead.vnd.trace.agent.label'), kind: 'text', min: 3, max: 500 },
    { name: 'submitted_day', label: t('lookahead.vnd.trace.submittedAt.label'), kind: 'date', hint: t('lookahead.vnd.trace.submittedAt.hint') },
    { name: 'submitted_time', label: t('lookahead.vnd.trace.submittedTime.label'), kind: 'text', pattern: TIME, hint: t('lookahead.vnd.trace.submittedTime.hint') },
    {
      name: 'files',
      label: t('lookahead.vnd.trace.files.label'),
      kind: 'custom',
      hint: t('lookahead.vnd.trace.files.hint'),
      initial: [],
      valid: (value) => filesValid(rowsOf(value)),
      render: (value, set, id) => {
        const rows = rowsOf(value);
        const change = (index: number, name: string, next: string): void => set(rows.map((row, at) => (at === index ? { ...row, [name]: next } : row)));
        return (
          <div className="vnd-stack" data-testid="trace-files">
            {rows.map((row, index) => (
              <fieldset key={`${id}-${index}`} className="vnd-stack" data-testid={`trace-file-${index + 1}`}>
                <legend>{t('lookahead.vnd.trace.file.legend', { n: index + 1 })}</legend>
                <input aria-label={t('lookahead.vnd.trace.file.version')} value={String(row.document_version_id ?? '')} onChange={(event) => change(index, 'document_version_id', event.target.value)} data-testid={`trace-file-version-${index + 1}`} />
                <input aria-label={t('lookahead.vnd.trace.file.author')} value={String(row.author ?? '')} maxLength={200} onChange={(event) => change(index, 'author', event.target.value)} />
                <input aria-label={t('lookahead.vnd.trace.file.producer')} value={String(row.producer ?? '')} maxLength={200} onChange={(event) => change(index, 'producer', event.target.value)} />
                <input aria-label={t('lookahead.vnd.trace.file.stamp')} value={String(row.created_stamp ?? '')} maxLength={60} onChange={(event) => change(index, 'created_stamp', event.target.value)} />
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => set(rows.filter((_, at) => at !== index))}>
                  {t('lookahead.vnd.trace.file.remove')}
                </button>
              </fieldset>
            ))}
            <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={rows.length >= MAX_FILES} data-testid="trace-add-file" onClick={() => set([...rows, blankFile()])}>
              {t('lookahead.vnd.trace.file.add')}
            </button>
          </div>
        );
      },
    },
  ];
}

/**
 * VND-13, the trace of the submission of a proposal: where and with what it was handed in. It is recorded once by the officer who received it and is never rewritten; the server keeps only blind indexes of the values, so two
 * proposals from one origin can be found by equality and no address, device or author is stored in the clear. The dialog says so, asks for at least one fact, and says a second record is refused.
 */
export function SubmissionTraceDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const command = useVendorCommand('recordProposalSubmissionTrace');
  return (
    <CommandDialog
      title={t('lookahead.vnd.trace.title')}
      context={[]}
      note={<p className="vnd-note">{t('lookahead.vnd.trace.note')}</p>}
      confirmLabel={t('lookahead.vnd.trace.confirm')}
      fields={fieldsOf(t)}
      blocked={(values) => !hasTraceFact(values) || timeWithoutDay(values)}
      wide
      describeError={describe}
      run={(values) => command.mutateAsync({ path: { id: clean(values.proposal) }, body: traceBody(values) })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
