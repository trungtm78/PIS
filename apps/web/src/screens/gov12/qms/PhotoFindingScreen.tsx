import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { Figure, InfoRule, LoadMore, WordSelect, refusalText, useCommand, usePagedList, useRead, useRights, vietnamDateTime, word } from '../docaud-support';
import type { RuleView } from '../docaud-support';
import '../docaud.css';

const PERMISSION = { scan: 'photo.finding.scan', review: 'photo.finding.review' } as const;
const REASON_MIN = 10;
const STATUSES = ['OPEN', 'IN_REVIEW', 'EXPLAINED', 'REFERRED'] as const;
const KINDS = ['SAME_FILE_OTHER_PROJECT', 'SAME_PLACE_AND_MOMENT_OTHER_PROJECT', 'SAME_FILE_OTHER_DAY'] as const;
type Status = (typeof STATUSES)[number];
type Move = 'TAKE' | 'EXPLAIN' | 'REFER' | 'REOPEN';

/** The moves a status allows (the same edges as the kernel). */
const MOVES: Readonly<Record<Status, readonly Move[]>> = { OPEN: ['TAKE'], IN_REVIEW: ['EXPLAIN', 'REFER'], EXPLAINED: ['REOPEN'], REFERRED: [] };

interface Finding {
  id: string;
  kind: (typeof KINDS)[number];
  first_photo_id: string;
  second_photo_id: string;
  first_project_id: string;
  second_project_id: string;
  metres: number | null;
  minutes: number | null;
  status: Status;
  reviewer_id: string | null;
  reason: string | null;
  first_flagged_at: string;
  rule_version: number;
  is_conclusion: boolean;
  version: number;
}

interface FindingList {
  as_of: string;
  items: Finding[];
  has_more: boolean;
  rule: RuleView & { place_metres: number; moment_minutes: number };
}

interface FindingDetail extends Finding {
  as_of: string;
  history: Array<{ id: string; move: string; to_status: string; actor_id: string | null; reason: string | null; at: string }>;
}

function MoveDialog({ finding, onClose }: { finding: Finding; onClose: () => void }) {
  const { t } = useTranslation();
  const moves = MOVES[finding.status];
  const [move, setMove] = useState<Move>(moves[0] ?? 'TAKE');
  const [error, setError] = useState<string | undefined>(undefined);
  const send = useCommand<{ move: Move; reason: string | undefined }>((client, input, attempt) =>
    client.command('movePhotoFinding' as never, { path: { id: finding.id }, ifMatchVersion: finding.version, body: { move: input.move, ...(input.reason === undefined ? {} : { reason: input.reason }) }, attempt } as never),
  );
  return (
    <ConfirmDialog
      open
      title={t('gov12da.qms12.move.title')}
      context={[{ label: t('gov12da.qms12.col.kind'), value: t(`gov12da.qms.kind.${word(finding.kind)}`) }]}
      confirmLabel={t('gov12da.qms12.move.confirm')}
      cancelLabel={t('gov12da.common.action.cancel')}
      pending={send.isPending}
      {...(move === 'TAKE' ? {} : { reason: { label: t('gov12da.common.reason.label'), required: true, minLength: REASON_MIN, hint: t('gov12da.common.reason.hint', { min: REASON_MIN }) } })}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(reason) => send.mutate({ move, reason: reason === undefined || reason.trim() === '' ? undefined : reason.trim() }, { onSuccess: onClose, onError: (failure) => setError(refusalText(t, failure)) })}
    >
      <WordSelect id="move-choice" label={t('gov12da.qms12.move.choice')} labelOf={(value) => t(`gov12da.qms.move.${word(value)}`)} values={moves} value={move} onChange={(value) => { setError(undefined); setMove(value as Move); }} />
    </ConfirmDialog>
  );
}

/**
 * QMS-12, the photos that need a person to explain them across projects (G4-12): the same file, or the same place at the same moment, in two projects, and the same file on two days of one project. Every row is a signal and
 * never a statement that a photo is false; the person who took either photo does not explain the pair, and the distance and the time of the pairing are the rule (not confirmed).
 */
