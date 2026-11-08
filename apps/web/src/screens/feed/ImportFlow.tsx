import { useId, useState } from 'react';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { ConfirmDialog, SectionCard } from '../../ui';
import { useApplyFeedFile, useFeedConnection, usePreviewFeedFile, useUploadFeedFile } from './feed-hooks';
import { applyBlockLabel, fitMessage, kindLabel } from './feed-labels';
import { FILE_ACCEPT, KINDS, applyGate, describeProblem, isForbidden, kindFit, kindOf, refusedApply, shortHash, sizeText, tooLarge } from './feed-model';
import type { Applied, Kind, Preview, Problem, UploadedFile } from './feed-model';
import { ProblemNote } from './feed-parts';
import { ExpectedColumns, PreviewPanel, ResultPanel } from './run-components';
import './feed.css';

type Access = 'ready' | 'loading' | 'readOnly' | 'noPreview' | 'denied' | 'error';

const problemOf = (kind: Problem['kind']): Problem => ({ kind, field: undefined, code: '', detail: undefined, missingColumns: [], layoutVersion: '', supported: [] });

/**
 * The flow of one file (FEED-02): choose the kind and see its expected columns, choose and upload the file (the kinds it fits are told, never switched for the person), run the dry run and read it row by row, and apply it once.
 * The dry run needs `actions.preview` and a session that is not read-only; the apply needs `actions.apply`, a file with a valid row that was not loaded before and a connection that is on. The same file again says it was applied.
 */
