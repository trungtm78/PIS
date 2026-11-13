import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../prj/components';
import { useProjects } from '../../prj/hooks';
import '../../prj/prj.css';
import { useLedger } from './hooks';
import { COLUMNS, EMPTY_FILTER, formatVnd, validateFilter } from './model';
import type { Column, FilterField, LedgerFilter } from './model';

type T = Translator['t'];
const NONE = '—';

/** The kind of the source document an entry was posted from (capital_ledger_entry.source_ref_kind); a kind this screen does not know is shown as it came. */
function sourceLabel(t: T, kind: string): string {
  switch (kind) {
    case 'CAPITAL_PLAN':
      return t('cap.ledger.source.capitalPlan');
    case 'APPROPRIATION':
      return t('cap.ledger.source.appropriation');
    case 'RESERVATION':
      return t('cap.ledger.source.reservation');
    case 'PAYMENT_REQUEST':
      return t('cap.ledger.source.paymentRequest');
    case 'TREASURY_TRANSACTION':
      return t('cap.ledger.source.treasury');
    case 'REALLOCATION':
      return t('cap.ledger.source.reallocation');
    case 'EXTENSION':
      return t('cap.ledger.source.extension');
    case 'YEAR_CLOSE':
      return t('cap.ledger.source.yearClose');
    case 'CONTRACT':
      return t('cap.ledger.source.contract');
    default:
      return kind === '' ? NONE : kind;
  }
}

function typeLabel(t: T, type: string): string {
  switch (type) {
    case 'APPROPRIATE':
      return t('cap.ledger.type.appropriate');
    case 'ALLOCATE':
      return t('cap.ledger.type.allocate');
    case 'REDUCE':
      return t('cap.ledger.type.reduce');
    case 'TRANSFER_OUT':
      return t('cap.ledger.type.transferOut');
    case 'TRANSFER_IN':
      return t('cap.ledger.type.transferIn');
    case 'RESERVE':
      return t('cap.ledger.type.reserve');
    case 'RELEASE':
      return t('cap.ledger.type.release');
    case 'COMMIT':
      return t('cap.ledger.type.commit');
    case 'UNCOMMIT':
      return t('cap.ledger.type.uncommit');
    case 'DISBURSE':
      return t('cap.ledger.type.disburse');
    case 'EXTEND_OUT':
      return t('cap.ledger.type.extendOut');
    case 'EXTEND_IN':
      return t('cap.ledger.type.extendIn');
    case 'LAPSE':
      return t('cap.ledger.type.lapse');
    case 'REVERSAL':
      return t('cap.ledger.type.reversal');
    default:
      return type;
  }
}

function columnLabel(t: T, column: Column): string {
  switch (column) {
    case 'appropriated':
      return t('cap.ledger.balance.appropriated');
    case 'allocated':
      return t('cap.ledger.balance.allocated');
    case 'reserved':
      return t('cap.ledger.balance.reserved');
    case 'committed':
      return t('cap.ledger.balance.committed');
    case 'disbursed':
      return t('cap.ledger.balance.disbursed');
  }
}

/**
 * CAP-21: the capital ledger (ST-CAP-014, CAP 3.4). The entries of the append-only ledger are listed newest first, and the balance at a chosen day ("view at the day") is the sum of the entries posted up to it, so every
 * balance can be traced to entries. A caller reads the entries of the projects in their scope; there is no action that writes.
 */
