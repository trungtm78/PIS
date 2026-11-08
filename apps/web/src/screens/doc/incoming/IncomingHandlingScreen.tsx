import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useUnitOptions } from '../registers/hooks';
import { FILE_PERMISSION, FileDialog } from './FileDialog';
import { useAssignLetter, useIncoming, useRegisterLetter, useRejectLetter, useResolveLetter, useStartLetter } from './hooks';
import { channelLabel, formProblemMessage, problemMessage, statusLabel, urgencyLabel } from './labels';
import { assignBody, canAct, describeProblem, emptyAssign, handlingLink, ledgerLink, openRegistersOf, validateAssign, validateWords, vietnamToday } from './model';
import type { AssignForm, IncomingLine } from './model';
import './incoming.css';

/**
 * DOC-13: the handling of one letter (ST-DOC-011, DOC.md F10). The chain from received to resolved is shown with who did what; the buttons are those the letter and the caller allow now: register it (the register gives the number),
 * reject it, assign it (and reassign it: the earlier assignments stay in the history), start working it and resolve it. Only the handler works a letter; the server judges every command again.
 */
export default function IncomingHandlingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [search] = useSearchParams();
  // The letter and the dialogs belong to one membership and to the letter that is open: a switch of either starts the screen over.
  return <HandlingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${search.get('id') ?? ''}`} route={route} />;
}

type Dialog = 'register' | 'assign' | 'resolve' | 'reject' | 'file';

interface DialogProps {
  line: IncomingLine;
  onClose(): void;
  /** The letter changed since the person read it: the dialog is closed, the letter is read again. */
  onConflict(): void;
}

/** What a command does when it is over: close the dialog if it worked and, if the letter had changed meanwhile, say so on the screen. */
const settle = (onClose: () => void, onConflict: () => void) => ({ onSuccess: onClose, onError: (error: unknown) => (describeProblem(error) === 'versionConflict' ? onConflict() : undefined) });

function HandlingContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode, permissions } = useSession();
  const mayFile = permissions === undefined || permissions.includes(FILE_PERMISSION);
  const [search] = useSearchParams();
  const wanted = search.get('id') ?? undefined;
  const letter = useIncoming(wanted);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [changed, setChanged] = useState(false);
  const openDialog = (next: Dialog): void => {
    setChanged(false);
    setDialog(next);
  };
  const conflict = (): void => {
    setDialog(undefined);
    setChanged(true);
  };
  const start = useStartLetter();
  const state = useScreenState({ isLoading: letter.isLoading, error: letter.error, data: wanted === undefined ? undefined : letter.data, isEmpty: (data) => data === null });
  const line = letter.data ?? undefined;
  const acting = canAct(mode);
  // A day written without a time (the deadline, the day on the letter) is shown as a day, not as midnight.
  const moment = (iso: string | null): string => {
    if (iso === null) return t('doc.incoming.none');
    const dayOnly = iso.length === 10;
    return new Intl.DateTimeFormat(locale, dayOnly ? { dateStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' } : { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(dayOnly ? `${iso}T00:00:00+07:00` : iso));
  };
  const refusal = changed ? problemMessage(t, 'versionConflict') : start.isError ? problemMessage(t, describeProblem(start.error)) : undefined;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.incoming.handling.title')}</h1>
          <p>{t('doc.incoming.handling.subtitle')}</p>
        </div>
        <div className="actions">
          <Link className="button" to={ledgerLink()}>
            {t('doc.incoming.ledger.link')}
          </Link>
        </div>
      </div>
      {wanted === undefined ? (
        <p className="callout" role="status" data-testid="no-letter-chosen">
          {t('doc.incoming.handling.choose')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void letter.refetch()}>
          {line === undefined ? (
            <p className="callout warning" role="alert" data-testid="letter-missing">
              {t('doc.incoming.error.notFound')}
            </p>
          ) : (
            <div className="card">
              <p data-testid="letter-title">
                <strong>{line.title}</strong> · <span data-testid="letter-status">{statusLabel(t, line.status)}</span>
                {line.overdueDays === null || line.dueOn === null ? null : (
                  <span className="incoming-chip danger" data-testid="overdue">
                    {t('doc.incoming.overdue', { days: line.overdueDays, date: moment(line.dueOn) })}
                  </span>
                )}
              </p>
              {refusal === undefined ? null : (
                <p className="callout warning" role="alert" data-testid="refusal">
                  {refusal}
                </p>
              )}
              <Facts line={line} moment={moment} />
              {acting ? (
                <div className="actions">
                  {line.actions.register ? (
                    <button type="button" className="primary" data-action="register" onClick={() => openDialog('register')}>
                      {t('doc.incoming.register.action')}
                    </button>
                  ) : null}
                  {line.actions.assign ? (
                    <button type="button" className="primary" data-action="assign" onClick={() => openDialog('assign')}>
                      {line.status === 'REGISTERED' ? t('doc.incoming.assign.action') : t('doc.incoming.reassign.action')}
                    </button>
                  ) : null}
                  {line.actions.startProcessing ? (
                    <button type="button" className="primary" data-action="start" disabled={start.isPending} onClick={() => start.mutate({ id: line.id, version: line.version })}>
                      {t('doc.incoming.start.action')}
                    </button>
                  ) : null}
                  {line.actions.resolve ? (
                    <button type="button" className="primary" data-action="resolve" onClick={() => openDialog('resolve')}>
                      {t('doc.incoming.resolve.action')}
                    </button>
                  ) : null}
                  {line.status === 'RESOLVED' && mayFile ? (
                    <button type="button" className="primary" data-action="file" onClick={() => openDialog('file')}>
                      {t('doc.dossier.file.action')}
                    </button>
                  ) : null}
                  {line.actions.reject ? (
                    <button type="button" data-action="reject" onClick={() => openDialog('reject')}>
                      {t('doc.incoming.reject.action')}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {line.assignments.length === 0 ? null : (
                <section aria-label={t('doc.incoming.history.title')} data-testid="history">
                  <h2>{t('doc.incoming.history.title')}</h2>
                  <ol className="qms-actions">
                    {line.assignments.map((entry) => (
                      <li key={entry.id} data-assignment={entry.id}>
                        {entry.unitName}
                        {entry.assignee === null ? '' : ` · ${entry.assignee}`}
                        {entry.dueOn === null ? '' : ` · ${t('doc.incoming.due', { date: moment(entry.dueOn) })}`}
                        <small className="sub incoming-meta">
                          {moment(entry.assignedAt)}
                          {entry.directive === null ? '' : ` — ${entry.directive}`}
                        </small>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </div>
          )}
        </StateBoundary>
      )}
      {dialog === 'register' && line !== undefined ? <RegisterDialog line={line} onClose={() => setDialog(undefined)} onConflict={conflict} /> : null}
      {dialog === 'assign' && line !== undefined ? <AssignDialog line={line} onClose={() => setDialog(undefined)} onConflict={conflict} /> : null}
      {dialog === 'resolve' && line !== undefined ? <ResolveDialog line={line} onClose={() => setDialog(undefined)} onConflict={conflict} /> : null}
      {dialog === 'file' && line !== undefined ? <FileDialog line={line} onClose={() => setDialog(undefined)} onConflict={conflict} /> : null}
      {dialog === 'reject' && line !== undefined ? <RejectDialog line={line} onClose={() => setDialog(undefined)} onConflict={conflict} /> : null}
      <p className="prototype-note">{t('doc.incoming.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Facts({ line, moment }: { line: IncomingLine; moment: (iso: string | null) => string }) {
  const { t } = useTranslation();
  const row = (label: string, value: ReactNode, id: string) => (
    <>
      <dt>{label}</dt>
      <dd data-testid={id}>{value}</dd>
    </>
  );
  return (
    <dl className="qms-facts">
      {row(t('doc.incoming.column.number'), line.symbol ?? t('doc.incoming.none'), 'fact-number')}
      {row(t('doc.incoming.field.sender'), line.senderName, 'fact-sender')}
      {line.documentId === '' ? null : row(t('doc.incoming.fact.document'), <code>{line.documentId}</code>, 'fact-document')}
      {row(t('doc.incoming.field.symbol'), line.originalSymbol ?? t('doc.incoming.none'), 'fact-symbol')}
      {row(t('doc.incoming.field.issuedOn'), moment(line.originalIssuedOn), 'fact-issued')}
      {row(t('doc.incoming.field.channel'), channelLabel(t, line.channel), 'fact-channel')}
      {row(t('doc.incoming.field.urgency'), urgencyLabel(t, line.urgency), 'fact-urgency')}
      {row(t('doc.incoming.column.received'), moment(line.receivedAt), 'fact-received')}
      {line.assignedUnit === null ? null : row(t('doc.incoming.column.assigned'), `${line.assignedUnit.name}${line.assignee === null ? '' : ` · ${line.assignee.name}`}`, 'fact-assigned')}
      {line.dueOn === null ? null : row(t('doc.incoming.field.dueOn'), moment(line.dueOn), 'fact-due')}
      {line.leaderDirective === null ? null : row(t('doc.incoming.field.directive'), line.leaderDirective, 'fact-directive')}
      {line.duplicateOfId === null ? null : row(t('doc.incoming.fact.duplicateOf'), <Link to={handlingLink(line.duplicateOfId)}>{line.duplicateOfId.slice(-8)}</Link>, 'fact-duplicate')}
      {line.duplicateOverrideReason === null ? null : row(t('doc.incoming.field.duplicateReason'), line.duplicateOverrideReason, 'fact-duplicate-reason')}
      {line.resolutionSummary === null ? null : row(t('doc.incoming.field.summary'), line.resolutionSummary, 'fact-summary')}
      {line.lateDays === null || line.lateDays === 0 ? null : row(t('doc.incoming.fact.late'), t('doc.incoming.late.days', { days: line.lateDays }), 'fact-late')}
      {line.rejectionReason === null ? null : row(t('doc.incoming.field.rejectionReason'), line.rejectionReason, 'fact-rejection')}
    </dl>
  );
}

interface FrameProps {
  title: string;
  error: unknown;
  hasError: boolean;
  pending: boolean;
  submitLabel: string;
  onSubmit(event: FormEvent): void;
  onClose(): void;
  children: ReactNode;
}

/** The frame the commands are asked in: the title, the refusal of the server in words, the fields (held while the command is on its way) and the two buttons. */
function Frame({ title, error, hasError, pending, submitLabel, onSubmit, onClose, children }: FrameProps) {
  const { t } = useTranslation();
  const words = { close: t('doc.incoming.dialog.close'), cancel: t('doc.incoming.dialog.cancel'), pending: t('doc.incoming.dialog.pending') };
  return (
    <CommandFrame title={title} refusal={hasError ? problemMessage(t, describeProblem(error)) : undefined} pending={pending} submitLabel={submitLabel} words={words} onSubmit={onSubmit} onClose={onClose}>
      <fieldset className="incoming-fields" disabled={pending}>
        {children}
      </fieldset>
    </CommandFrame>
  );
}

/** Registering: the server takes the only open register of the caller; when several are open it names them and the person chooses one. */
function RegisterDialog({ line, onClose, onConflict }: DialogProps) {
  const { t } = useTranslation();
  const register = useRegisterLetter();
  const [opened] = useState(() => ({ id: line.id, version: line.version }));
  const [chosen, setChosen] = useState('');
  const choices = openRegistersOf(register.error);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (register.isPending) return;
    register.mutate({ id: opened.id, version: opened.version, body: chosen === '' ? {} : { register_id: chosen } }, settle(onClose, onConflict));
  };
  return (
    <Frame title={t('doc.incoming.register.title')} error={register.error} hasError={register.isError} pending={register.isPending} submitLabel={t('doc.incoming.register.submit')} onSubmit={send} onClose={onClose}>
      {choices.length > 0 ? (
        <Field id="register-choice" label={t('doc.incoming.register.choose')} error={undefined}>
          <select id="register-choice" value={chosen} onChange={(event) => setChosen(event.target.value)}>
            <option value="">{t('doc.incoming.register.automatic')}</option>
            {choices.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.code}
                {candidate.name === '' ? '' : ` · ${candidate.name}`}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
    </Frame>
  );
}

function AssignDialog({ line, onClose, onConflict }: DialogProps) {
  const { t } = useTranslation();
  const assign = useAssignLetter();
  const units = useUnitOptions();
  const [opened] = useState(() => ({ id: line.id, version: line.version }));
  const [form, setForm] = useState<AssignForm>(() => ({ ...emptyAssign(), unitId: line.assignedUnit?.id ?? '', assigneeUserId: line.assignee?.userId ?? '', directive: line.leaderDirective ?? '', dueOn: line.dueOn ?? '' }));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateAssign(form, vietnamToday());
  // The list of units needs the right to read them, which the right to assign does not carry: without it the unit is typed (its id) and the server judges it.
  const typedUnit = units.isError || (units.isSuccess && (units.data ?? []).length === 0);
  const shown = (field: keyof AssignForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (assign.isPending || Object.keys(problems).length > 0) return;
    assign.mutate({ id: opened.id, version: opened.version, body: assignBody(form) }, settle(onClose, onConflict));
  };
  return (
    <Frame title={t('doc.incoming.assign.title')} error={assign.error} hasError={assign.isError} pending={assign.isPending} submitLabel={t('doc.incoming.assign.submit')} onSubmit={send} onClose={onClose}>
      <Field id="assign-unit" label={t('doc.incoming.field.unit')} error={shown('unitId')} hint={typedUnit ? t('doc.incoming.field.unit.typed') : undefined}>
        {typedUnit ? (
          <input id="assign-unit" autoComplete="off" value={form.unitId} onChange={(event) => setForm({ ...form, unitId: event.target.value.trim() })} />
        ) : (
          <select id="assign-unit" value={form.unitId} onChange={(event) => setForm({ ...form, unitId: event.target.value })}>
            <option value="">{t('doc.incoming.field.unit.choose')}</option>
            {(units.data ?? []).map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name === '' ? unit.code : unit.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field id="assign-user" label={t('doc.incoming.field.assignee')} error={shown('assigneeUserId')} hint={t('doc.incoming.field.assignee.hint')}>
        <input id="assign-user" autoComplete="off" value={form.assigneeUserId} onChange={(event) => setForm({ ...form, assigneeUserId: event.target.value })} />
      </Field>
      <Field id="assign-due" label={t('doc.incoming.field.dueOn')} error={shown('dueOn')}>
        <input id="assign-due" type="date" min={vietnamToday()} value={form.dueOn} onChange={(event) => setForm({ ...form, dueOn: event.target.value })} />
      </Field>
      <Field id="assign-directive" label={t('doc.incoming.field.directive')} error={shown('directive')}>
        <textarea id="assign-directive" rows={3} value={form.directive} onChange={(event) => setForm({ ...form, directive: event.target.value })} />
      </Field>
    </Frame>
  );
}

function ResolveDialog({ line, onClose, onConflict }: DialogProps) {
  const { t } = useTranslation();
  const resolve = useResolveLetter();
  const [opened] = useState(() => ({ id: line.id, version: line.version }));
  const [summary, setSummary] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problem = validateWords(summary, 5, 2000);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (resolve.isPending || problem !== undefined) return;
    resolve.mutate({ id: opened.id, version: opened.version, body: { resolution_summary: summary.trim() } }, settle(onClose, onConflict));
  };
  return (
    <Frame title={t('doc.incoming.resolve.title')} error={resolve.error} hasError={resolve.isError} pending={resolve.isPending} submitLabel={t('doc.incoming.resolve.submit')} onSubmit={send} onClose={onClose}>
      {line.overdueDays === null ? null : <p className="callout warning">{t('doc.incoming.resolve.late', { days: line.overdueDays })}</p>}
      <Field id="resolve-summary" label={t('doc.incoming.field.summary')} error={submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined}>
        <textarea id="resolve-summary" rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} />
      </Field>
    </Frame>
  );
}

function RejectDialog({ line, onClose, onConflict }: DialogProps) {
  const { t } = useTranslation();
  const reject = useRejectLetter();
  const [opened] = useState(() => ({ id: line.id, version: line.version }));
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problem = validateWords(reason, 10, 1000);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (reject.isPending || problem !== undefined) return;
    reject.mutate({ id: opened.id, version: opened.version, body: { rejection_reason: reason.trim() } }, settle(onClose, onConflict));
  };
  return (
    <Frame title={t('doc.incoming.reject.title')} error={reject.error} hasError={reject.isError} pending={reject.isPending} submitLabel={t('doc.incoming.reject.submit')} onSubmit={send} onClose={onClose}>
      <Field id="reject-reason" label={t('doc.incoming.field.rejectionReason')} error={submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined}>
        <textarea id="reject-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Frame>
  );
}
