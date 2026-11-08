import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, ReadonlyStat, StatusPill } from '../../../ui';
import { useComparison, useDocument } from './hooks';
import { opLabel, versionStatusLabel } from './labels';
import { READ_PERMISSION, documentLink, foldEntries, sideWords, stamp, versionTone } from './model';
import type { CompareEntry } from './model';
import './repository.css';

/**
 * DOC-27: the comparison of two versions of a document (DOC-2, PD.02). A text document is compared unit by unit (a changed unit shows the words that left and the words that came in), a workbook cell by cell; units that did
 * not change are folded into one row that says how many it hides. The comparison is of the extracted text, not of the bytes, and says how it counted (the formula) and when it was made.
 */
export default function CompareScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [search] = useSearchParams();
  // The choice of versions belongs to one membership and to the document that is open: a switch of either starts the screen over.
  return <CompareContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${search.get('id') ?? ''}`} route={route} />;
}

const tone = (op: CompareEntry['op']): 'success' | 'danger' | 'warning' | 'neutral' => (op === 'ADDED' ? 'success' : op === 'REMOVED' ? 'danger' : op === 'CHANGED' ? 'warning' : 'neutral');

function Side({ entry, side }: { entry: CompareEntry; side: 'before' | 'after' }) {
  const unit = side === 'before' ? entry.before : entry.after;
  if (unit === null) return <div className="doc2-side doc2-side-empty" data-side={side} />;
  return (
    <div className="doc2-side" data-side={side}>
      <div className="muted">{unit.label}</div>
      <p>
        {sideWords(entry, side).map((word, index) => (
          <span key={index} className={word.mark ? (side === 'before' ? 'doc2-mark doc2-mark-out' : 'doc2-mark doc2-mark-in') : undefined} data-mark={word.mark ? side : undefined}>
            {index > 0 ? ' ' : ''}
            {word.text}
          </span>
        ))}
      </p>
    </div>
  );
}

function CompareContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const [search, setSearch] = useSearchParams();
  const id = search.get('id') ?? undefined;
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const detail = useDocument(mayRead ? id : undefined);
  const versions = detail.data?.versions ?? [];
  const from = search.get('from') ?? undefined;
  const to = search.get('to') ?? undefined;
  const comparison = useComparison(mayRead ? id : undefined, from, to);
  const [expanded, setExpanded] = useState(false);
  const detailState = useScreenState({ isLoading: detail.isLoading, error: detail.error, data: id === undefined ? undefined : detail.data, isEmpty: () => false });
  const chosen = from !== undefined && to !== undefined && from !== to;
  const compareState = useScreenState({ isLoading: comparison.isLoading && chosen, error: chosen ? comparison.error : undefined, data: chosen ? comparison.data : [], isEmpty: () => false });
  const refreshFailed = comparison.isError && comparison.data !== undefined;
  const data = comparison.data;
  const folded = data === undefined ? [] : foldEntries(data.entries, expanded);
  const pick = (key: 'from' | 'to', value: string): void => {
    const next = new URLSearchParams(search);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setSearch(next);
  };
  const swap = (): void => {
    const next = new URLSearchParams(search);
    if (to !== undefined) next.set('from', to);
    if (from !== undefined) next.set('to', from);
    setSearch(next);
  };
  const title = detail.data?.document.title;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.repo.compare.title')}</h1>
          <p>{title ?? t('doc.repo.compare.subtitle')}</p>
        </div>
        {id !== undefined && (
          <div className="actions">
            <Link className="ui-button ui-button--outline" to={documentLink(id)} data-testid="back">
              {t('doc.repo.compare.back')}
            </Link>
          </div>
        )}
      </div>
      <ContextBar
        items={[
          { label: t('doc.repo.context.scope'), value: tenant?.name ?? '–' },
          { label: t('doc.repo.context.project'), value: detail.data === undefined ? '–' : detail.data.document.project.code },
        ]}
        {...(data === undefined ? {} : { asOf: stamp(data.as_of) })}
        stale={refreshFailed}
      />
      {!mayRead ? (
        <p className="callout warning" role="status" data-testid="no-read">
          {t('doc.repo.denied')}
        </p>
      ) : id === undefined ? (
        <p className="callout" role="status" data-testid="no-id">
          {t('doc.repo.compare.noId')}
        </p>
      ) : (
        <StateBoundary state={detailState} onRetry={() => void detail.refetch()}>
          <div className="doc2-filters" role="group" aria-label={t('doc.repo.compare.pickAria')}>
            <div className="field">
              <label htmlFor="c-from">{t('doc.repo.compare.from')}</label>
              <select id="c-from" value={from ?? ''} onChange={(event) => pick('from', event.target.value)}>
                <option value="">{t('doc.repo.field.choose')}</option>
                {versions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t('doc.repo.compare.option', { no: item.version_no, status: versionStatusLabel(t, item.status) })}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="c-to">{t('doc.repo.compare.to')}</label>
              <select id="c-to" value={to ?? ''} onChange={(event) => pick('to', event.target.value)}>
                <option value="">{t('doc.repo.field.choose')}</option>
                {versions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t('doc.repo.compare.option', { no: item.version_no, status: versionStatusLabel(t, item.status) })}
                  </option>
                ))}
              </select>
            </div>
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="swap" disabled={!chosen} onClick={swap}>
              {t('doc.repo.compare.swap')}
            </button>
          </div>
          {from !== undefined && to !== undefined && from === to && (
            <p className="callout warning" role="status" data-testid="same">
              {t('doc.repo.compare.same')}
            </p>
          )}
          {!chosen ? (
            <p className="callout" role="status" data-testid="choose">
              {t('doc.repo.compare.choose')}
            </p>
          ) : (
            <StateBoundary state={compareState} onRetry={() => void comparison.refetch()}>
              {refreshFailed && (
                <p className="callout warning" role="status" data-testid="stale-note">
                  {t('doc.repo.stale', { time: data === undefined ? '' : stamp(data.as_of) })}
                </p>
              )}
              {data !== undefined && (
                <>
                  <p>
                    <StatusPill tone={versionTone(data.from.status)}>{t('doc.repo.compare.side', { no: data.from.version_no, status: versionStatusLabel(t, data.from.status) })}</StatusPill> →{' '}
                    <StatusPill tone={versionTone(data.to.status)}>{t('doc.repo.compare.side', { no: data.to.version_no, status: versionStatusLabel(t, data.to.status) })}</StatusPill>{' '}
                    <span className="muted" data-testid="mode">
                      {data.mode === 'CELLS' ? t('doc.repo.compare.modeCells') : t('doc.repo.compare.modeSequence')}
                    </span>
                  </p>
                  <ul className="doc2-stats" data-testid="summary">
                    <li>
                      <ReadonlyStat label={opLabel(t, 'ADDED')} value={String(data.summary.added)} tone="success" />
                    </li>
                    <li>
                      <ReadonlyStat label={opLabel(t, 'REMOVED')} value={String(data.summary.removed)} tone="danger" />
                    </li>
                    <li>
                      <ReadonlyStat label={opLabel(t, 'CHANGED')} value={String(data.summary.changed)} tone="warning" />
                    </li>
                    <li>
                      <ReadonlyStat label={opLabel(t, 'EQUAL')} value={String(data.summary.equal)} />
                    </li>
                  </ul>
                  <p className="muted" data-testid="formula">
                    {t('doc.repo.compare.formula', { formula: data.formula })} {t('doc.repo.compare.asOf', { time: stamp(data.as_of) })}
                  </p>
                  {data.summary.added + data.summary.removed + data.summary.changed === 0 ? (
                    <p className="callout" role="status" data-testid="identical">
                      {t('doc.repo.compare.identical')}
                    </p>
                  ) : null}
                  <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="toggle-equal" aria-pressed={expanded} onClick={() => setExpanded((current) => !current)}>
                    {expanded ? t('doc.repo.compare.fold') : t('doc.repo.compare.expand', { count: data.summary.equal })}
                  </button>
                  <ol className="doc2-entries" data-testid="entries">
                    {folded.map((row) =>
                      row.kind === 'equal' ? (
                        <li key={`equal-${row.from}`} className="doc2-entry doc2-entry-equal" data-op="EQUAL-FOLDED">
                          <span className="muted">{t('doc.repo.compare.hidden', { count: row.entries.length })}</span>
                        </li>
                      ) : (
                        <li key={row.index} className="doc2-entry" data-op={row.entry.op}>
                          <StatusPill tone={tone(row.entry.op)}>{opLabel(t, row.entry.op)}</StatusPill>
                          <div className="doc2-sides">
                            <Side entry={row.entry} side="before" />
                            <Side entry={row.entry} side="after" />
                          </div>
                        </li>
                      ),
                    )}
                  </ol>
                </>
              )}
            </StateBoundary>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('doc.repo.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