export function ImportFlow() {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const connection = useFeedConnection();
  const upload = useUploadFeedFile();
  const dry = usePreviewFeedFile();
  const apply = useApplyFeedFile();
  const reasonId = useId();
  const [kind, setKind] = useState<Kind>('PROJECT');
  const [file, setFile] = useState<File | undefined>(undefined);
  const [uploaded, setUploaded] = useState<UploadedFile | undefined>(undefined);
  const [preview, setPreview] = useState<Preview | undefined>(undefined);
  const [applied, setApplied] = useState<Applied | undefined>(undefined);
  const [refused, setRefused] = useState<Applied | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);

  const conn = connection.data;
  const access: Access =
    mode === 'READ_ONLY'
      ? 'readOnly'
      : connection.isLoading
        ? 'loading'
        : conn === undefined
          ? isForbidden(connection.error)
            ? 'denied'
            : 'error'
          : !conn.actions.preview
            ? 'noPreview'
            : 'ready';

  const busy = upload.isPending || dry.isPending || apply.isPending;
  const layout = conn?.layouts.find((one) => one.kind === kind);

  const clearResults = (): void => {
    setPreview(undefined);
    setApplied(undefined);
    setRefused(undefined);
    setProblem(undefined);
    dry.reset();
    apply.reset();
  };
  const chooseFile = (next: File | undefined): void => {
    setFile(next);
    setUploaded(undefined);
    clearResults();
    upload.reset();
    if (next !== undefined && tooLarge(next)) setProblem(problemOf('tooLarge'));
  };
  const chooseKind = (next: Kind): void => {
    setKind(next);
    clearResults();
  };

  const send = (): void => {
    if (file === undefined || busy || tooLarge(file)) return;
    setProblem(undefined);
    upload.mutate(file, {
      onSuccess: (result) => (result === undefined ? setProblem(problemOf('general')) : setUploaded(result)),
      onError: (error) => setProblem(describeProblem(error)),
    });
  };

  const run = (): void => {
    if (uploaded === undefined || busy) return;
    clearResults();
    dry.mutate(
      { kind, fileObjectKey: uploaded.fileObjectKey, fileSha256: uploaded.fileSha256 },
      {
        onSuccess: (result) => (result === undefined ? setProblem(problemOf('general')) : setPreview(result)),
        onError: (error) => setProblem(describeProblem(error)),
      },
    );
  };

  const confirm = (): void => {
    if (uploaded === undefined || busy) return;
    setProblem(undefined);
    apply.mutate(
      { kind, fileObjectKey: uploaded.fileObjectKey, fileSha256: uploaded.fileSha256 },
      {
        onSuccess: (result) => {
          setConfirming(false);
          if (result === undefined) setProblem(problemOf('general'));
          else setApplied(result);
        },
        onError: (error) => {
          setConfirming(false);
          const failure = describeProblem(error);
          setProblem(failure);
          setRefused(refusedApply(error));
          // A file that was loaded before, or a connection that is off, closes the apply for this file at once.
          if (failure.kind === 'alreadyApplied') setPreview((current) => (current === undefined ? current : { ...current, alreadyApplied: true }));
          if (failure.kind === 'connectionDisabled') setPreview((current) => (current === undefined ? current : { ...current, connectionEnabled: false }));
        },
      },
    );
  };

  const block = applyGate({
    preview,
    previewIsCurrent: preview !== undefined && uploaded !== undefined && preview.kind === kind && preview.fileSha256 === uploaded.fileSha256,
    canApply: conn?.actions.apply === true,
    connectionBlocked: conn !== undefined && !conn.enabled,
    applied: applied !== undefined,
    working: apply.isPending,
  });
  const fit = uploaded === undefined ? undefined : kindFit(uploaded, kind);
  const outcome = applied ?? refused;

  return (
    <>
      <SectionCard title={t('feed.runs.flow.title')}>
        {access === 'readOnly' && (
          <p className="callout" role="status" data-testid="import-readonly">
            {t('feed.runs.state.readOnly')}
          </p>
        )}
        {access === 'loading' && (
          <p className="callout" role="status" aria-busy="true" data-testid="import-connection-loading">
            {t('feed.runs.state.connectionLoading')}
          </p>
        )}
        {access === 'denied' && (
          <p className="callout warning" role="alert" data-testid="import-denied">
            {t('feed.runs.state.connectionDenied')}
          </p>
        )}
        {access === 'error' && (
          <div className="callout warning" role="alert" data-testid="import-connection-error">
            <p>{t('feed.runs.state.connectionError')}</p>
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void connection.refetch()}>
              {t('states.retry.action')}
            </button>
          </div>
        )}
        {access === 'noPreview' && (
          <p className="callout" role="status" data-testid="import-no-preview">
            {t('feed.runs.state.noPreview')}
          </p>
        )}
        {access === 'ready' && (
          <div className="feed-form">
            <div className="field">
              <label htmlFor="feed-import-kind">{t('feed.runs.flow.kind.label')}</label>
              <select id="feed-import-kind" value={kind} disabled={busy} onChange={(event) => chooseKind(kindOf(event.target.value) ?? 'PROJECT')}>
                {KINDS.map((value) => (
                  <option key={value} value={value}>
                    {kindLabel(t, value)}
                  </option>
                ))}
              </select>
            </div>
            <ExpectedColumns layout={layout} title={t('feed.runs.columns.summary', { kind: kindLabel(t, kind), version: conn?.layoutVersion ?? '' })} />
            <div className="field">
              <label htmlFor="feed-import-file">{t('feed.runs.flow.file.label')}</label>
              <input id="feed-import-file" type="file" accept={FILE_ACCEPT} disabled={busy} onChange={(event) => chooseFile(event.target.files?.[0])} />
            </div>
            {uploaded !== undefined && (
              <p data-testid="import-file">
                {t('feed.runs.file.summary', { format: uploaded.format, rows: uploaded.rowCount.toLocaleString(locale), size: sizeText(uploaded.sizeBytes, locale).value, unit: sizeText(uploaded.sizeBytes, locale).unit, hash: shortHash(uploaded.fileSha256) })}
              </p>
            )}
            {uploaded !== undefined && fit !== undefined && fit !== 'fits' && (
              <p className="callout warning" role="status" data-testid="kind-fit" data-fit={fit}>
                {fitMessage(t, fit, { kinds: uploaded.matchingKinds.map((one) => kindLabel(t, one)).join(', '), chosen: kindLabel(t, kind) })}
              </p>
            )}
            {problem !== undefined && <ProblemNote problem={problem} />}
            <div className="feed-actions">
              <button type="button" className="ui-button ui-button--outline" disabled={file === undefined || uploaded !== undefined || busy || tooLarge(file)} onClick={send}>
                {upload.isPending ? t('feed.runs.flow.upload.pending') : t('feed.runs.flow.upload.action')}
              </button>
              <button type="button" className="ui-button ui-button--primary" disabled={uploaded === undefined || busy} onClick={run}>
                {dry.isPending ? t('feed.runs.flow.preview.pending') : t('feed.runs.flow.preview.action')}
              </button>
              <button type="button" className="ui-button ui-button--primary" disabled={block !== null} aria-describedby={block === null ? undefined : reasonId} onClick={() => setConfirming(true)}>
                {apply.isPending ? t('feed.runs.flow.apply.pending') : t('feed.runs.flow.apply.action')}
              </button>
            </div>
            <small className="sub">{t('feed.runs.flow.preview.hint')}</small>
            {block !== null && (
              <small className="sub" id={reasonId} data-testid="apply-reason" data-reason={block}>
                {applyBlockLabel(t, block)}
              </small>
            )}
          </div>
        )}
      </SectionCard>
      {preview !== undefined && (
        <SectionCard title={t('feed.runs.preview.title')}>
          <PreviewPanel preview={preview} />
        </SectionCard>
      )}
      {outcome !== undefined && (
        <SectionCard title={t('feed.runs.result.title')}>
          <ResultPanel applied={outcome} />
        </SectionCard>
      )}
      {uploaded !== undefined && preview !== undefined && (
        <ConfirmDialog
          open={confirming}
          title={t('feed.runs.confirm.title')}
          context={[
            { label: t('feed.runs.field.kind'), value: kindLabel(t, kind) },
            { label: t('feed.runs.field.layout'), value: preview.layoutVersion },
            { label: t('feed.runs.field.hash'), value: shortHash(uploaded.fileSha256) },
            { label: t('feed.runs.field.valid'), value: preview.counts.valid.toLocaleString(locale) },
          ]}
          confirmLabel={t('feed.runs.confirm.action')}
          cancelLabel={t('feed.common.dialog.cancel.action')}
          pending={apply.isPending}
          onConfirm={confirm}
          onCancel={() => setConfirming(false)}
        >
          <p data-testid="confirm-irreversible">{t('feed.runs.confirm.irreversible')}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
