import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { AuditLine, ContextBar, StatusPill } from '../../../ui';
import { linkOf } from '../../ctr/export/model';
import { CommandDialog } from './CommandDialog';
import { Comments } from './Comments';
import { AddVersionDialog, EditDialog, SubmitDialog } from './DocumentDialogs';
import { useArchive, useDocument, useDownloadLink, useRerunExtraction, useRestore, useVersion, useWithdrawReview } from './hooks';
import { classLabel, effectiveLabel, extractionLabel, formatLabel, problemText, reviewStatusLabel, securityLabel, versionStatusLabel } from './labels';
import { READ_PERMISSION, boardLink, compareLink, dayText, effectiveTone, repositoryLink, reviewTone, sizeText, stamp, versionTone } from './model';
import type { TextUnit } from './model';
import { Viewer } from './Viewer';
import './repository.css';

type Dialog = 'edit' | 'addVersion' | 'archive' | 'restore' | 'submit' | 'withdraw' | undefined;

/**
 * DOC-25: one document of a project (DOC-2, PD.01, PD.02): its description and effective period, its versions with the state of each (an approved version is locked), the text of the chosen version in citable units with the
 * reference of each, the comments on it, and the steps of the document: correct it, add a version, send a draft to review, withdraw a review, archive and restore, read the text again, download the file. The server judges every step again.
 */
