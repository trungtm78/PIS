import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useEdition } from '../../editions/EditionContext';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Citation, FormPanel, Money, OriginBadge, StatusBadge } from './components';
import { useAppropriations, useDecideAppropriation, useMasterOptions, useRegisterAppropriation } from './hooks';
import { levelLabel, originLabel, problemMessage } from './labels';
import {
  APPROVE_PERMISSION,
  ALL_ORIGINS,
  BUDGET_LEVELS,
  EMPTY_FILTER,
  MANAGE_PERMISSION,
  ENTERPRISE_LEVEL,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  changeField,
  describeProblem,
  emptyFormOf,
  filterLines,
  formLevelsOf,
  formOfRevision,
  formOriginsOf,
  isPublished,
  registerBody,
  sortLines,
  totalsOf,
  validateForm,
  yearsOf,
} from './model';
import type { AppropriationForm, AppropriationLine, BookFilter, BudgetLevel, FieldProblem, FormField, Origin } from './model';
import './cap.css';

type Panel = { kind: 'new' } | { kind: 'revision'; line: AppropriationLine };
interface Acting {
  id: string;
  decision: 'approve' | 'reject';
}

/**
 * CAP-16: the book of the capital assigned to the province, by fund source, plan year, origin and budget level, each line backed by the
 * decision document that assigned it. "Remaining" is the amount less what is allocated. A planner registers a draft or a revision, an
 * approver who is not the planner publishes or rejects it; the amount is typed in millions of dong and sent as exact VND.
 */
