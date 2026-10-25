import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { errorIdOf, wireControl } from '../../field-wiring';
import type { TrackedPackage } from '../procurement/model';
import { useContractorOptions, useReceiveProposal, useUploadProposalFile } from './hooks';
import { intakeProblemMessage, partLabel, problemMessage } from './labels';
import { EMPTY_INTAKE, FILE_ACCEPT, MAX_FILES, PROPOSAL_PARTS, describeProblem, hasProblems, receiveBody, sizeText, validateIntake } from './model';
import type { IntakeFile, IntakeForm, Problem, ProposalPart } from './model';
import '../bid.css';

/** The multiplication sign on the close button of a dialog. */
const CLOSE_GLYPH = '×';

export interface IntakeDialogProps {
  pack: TrackedPackage;
  onClose(): void;
}

/** A name for a file from the name of the file chosen: without its extension. */
const titleOfFile = (name: string): string => name.replace(/\.pdf$/i, '').trim();

/**
 * The receipt of a proposal (BID-05): the contractor, the time they handed it in, the price and the files of the bid, each file put through the upload door first (judged by
 * its bytes, scanned, its pages counted) and named here by the key the door answered. The server keeps the proposal sealed until the opening of the bids.
 */
export function IntakeDialog({ pack, onClose }: IntakeDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const contractors = useContractorOptions(true);
  const upload = useUploadProposalFile();
  const receive = useReceiveProposal();
  const [form, setForm] = useState<IntakeForm>(EMPTY_INTAKE);
  const [uploading, setUploading] = useState<ReadonlySet<number>>(new Set());
  const [failed, setFailed] = useState<Readonly<Record<number, Problem>>>({});
  const [submitted, setSubmitted] = useState(false);
  const nextUid = useRef(1);
  const problems = validateIntake(form, new Date());
  const show = (problem: Parameters<typeof intakeProblemMessage>[1] | undefined): string | undefined => (submitted && problem !== undefined ? intakeProblemMessage(t, problem) : undefined);

  const update = (uid: number, change: Partial<IntakeFile>): void => setForm((current) => ({ ...current, files: current.files.map((file) => (file.uid === uid ? { ...file, ...change } : file)) }));
  const addFile = (): void => {
    const uid = nextUid.current;
    nextUid.current += 1;
    setForm((current) => ({ ...current, files: [...current.files, { uid, part: 'TECHNICAL', title: '', fileName: '', uploaded: undefined }] }));
  };
  const removeFile = (uid: number): void => setForm((current) => ({ ...current, files: current.files.filter((file) => file.uid !== uid) }));
  const pick = async (uid: number, file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setFailed((current) => Object.fromEntries(Object.entries(current).filter(([key]) => Number(key) !== uid)));
    setForm((current) => ({ ...current, files: current.files.map((row) => (row.uid === uid ? { ...row, fileName: file.name, uploaded: undefined, title: row.title.trim() === '' ? titleOfFile(file.name) : row.title } : row)) }));
    setUploading((current) => new Set(current).add(uid));
    try {
      const stored = await upload.mutateAsync(file);
      if (stored !== undefined) update(uid, { uploaded: stored });
    } catch (error) {
      setFailed((current) => ({ ...current, [uid]: describeProblem(error) }));
    } finally {
      setUploading((current) => {
        const next = new Set(current);
        next.delete(uid);
        return next;
      });
    }
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (receive.isPending || uploading.size > 0 || hasProblems(problems)) return;
    receive.mutate(receiveBody(pack.id, form), { onSuccess: onClose });
  };

  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('bid.proposals.intake.title', { code: pack.code })}</strong>
          <button type="button" className="icon-button" aria-label={t('bid.proposals.intake.close')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="bid-dialog-body">
          <form onSubmit={submit} noValidate>
            {receive.isError ? (
              <p className="callout warning" role="alert" data-testid="refusal">
                {problemMessage(t, describeProblem(receive.error))}
              </p>
            ) : null}
            <div className="formgrid">
              <div className="field" data-field="intake-contractor">
                <label htmlFor="intake-contractor">{t('bid.proposals.field.contractor')}</label>
                {wireControl(
                  <select id="intake-contractor" value={form.contractorId} onChange={(event) => setForm({ ...form, contractorId: event.target.value })}>
                    <option value="">{t('bid.proposals.field.contractor.choose')}</option>
                    {(contractors.data ?? []).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.restricted ? t('bid.proposals.field.contractor.restricted', { name: option.legalName }) : option.legalName}
                      </option>
                    ))}
                  </select>,
                  'intake-contractor',
                  { hint: false, error: show(problems.contractorId) !== undefined },
                )}
                {show(problems.contractorId) === undefined ? null : (
                  <small role="alert" className="field-error" id={errorIdOf('intake-contractor')}>
                    {show(problems.contractorId)}
                  </small>
                )}
              </div>
              <div className="field" data-field="intake-submitted">
                <label htmlFor="intake-submitted">{t('bid.proposals.field.submittedAt')}</label>
                {wireControl(
                  <input id="intake-submitted" type="datetime-local" value={form.submittedAt} onChange={(event) => setForm({ ...form, submittedAt: event.target.value })} />,
                  'intake-submitted',
                  { hint: false, error: show(problems.submittedAt) !== undefined },
                )}
                {show(problems.submittedAt) === undefined ? null : (
                  <small role="alert" className="field-error" id={errorIdOf('intake-submitted')}>
                    {show(problems.submittedAt)}
                  </small>
                )}
              </div>
              <div className="field" data-field="intake-price">
                <label htmlFor="intake-price">{t('bid.proposals.field.price')}</label>
                {wireControl(
                  <input id="intake-price" inputMode="numeric" autoComplete="off" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} />,
                  'intake-price',
                  { hint: false, error: show(problems.price) !== undefined },
                )}
                <small className="sub">{t('bid.proposals.field.price.hint')}</small>
                {show(problems.price) === undefined ? null : (
                  <small role="alert" className="field-error" id={errorIdOf('intake-price')}>
                    {show(problems.price)}
                  </small>
                )}
              </div>
            </div>
            <fieldset className="bid-files" data-testid="intake-files">
              <legend>{t('bid.proposals.files.title')}</legend>
              {form.files.map((file, index) => {
                const rowProblem = show(problems.rows[file.uid]);
                const failure = failed[file.uid];
                return (
                  <div className="bid-file-row" key={file.uid} data-file-uid={file.uid}>
                    <div className="field">
                      <label htmlFor={`intake-part-${file.uid}`}>{t('bid.proposals.file.part', { n: index + 1 })}</label>
                      <select id={`intake-part-${file.uid}`} value={file.part} onChange={(event) => update(file.uid, { part: event.target.value as ProposalPart })}>
                        {PROPOSAL_PARTS.map((part) => (
                          <option key={part} value={part}>
                            {partLabel(t, part)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor={`intake-title-${file.uid}`}>{t('bid.proposals.file.title', { n: index + 1 })}</label>
                      <input id={`intake-title-${file.uid}`} value={file.title} onChange={(event) => update(file.uid, { title: event.target.value })} />
                    </div>
                    <div className="field">
                      <label htmlFor={`intake-file-${file.uid}`}>{t('bid.proposals.file.pick', { n: index + 1 })}</label>
                      <input id={`intake-file-${file.uid}`} type="file" accept={FILE_ACCEPT} onChange={(event) => void pick(file.uid, event.target.files?.[0])} />
                    </div>
                    <div className="bid-file-state">
                      {uploading.has(file.uid) ? (
                        <span role="status" data-testid="file-uploading">
                          {t('bid.proposals.file.uploading')}
                        </span>
                      ) : file.uploaded === undefined ? null : (
                        <span data-testid="file-uploaded">{t('bid.proposals.file.uploaded', { pages: file.uploaded.pageCount, size: sizeText(file.uploaded.sizeBytes) })}</span>
                      )}
                      {failure === undefined ? null : (
                        <small role="alert" className="field-error" data-testid="file-failed">
                          {problemMessage(t, failure)}
                        </small>
                      )}
                      {rowProblem === undefined ? null : (
                        <small role="alert" className="field-error">
                          {rowProblem}
                        </small>
                      )}
                      <button type="button" className="button" aria-label={t('bid.proposals.file.remove.aria', { n: index + 1 })} onClick={() => removeFile(file.uid)}>
                        {t('bid.proposals.file.remove')}
                      </button>
                    </div>
                  </div>
                );
              })}
              {show(problems.files) === undefined ? null : (
                <small role="alert" className="field-error">
                  {show(problems.files)}
                </small>
              )}
              <button type="button" className="button" disabled={form.files.length >= MAX_FILES} onClick={addFile}>
                {t('bid.proposals.files.add')}
              </button>
            </fieldset>
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('bid.proposals.intake.cancel')}
              </button>
              <button type="submit" className="primary" disabled={receive.isPending || uploading.size > 0}>
                {receive.isPending ? t('bid.proposals.intake.pending') : t('bid.proposals.intake.submit')}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}
