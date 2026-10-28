import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useContracts } from '../../ctr/hooks';
import { usePhotoChecks, usePhotos } from './hooks';
import { duplicateLabel, exifLabel, flagMessage, geofenceLabel, problemMessage, sourceLabel, summaryLabel, timeLabel } from './labels';
import { NO_FILTER, SUMMARIES, describeProblem } from './model';
import type { PhotoFilter, PhotoLine } from './model';
import '../qms.css';

/**
 * QMS-08: the register of the photos of the site (ST-QMS-003, QMS 3.4, BR-QMS-06). Each photo shows when it was taken and received, where it was (only if the person consented to keeping the place) and the four review
 * flags: time, place, repetition and EXIF. The flags are aids for a person to look at; the screen never calls a photo true or false. Photos are registered by the phone (QMS-10), which uploads the file; the screen only reads.
 */
export default function PhotoGalleryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the chosen photo belong to one membership: a switch of tenant or of membership starts the screen over.
  return <GalleryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function GalleryContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const contracts = useContracts();
  const options = useMemo(() => contracts.data ?? [], [contracts.data]);
  const [filter, setFilter] = useState<PhotoFilter>(NO_FILTER);
  const list = usePhotos(filter);
  const lines = useMemo(() => (list.data?.pages ?? []).flatMap((page) => page.lines), [list.data]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const chosen = search.get('photo') ?? undefined;
  const moment = (iso: string | null): string => (iso === null ? t('qms.photo.none') : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso)));
  const change = (next: Partial<PhotoFilter>): void => setFilter({ ...filter, ...next });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('qms.photo.title')}</h1>
          <p>{t('qms.photo.subtitle')}</p>
        </div>
      </div>
      <p className="callout" role="note" data-testid="review-note">
        {t('qms.photo.note')}
      </p>
      <div className="card">
        <div className="field">
          <label htmlFor="photo-filter-contract">{t('qms.photo.filter.contract')}</label>
          <select id="photo-filter-contract" value={filter.contractId} onChange={(event) => change({ contractId: event.target.value })}>
            <option value="">{t('qms.photo.filter.allContracts')}</option>
            {options.map((contract) => (
              <option key={contract.id} value={contract.id}>
                {contract.title === null ? contract.code : `${contract.code} · ${contract.title}`}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="photo-filter-summary">{t('qms.photo.filter.summary')}</label>
          <select id="photo-filter-summary" value={filter.summary} onChange={(event) => change({ summary: event.target.value })}>
            <option value="">{t('qms.photo.filter.allSummaries')}</option>
            {SUMMARIES.filter((summary) => summary !== 'FAIL').map((summary) => (
              <option key={summary} value={summary}>
                {summaryLabel(t, summary)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="card">
          {lines.length === 0 ? (
            <p className="callout" role="status" data-testid="no-photos">
              {t('qms.photo.none.notice')}
            </p>
          ) : (
            <table className="table" data-testid="photos">
              <thead>
                <tr>
                  <th scope="col">{t('qms.photo.column.photo')}</th>
                  <th scope="col">{t('qms.photo.column.time')}</th>
                  <th scope="col">{t('qms.photo.column.place')}</th>
                  <th scope="col">{t('qms.photo.column.checks')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('qms.photo.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <PhotoRow key={line.id} line={line} moment={moment} chosen={chosen === line.id} onChoose={() => setSearch({ photo: line.id })} />
                ))}
              </tbody>
            </table>
          )}
          {list.hasNextPage ? (
            <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('qms.photo.more.action')}
            </button>
          ) : null}
        </div>
      </StateBoundary>
      {chosen === undefined ? null : <Details id={chosen} moment={moment} onClose={() => setSearch({})} />}
      <p className="prototype-note">{t('qms.photo.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function PhotoRow({ line, moment, chosen, onChoose }: { line: PhotoLine; moment: (iso: string | null) => string; chosen: boolean; onChoose(): void }) {
  const { t } = useTranslation();
  return (
    <tr data-photo={line.id} data-summary={line.checks.summary} data-chosen={chosen ? 'yes' : 'no'}>
      <td data-testid="photo">
        <strong>{line.caption ?? line.id.slice(0, 8)}</strong>
        <small className="sub qms-regime">
          {line.projectCode}
          {line.contract === null ? '' : ` · ${line.contract.code}`}
          {line.deviceModel === null ? '' : ` · ${line.deviceModel}`}
        </small>
      </td>
      <td data-testid="time">
        <span>{moment(line.takenAtExif)}</span>
        <small className="sub qms-regime">{t('qms.photo.received', { when: moment(line.receivedAt) })}</small>
      </td>
      <td data-testid="place">
        {line.place === null ? (
          <span className="sub">{line.geoConsent ? t('qms.photo.place.none') : t('qms.photo.place.noConsent')}</span>
        ) : (
          <span>
            {line.place.lat.toFixed(6)}, {line.place.lng.toFixed(6)}
            <small className="sub qms-regime">
              {sourceLabel(t, line.place.source)}
              {line.place.accuracyM === null ? '' : ` · ${t('qms.photo.accuracy', { value: line.place.accuracyM })}`}
            </small>
          </span>
        )}
      </td>
      <td data-testid="checks">
        <ul className="qms-signers">
          <li data-check="time">{timeLabel(t, line.checks.time)}</li>
          <li data-check="geofence">{geofenceLabel(t, line.checks.geofence)}</li>
          <li data-check="duplicate">{duplicateLabel(t, line.checks.duplicate)}</li>
          <li data-check="exif">{exifLabel(t, line.checks.exif)}</li>
        </ul>
        <span className={line.checks.summary === 'PASS' ? 'qms-badge ok' : 'qms-badge warning'} data-testid="summary">
          {summaryLabel(t, line.checks.summary)}
        </span>
      </td>
      <td>
        <button type="button" data-open={line.id} onClick={onChoose}>
          {t('qms.photo.open.action')}
        </button>
      </td>
    </tr>
  );
}

/** The checks of one photo, read on their own, with what each flag asks a reviewer to look at. */
function Details({ id, moment, onClose }: { id: string; moment: (iso: string | null) => string; onClose(): void }) {
  const { t } = useTranslation();
  const checks = usePhotoChecks(id);
  const state = useScreenState({ isLoading: checks.isLoading, error: checks.error, data: checks.data, isEmpty: (data) => data === null });
  const view = checks.data ?? undefined;
  return (
    <div className="card" data-testid="photo-details">
      <div className="actions">
        <h2>{t('qms.photo.details.title')}</h2>
        <button type="button" onClick={onClose}>
          {t('qms.photo.details.close')}
        </button>
      </div>
      <StateBoundary state={state} onRetry={() => void checks.refetch()}>
        {view === undefined ? (
          <p className="callout warning" role="alert" data-testid="details-missing">
            {problemMessage(t, describeProblem(checks.error))}
          </p>
        ) : (
          <>
            <dl className="qms-facts">
              <dt>{t('qms.photo.column.time')}</dt>
              <dd data-testid="details-taken">{moment(view.takenAtExif)}</dd>
              <dt>{t('qms.photo.details.received')}</dt>
              <dd>{moment(view.receivedAt)}</dd>
              <dt>{t('qms.photo.column.place')}</dt>
              <dd data-testid="details-place">{view.place === null ? (view.geoConsent ? t('qms.photo.place.none') : t('qms.photo.place.noConsent')) : `${view.place.lat.toFixed(6)}, ${view.place.lng.toFixed(6)}`}</dd>
            </dl>
            {view.flags.length === 0 ? (
              <p className="qms-badge ok" role="status" data-testid="no-flags">
                {t('qms.photo.flags.none')}
              </p>
            ) : (
              <ul className="qms-actions" data-testid="flags">
                {view.flags.map((flag) => (
                  <li key={flag} data-flag={flag}>
                    {flagMessage(t, flag)}
                  </li>
                ))}
              </ul>
            )}
            <p className="sub" data-testid="details-note">
              {t('qms.photo.note')}
            </p>
          </>
        )}
      </StateBoundary>
    </div>
  );
}