export default function AppropriationBookScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The book, the form and the drafts belong to one membership: a switch of tenant or of membership starts the screen over.
  return <BookContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BookContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const canManage = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && !frozen;
  const canApprove = (permissions === undefined || permissions.includes(APPROVE_PERMISSION)) && !frozen;
  const book = useAppropriations();
  const register = useRegisterAppropriation();
  const decide = useDecideAppropriation();
  const [filter, setFilter] = useState<BookFilter>(EMPTY_FILTER);
  const [panel, setPanel] = useState<Panel | undefined>(undefined);
  // The register of the enterprise edition lists other origins, the single level and a kind of decision document: the form opens on a line it accepts.
  const enterprise = useEdition().manifest.edition === 'enterprise';
  const [form, setForm] = useState<AppropriationForm>(() => emptyFormOf(enterprise));
  const [errors, setErrors] = useState<Partial<Record<FormField, FieldProblem>>>({});
  const [acting, setActing] = useState<Acting | undefined>(undefined);
  const [reason, setReason] = useState('');
  const funds = useMasterOptions(['FUND_SOURCE'], panel !== undefined);
  const programs = useMasterOptions(['PROGRAM'], panel !== undefined);
  const state = useScreenState({ isLoading: book.isLoading, error: book.error, data: book.data });
  const shown = useMemo(() => sortLines(filterLines(book.data ?? [], filter)), [book.data, filter]);
  // The filters list what the form of the edition registers (the public origins and levels, or the enterprise ones), then any other origin or level the register holds a line of (the public edition never sees the enterprise ones).
  const filterOrigins = useMemo(() => [...formOriginsOf(enterprise), ...ALL_ORIGINS.filter((origin) => !formOriginsOf(enterprise).includes(origin) && (book.data ?? []).some((line) => line.origin === origin))] as readonly Origin[], [book.data, enterprise]);
  const filterLevels = useMemo(() => [...formLevelsOf(enterprise), ...([...BUDGET_LEVELS, ENTERPRISE_LEVEL] as readonly BudgetLevel[]).filter((level) => !formLevelsOf(enterprise).includes(level) && (book.data ?? []).some((line) => line.budgetLevel === level))] as readonly BudgetLevel[], [book.data, enterprise]);
  const totals = useMemo(() => totalsOf(shown.filter(isPublished)), [shown]);
  const problem = register.isError ? describeProblem(register.error) : decide.isError ? describeProblem(decide.error) : undefined;
  const reasonTooShort = reason.trim().length < REASON_MIN_LENGTH;

  const open = (next: Panel): void => {
    register.reset();
    setErrors({});
    setPanel(next);
    setForm(next.kind === 'new' ? emptyFormOf(enterprise) : formOfRevision(next.line, locale));
  };
  const close = (): void => {
    setPanel(undefined);
    setErrors({});
  };
  const setField = (field: FormField, value: string): void => {
    setForm((current) => changeField(current, field, value, enterprise));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };
  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (register.isPending || !canManage || panel === undefined) return;
    const found = validateForm(form, locale, enterprise);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    register.mutate(registerBody(form, locale, panel.kind === 'revision' ? panel.line.id : undefined), { onSuccess: close });
  };
  const startActing = (next: Acting): void => {
    decide.reset();
    setReason('');
    setActing(next);
  };
  const send = (event: FormEvent, line: AppropriationLine): void => {
    event.preventDefault();
    if (decide.isPending || acting === undefined || reasonTooShort) return;
    decide.mutate({ id: line.id, version: line.version, decision: acting.decision, reason: reason.trim() }, { onSuccess: () => setActing(undefined) });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.book.page.title')}</h1>
          <p>{t('cap.book.page.subtitle')}</p>
        </div>
        {canManage ? (
          <button type="button" className="button primary" onClick={() => open({ kind: 'new' })} disabled={panel?.kind === 'new'}>
            {t('cap.book.register.action')}
          </button>
        ) : null}
      </div>
      {!canManage && !canApprove ? (
        <p className="callout" role="status">
          {frozen ? t('cap.readOnly.frozen.notice') : t('cap.readOnly.denied.notice')}
        </p>
      ) : null}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="problem">
          {problemMessage(t, problem)}
        </p>
      )}
      {panel === undefined ? null : (
        <FormPanel
          title={panel.kind === 'new' ? t('cap.book.form.new.title') : t('cap.book.form.revision.title', { fund: panel.line.fundSource.businessKey, year: panel.line.planYear })}
          form={form}
          errors={errors}
          funds={funds.data ?? []}
          programs={programs.data ?? []}
          revision={panel.kind === 'revision'}
          enterprise={enterprise}
          disabled={!canManage}
          pending={register.isPending}
          onChange={setField}
          onSubmit={save}
          onCancel={close}
        />
      )}
      <StateBoundary state={state} onRetry={() => void book.refetch()}>
        <div className="card">
          <form className="cap-filters" role="search" aria-label={t('cap.book.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="book-year">{t('cap.book.year.label')}</label>
              <select id="book-year" value={filter.year} onChange={(event) => setFilter({ ...filter, year: event.target.value })}>
                <option value="">{t('cap.book.filter.all')}</option>
                {yearsOf(book.data ?? []).map((year) => (
                  <option key={year} value={String(year)}>
                    {year}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="book-origin">{t('cap.book.origin.label')}</label>
              <select id="book-origin" value={filter.origin} onChange={(event) => setFilter({ ...filter, origin: event.target.value as Origin | '' })}>
                <option value="">{t('cap.book.filter.all')}</option>
                {filterOrigins.map((origin) => (
                  <option key={origin} value={origin}>
                    {originLabel(t, origin)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="book-level">{t('cap.book.level.label')}</label>
              <select id="book-level" value={filter.budgetLevel} onChange={(event) => setFilter({ ...filter, budgetLevel: event.target.value as BudgetLevel | '' })}>
                <option value="">{t('cap.book.filter.all')}</option>
                {filterLevels.map((level) => (
                  <option key={level} value={level}>
                    {levelLabel(t, level)}
                  </option>
                ))}
              </select>
            </div>
          </form>
          {shown.length === 0 ? (
            <p className="callout" role="status" data-testid="no-match">
              {t('cap.book.noMatch.notice')}
            </p>
          ) : (
            <div className="cap-scroll">
              <table className="table cap-table" data-testid="book" aria-label={t('cap.book.table.aria')}>
                <caption className="sr-only">{t('cap.book.table.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="cap-pin cap-pin-1">
                      {t('cap.book.column.fund')}
                    </th>
                    <th scope="col" className="cap-pin cap-pin-2">
                      {t('cap.book.column.year')}
                    </th>
                    <th scope="col">{t('cap.book.column.origin')}</th>
                    <th scope="col">{t('cap.book.column.level')}</th>
                    <th scope="col">{t('cap.book.column.decision')}</th>
                    <th scope="col" className="cap-number">
                      {t('cap.book.column.amount')}
                    </th>
                    <th scope="col" className="cap-number">
                      {t('cap.book.column.allocated')}
                    </th>
                    <th scope="col" className="cap-number">
                      {t('cap.book.column.remaining')}
                    </th>
                    <th scope="col">{t('cap.book.column.status')}</th>
                    <th scope="col">{t('cap.book.column.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((line) => (
                    <BookRow
                      key={line.id}
                      line={line}
                      mine={line.createdBy === tenant?.membershipId}
                      canManage={canManage}
                      canApprove={canApprove}
                      acting={acting?.id === line.id ? acting : undefined}
                      reason={reason}
                      reasonTooShort={reasonTooShort}
                      pending={decide.isPending}
                      onReason={setReason}
                      onRevise={() => open({ kind: 'revision', line })}
                      onAct={(decision) => startActing({ id: line.id, decision })}
                      onCancel={() => setActing(undefined)}
                      onSend={(event) => send(event, line)}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr data-testid="totals">
                    <th scope="row" colSpan={5}>
                      {t('cap.book.total.label')}
                    </th>
                    <td className="cap-number">
                      <Money vnd={totals.amountVnd} />
                    </td>
                    <td className="cap-number">
                      <Money vnd={totals.allocatedVnd} />
                    </td>
                    <td className="cap-number">
                      <Money vnd={totals.remainingVnd} />
                    </td>
                    <td colSpan={2}>{t('cap.book.total.note')}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('cap.book.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface RowProps {
  line: AppropriationLine;
  mine: boolean;
  canManage: boolean;
  canApprove: boolean;
  acting: Acting | undefined;
  reason: string;
  reasonTooShort: boolean;
  pending: boolean;
  onReason: (reason: string) => void;
  onRevise: () => void;
  onAct: (decision: 'approve' | 'reject') => void;
  onCancel: () => void;
  onSend: (event: FormEvent) => void;
}

function BookRow({ line, mine, canManage, canApprove, acting, reason, reasonTooShort, pending, onReason, onRevise, onAct, onCancel, onSend }: RowProps) {
  const { t } = useTranslation();
  const draft = line.status === 'DRAFT';
  return (
    <>
      <tr data-appropriation-id={line.id} data-origin={line.origin}>
        <th scope="row" className="cap-pin cap-pin-1">
          <span>{line.fundSource.businessKey}</span> <small className="sub">{line.fundSource.label}</small>
          {line.program === null ? null : <small className="sub"> · {line.program.label}</small>}
        </th>
        <td className="cap-pin cap-pin-2">{line.planYear}</td>
        <td>
          <OriginBadge origin={line.origin} />
          {line.revision > 1 ? <small className="sub"> {t('cap.book.revision.label', { revision: line.revision })}</small> : null}
        </td>
        <td>{levelLabel(t, line.budgetLevel)}</td>
        <td>
          <Citation line={line} />
          <small className="sub"> {line.issuingAuthority}</small>
        </td>
        <td className="cap-number">
          <Money vnd={line.amountVnd} />
        </td>
        <td className="cap-number">
          <Money vnd={line.allocatedTotalVnd} />
        </td>
        <td className="cap-number" data-testid="remaining">
          <Money vnd={line.remainingVnd} />
        </td>
        <td>
          <StatusBadge line={line} />
        </td>
        <td className="cap-actions">
          {draft && canApprove && !mine ? (
            <>
              <button type="button" className="primary" data-decision="approve" onClick={() => onAct('approve')}>
                {t('cap.book.approve.action')}
              </button>
              <button type="button" data-decision="reject" onClick={() => onAct('reject')}>
                {t('cap.book.reject.action')}
              </button>
            </>
          ) : null}
          {draft && canApprove && mine ? <small className="sub">{t('cap.book.ownDraft.notice')}</small> : null}
          {line.status === 'PUBLISHED' && canManage ? (
            <button type="button" data-action="revise" onClick={onRevise}>
              {t('cap.book.revise.action')}
            </button>
          ) : null}
        </td>
      </tr>
      {acting === undefined ? null : (
        <tr data-testid="decision-row">
          <td colSpan={10}>
            <form className="cap-decision" onSubmit={onSend} aria-label={t('cap.book.decision.title')}>
              <label htmlFor={`reason-${line.id}`}>{acting.decision === 'approve' ? t('cap.book.reason.approve.label') : t('cap.book.reason.reject.label')}</label>
              <textarea id={`reason-${line.id}`} value={reason} maxLength={REASON_MAX_LENGTH} onChange={(event) => onReason(event.target.value)} />
              <small className="sub">{t('cap.book.reason.hint', { min: REASON_MIN_LENGTH })}</small>
              <div className="formfooter">
                <button type="button" onClick={onCancel}>
                  {t('cap.book.decision.cancel.action')}
                </button>
                <button type="submit" className="button primary" disabled={pending || reasonTooShort}>
                  {pending ? t('cap.book.decision.submit.pending') : acting.decision === 'approve' ? t('cap.book.decision.approve.action') : t('cap.book.decision.reject.action')}
                </button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
