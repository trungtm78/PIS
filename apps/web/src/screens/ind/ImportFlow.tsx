import { useId, useState } from 'react';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { ConfirmDialog, SectionCard } from '../../ui';
import { ProblemNote, RowErrorsTable } from './ind-components';
import { useApplyImport, usePreviewImport, useUploadFile } from './ind-hooks';
import { applyBlockLabel } from './ind-labels';
import { IMPORT_ACCEPT, applyGate, describeProblem, holds, refusedApply, shortHash, sizeText, tooLarge } from './ind-model';
import type { Applied, Preview, Problem, UploadedFile } from './ind-model';
import { ImportPreview } from './ImportPreview';
import './ind.css';

const problemOf = (kind: Problem['kind']): Problem => ({ kind, code: '', detail: '', missing: [], violations: [] });

function ImportResult({ applied }: { applied: Applied }) {
  const { t, locale } = useTranslation();
  const num = (value: number): string => value.toLocaleString(locale);
  return (
    <div data-testid="import-result" data-refused={applied.runId === null ? 'true' : 'false'}>
      <p role="status">{applied.runId === null ? t('ind.imp.result.refused') : t('ind.imp.result.done', { code: applied.mappingCode, version: applied.mappingVersion })}</p>
      <dl className="ind-counts" data-testid="result-counts">
        <div>
          <dt>{t('ind.imp.count.total')}</dt>
          <dd>{num(applied.counts.total)}</dd>
        </div>
        <div>
          <dt>{t('ind.imp.result.applied')}</dt>
          <dd>{num(applied.counts.applied)}</dd>
        </div>
        <div>
          <dt>{t('ind.imp.count.errors')}</dt>
          <dd>{num(applied.counts.quarantined)}</dd>
        </div>
        <div>
          <dt>{t('ind.imp.count.duplicate')}</dt>
          <dd>{num(applied.counts.duplicate)}</dd>
        </div>
        <div>
          <dt>{t('ind.imp.count.conflict')}</dt>
          <dd>{num(applied.counts.conflict)}</dd>
        </div>
        <div>
          <dt>{t('ind.imp.result.written')}</dt>
          <dd>{num(applied.figuresWritten)}</dd>
        </div>
        <div>
          <dt>{t('ind.imp.result.unchanged')}</dt>
          <dd>{num(applied.figuresUnchanged)}</dd>
        </div>
        <div>
          <dt>{t('ind.imp.result.differing')}</dt>
          <dd>{num(applied.figuresDiffering)}</dd>
        </div>
      </dl>
      {applied.figuresDiffering > 0 || applied.counts.differencesOpened > 0 ? (
        <p className="callout warning" role="status" data-testid="result-differences">
          {t('ind.imp.result.differences', { n: applied.counts.differencesOpened })}
        </p>
      ) : null}
      {applied.errors.length === 0 ? null : <RowErrorsTable errors={applied.errors} caption={t('ind.imp.result.caption')} truncated={applied.errorsTruncated} testId="result-errors" />}
    </div>
  );
}

/**
 * The flow of one file (IND-03, part A): choose and upload the file (the approved mappings that read it are told, never chosen for the person), optionally name the project and the period the form does not carry,
 * run the dry run, read it row by row, and apply it once. The dry run needs the right to preview and a session that is not read-only; the apply needs the right to import, a dry run of this very file and mapping, a
 * file with a valid row that was not loaded before.
 */
