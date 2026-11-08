import type { UseQueryResult } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { ConfirmDialog, SectionCard } from '../../../ui';
import { ExpectedColumns, ProblemNote } from './import-components';
import { useApplyEgpFile, usePreviewEgpFile, useUploadEgpFile } from './import-hooks';
import { applyBlockLabel, fitMessage, kindLabel } from './import-labels';
import { IMPORT_ACCEPT, KINDS, applyGate, describeProblem, isForbidden, kindFit, kindOf, refusedApply, shortHash, sizeText, tooLarge } from './import-model';
import type { Applied, Connection, Kind, Preview, Problem, UploadedFile } from './import-model';
import { ImportPreview } from './ImportPreview';
import { ImportResult } from './ImportResult';
import './import.css';

type Access = 'ready' | 'loading' | 'readOnly' | 'noPreview' | 'denied' | 'error';

const problemOf = (kind: Problem['kind']): Problem => ({ kind, missingColumns: [], layoutVersion: '', supported: [], code: '' });

/**
 * The flow of one file (BID-24, part A): choose the kind and see its expected columns, choose and upload the file (the kinds it fits are told, never switched for the person), run the dry run, read it row by row, and apply it once.
 * Dry run needs `actions.preview` and a session that is not read-only; apply needs `actions.apply`, a file with a valid row that was not loaded before and a connection that is on.
 */
export function ImportFlow({ connection }: { connection: UseQueryResult<Connection | undefined> }) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const upload = useUploadEgpFile();
  const dry = usePreviewEgpFile();
  const apply = useApplyEgpFile();
  const reasonId = useId();
  const [kind, setKind] = useState<Kind>('KHLCNT');
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
          ? connection.error === null || connection.error === undefined
            ? 'error'
            : isForbidden(connection.error)
              ? 'denied'
              : 'error'
          : !conn.canPreview
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
    canApply: conn?.canApply === true,
    connectionBlocked: conn?.applyBlocked === true,
    applied: applied !== undefined,
    working: apply.isPending,
  });
  const fit = uploaded === undefined ? undefined : kindFit(uploaded, kind);
  const outcome = applied ?? refused;

  return (
    <>
      <SectionCard title={t('egp.import.flow.title')}>
        {access === 'readOnly' ? (
          <p className="callout" role="status" data-testid="import-readonly">
            {t('egp.import.state.readOnly')}
          </p>
        ) : null}
        {access === 'loading' ? (
          <p className="callout" role="status" aria-busy="true" data-testid="import-connection-loading">
            {t('egp.import.state.connectionLoading')}
          </p>
        ) : null}
        {access === 'denied' ? (
          <p className="callout warning" role="alert" data-testid="import-denied">
            {t('egp.import.state.connectionDenied')}
          </p>
        ) : null}
        {access === 'error' ? (
          <div className="callout warning" role="alert" data-testid="import-connection-error">
            <p>{t('egp.import.state.connectionError')}</p>
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void connection.refetch()}>
              {t('states.retry.action')}
            </button>
          </div>
        ) : null}
        {access === 'noPreview' ? (
          <p className="callout" role="status" data-testid="import-no-preview">
            {t('egp.import.state.noPreview')}
          </p>
        ) : null}
        {access === 'ready' ? (
          <div className="egpi-form">
            <div className="field">
              <label htmlFor="egp-import-kind">{t('egp.import.flow.kind.label')}</label>
              <select id="egp-import-kind" value={kind} disabled={busy} onChange={(event) => chooseKind(kindOf(event.target.value) ?? 'KHLCNT')}>
                {KINDS.map((value) => (
                  <option key={value} value={value}>
                    {kindLabel(t, value)}
                  </option>
                ))}
              </select>
            </div>
            <ExpectedColumns layout={layout} title={t('egp.import.columns.summary', { kind: kindLabel(t, kind), version: conn?.layoutVersion ?? '' })} />
            <div className="field">
              <label htmlFor="egp-import-file">{t('egp.import.flow.file.label')}</label>
              <input id="egp-import-file" type="file" accept={IMPORT_ACCEPT} disabled={busy} onChange={(event) => chooseFile(event.target.files?.[0])} />
            </div>
            {uploaded === undefined ? null : (
              <p data-testid="import-file">
                {t('egp.import.file.summary', { format: uploaded.format, rows: uploaded.rowCount.toLocaleString(locale), size: sizeText(uploaded.sizeBytes, locale).value, unit: sizeText(uploaded.sizeBytes, locale).unit, hash: shortHash(uploaded.fileSha256) })}
              </p>
            )}
            {uploaded === undefined || fit === undefined || fit === 'fits' ? null : (
              <p className="callout warning" role="status" data-testid="kind-fit" data-fit={fit}>
                {fitMessage(t, fit, { kinds: uploaded.matchingKinds.map((one) => kindLabel(t, one)).join(', '), chosen: kindLabel(t, kind) })}
              </p>
            )}
            {problem === undefined ? null : <ProblemNote problem={problem} />}
            <div className="egpi-actions">
              <button type="button" className="ui-button ui-button--outline" disabled={file === undefined || uploaded !== undefined || busy || tooLarge(file)} onClick={send}>
                {upload.isPending ? t('egp.import.flow.upload.pending') : t('egp.import.flow.upload.action')}
              </button>
              <button type="button" className="ui-button ui-button--primary" disabled={uploaded === undefined || busy} onClick={run}>
                {dry.isPending ? t('egp.import.flow.preview.pending') : t('egp.import.flow.preview.action')}
              </button>
              <button type="button" className="ui-button ui-button--primary" disabled={block !== null} aria-describedby={block === null ? undefined : reasonId} onClick={() => setConfirming(true)}>
                {apply.isPending ? t('egp.import.flow.apply.pending') : t('egp.import.flow.apply.action')}
              </button>
            </div>
            <small className="sub">{t('egp.import.flow.preview.hint')}</small>
            {block === null ? null : (
              <small className="sub" id={reasonId} data-testid="apply-reason" data-reason={block}>
                {applyBlockLabel(t, block)}
              </small>
            )}
          </div>
        ) : null}
      </SectionCard>
      {preview === undefined ? null : (
        <SectionCard title={t('egp.import.preview.title')}>
          <ImportPreview preview={preview} />
        </SectionCard>
      )}
      {outcome === undefined ? null : (
        <SectionCard title={t('egp.import.result.title')}>
          <ImportResult applied={outcome} />
        </SectionCard>
      )}
      {uploaded === undefined || preview === undefined ? null : (
        <ConfirmDialog
          open={confirming}
          title={t('egp.import.confirm.title')}
          context={[
            { label: t('egp.import.field.kind'), value: kindLabel(t, kind) },
            { label: t('egp.import.field.layout'), value: preview.layoutVersion },
            { label: t('egp.import.field.hash'), value: shortHash(uploaded.fileSha256) },
            { label: t('egp.import.field.valid'), value: preview.counts.valid.toLocaleString(locale) },
          ]}
          confirmLabel={t('egp.import.confirm.action')}
          cancelLabel={t('egp.import.confirm.cancel')}
          pending={apply.isPending}
          onConfirm={confirm}
          onCancel={() => setConfirming(false)}
        >
          <p data-testid="confirm-irreversible">{t('egp.import.confirm.irreversible')}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
