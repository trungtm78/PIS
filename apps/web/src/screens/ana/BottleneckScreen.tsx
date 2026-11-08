import { useState } from 'react';
import { Link } from 'react-router-dom';
import { translator, useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, SectionCard } from '../../ui';
import { useBottlenecks } from './bottleneck-hooks';
import { HALTED_PATH, sourceLink } from './bottleneck-model';
import type { Analysis, Holder, Item, Source } from './bottleneck-model';
import { codeKey, dayText, vndText } from './common';
import { AnaFigureInfo, NaNote, UnverifiedNote } from './components';

type T = Translator['t'];

export const causeLabel = (t: T, code: string): string => (translator.has(`ana.bn.cause.${codeKey(code)}`) ? t(`ana.bn.cause.${codeKey(code)}`) : code);
export const causeAction = (t: T, code: string): string => (translator.has(`ana.bn.action.${codeKey(code)}`) ? t(`ana.bn.action.${codeKey(code)}`) : t('ana.bn.action.default'));

function sourceLabel(t: T, source: Source): string {
  switch (source) {
    case 'PAYMENT':
      return t('ana.bn.source.payment');
    case 'LAND':
      return t('ana.bn.source.land');
    case 'ISSUE':
      return t('ana.bn.source.issue');
    case 'HALT':
      return t('ana.bn.source.halt');
  }
}

export function bucketLabel(t: T, bucket: string): string {
  const match = /^(LE|GT)_(\d+)$/.exec(bucket);
  if (match === null) return bucket;
  return match[1] === 'LE' ? t('ana.bn.bucket.le', { days: match[2] as string }) : t('ana.bn.bucket.gt', { days: match[2] as string });
}

export function holderLabel(t: T, holder: Holder): string {
  if (holder.kind === 'EXTERNAL') return holder.code === 'TREASURY' ? t('ana.bn.holder.treasury') : (holder.code ?? t('ana.bn.holder.external'));
  if (holder.name !== null && holder.name !== '') return holder.name;
  return holder.kind === 'PERSON' ? t('ana.bn.holder.person') : t('ana.bn.holder.unit');
}

/** Why an amount is missing, in words (never 0). */
export function amountReason(t: T, reason: string): string {
  return reason === 'NO_AMOUNT' ? t('ana.bn.na.noAmount') : t('ana.bn.na.other');
}

function Tile({ id, label, value, note, info }: { id: string; label: string; value: string; note?: string | undefined; info?: React.ReactNode }) {
  return (
    <li className="ana-tile">
      <span className="ana-tile__label">
        {label}
        {info}
      </span>
      <strong className="ana-tile__value" data-testid={`bn-tile-${id}`}>
        {value}
      </strong>
      {note === undefined ? null : <span className="ana-tile__note">{note}</span>}
    </li>
  );
}

