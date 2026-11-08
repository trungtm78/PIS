import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { Figure, InfoRule, LoadMore, WordSelect, dong, refusalText, useCommand, usePagedList, useRights, vietnamDay, vietnamDateTime, word } from '../docaud-support';
import '../docaud.css';
import { GIFT_STATUSES, GIVER_KINDS, OUTCOMES, REASON_MIN, UUID } from './audModel';
import type { Gift, GiftList, Outcome } from './audModel';

const PERMISSION = { declare: 'aud.gift.declare', review: 'aud.gift.review' } as const;

interface DeclareForm {
  recipientId: string;
  giverName: string;
  giverKind: string;
  description: string;
  valueVnd: string;
  receivedOn: string;
}

function DeclareDialog({ defaultRecipient, onClose }: { defaultRecipient: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<DeclareForm>({ recipientId: defaultRecipient, giverName: '', giverKind: 'CONTRACTOR', description: '', valueVnd: '', receivedOn: '' });
  const [error, setError] = useState<string | undefined>(undefined);
  const send = useCommand<DeclareForm>((client, input, attempt) =>
    client.command('declareGift' as never, { body: { recipient_id: input.recipientId, giver_name: input.giverName, giver_kind: input.giverKind, description: input.description, value_vnd: input.valueVnd, received_on: input.receivedOn }, attempt } as never),
  );
  const set = (change: Partial<DeclareForm>): void => {
    setError(undefined);
    setForm({ ...form, ...change });
  };
  return (
    <ConfirmDialog
      open
      title={t('gov12da.aud19.declare.title')}
      context={[]}
      confirmLabel={t('gov12da.aud19.declare.confirm')}
      cancelLabel={t('gov12da.common.action.cancel')}
      pending={send.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        const valid = UUID.test(form.recipientId) && form.giverName.trim() !== '' && form.description.trim().length >= 5 && /^\d{1,18}$/.test(form.valueVnd) && /^\d{4}-\d{2}-\d{2}$/.test(form.receivedOn);
        if (!valid) {
          setError(t('gov12da.error.validation.text'));
          return;
        }
        send.mutate({ ...form, giverName: form.giverName.trim(), description: form.description.trim() }, { onSuccess: onClose, onError: (failure) => setError(refusalText(t, failure)) });
      }}
    >
      <div className="g12-form">
        <label className="g12-field">
          {t('gov12da.aud19.declare.recipient')}
          <input type="text" value={form.recipientId} data-testid="declare-recipient" onChange={(event) => set({ recipientId: event.target.value.trim() })} />
        </label>
        <label className="g12-field">
          {t('gov12da.aud19.declare.giver')}
          <input type="text" value={form.giverName} data-testid="declare-giver" onChange={(event) => set({ giverName: event.target.value })} />
        </label>
        <WordSelect id="declare-kind" label={t('gov12da.aud19.declare.kind')} labelOf={(value) => t(`gov12da.aud.giver.${word(value)}`)} values={GIVER_KINDS} value={form.giverKind} onChange={(value) => set({ giverKind: value })} />
        <label className="g12-field">
          {t('gov12da.aud19.declare.description')}
          <input type="text" value={form.description} data-testid="declare-description" onChange={(event) => set({ description: event.target.value })} />
        </label>
        <label className="g12-field">
          {t('gov12da.aud19.declare.value')}
          <input type="text" inputMode="numeric" value={form.valueVnd} data-testid="declare-value" onChange={(event) => set({ valueVnd: event.target.value.trim() })} />
        </label>
        <label className="g12-field">
          {t('gov12da.aud19.declare.received')}
          <input type="date" value={form.receivedOn} data-testid="declare-received" onChange={(event) => set({ receivedOn: event.target.value })} />
        </label>
      </div>
    </ConfirmDialog>
  );
}