export default function LedgerScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The ledger is read for one membership: a switch starts the screen over.
  return <LedgerContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function LedgerContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const [draft, setDraft] = useState<LedgerFilter>(EMPTY_FILTER);
  const [applied, setApplied] = useState<LedgerFilter>(EMPTY_FILTER);
  const [problems, setProblems] = useState<Partial<Record<FilterField, 'invalid'>>>({});
  const projects = useProjects();
  const list = useLedger(applied, true);
  const items = (list.data?.pages ?? []).flatMap((page) => page.items);
  const head = list.data?.pages[0];
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : items, isEmpty: () => items.length === 0 });
  const money = (amount: string): string => t('cap.ledger.value.amount', { amount: formatVnd(amount, locale) });
  const set = (patch: Partial<LedgerFilter>): void => setDraft((value) => ({ ...value, ...patch }));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateFilter(draft);
    setProblems(found);
    if (Object.keys(found).length === 0) setApplied(draft);
  };
  const error = (field: FilterField): string | undefined => (problems[field] === undefined ? undefined : t('cap.ledger.field.invalid.error'));
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.ledger.page.title')}</h1>
          <p>{t('cap.ledger.page.subtitle')}</p>
        </div>
      </div>
      <form className="card" onSubmit={submit} noValidate aria-label={t('cap.ledger.filter.title')}>
        <h2>{t('cap.ledger.filter.title')}</h2>
        {(projects.data ?? []).length === 0 ? null : (
          <Field id="ledger-project" label={t('cap.ledger.field.project.label')} error={undefined}>
            <select id="ledger-project" value={draft.projectId} onChange={(event) => set({ projectId: event.target.value })}>
              <option value="">{NONE}</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.code} {project.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field id="ledger-appropriation" label={t('cap.ledger.field.appropriation.label')} error={error('appropriationId')} hint={t('cap.ledger.field.id.hint')}>
          <input id="ledger-appropriation" type="text" value={draft.appropriationId} onChange={(event) => set({ appropriationId: event.target.value })} />
        </Field>
        <Field id="ledger-line" label={t('cap.ledger.field.line.label')} error={error('lineId')} hint={t('cap.ledger.field.id.hint')}>
          <input id="ledger-line" type="text" value={draft.lineId} onChange={(event) => set({ lineId: event.target.value })} />
        </Field>
        <Field id="ledger-day" label={t('cap.ledger.field.day.label')} error={error('day')} hint={t('cap.ledger.field.day.hint')}>
          <input id="ledger-day" type="date" value={draft.day} onChange={(event) => set({ day: event.target.value })} />
        </Field>
        <div className="formfooter">
          <button type="submit" className="primary">
            {t('cap.ledger.filter.apply.action')}
          </button>
        </div>
      </form>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        {head === undefined ? null : (
          <>
            <section aria-labelledby="balance-title" data-testid="balance">
              <h2 id="balance-title">{t('cap.ledger.balance.title', { count: head.entryCount })}</h2>
              <p className="sub" data-testid="as-of">
                {applied.day === '' ? t('cap.ledger.balance.now') : t('cap.ledger.balance.at', { day: applied.day })}
              </p>
              <dl>
                {COLUMNS.map((column) => (
                  <div key={column} data-column={column}>
                    <dt>{columnLabel(t, column)}</dt>
                    <dd>{money(head.balance[column])}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <div className="tablewrap">
              <table className="table" aria-label={t('cap.ledger.list.aria')} data-testid="entries">
                <thead>
                  <tr>
                    <th scope="col">{t('cap.ledger.col.posted')}</th>
                    <th scope="col">{t('cap.ledger.col.type')}</th>
                    <th scope="col">{t('cap.ledger.col.amount')}</th>
                    <th scope="col">{t('cap.ledger.col.project')}</th>
                    <th scope="col">{t('cap.ledger.col.source')}</th>
                    <th scope="col">{t('cap.ledger.col.reversalOf')}</th>
                    <th scope="col">{t('cap.ledger.col.reason')}</th>
                    <th scope="col">{t('cap.ledger.col.by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} data-entry={item.id} data-type={item.entryType}>
                      <td>{item.postedAt}</td>
                      <td>{typeLabel(t, item.entryType)}</td>
                      <td>{money(item.amountVnd)}</td>
                      <td>{item.project === null ? NONE : `${item.project.code} ${item.project.name}`}</td>
                      <td data-source={item.sourceRefKind}>
                        {sourceLabel(t, item.sourceRefKind)}
                        {item.sourceRefId === null ? null : <span className="prj-code" title={item.sourceRefId}>{item.sourceRefId.slice(0, 8)}</span>}
                      </td>
                      <td>{item.reversalOfId === null ? NONE : <span className="prj-code">{t('cap.ledger.reversal.of', { id: item.reversalOfId })}</span>}</td>
                      <td>{item.reason ?? NONE}</td>
                      <td>{item.postedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.hasNextPage ? (
              <p>
                <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {t('cap.ledger.more.action')}
                </button>
              </p>
            ) : null}
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('cap.ledger.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