function ItemsTable({ items }: { items: readonly Item[] }) {
  const { t } = useTranslation();
  return (
    <div className="tablewrap">
      <table className="ana-table" aria-label={t('ana.bn.items.aria')} data-testid="bn-items">
        <caption className="sr-only">{t('ana.bn.items.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('ana.bn.col.project')}</th>
            <th scope="col">{t('ana.bn.col.source')}</th>
            <th scope="col">{t('ana.bn.col.cause')}</th>
            <th scope="col" className="num">
              {t('ana.bn.col.amount')}
            </th>
            <th scope="col" className="num">
              {t('ana.bn.col.age')}
            </th>
            <th scope="col">{t('ana.bn.col.holder')}</th>
            <th scope="col">
              <span className="sr-only">{t('ana.bn.col.open')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.key} data-testid="bn-item" data-key={item.key}>
              <th scope="row">{item.project.code ?? '—'}</th>
              <td>{sourceLabel(t, item.source)}</td>
              <td>
                {causeLabel(t, item.causeCode)}
                {item.causeKnown ? null : <span className="ana-caveat"> {t('ana.bn.cause.unknown')}</span>}
              </td>
              <td className="num" data-testid="bn-amount">
                {item.amountVnd === null ? (
                  <>
                    {t('ana.common.na')} <span className="ana-caveat">{amountReason(t, item.amountNullReason ?? '')}</span>
                  </>
                ) : (
                  vndText(item.amountVnd)
                )}
              </td>
              <td className="num">
                {t('ana.bn.age.days', { days: item.ageDays })} <span className="ana-caveat">{t('ana.bn.age.since', { day: dayText(item.since) })}</span>
              </td>
              <td>{holderLabel(t, item.holder)}</td>
              <td>
                <Link to={sourceLink(item)} aria-label={t('ana.bn.open.aria', { project: item.project.code ?? '' })}>
                  {t('ana.bn.open')}
                </Link>
                {item.mergedKeys.length === 0 ? null : <span className="ana-caveat"> {t('ana.bn.merged', { count: item.mergedKeys.length })}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * BI-27: the bottlenecks (G3-9). What holds money and work up: the amount held (where a source has none, N/A with the reason: the sum is then a lower bound and says so), a standard cause with its owner and the expected
 * action, the age of the debt in buckets, and who holds it. One amount described by two sources is counted once. Every line opens its record.
 */
export default function BottleneckScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <BottleneckContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BottleneckContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState({ cause: '', bucket: '' });
  const query = useBottlenecks(filter);
  const analysis: Analysis | undefined = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: analysis === undefined ? query.error : undefined, data: analysis, isEmpty: (data) => (data as Analysis).itemsTotal === 0 && filter.cause === '' && filter.bucket === '' });
  const contextItems = [
    { label: t('ana.bn.context.asOf'), value: dayText(analysis?.asOf ?? null) },
    { label: t('ana.bn.context.items'), value: analysis === undefined ? '—' : String(analysis.itemsTotal) },
  ];
  const cut = analysis?.sources.filter((source) => source.cut) ?? [];
  const skipped = analysis?.sources.filter((source) => source.skipped > 0) ?? [];
  const total = analysis?.byBucket.reduce((sum, row) => sum + row.count, 0) ?? 0;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ana.bn.page.title')}</h1>
          <p>{t('ana.bn.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={contextItems} unit={t('ana.bn.context.unit')} />
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {analysis === undefined ? null : (
          <div className="ana-stack">
            <UnverifiedNote unverified={analysis.model.unverified} />
            {cut.length === 0 ? null : (
              <p role="status" data-testid="bn-cut">
                {t('ana.bn.cut', { sources: cut.map((source) => sourceLabel(t, source.source)).join(', ') })}
              </p>
            )}
            {skipped.length === 0 ? null : (
              <p role="status" data-testid="bn-skipped">
                {skipped.map((source) => t('ana.bn.skipped', { source: sourceLabel(t, source.source), count: source.skipped })).join(' ')}
              </p>
            )}
            <ul className="ana-tiles" data-testid="bn-tiles">
              <Tile id="held" label={t('ana.bn.tile.held')} value={`${vndText(analysis.heldVnd)} ${t('ana.bn.unit.vnd')}`} note={analysis.noAmount > 0 ? t('ana.bn.tile.lowerBound', { count: analysis.noAmount }) : undefined} info={<AnaFigureInfo name={t('ana.bn.tile.held')} info={analysis.info} />} />
              <Tile id="items" label={t('ana.bn.tile.items')} value={String(analysis.itemsTotal)} />
              <Tile id="noAmount" label={t('ana.bn.tile.noAmount')} value={String(analysis.noAmount)} note={t('ana.bn.na.noAmount')} />
              <Tile id="merged" label={t('ana.bn.tile.merged')} value={String(analysis.merged)} note={t('ana.bn.tile.mergedNote')} />
            </ul>
            <div className="ana-controls" role="group" aria-label={t('ana.bn.filter.aria')}>
              <label>
                {t('ana.bn.filter.cause')}
                <select value={filter.cause} onChange={(event) => setFilter({ ...filter, cause: event.target.value })} data-testid="bn-filter-cause">
                  <option value="">{t('ana.bn.filter.all')}</option>
                  {analysis.model.causes.map((cause) => (
                    <option key={cause.code} value={cause.code}>
                      {causeLabel(t, cause.code)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('ana.bn.filter.bucket')}
                <select value={filter.bucket} onChange={(event) => setFilter({ ...filter, bucket: event.target.value })} data-testid="bn-filter-bucket">
                  <option value="">{t('ana.bn.filter.all')}</option>
                  {analysis.model.buckets.map((bucket) => (
                    <option key={bucket} value={bucket}>
                      {bucketLabel(t, bucket)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <SectionCard title={t('ana.bn.cause.title')} unit={t('ana.bn.unit.vnd')}>
              <div className="tablewrap">
                <table className="ana-table" aria-label={t('ana.bn.cause.aria')} data-testid="bn-causes">
                  <caption className="sr-only">{t('ana.bn.cause.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('ana.bn.col.cause')}</th>
                      <th scope="col">{t('ana.bn.col.owner')}</th>
                      <th scope="col">{t('ana.bn.col.action')}</th>
                      <th scope="col" className="num">
                        {t('ana.bn.col.count')}
                      </th>
                      <th scope="col" className="num">
                        {t('ana.bn.col.amount')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.byCause.map((row) => (
                      <tr key={row.key} data-testid="bn-cause">
                        <th scope="row">{causeLabel(t, row.key)}</th>
                        <td>{analysis.model.causes.find((cause) => cause.code === row.key)?.ownerModule ?? '—'}</td>
                        <td>{causeAction(t, row.key)}</td>
                        <td className="num">{row.count}</td>
                        <td className="num">
                          {vndText(row.amountVnd)}
                          {row.noAmount > 0 ? <span className="ana-caveat"> {t('ana.bn.noAmountOf', { count: row.noAmount })}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
            <SectionCard title={t('ana.bn.bucket.title')}>
              <ul className="ana-bars" data-testid="bn-buckets">
                {analysis.byBucket.map((row) => (
                  <li key={row.key} data-bucket={row.key}>
                    <span>{bucketLabel(t, row.key)}</span>{' '}
                    <meter min={0} max={Math.max(total, 1)} value={row.count} aria-label={bucketLabel(t, row.key)} />{' '}
                    <strong>{row.count}</strong> <span className="ana-caveat">{vndText(row.amountVnd)}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
            <SectionCard title={t('ana.bn.holder.title')} unit={t('ana.bn.unit.vnd')}>
              <ul data-testid="bn-holders">
                {analysis.byHolder.slice(0, 10).map((row) => (
                  <li key={row.key}>
                    {holderLabel(t, row.holder)}: {row.count} ({vndText(row.amountVnd)})
                  </li>
                ))}
              </ul>
            </SectionCard>
            <SectionCard title={t('ana.bn.items.title')} unit={t('ana.bn.unit.vnd')}>
              {analysis.items.length === 0 ? <NaNote reason="NO_MATCH" label={() => t('ana.bn.items.none')} /> : <ItemsTable items={analysis.items} />}
            </SectionCard>
            <p className="ana-links">
              <Link to={HALTED_PATH}>{t('ana.bn.link.halted')}</Link>
            </p>
          </div>
        )}
      </StateBoundary>
    </section>
  );
}