function CloseDialog({ gift, onClose }: { gift: Gift; onClose: () => void }) {
  const { t } = useTranslation();
  const [outcome, setOutcome] = useState<Outcome>(gift.flags.may_be_kept ? 'KEPT' : 'RETURNED');
  const [error, setError] = useState<string | undefined>(undefined);
  const send = useCommand<{ outcome: Outcome; note: string }>((client, input, attempt) =>
    client.command('closeGift' as never, { path: { id: gift.id }, ifMatchVersion: gift.version, body: { outcome: input.outcome, note: input.note }, attempt } as never),
  );
  return (
    <ConfirmDialog
      open
      title={t('gov12da.aud19.close.title', { giver: gift.giver_name })}
      context={[{ label: t('gov12da.aud19.col.value'), value: dong(gift.value_vnd) }]}
      confirmLabel={t('gov12da.aud19.close.confirm')}
      cancelLabel={t('gov12da.common.action.cancel')}
      pending={send.isPending}
      reason={{ label: t('gov12da.aud19.close.note'), required: true, minLength: REASON_MIN, hint: t('gov12da.common.reason.hint', { min: REASON_MIN }) }}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(note) => send.mutate({ outcome, note: (note ?? '').trim() }, { onSuccess: onClose, onError: (failure) => setError(refusalText(t, failure)) })}
    >
      <WordSelect id="close-outcome" label={t('gov12da.aud19.close.outcome')} labelOf={(value) => t(`gov12da.aud.outcome.${word(value)}`)} values={OUTCOMES} value={outcome} onChange={(value) => { setError(undefined); setOutcome(value as Outcome); }} />
    </ConfirmDialog>
  );
}

/**
 * AUD-19, the gifts register (G4-12). A member of staff declares a gift received because of the work; the flags (late, needs a review, may be kept) are those of the rule of the day of the declaration (not confirmed). A second
 * person takes the review and closes it with the reason; a gift over the keep line is returned or handed to the unit, never kept; the recipient never reviews their own gift.
 */