export default function DocumentScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [search] = useSearchParams();
  // The dialogs and the thread belong to one membership and to the document that is open: a switch of either starts the screen over.
  return <DocumentContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${search.get('id') ?? ''}`} route={route} />;
}

function DocumentContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const id = search.get('id') ?? undefined;
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const frozen = mode === 'READ_ONLY';
  const detail = useDocument(mayRead ? id : undefined);
  const data = detail.data;
  const chosen = search.get('version') ?? data?.document.current_version?.id ?? data?.versions[0]?.id;
  const version = useVersion(mayRead ? chosen : undefined);
  const [dialog, setDialog] = useState<Dialog>(undefined);
  const [anchor, setAnchor] = useState<{ citationId: string; label: string } | null>(null);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const archive = useArchive();
  const restore = useRestore();
  const withdraw = useWithdrawReview();
  const rerun = useRerunExtraction();
  const download = useDownloadLink();
  const state = useScreenState({ isLoading: detail.isLoading, error: data === undefined ? detail.error : undefined, data: id === undefined ? undefined : data, isEmpty: () => false });
  const versionState = useScreenState({ isLoading: version.isLoading, error: version.data === undefined ? version.error : undefined, data: version.data, isEmpty: () => false });
  const refreshFailed = detail.isError && data !== undefined;
  const document = data?.document;
  const picked = data?.versions.find((item) => item.id === chosen);
  const actions = data?.actions;
  const latest = data?.rounds[0];
  const acting = !frozen;
  const open = (next: Dialog): void => {
    setReceipt(undefined);
    setDialog(next);
  };
  const close = (): void => {
    setDialog(undefined);
    archive.reset();
    restore.reset();
    withdraw.reset();
  };
  const done = (message: string): void => {
    setDialog(undefined);
    setReceipt(message);
  };
  const reload = (): void => {
    void detail.refetch();
    void version.refetch();
  };
  const select = (versionId: string): void => {
    setAnchor(null);
    setSearch({ id: id ?? '', version: versionId });
  };
  const onAnchor = (unit: TextUnit | null): void => setAnchor(unit === null ? null : { citationId: unit.citation_id, label: unit.label });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{document?.title ?? t('doc.repo.detail.title')}</h1>
          <p>{document === undefined ? t('doc.repo.detail.subtitle') : [document.reference, classLabel(t, document.doc_class)].filter((part) => part !== null && part !== '').join(' · ')}</p>
        </div>
        <div className="actions">
          <Link className="ui-button ui-button--outline" to={repositoryLink(document?.project.id)} data-testid="back">
            {t('doc.repo.detail.back')}
          </Link>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('doc.repo.context.scope'), value: tenant?.name ?? '–' },
          { label: t('doc.repo.context.project'), value: document === undefined ? '–' : `${document.project.code} - ${document.project.name}` },
        ]}
        {...(data === undefined ? {} : { asOf: stamp(data.as_of) })}
        stale={refreshFailed}
      />
      {frozen && (
        <p className="callout" data-testid="readonly-note">
          {t('doc.repo.readonly.mode')}
        </p>
      )}
      {receipt !== undefined && (
        <p className="callout doc2-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      {refreshFailed && (
        <p className="callout warning" role="status" data-testid="stale-note">
          {t('doc.repo.stale', { time: data === undefined ? '' : stamp(data.as_of) })}
        </p>
      )}
      {!mayRead ? (
        <p className="callout warning" role="status" data-testid="no-read">
          {t('doc.repo.denied')}
        </p>
      ) : id === undefined ? (
        <p className="callout" role="status" data-testid="no-id">
          {t('doc.repo.detail.noId')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={reload}>
          {document !== undefined && data !== undefined && actions !== undefined && (
            <>
              <section aria-labelledby="facts-title" data-testid="facts">
                <h2 id="facts-title">{t('doc.repo.detail.facts')}</h2>
                <p>
                  <StatusPill tone={effectiveTone(document.effective_state)}>{effectiveLabel(t, document.effective_state)}</StatusPill>{' '}
                  {document.status === 'ARCHIVED' && <StatusPill tone="neutral">{t('doc.repo.status.archived')}</StatusPill>}
                </p>
                <dl className="doc2-facts">
                  <div>
                    <dt>{t('doc.repo.field.class')}</dt>
                    <dd>{classLabel(t, document.doc_class)}</dd>
                  </div>
                  <div>
                    <dt>{t('doc.repo.field.security')}</dt>
                    <dd>{securityLabel(t, document.security_class)}</dd>
                  </div>
                  <div>
                    <dt>{t('doc.repo.field.project')}</dt>
                    <dd>{`${document.project.code} - ${document.project.name}`}</dd>
                  </div>
                  <div>
                    <dt>{t('doc.repo.field.contract')}</dt>
                    <dd data-testid="fact-contract">{document.contract?.code ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>{t('doc.repo.field.package')}</dt>
                    <dd data-testid="fact-package">{document.package?.code ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>{t('doc.repo.field.period')}</dt>
                    <dd data-testid="fact-period">{document.effective_from === null && document.effective_to === null ? '—' : t('doc.repo.period', { from: dayText(document.effective_from) || '…', to: dayText(document.effective_to) || '…' })}</dd>
                  </div>
                  {document.note !== null && (
                    <div>
                      <dt>{t('doc.repo.field.note')}</dt>
                      <dd>{document.note}</dd>
                    </div>
                  )}
                  {document.archive_reason !== null && (
                    <div>
                      <dt>{t('doc.repo.detail.archiveReason')}</dt>
                      <dd data-testid="fact-archive">{document.archive_reason}</dd>
                    </div>
                  )}
                </dl>
                <AuditLine
                  items={[
                    { label: t('doc.repo.audit.created'), value: stamp(document.created_at) },
                    { label: t('doc.repo.audit.updated'), value: stamp(document.updated_at) },
                    { label: t('doc.repo.audit.version'), value: String(document.version) },
                  ]}
                />
              </section>

              {acting && (
                <div className="actions doc2-actions" data-testid="actions">
                  {actions.update && (
                    <button type="button" className="ui-button ui-button--outline" data-testid="edit" onClick={() => open('edit')}>
                      {t('doc.repo.action.edit')}
                    </button>
                  )}
                  {actions.add_version && (
                    <button type="button" className="ui-button ui-button--outline" data-testid="add-version" onClick={() => open('addVersion')}>
                      {t('doc.repo.action.addVersion')}
                    </button>
                  )}
                  {actions.submit_for_review && document.current_version !== null && (
                    <button type="button" className="ui-button ui-button--primary" data-testid="submit" onClick={() => open('submit')}>
                      {t('doc.repo.action.submit')}
                    </button>
                  )}
                  {actions.withdraw_review && latest !== undefined && (
                    <button type="button" className="ui-button ui-button--outline" data-testid="withdraw" onClick={() => open('withdraw')}>
                      {t('doc.repo.action.withdraw')}
                    </button>
                  )}
                  {actions.archive && (
                    <button type="button" className="ui-button ui-button--outline" data-testid="archive" onClick={() => open('archive')}>
                      {t('doc.repo.action.archive')}
                    </button>
                  )}
                  {actions.restore && (
                    <button type="button" className="ui-button ui-button--outline" data-testid="restore" onClick={() => open('restore')}>
                      {t('doc.repo.action.restore')}
                    </button>
                  )}
                </div>
              )}

              <section aria-labelledby="versions-title" data-testid="versions">
                <h2 id="versions-title">{t('doc.repo.versions.title')}</h2>
                <div className="tablewrap">
                  <table aria-label={t('doc.repo.versions.aria')}>
                    <thead>
                      <tr>
                        <th scope="col">{t('doc.repo.versions.col.no')}</th>
                        <th scope="col">{t('doc.repo.versions.col.status')}</th>
                        <th scope="col">{t('doc.repo.versions.col.file')}</th>
                        <th scope="col">{t('doc.repo.versions.col.text')}</th>
                        <th scope="col">{t('doc.repo.versions.col.comments')}</th>
                        <th scope="col">{t('doc.repo.versions.col.created')}</th>
                        <th scope="col">
                          <span className="sr-only">{t('doc.repo.versions.col.actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.versions.map((item) => {
                        const size = sizeText(item.size_bytes);
                        return (
                          <tr key={item.id} data-version={item.id} data-status={item.status} aria-current={item.id === chosen ? 'true' : undefined}>
                            <td>{t('doc.repo.version.number', { no: item.version_no })}</td>
                            <td>
                              <StatusPill tone={versionTone(item.status)}>{versionStatusLabel(t, item.status)}</StatusPill>
                              {item.locked && (
                                <div className="muted" data-testid={`locked-${item.id}`}>
                                  {t('doc.repo.versions.locked', { name: item.locked_by_name ?? t('doc.repo.comments.unknownAuthor'), time: stamp(item.locked_at) })}
                                </div>
                              )}
                              {document.approved_version?.id === item.id && <div className="muted">{t('doc.repo.versions.baseline')}</div>}
                            </td>
                            <td>
                              {formatLabel(t, item.format)} · {size.value} {size.unit}
                              {item.page_count !== null && ` · ${t('doc.repo.file.pages', { count: item.page_count })}`}
                              {item.change_note !== null && <div className="muted">{item.change_note}</div>}
                            </td>
                            <td>
                              <StatusPill tone={item.extraction_status === 'EXTRACTED' ? 'success' : item.extraction_status === 'FAILED' ? 'danger' : 'warning'}>{extractionLabel(t, item.extraction_status)}</StatusPill>
                              <div className="muted">{t('doc.repo.versions.units', { count: item.unit_count })}</div>
                            </td>
                            <td>{item.open_comments}</td>
                            <td>
                              {stamp(item.created_at)}
                              <div className="muted">{item.created_by_name ?? ''}</div>
                            </td>
                            <td>
                              <button type="button" className="ui-button ui-button--outline ui-button--small" data-select={item.id} disabled={item.id === chosen} onClick={() => select(item.id)}>
                                {t('doc.repo.versions.open')}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {data.versions.length >= 2 && (
                  <p>
                    <Link className="ui-button ui-button--outline" to={compareLink(document.id, data.versions[1]?.id, data.versions[0]?.id)} data-testid="to-compare">
                      {t('doc.repo.versions.compare')}
                    </Link>
                  </p>
                )}
              </section>

              {picked?.locked === true && (
                <p className="callout doc2-locked" role="status" data-testid="locked-banner">
                  {t('doc.repo.locked.banner', { no: picked.version_no })}
                </p>
              )}

              <StateBoundary state={versionState} onRetry={() => void version.refetch()}>
                {version.data !== undefined && (
                  <>
                    <div className="actions doc2-actions">
                      <button
                        type="button"
                        className="ui-button ui-button--outline"
                        data-testid="download"
                        disabled={!version.data.actions.download || download.isPending}
                        onClick={() => download.mutate(version.data?.version.id ?? '')}
                      >
                        {t('doc.repo.action.download')}
                      </button>
                      {download.data !== undefined && (
                        <a href={linkOf(download.data.url, import.meta.env.VITE_API_BASE_URL ?? '')} download data-testid="download-link">
                          {t('doc.repo.download.ready', { size: sizeText(download.data.size_bytes).value, unit: sizeText(download.data.size_bytes).unit, time: stamp(download.data.expires_at) })}
                        </a>
                      )}
                      {download.isError && (
                        <span role="alert" className="callout warning" data-testid="download-error">
                          {problemText(t, download.error)}
                        </span>
                      )}
                    </div>
                    {rerun.isError && (
                      <p role="alert" className="callout warning" data-testid="rerun-error">
                        {problemText(t, rerun.error)}
                      </p>
                    )}
                    <Viewer
                      detail={version.data}
                      anchor={anchor?.citationId ?? null}
                      onAnchor={onAnchor}
                      onReextract={acting && version.data.actions.re_extract ? () => rerun.mutate({ versionId: version.data?.version.id ?? '' }) : undefined}
                      rereading={rerun.isPending}
                    />
                    <Comments
                      versionId={version.data.version.id}
                      anchor={anchor}
                      onClearAnchor={() => setAnchor(null)}
                      mayComment={version.data.actions.comment}
                      frozen={frozen}
                      locked={version.data.version.locked}
                    />
                  </>
                )}
              </StateBoundary>

              <section aria-labelledby="rounds-title" data-testid="rounds">
                <h2 id="rounds-title">{t('doc.repo.rounds.title')}</h2>
                {data.rounds.length === 0 ? (
                  <p className="muted">{t('doc.repo.rounds.empty')}</p>
                ) : (
                  <ul>
                    {data.rounds.map((round) => (
                      <li key={round.id} data-round={round.id}>
                        <Link to={boardLink(round.id)}>
                          {t('doc.repo.rounds.item', { round: round.round, no: round.version_no })}
                        </Link>{' '}
                        <StatusPill tone={reviewTone(round.status)}>{reviewStatusLabel(t, round.status)}</StatusPill> <span className="muted">{stamp(round.submitted_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {dialog === 'edit' && <EditDialog document={document} onClose={close} onReload={reload} onDone={() => done(t('doc.repo.receipt.updated', { time: stamp(new Date().toISOString()) }))} />}
              {dialog === 'addVersion' && <AddVersionDialog document={document} onClose={close} onDone={() => done(t('doc.repo.receipt.versionAdded', { time: stamp(new Date().toISOString()) }))} />}
              {dialog === 'submit' && document.current_version !== null && (
                <SubmitDialog
                  document={document}
                  versionId={document.current_version.id}
                  versionNo={document.current_version.version_no}
                  round={(latest?.round ?? 0) + 1}
                  onClose={close}
                  onDone={(reviewId) => {
                    done(t('doc.repo.receipt.submitted', { time: stamp(new Date().toISOString()) }));
                    if (reviewId !== undefined) navigate(boardLink(reviewId));
                  }}
                />
              )}
              {dialog === 'archive' && (
                <CommandDialog
                  title={t('doc.repo.archive.title')}
                  context={[{ label: t('doc.repo.field.title'), value: document.title }]}
                  confirmLabel={t('doc.repo.archive.confirm')}
                  reason={{ label: t('doc.repo.archive.reason'), required: true }}
                  pending={archive.isPending}
                  error={archive.error ?? undefined}
                  onCancel={close}
                  onReload={() => {
                    reload();
                    close();
                  }}
                  onConfirm={(reason) => archive.mutate({ id: document.id, version: document.version, reason }, { onSuccess: () => done(t('doc.repo.receipt.archived', { time: stamp(new Date().toISOString()) })) })}
                />
              )}
              {dialog === 'restore' && (
                <CommandDialog
                  title={t('doc.repo.restore.title')}
                  context={[{ label: t('doc.repo.field.title'), value: document.title }]}
                  confirmLabel={t('doc.repo.restore.confirm')}
                  pending={restore.isPending}
                  error={restore.error ?? undefined}
                  onCancel={close}
                  onReload={() => {
                    reload();
                    close();
                  }}
                  onConfirm={() => restore.mutate({ id: document.id, version: document.version }, { onSuccess: () => done(t('doc.repo.receipt.restored', { time: stamp(new Date().toISOString()) })) })}
                />
              )}
              {dialog === 'withdraw' && latest !== undefined && (
                <CommandDialog
                  title={t('doc.repo.withdraw.title')}
                  context={[
                    { label: t('doc.repo.field.title'), value: document.title },
                    { label: t('doc.repo.submit.round'), value: String(latest.round) },
                  ]}
                  confirmLabel={t('doc.repo.withdraw.confirm')}
                  reason={{ label: t('doc.repo.withdraw.reason'), required: true }}
                  pending={withdraw.isPending}
                  error={withdraw.error ?? undefined}
                  onCancel={close}
                  onReload={() => {
                    reload();
                    close();
                  }}
                  onConfirm={(reason) => withdraw.mutate({ id: latest.id, version: latest.version, reason }, { onSuccess: () => done(t('doc.repo.receipt.withdrawn', { time: stamp(new Date().toISOString()) })) })}
                />
              )}
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('doc.repo.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
