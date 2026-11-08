import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useDossiers } from '../archive/hooks';
import { problemMessage as archiveProblem } from '../archive/labels';
import { describeProblem as describeArchive } from '../archive/rules';
import { useFileLetter } from './hooks';
import type { IncomingLine } from './model';

const ORDINAL = /^\d+$/;

/** The permission that files a letter into a dossier (`fileIncomingDocument`); the server judges it again. */
export const FILE_PERMISSION = 'doc.dossier.manage';

/**
 * Files a resolved letter into an open dossier (RESOLVED to FILED). Only the dossiers that are open and that the caller may add to are offered; the position in the dossier is optional (the server appends). The letter keeps
 * the version it was read at, so a letter that moved meanwhile is refused (409) and read again.
 */
export function FileDialog({ line, onClose, onConflict }: { line: IncomingLine; onClose(): void; onConflict(): void }) {
  const { t } = useTranslation();
  const dossiers = useDossiers(true);
  const file = useFileLetter();
  const [opened] = useState(() => ({ id: line.id, version: line.version }));
  const [dossierId, setDossierId] = useState('');
  const [ordinal, setOrdinal] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const open = (dossiers.data ?? []).filter((dossier) => dossier.status === 'OPEN' && dossier.mayAddDocument);
  const dossierProblem = dossierId === '' ? t('doc.dossier.file.error.dossier') : undefined;
  const ordinalProblem = ordinal.trim() !== '' && (!ORDINAL.test(ordinal.trim()) || Number(ordinal) < 1) ? t('doc.dossier.file.error.ordinal') : undefined;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (file.isPending || dossierProblem !== undefined || ordinalProblem !== undefined) return;
    file.mutate(
      { id: opened.id, version: opened.version, body: { dossier_id: dossierId, ...(ordinal.trim() === '' ? {} : { ordinal: Number(ordinal) }) } },
      { onSuccess: onClose, onError: (error) => (describeArchive(error) === 'conflict' ? onConflict() : undefined) },
    );
  };
  const words = { close: t('doc.incoming.dialog.close'), cancel: t('doc.incoming.dialog.cancel'), pending: t('doc.incoming.dialog.pending') };
  return (
    <CommandFrame title={t('doc.dossier.file.title')} refusal={file.isError ? archiveProblem(t, describeArchive(file.error)) : undefined} pending={file.isPending} submitLabel={t('doc.dossier.file.submit')} words={words} onSubmit={send} onClose={onClose}>
      <fieldset className="incoming-fields" disabled={file.isPending}>
        {dossiers.isLoading ? (
          <p role="status" aria-busy="true">
            {t('doc.dossier.file.loading')}
          </p>
        ) : dossiers.isError ? (
          <p role="alert" data-testid="file-dossiers-error">
            {t('doc.dossier.file.failed')}{' '}
            <button type="button" onClick={() => void dossiers.refetch()}>
              {t('doc.dossier.retry')}
            </button>
          </p>
        ) : open.length === 0 ? (
          <p className="callout warning" role="status" data-testid="file-no-dossier">
            {t('doc.dossier.file.none')}
          </p>
        ) : (
          <>
            <Field id="file-dossier" label={t('doc.dossier.file.dossier')} error={submitted ? dossierProblem : undefined}>
              <select id="file-dossier" value={dossierId} onChange={(event) => setDossierId(event.target.value)}>
                <option value="">{t('doc.dossier.file.choose')}</option>
                {open.map((dossier) => (
                  <option key={dossier.id} value={dossier.id}>
                    {t('doc.archive.dossier.code', { code: dossier.dossierCode, year: dossier.year })} · {dossier.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="file-ordinal" label={t('doc.dossier.file.ordinal')} error={submitted ? ordinalProblem : undefined} hint={t('doc.dossier.file.ordinal.hint')}>
              <input id="file-ordinal" inputMode="numeric" value={ordinal} onChange={(event) => setOrdinal(event.target.value)} />
            </Field>
          </>
        )}
      </fieldset>
    </CommandFrame>
  );
}
