import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, StatusPill } from '../../../ui';
import { useDocuments, useLinkOptions } from './hooks';
import { classLabel, effectiveLabel, reviewStatusLabel, securityLabel, versionStatusLabel } from './labels';
import { READ_PERMISSION, UPLOAD_PERMISSION, boardLink, dayText, documentLink, effectiveTone, reviewTone, stamp, versionTone } from './model';
import type { DocumentFilter } from './hooks';
import type { DocumentSummary } from './model';
import { CLASSES, CreateDialog } from './RepositoryDialogs';
import './repository.css';

const EFFECTIVE = ['IN_FORCE', 'NOT_YET', 'EXPIRED', 'UNDATED'] as const;
const STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
const REVIEW_STATUSES = ['NONE', 'IN_REVIEW', 'SUPPLEMENT_REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;

/**
 * DOC-24: the document repository of the projects (DOC-2, PD.01, PD.02). Every file a project keeps (a decision, a design, an estimate, a contract, a record of acceptance or payment) with its class, its effective period, its
 * links to the contract and the package, the state of its latest version and of its review. A person adds a document by uploading a PDF, a Word file or a workbook; the server checks the file, reads its text and judges every link.
 */
export default function RepositoryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [search] = useSearchParams();
  // The filters and the dialog belong to one membership: a switch of tenant or of membership starts the screen over.
  return <RepositoryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${search.get('project') ?? ''}`} route={route} />;
}

function RepositoryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const mayUpload = permissions === undefined || permissions.includes(UPLOAD_PERMISSION);
  const frozen = mode === 'READ_ONLY';
  const [filter, setFilter] = useState<DocumentFilter>(() => {
    const project = search.get('project');
    return project === null ? {} : { projectId: project };
  });
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const [receipt, setReceipt] = useState<{ id: string | undefined; time: string } | undefined>(undefined);
  const projects = useLinkOptions('project', mayRead);
  const list = useDocuments(filter, mayRead);
  const pages = list.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const applied = Object.values(filter).filter((value) => value !== undefined && value !== '').length;
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const refreshFailed = list.isError && list.data !== undefined;
  const asOf = pages[0]?.as_of;
  const projectName = projects.data?.find((option) => option.id === filter.projectId)?.label ?? t('doc.repo.list.allProjects');
  const patch = (next: Partial<DocumentFilter>): void => setFilter((current) => ({ ...current, ...next }));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.repo.list.title')}</h1>
          <p>{t('doc.repo.list.subtitle')}</p>
        </div>
        <div className="actions">
          <Link className="ui-button ui-button--outline" to={boardLink()} data-testid="to-board">
            {t('doc.repo.list.toBoard')}
          </Link>
          {mayRead && mayUpload && !frozen && (
            <button type="button" className="ui-button ui-button--primary" data-testid="add-document" onClick={() => { setReceipt(undefined); setCreating(true); }}>
              {t('doc.repo.list.add')}
            </button>
          )}
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('doc.repo.context.scope'), value: tenant?.name ?? '–' },
          { label: t('doc.repo.context.project'), value: projectName },
        ]}
        {...(asOf === undefined ? {} : { asOf: stamp(asOf) })}
        stale={refreshFailed}
      />
      {frozen && (
        <p className="callout" data-testid="readonly-note">
          {t('doc.repo.readonly.mode')}
        </p>
      )}
      {receipt !== undefined && (
        <p className="callout doc2-receipt" role="status" data-testid="create-receipt">
          {t('doc.repo.list.created', { time: receipt.time })}{' '}
          {receipt.id !== undefined && (
            <Link to={documentLink(receipt.id)} data-testid="created-link">
              {t('doc.repo.list.openCreated')}
            </Link>
          )}
        </p>
      )}
      {!mayRead ? (
        <p className="callout warning" role="status" data-testid="no-read">
          {t('doc.repo.denied')}
        </p>
      ) : (
        <>
          <div className="doc2-filters" role="search" aria-label={t('doc.repo.filter.aria')}>
            <div className="field">
              <label htmlFor="f-project">{t('doc.repo.field.project')}</label>
              <select id="f-project" value={filter.projectId ?? ''} onChange={(event) => patch({ projectId: event.target.value })}>
                <option value="">{t('doc.repo.list.allProjects')}</option>
                {(projects.data ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-class">{t('doc.repo.field.class')}</label>
              <select id="f-class" value={filter.docClass ?? ''} onChange={(event) => patch({ docClass: event.target.value })}>
                <option value="">{t('doc.repo.filter.any')}</option>
                {(pages[0]?.classes ?? CLASSES).map((value) => (
                  <option key={value} value={value}>
                    {classLabel(t, value)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-effective">{t('doc.repo.field.effective')}</label>
              <select id="f-effective" value={filter.effective ?? ''} onChange={(event) => patch({ effective: event.target.value })}>
                <option value="">{t('doc.repo.filter.any')}</option>
                {EFFECTIVE.map((value) => (
                  <option key={value} value={value}>
                    {effectiveLabel(t, value)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-status">{t('doc.repo.field.status')}</label>
              <select id="f-status" value={filter.status ?? ''} onChange={(event) => patch({ status: event.target.value })}>
                <option value="">{t('doc.repo.filter.any')}</option>
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {t(value === 'ACTIVE' ? 'doc.repo.status.active' : 'doc.repo.status.archived')}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-review">{t('doc.repo.field.review')}</label>
              <select id="f-review" value={filter.reviewStatus ?? ''} onChange={(event) => patch({ reviewStatus: event.target.value })}>
                <option value="">{t('doc.repo.filter.any')}</option>
                {REVIEW_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {reviewStatusLabel(t, value)}
                  </option>
                ))}
              </select>
            </div>
            <form
              className="field"
              onSubmit={(event) => {
                event.preventDefault();
                patch({ q: text.trim() });
              }}
            >
              <label htmlFor="f-text">{t('doc.repo.filter.text')}</label>
              <input id="f-text" type="search" value={text} maxLength={100} onChange={(event) => setText(event.target.value)} />
              <button type="submit" className="ui-button ui-button--outline ui-button--small" data-testid="search">
                {t('doc.repo.filter.search')}
              </button>
            </form>
          </div>
          {refreshFailed && (
            <p className="callout warning" role="status" data-testid="stale-note">
              {t('doc.repo.stale', { time: asOf === undefined ? '' : stamp(asOf) })}
            </p>
          )}
          <StateBoundary state={state} onRetry={() => void list.refetch()}>
            {items.length === 0 ? (
              <div className="card statecard" role="status" data-testid="empty">
                <h2>{applied > 0 ? t('doc.repo.list.emptyFiltered.title') : t('doc.repo.list.empty.title')}</h2>
                <p className="muted">{applied > 0 ? t('doc.repo.list.emptyFiltered.body') : t('doc.repo.list.empty.body')}</p>
                {applied > 0 && (
                  <button
                    type="button"
                    className="ui-button ui-button--outline"
                    data-testid="clear-filters"
                    onClick={() => {
                      setFilter({});
                      setText('');
                    }}
                  >
                    {t('doc.repo.filter.clear')}
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="tablewrap">
                  <table aria-label={t('doc.repo.list.aria')} data-testid="documents">
                    <thead>
                      <tr>
                        <th scope="col">{t('doc.repo.col.reference')}</th>
                        <th scope="col">{t('doc.repo.col.title')}</th>
                        <th scope="col">{t('doc.repo.col.class')}</th>
                        <th scope="col">{t('doc.repo.col.links')}</th>
                        <th scope="col">{t('doc.repo.col.effective')}</th>
                        <th scope="col">{t('doc.repo.col.version')}</th>
                        <th scope="col">{t('doc.repo.col.review')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((document) => (
                        <Row key={document.id} document={document} onOpen={() => navigate(documentLink(document.id))} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted" data-testid="count">
                  {t('doc.repo.list.count', { count: items.length })}
                </p>
                {list.hasNextPage && (
                  <button type="button" className="ui-button ui-button--outline" data-testid="more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                    {t('doc.repo.list.more')}
                  </button>
                )}
              </>
            )}
          </StateBoundary>
        </>
      )}
      {creating && (
        <CreateDialog
          defaultProject={filter.projectId}
          onClose={() => setCreating(false)}
          onDone={(id) => {
            setCreating(false);
            setReceipt({ id, time: stamp(new Date().toISOString()) });
          }}
        />
      )}
      <p className="prototype-note">{t('doc.repo.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Row({ document, onOpen }: { document: DocumentSummary; onOpen: () => void }) {
  const { t } = useTranslation();
  const current = document.current_version;
  const review = document.latest_review;
  return (
    <tr data-document={document.id} data-status={document.status} onDoubleClick={onOpen}>
      <td>{document.reference ?? '—'}</td>
      <td>
        <Link to={documentLink(document.id)} data-open={document.id}>
          {document.title}
        </Link>
        {document.status === 'ARCHIVED' && (
          <>
            {' '}
            <StatusPill tone="neutral">{t('doc.repo.status.archived')}</StatusPill>
          </>
        )}
        <div className="muted">{securityLabel(t, document.security_class)}</div>
      </td>
      <td>{classLabel(t, document.doc_class)}</td>
      <td>
        <div>{document.project.code}</div>
        {document.contract !== null && <div>{t('doc.repo.link.contract', { code: document.contract.code })}</div>}
        {document.package !== null && <div>{t('doc.repo.link.package', { code: document.package.code })}</div>}
      </td>
      <td>
        <StatusPill tone={effectiveTone(document.effective_state)}>{effectiveLabel(t, document.effective_state)}</StatusPill>
        <div className="muted">{document.effective_from === null && document.effective_to === null ? '—' : t('doc.repo.period', { from: dayText(document.effective_from) || '…', to: dayText(document.effective_to) || '…' })}</div>
      </td>
      <td>
        {current === null ? (
          '—'
        ) : (
          <>
            <div>{t('doc.repo.version.number', { no: current.version_no })}</div>
            <StatusPill tone={versionTone(current.status)}>{versionStatusLabel(t, current.status)}</StatusPill>
          </>
        )}
        <div className="muted">{t('doc.repo.version.count', { count: document.version_count })}</div>
        {document.approved_version !== null && <div className="muted">{t('doc.repo.version.approvedNo', { no: document.approved_version.version_no })}</div>}
      </td>
      <td>
        {review === null ? (
          <span className="muted">{reviewStatusLabel(t, 'NONE')}</span>
        ) : (
          <Link to={boardLink(review.id)} data-review={review.id}>
            <StatusPill tone={reviewTone(review.status)}>{reviewStatusLabel(t, review.status)}</StatusPill> {t('doc.repo.review.round', { round: review.round })}
          </Link>
        )}
      </td>
    </tr>
  );
}
