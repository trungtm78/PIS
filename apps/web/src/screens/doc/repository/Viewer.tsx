import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import { StatusPill } from '../../../ui';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useUnits } from './hooks';
import type { UnitFilter } from './hooks';
import { extractionLabel, placeLabel, unitKindLabel } from './labels';
import { extractionTone } from './model';
import type { TextUnit, VersionDetail } from './model';

interface ViewerProps {
  detail: VersionDetail;
  anchor: string | null;
  onAnchor: (unit: TextUnit | null) => void;
  /** The version has no text yet and the caller may read it again (an OCR reader was bound since). */
  onReextract: (() => void) | undefined;
  rereading: boolean;
}

/**
 * The text of a version in citable units (DOC-25, PD.01): the page, paragraph, table cell or sheet cell each unit sits in, its text, and the reference another feature cites it by (`docver:<version>#<citation>`), which the
 * person can copy. The page, the sheet and a word narrow the list; the number of open comments of a unit is on it and opens its thread. A file with no text is said as such, never shown as an empty document.
 */
export function Viewer({ detail, anchor, onAnchor, onReextract, rereading }: ViewerProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<UnitFilter>({});
  const [text, setText] = useState('');
  const [copied, setCopied] = useState<string | undefined>(undefined);
  const version = detail.version;
  const readable = version.extraction_status === 'EXTRACTED';
  const units = useUnits(readable ? version.id : undefined, filter);
  const items = (units.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: units.isLoading && readable, error: units.error, data: readable ? units.data : [], isEmpty: () => false });
  const refreshFailed = units.isError && units.data !== undefined;
  const copy = (unit: TextUnit): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) return setCopied(unit.citation_id);
    void clipboard.writeText(unit.citation_ref).then(() => setCopied(unit.citation_id));
  };

  return (
    <section aria-labelledby="viewer-title" data-testid="viewer">
      <h2 id="viewer-title">{t('doc.repo.viewer.title')}</h2>
      <p>
        <StatusPill tone={extractionTone(version.extraction_status)}>{extractionLabel(t, version.extraction_status)}</StatusPill>{' '}
        {version.extraction_engine !== null && <span className="muted">{t('doc.repo.viewer.engine', { engine: version.extraction_engine })}</span>}
      </p>
      <p className="muted" data-testid="viewer-counts">
        {t('doc.repo.viewer.counts', { units: version.unit_count, pages: version.page_count ?? 0 })}
        {version.truncated_units > 0 && ` · ${t('doc.repo.viewer.truncated', { count: version.truncated_units })}`}
      </p>
      {!readable ? (
        <div className="callout warning" role="status" data-testid="no-text">
          <p>{version.extraction_status === 'FAILED' ? t('doc.repo.viewer.failed') : version.extraction_status === 'NO_TEXT' ? t('doc.repo.viewer.noText') : t('doc.repo.viewer.pending')}</p>
          {onReextract !== undefined && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="reextract" disabled={rereading} onClick={onReextract}>
              {t('doc.repo.viewer.reextract')}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="doc2-filters" role="search" aria-label={t('doc.repo.viewer.filterAria')}>
            {detail.outline.pages.length > 0 && (
              <div className="field">
                <label htmlFor="v-page">{t('doc.repo.viewer.page')}</label>
                <select id="v-page" value={filter.page ?? ''} onChange={(event) => setFilter((current) => ({ ...current, ...(event.target.value === '' ? { page: undefined } : { page: Number(event.target.value) }) }))}>
                  <option value="">{t('doc.repo.filter.any')}</option>
                  {detail.outline.pages.map((page) => (
                    <option key={page} value={page}>
                      {t('doc.repo.viewer.pageOption', { page })}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {detail.outline.sheets.length > 0 && (
              <div className="field">
                <label htmlFor="v-sheet">{t('doc.repo.viewer.sheet')}</label>
                <select id="v-sheet" value={filter.sheet ?? ''} onChange={(event) => setFilter((current) => ({ ...current, ...(event.target.value === '' ? { sheet: undefined } : { sheet: event.target.value }) }))}>
                  <option value="">{t('doc.repo.filter.any')}</option>
                  {detail.outline.sheets.map((sheet) => (
                    <option key={sheet} value={sheet}>
                      {sheet}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <form
              className="field"
              onSubmit={(event) => {
                event.preventDefault();
                setFilter((current) => (text.trim() === '' ? { ...current, q: undefined } : { ...current, q: text.trim() }));
              }}
            >
              <label htmlFor="v-text">{t('doc.repo.viewer.search')}</label>
              <input id="v-text" type="search" value={text} maxLength={100} onChange={(event) => setText(event.target.value)} />
              <button type="submit" className="ui-button ui-button--outline ui-button--small" data-testid="viewer-search">
                {t('doc.repo.filter.search')}
              </button>
            </form>
          </div>
          {refreshFailed && (
            <p className="callout warning" role="status" data-testid="viewer-stale">
              {t('doc.repo.viewer.stale')}
            </p>
          )}
          <StateBoundary state={state} onRetry={() => void units.refetch()}>
            {items.length === 0 ? (
              <p className="callout" role="status" data-testid="viewer-empty">
                {t('doc.repo.viewer.emptyFiltered')}
              </p>
            ) : (
              <ol className="doc2-units" data-testid="units">
                {items.map((unit) => (
                  <li key={unit.id} className="doc2-unit" data-citation={unit.citation_id} data-anchored={anchor === unit.citation_id ? 'true' : 'false'}>
                    <div className="doc2-unit-head">
                      <strong>{placeLabel(t, unit)}</strong> <span className="muted">{unitKindLabel(t, unit.kind)}</span>
                      {unit.confidence !== null && <span className="muted"> {t('doc.repo.viewer.confidence', { value: unit.confidence })}</span>}
                    </div>
                    <p className="doc2-unit-text">{unit.text}</p>
                    <div className="doc2-unit-foot">
                      <code data-testid="reference">{unit.citation_ref}</code>
                      <button type="button" className="ui-button ui-button--outline ui-button--small" data-copy={unit.citation_id} onClick={() => copy(unit)}>
                        {copied === unit.citation_id ? t('doc.repo.viewer.copied') : t('doc.repo.viewer.copy')}
                      </button>
                      <button type="button" className="ui-button ui-button--outline ui-button--small" data-comments={unit.citation_id} aria-pressed={anchor === unit.citation_id} onClick={() => onAnchor(anchor === unit.citation_id ? null : unit)}>
                        {t('doc.repo.viewer.comments', { count: unit.open_comments })}
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {units.hasNextPage && (
              <button type="button" className="ui-button ui-button--outline" data-testid="viewer-more" disabled={units.isFetchingNextPage} onClick={() => void units.fetchNextPage()}>
                {t('doc.repo.viewer.more')}
              </button>
            )}
          </StateBoundary>
        </>
      )}
    </section>
  );
}