export default function PhotoFindingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <PhotoFindingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PhotoFindingContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const navigate = useNavigate();
  const { holds, frozen } = useRights();
  const [params] = useSearchParams();
  const id = params.get('finding') ?? undefined;
  const [statusFilter, setStatusFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [moving, setMoving] = useState<Finding | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const pages = usePagedList<Finding>('listPhotoFindings', { status: statusFilter, kind: kindFilter }, 100, id === undefined);
  const list = { ...pages.first, data: pages.first.data === undefined ? undefined : ({ ...pages.first.data, items: pages.items, has_more: pages.hasMore } as FindingList) };
  const one = useRead<FindingDetail>('getPhotoFinding', { path: { id: id ?? '' } }, id !== undefined);
  const query = id === undefined ? list : one;
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: (value) => id === undefined && (value as FindingList).items.length === 0 });
  const refreshFailed = query.isError && data !== undefined;
  const scan = useCommand<null>((client, _input, attempt) => client.command('scanPhotoFindings' as never, { body: {}, attempt } as never));
  const mayScan = holds(PERMISSION.scan) && !frozen;
  const mayReview = holds(PERMISSION.review) && !frozen;
  const asOf = data?.as_of ?? '';
  const rule = list.data?.rule;
  const ruleOf = (row: Finding): RuleView => ({ version: row.rule_version, unverified: row.rule_version === 0 || (rule?.unverified ?? true) });

  const measures = (row: Finding) => (
    <span data-testid={`measure-${row.id}`}>
      {row.metres === null ? '–' : t('gov12da.qms12.measure.metres', { metres: row.metres })}{' / '}
      {row.minutes === null ? '–' : t('gov12da.qms12.measure.minutes', { minutes: row.minutes })}{' '}
      <InfoRule topic="photo" name={t('gov12da.qms12.col.measure')} asOf={asOf} rule={ruleOf(row)} />
    </span>
  );
  const columns: DataTableColumn<Finding>[] = [
    { key: 'kind', header: t('gov12da.qms12.col.kind'), pinned: true, render: (row) => <><button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`open-${row.id}`} onClick={() => void navigate(`/qms/qms-12?finding=${row.id}`)}>{t(`gov12da.qms.kind.${word(row.kind)}`)}</button><div className="g12-muted">{t('gov12da.qms12.signal.text')}</div></> },
    { key: 'photos', header: t('gov12da.qms12.col.photos'), render: (row) => <><code className="g12-hash">{row.first_photo_id}</code><br /><code className="g12-hash">{row.second_photo_id}</code></> },
    { key: 'projects', header: t('gov12da.qms12.col.projects'), render: (row) => (row.first_project_id === row.second_project_id ? t('gov12da.qms12.projects.same') : t('gov12da.qms12.projects.two')) },
    { key: 'measure', header: t('gov12da.qms12.col.measure'), render: measures },
    { key: 'status', header: t('gov12da.qms12.col.status'), render: (row) => <StatusPill tone={row.status === 'EXPLAINED' ? 'success' : row.status === 'REFERRED' ? 'danger' : row.status === 'IN_REVIEW' ? 'info' : 'warning'}>{t(`gov12da.qms.status.${word(row.status)}`)}</StatusPill> },
    { key: 'flagged', header: t('gov12da.qms12.col.flagged'), render: (row) => vietnamDateTime(row.first_flagged_at) },
    { key: 'action', header: t('gov12da.qms12.col.action'), render: (row) => (mayReview && MOVES[row.status].length > 0 ? <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`move-${row.id}`} onClick={() => setMoving(row)}>{t('gov12da.qms12.action.review')}</button> : <span className="g12-muted">{t('gov12da.doc28.action.none')}</span>) },
  ];
  const detail = id === undefined ? undefined : one.data;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gov12da.qms12.page.title')}</h1>
          <p>{t('gov12da.qms12.page.subtitle')}</p>
        </div>
        <span className="g12-actions">
          {id === undefined ? null : <button type="button" className="ui-button ui-button--outline" data-testid="back" onClick={() => void navigate('/qms/qms-12')}>{t('gov12da.qms12.back')}</button>}
          {mayScan && id === undefined ? <button type="button" className="ui-button ui-button--primary" data-testid="scan" disabled={scan.isPending} onClick={() => scan.mutate(null, { onSuccess: () => setNotice(t('gov12da.qms12.scan.done')), onError: (failure) => setNotice(refusalText(t, failure)) })}>{t('gov12da.qms12.scan.open')}</button> : null}
        </span>
      </div>
      <ContextBar items={[{ label: t('gov12da.common.context.scope'), value: tenant?.name ?? '–' }]} {...(asOf === '' ? {} : { asOf: vietnamDateTime(asOf) })} stale={refreshFailed} />
      <p className="callout" role="note" data-testid="signal-note">{t('gov12da.qms12.note.signal')}</p>
      {notice === undefined ? null : <p className="callout" role="status" data-testid="notice">{notice}</p>}
      {id === undefined && rule !== undefined ? (
        <div className="g12-figures">
          <Figure label={t('gov12da.qms12.figure.place')} value={t('gov12da.qms12.measure.metres', { metres: rule.place_metres })} topic="photo" asOf={asOf} rule={rule} testId="figure-place" />
          <Figure label={t('gov12da.qms12.figure.moment')} value={t('gov12da.qms12.measure.minutes', { minutes: rule.moment_minutes })} topic="photo" asOf={asOf} rule={rule} testId="figure-moment" />
        </div>
      ) : null}
      {id === undefined ? (
        <div className="g12-filter">
          <WordSelect id="filter-status" label={t('gov12da.qms12.filter.status')} labelOf={(value) => t(`gov12da.qms.status.${word(value)}`)} values={STATUSES} value={statusFilter} onChange={setStatusFilter} any={t('gov12da.common.filter.any')} />
          <WordSelect id="filter-kind" label={t('gov12da.qms12.filter.kind')} labelOf={(value) => t(`gov12da.qms.kind.${word(value)}`)} values={KINDS} value={kindFilter} onChange={setKindFilter} any={t('gov12da.common.filter.any')} />
        </div>
      ) : null}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {id === undefined && list.data !== undefined ? <DataTable caption={t('gov12da.qms12.table.caption')} columns={columns} rows={list.data.items} rowKey={(row) => row.id} /> : null}
        {id === undefined ? <LoadMore shown={pages.items.length} hasMore={pages.hasMore} loading={pages.loading} failed={pages.failed} onLoad={() => void pages.loadMore()} /> : null}
        {detail === undefined ? null : (
          <>
            <DataTable caption={t('gov12da.qms12.detail.caption')} columns={columns} rows={[detail]} rowKey={(row) => row.id} />
            {detail.reason === null ? null : <p className="callout" data-testid="detail-reason">{detail.reason}</p>}
            <h2>{t('gov12da.qms12.history.title')}</h2>
            <ul data-testid="history">
              {detail.history.map((entry) => (
                <li key={entry.id}>
                  {vietnamDateTime(entry.at)} {t(`gov12da.qms.move.${word(entry.move)}`)} → {t(`gov12da.qms.status.${word(entry.to_status)}`)}
                  {entry.reason === null ? null : <span className="g12-muted"> {entry.reason}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </StateBoundary>
      {moving === undefined ? null : <MoveDialog finding={moving} onClose={() => setMoving(undefined)} />}
      <p className="prototype-note">{t('gov12da.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