export default function GiftScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <GiftContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function GiftContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const { holds, frozen, membershipId } = useRights();
  const [statusFilter, setStatusFilter] = useState('');
  const [declaring, setDeclaring] = useState(false);
  const [closing, setClosing] = useState<Gift | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const pages = usePagedList<Gift>('listGifts', { status: statusFilter }, 100);
  const list = pages.first;
  const data = list.data === undefined ? undefined : ({ ...list.data, items: pages.items, has_more: pages.hasMore } as GiftList);
  const state = useScreenState({ isLoading: list.isLoading, error: data === undefined ? list.error : undefined, data, isEmpty: (value) => (value as GiftList).items.length === 0 });
  const refreshFailed = list.isError && data !== undefined;
  const take = useCommand<Gift>((client, gift, attempt) => client.command('takeGiftReview' as never, { path: { id: gift.id }, ifMatchVersion: gift.version, attempt } as never));
  const mayDeclare = holds(PERMISSION.declare) && !frozen;
  const mayReview = holds(PERMISSION.review) && !frozen;
  const asOf = data?.as_of ?? '';
  const rule = data?.rule;

  const columns: DataTableColumn<Gift>[] = [
    { key: 'giver', header: t('gov12da.aud19.col.giver'), pinned: true, render: (row) => <><strong>{row.giver_name}</strong><div className="g12-muted">{t(`gov12da.aud.giver.${word(row.giver_kind)}`)}</div><div className="g12-muted">{row.description}</div></> },
    { key: 'value', header: t('gov12da.aud19.col.value'), align: 'right', render: (row) => <span data-testid={`value-${row.id}`}>{dong(row.value_vnd)} <InfoRule topic="gift" name={t('gov12da.aud19.col.value')} asOf={asOf} rule={rule === undefined ? undefined : { version: row.rule_version, unverified: rule.unverified || row.rule_version === 0 }} /></span> },
    { key: 'dates', header: t('gov12da.aud19.col.dates'), render: (row) => t('gov12da.aud19.dates.text', { received: vietnamDay(row.received_on), declared: vietnamDay(row.declared_on) }) },
    {
      key: 'flags',
      header: t('gov12da.aud19.col.flags'),
      render: (row) => (
        <span data-testid={`flags-${row.id}`}>
          {row.flags.late ? <StatusPill tone="danger">{t('gov12da.aud19.flag.late')}</StatusPill> : null}{' '}
          {row.flags.needs_review ? <StatusPill tone="warning">{t('gov12da.aud19.flag.review')}</StatusPill> : null}{' '}
          {row.flags.may_be_kept ? null : <StatusPill tone="danger">{t('gov12da.aud19.flag.noKeep')}</StatusPill>}
        </span>
      ),
    },
    { key: 'status', header: t('gov12da.aud19.col.status'), render: (row) => <><StatusPill tone={row.status === 'CLOSED' ? 'success' : row.status === 'UNDER_REVIEW' ? 'info' : 'neutral'}>{t(`gov12da.aud.gift.${word(row.status)}`)}</StatusPill>{row.outcome === null ? null : <div data-testid={`outcome-${row.id}`}>{t(`gov12da.aud.outcome.${word(row.outcome)}`)}{row.outcome_note === null ? null : <span className="g12-muted"> {row.outcome_note}</span>}</div>}</> },
    {
      key: 'action',
      header: t('gov12da.aud19.col.action'),
      render: (row) => {
        if (row.status === 'DECLARED' && mayReview && row.recipient_id !== membershipId) return <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`take-${row.id}`} onClick={() => take.mutate(row, { onError: (failure) => setNotice(refusalText(t, failure)) })}>{t('gov12da.aud19.action.take')}</button>;
        if (row.status === 'UNDER_REVIEW' && mayReview && row.reviewer_id === membershipId) return <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`close-${row.id}`} onClick={() => setClosing(row)}>{t('gov12da.aud19.action.close')}</button>;
        return <span className="g12-muted">{t('gov12da.doc28.action.none')}</span>;
      },
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gov12da.aud19.page.title')}</h1>
          <p>{t('gov12da.aud19.page.subtitle')}</p>
        </div>
        {mayDeclare ? <button type="button" className="ui-button ui-button--primary" data-testid="declare-open" onClick={() => setDeclaring(true)}>{t('gov12da.aud19.declare.open')}</button> : null}
      </div>
      <ContextBar items={[{ label: t('gov12da.common.context.scope'), value: tenant?.name ?? '–' }]} {...(data === undefined ? {} : { asOf: vietnamDateTime(data.as_of) })} stale={refreshFailed} />
      {notice === undefined ? null : <p className="callout" role="alert" data-testid="notice">{notice}</p>}
      {data === undefined ? null : (
        <div className="g12-figures">
          <Figure label={t('gov12da.aud19.figure.declareWithin')} value={t('gov12da.aud19.figure.days', { days: data.rule.declare_within_days })} topic="gift" asOf={asOf} rule={rule} testId="figure-declare" />
          <Figure label={t('gov12da.aud19.figure.review')} value={dong(data.rule.review_over_vnd)} topic="gift" asOf={asOf} rule={rule} testId="figure-review" />
          <Figure label={t('gov12da.aud19.figure.keep')} value={dong(data.rule.keep_up_to_vnd)} topic="gift" asOf={asOf} rule={rule} testId="figure-keep" />
        </div>
      )}
      <div className="g12-filter">
        <WordSelect id="filter-status" label={t('gov12da.aud19.filter.status')} labelOf={(value) => t(`gov12da.aud.gift.${word(value)}`)} values={GIFT_STATUSES} value={statusFilter} onChange={setStatusFilter} any={t('gov12da.common.filter.any')} />
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        {data !== undefined && <DataTable caption={t('gov12da.aud19.table.caption')} columns={columns} rows={data.items} rowKey={(row) => row.id} />}
        <LoadMore shown={pages.items.length} hasMore={pages.hasMore} loading={pages.loading} failed={pages.failed} onLoad={() => void pages.loadMore()} />
      </StateBoundary>
      {declaring ? <DeclareDialog defaultRecipient={membershipId ?? ''} onClose={() => setDeclaring(false)} /> : null}
      {closing === undefined ? null : <CloseDialog gift={closing} onClose={() => setClosing(undefined)} />}
      <p className="prototype-note">{t('gov12da.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