export function ImportFlow() {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const upload = useUploadFile();
  const dry = usePreviewImport();
  const apply = useApplyImport();
  const ids = useId();
  const reasonId = useId();
  const [file, setFile] = useState<File | undefined>(undefined);
  const [uploaded, setUploaded] = useState<UploadedFile | undefined>(undefined);
  const [mapping, setMapping] = useState('');
  const [projectCode, setProjectCode] = useState('');
  const [periodCode, setPeriodCode] = useState('');
  const [preview, setPreview] = useState<Preview | undefined>(undefined);
  const [applied, setApplied] = useState<Applied | undefined>(undefined);
  const [refused, setRefused] = useState<Applied | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);

  const readOnly = mode === 'READ_ONLY';
  const mayPreview = !readOnly && holds(permissions, 'ind.import.preview');
  const mayApply = !readOnly && holds(permissions, 'ind.import');
  const busy = upload.isPending || dry.isPending || apply.isPending;
  const chosen = mapping !== '' && uploaded?.fittingMappings.includes(mapping) === true ? mapping : '';

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
    setMapping('');
    clearResults();
    upload.reset();
    if (next !== undefined && tooLarge(next)) setProblem(problemOf('tooLarge'));
  };
  const input = uploaded === undefined || chosen === '' ? undefined : { mappingCode: chosen, fileObjectKey: uploaded.fileObjectKey, fileSha256: uploaded.fileSha256, projectCode, periodCode };

  const send = (): void => {
    if (file === undefined || busy || tooLarge(file)) return;
    setProblem(undefined);
    upload.mutate(file, {
      onSuccess: (result) => {
        if (result === undefined) setProblem(problemOf('general'));
        else {
          setUploaded(result);
          // One mapping that fits is the obvious choice; several are left to the person.
          if (result.fittingMappings.length === 1) setMapping(result.fittingMappings[0] ?? '');
        }
      },
      onError: (error) => setProblem(describeProblem(error)),
    });
  };
  const run = (): void => {
    if (input === undefined || busy) return;
    clearResults();
    dry.mutate(input, {
      onSuccess: (result) => (result === undefined ? setProblem(problemOf('general')) : setPreview(result)),
      onError: (error) => setProblem(describeProblem(error)),
    });
  };
  const confirm = (): void => {
    if (input === undefined || busy) return;
    setProblem(undefined);
    apply.mutate(input, {
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
        // A file that was loaded before closes the apply for this file at once.
        if (failure.kind === 'alreadyApplied') setPreview((current) => (current === undefined ? current : { ...current, alreadyApplied: true }));
      },
    });
  };

  const block = applyGate({
    preview,
    previewIsCurrent: preview !== undefined && uploaded !== undefined && preview.mappingCode === chosen && preview.fileSha256 === uploaded.fileSha256,
    canApply: mayApply,
    applied: applied !== undefined,
    working: apply.isPending,
  });
  const outcome = applied ?? refused;

  return (
    <>
      <SectionCard title={t('ind.imp.flow.title')}>
        {readOnly ? (
          <p className="callout" role="status" data-testid="import-readonly">
            {t('ind.imp.state.readOnly')}
          </p>
        ) : !mayPreview ? (
          <p className="callout" role="status" data-testid="import-noauthority">
            {t('ind.imp.state.noPreview')}
          </p>
        ) : (
          <div className="ind-form">
            <p className="sub">{t('ind.imp.flow.note')}</p>
            <div className="field">
              <label htmlFor={`${ids}-file`}>{t('ind.imp.flow.file.label')}</label>
              <input id={`${ids}-file`} type="file" accept={IMPORT_ACCEPT} disabled={busy} onChange={(event) => chooseFile(event.target.files?.[0])} />
            </div>
            {uploaded === undefined ? null : (
              <p data-testid="import-file">
                {t('ind.imp.file.summary', { format: uploaded.format, rows: uploaded.rowCount.toLocaleString(locale), size: sizeText(uploaded.sizeBytes, locale).value, unit: sizeText(uploaded.sizeBytes, locale).unit, hash: shortHash(uploaded.fileSha256) })}
              </p>
            )}
            {uploaded === undefined ? null : uploaded.fittingMappings.length === 0 ? (
              <p className="callout warning" role="status" data-testid="no-fitting-mapping">
                {t('ind.imp.flow.noFitting')}
              </p>
            ) : (
              <div className="field">
                <label htmlFor={`${ids}-mapping`}>{t('ind.imp.flow.mapping.label')}</label>
                <select
                  id={`${ids}-mapping`}
                  value={chosen}
                  disabled={busy}
                  onChange={(event) => {
                    setMapping(event.target.value);
                    clearResults();
                  }}
                >
                  <option value="">{t('ind.imp.flow.mapping.choose')}</option>
                  {uploaded.fittingMappings.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {uploaded === undefined ? null : (
              <>
                <div className="field">
                  <label htmlFor={`${ids}-project`}>{t('ind.imp.flow.project.label')}</label>
                  <input id={`${ids}-project`} type="text" value={projectCode} disabled={busy} onChange={(event) => { setProjectCode(event.target.value); clearResults(); }} />
                  <small className="sub">{t('ind.imp.flow.project.hint')}</small>
                </div>
                <div className="field">
                  <label htmlFor={`${ids}-period`}>{t('ind.imp.flow.period.label')}</label>
                  <input id={`${ids}-period`} type="text" value={periodCode} disabled={busy} onChange={(event) => { setPeriodCode(event.target.value); clearResults(); }} />
                  <small className="sub">{t('ind.imp.flow.period.hint')}</small>
                </div>
              </>
            )}
            {problem === undefined ? null : <ProblemNote problem={problem} />}
            <div className="ind-actions">
              <button type="button" className="ui-button ui-button--outline" disabled={file === undefined || uploaded !== undefined || busy || tooLarge(file)} onClick={send}>
                {upload.isPending ? t('ind.imp.flow.upload.pending') : t('ind.imp.flow.upload.action')}
              </button>
              <button type="button" className="ui-button ui-button--primary" disabled={input === undefined || busy} onClick={run}>
                {dry.isPending ? t('ind.imp.flow.preview.pending') : t('ind.imp.flow.preview.action')}
              </button>
              <button type="button" className="ui-button ui-button--primary" disabled={block !== null} aria-describedby={block === null ? undefined : reasonId} onClick={() => setConfirming(true)}>
                {apply.isPending ? t('ind.imp.flow.apply.pending') : t('ind.imp.flow.apply.action')}
              </button>
            </div>
            <small className="sub">{t('ind.imp.flow.preview.hint')}</small>
            {block === null ? null : (
              <small className="sub" id={reasonId} data-testid="apply-reason" data-reason={block}>
                {applyBlockLabel(t, block)}
              </small>
            )}
          </div>
        )}
      </SectionCard>
      {preview === undefined ? null : (
        <SectionCard title={t('ind.imp.preview.title')}>
          <ImportPreview preview={preview} />
        </SectionCard>
      )}
      {outcome === undefined ? null : (
        <SectionCard title={t('ind.imp.result.title')}>
          <ImportResult applied={outcome} />
        </SectionCard>
      )}
      {uploaded === undefined || preview === undefined || input === undefined ? null : (
        <ConfirmDialog
          open={confirming}
          title={t('ind.imp.confirm.title')}
          context={[
            { label: t('ind.imp.field.mapping'), value: t('ind.imp.preview.mapping', { code: preview.mappingCode, version: preview.mappingVersion }) },
            { label: t('ind.imp.field.hash'), value: shortHash(uploaded.fileSha256) },
            { label: t('ind.imp.field.valid'), value: preview.counts.valid.toLocaleString(locale) },
          ]}
          confirmLabel={t('ind.imp.confirm.action')}
          cancelLabel={t('ind.imp.confirm.cancel')}
          pending={apply.isPending}
          onConfirm={confirm}
          onCancel={() => setConfirming(false)}
        >
          <p data-testid="confirm-irreversible">{t('ind.imp.confirm.irreversible')}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
