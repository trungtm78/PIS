import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { Field } from '../components';
import '../dis.css';
import type { Attachment } from './detail-parts';
import { ReportFacts } from './components';
import { useSaveDraft, useUploadReportFile } from './hooks';
import { cellLabel, findingMessage, reportProblemMessage } from './labels';
import { CELLS, canEdit, describeReport } from './model';
import type { ReportDetail } from './model';
import { formatVnd } from './money';
import { StepFrame } from './StepFrame';
import { NOTE_FIELDS, attachmentsBody, notesBody, notesFormOf, stepLink, stepOfFinding, validateNotes } from './step-model';
import type { NoteField, NotesForm } from './step-model';

/**
 * DIS-06: the review of the draft before it is sent (ST-DIS-004, DIS 3 F1 step 7, BR-DIS-07): every error that would stop the sending and every warning that would not, all at once and each with the
 * step where it is put right; the change of each cell since the period before; the notes of the report; and the files attached to it. A file is scanned by the upload door before it can be attached,
 * and only a clean file is ever shown here. The sending itself is a later story.
 */
export default function ReviewScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenantId = useSession().tenant?.id;
  return (
    <StepFrame
      key={tenantId ?? 'none'}
      route={route}
      current="review"
      texts={{
        back: t('dis.review.back.link'),
        title: t('dis.review.page.title'),
        subtitle: t('dis.review.page.subtitle'),
        choose: t('dis.review.choose.text'),
        footer: t('dis.review.footer.reference', { id: route.id, req: route.req ?? '' }),
      }}
    >
      {(detail) => <Review key={detail.id} detail={detail} />}
    </StepFrame>
  );
}

function Review({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const editable = canEdit(permissions, mode, detail.status);
  const review = detail.review;
  const reportId = detail.id;
  const fixLink = (finding: { code: string; field: string; values: Record<string, string | null> }) => {
    const path = stepOfFinding(finding);
    return path === undefined ? null : (
      <Link to={stepLink(path, reportId)} className="dis-fix-link">
        {t('dis.review.fix.link')}
      </Link>
    );
  };

  return (
    <div className="card">
      <ReportFacts detail={detail} />
      {review === null ? (
        <p className="callout" role="status" data-testid="review-status">
          {t('dis.review.status.sent')}
        </p>
      ) : (
        <>
          <p className={review.blocking ? 'callout warning' : 'callout'} role="status" data-testid="review-status">
            {review.blocking ? t('dis.review.status.blocking') : t('dis.review.status.ready')}
          </p>
          <h2>{t('dis.review.errors.title')}</h2>
          {review.errors.length === 0 ? (
            <p className="muted" data-testid="review-errors-none">
              {t('dis.review.none.text')}
            </p>
          ) : (
            <ul className="dis-findings" data-testid="review-errors">
              {review.errors.map((finding) => (
                <li key={`${finding.code}:${finding.field}`} data-code={finding.code}>
                  {findingMessage(t, finding)} {fixLink(finding)}
                </li>
              ))}
            </ul>
          )}
          <h2>{t('dis.review.warnings.title')}</h2>
          {review.warnings.length === 0 ? (
            <p className="muted" data-testid="review-warnings-none">
              {t('dis.review.none.text')}
            </p>
          ) : (
            <ul className="dis-findings" data-testid="review-warnings">
              {review.warnings.map((finding) => (
                <li key={`${finding.code}:${finding.field}`} data-code={finding.code}>
                  {findingMessage(t, finding)} {fixLink(finding)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <Differences detail={detail} />
      <Notes detail={detail} editable={editable} />
      <Files detail={detail} editable={editable} />
    </div>
  );
}

/** What each cell added since the period before; a fall is marked in words and in colour. */
function Differences({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const compared = detail.cells.some((cell) => cell.previousCumulativeVnd !== null);
  return (
    <section aria-labelledby="review-diff-title">
      <h2 id="review-diff-title">{t('dis.review.diff.title')}</h2>
      {compared ? (
        <div className="tablewrap">
          <table className="table dis-matrix" aria-label={t('dis.review.diff.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('dis.review.diff.col.source')}</th>
                <th scope="col" className="num">
                  {t('dis.review.diff.col.previous')}
                </th>
                <th scope="col" className="num">
                  {t('dis.review.diff.col.current')}
                </th>
                <th scope="col" className="num">
                  {t('dis.review.diff.col.change')}
                </th>
              </tr>
            </thead>
            <tbody>
              {CELLS.map((key) => {
                const cell = detail.cells.find((entry) => entry.bucket === key.bucket && entry.level === key.level);
                const fall = cell?.deltaVnd?.startsWith('-') === true;
                return (
                  <tr key={`${key.bucket}:${key.level}`}>
                    <th scope="row">{cellLabel(t, key)}</th>
                    <td className="num">{cell?.previousCumulativeVnd == null ? t('dis.reportEdit.none.text') : formatVnd(cell.previousCumulativeVnd)}</td>
                    <td className="num">{formatVnd(cell?.cumulativeVnd ?? '0')}</td>
                    <td className={fall ? 'num dis-fall' : 'num'} data-testid={`diff-${key.bucket}:${key.level}`}>
                      {cell?.deltaVnd == null ? t('dis.reportEdit.none.text') : formatVnd(cell.deltaVnd)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted" data-testid="diff-none">
          {t('dis.review.diff.none.text')}
        </p>
      )}
    </section>
  );
}

function Notes({ detail, editable }: { detail: ReportDetail; editable: boolean }) {
  const { t } = useTranslation();
  const save = useSaveDraft();
  const [form, setForm] = useState<NotesForm>(() => notesFormOf(detail));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateNotes(form);
  const described = save.isError ? describeReport(save.error) : undefined;
  const label = (field: NoteField): string => {
    switch (field) {
      case 'results':
        return t('dis.review.notes.results.label');
      case 'causes':
        return t('dis.review.notes.causes.label');
      case 'solutions':
        return t('dis.review.notes.solutions.label');
      case 'proposals':
        return t('dis.review.notes.proposals.label');
    }
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (!editable || save.isPending || Object.keys(problems).length > 0) return;
    save.mutate({ detail, body: notesBody(detail, form) });
  };
  return (
    <form onSubmit={submit} noValidate aria-labelledby="review-notes-title">
      <h2 id="review-notes-title">{t('dis.review.notes.title')}</h2>
      <p className="sub">{t('dis.review.notes.help')}</p>
      {described === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="notes-refusal">
          {reportProblemMessage(t, described.problem)}
        </p>
      )}
      {NOTE_FIELDS.map((field) => (
        <Field key={field} id={`note-${field}`} label={label(field)} error={submitted && problems[field] !== undefined ? t('dis.review.notes.tooLong.error') : undefined}>
          <textarea id={`note-${field}`} rows={3} value={form[field]} disabled={!editable} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, [field]: event.target.value })} />
        </Field>
      ))}
      {editable ? (
        <div className="formfooter">
          <button type="submit" disabled={save.isPending}>
            {save.isPending ? t('dis.review.notes.save.pending') : t('dis.review.notes.save.action')}
          </button>
        </div>
      ) : null}
    </form>
  );
}

const sizeInKb = (bytes: number): number => Math.max(1, Math.ceil(bytes / 1024));

function Files({ detail, editable }: { detail: ReportDetail; editable: boolean }) {
  const { t } = useTranslation();
  const upload = useUploadReportFile();
  const save = useSaveDraft();
  const [uploading, setUploading] = useState<string | undefined>(undefined);
  const failure = upload.isError ? upload.error : save.isError ? save.error : undefined;
  const described = failure === undefined ? undefined : describeReport(failure);
  const busy = uploading !== undefined || save.isPending;

  const attach = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.target;
    const file = input.files?.[0];
    input.value = '';
    if (file === undefined || !editable || busy) return;
    setUploading(file.name);
    try {
      const stored = await upload.mutateAsync(file);
      if (stored !== undefined) await save.mutateAsync({ detail, body: attachmentsBody(detail, [...detail.attachments, stored]) });
    } catch {
      // The refusal is shown from the state of the two commands.
    } finally {
      setUploading(undefined);
    }
  };
  const remove = (file: Attachment): void => {
    if (!editable || busy) return;
    save.mutate({ detail, body: attachmentsBody(detail, detail.attachments.filter((entry) => entry.fileObjectId !== file.fileObjectId)) });
  };

  return (
    <section aria-labelledby="review-files-title">
      <h2 id="review-files-title">{t('dis.review.files.title')}</h2>
      <p className="sub">{t('dis.review.files.help')}</p>
      {described === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="files-refusal">
          {reportProblemMessage(t, described.problem)}
        </p>
      )}
      {editable ? (
        <div className="field">
          <label htmlFor="report-file">{t('dis.review.files.pick.label')}</label>
          <input id="report-file" type="file" disabled={busy} onChange={(event) => void attach(event)} />
        </div>
      ) : null}
      {uploading === undefined ? null : (
        <p role="status" data-testid="files-uploading">
          {t('dis.review.files.uploading.text', { name: uploading })}
        </p>
      )}
      {detail.attachments.length === 0 ? (
        <p className="muted" data-testid="files-none">
          {t('dis.review.files.none.text')}
        </p>
      ) : (
        <ul className="dis-files" aria-label={t('dis.review.files.list.aria')}>
          {detail.attachments.map((file) => (
            <li key={file.fileObjectId} data-file={file.fileObjectId}>
              <span>{file.fileName}</span> <span className="sub">{t('dis.review.files.size.text', { size: sizeInKb(file.sizeBytes) })}</span> <span className="pill gray">{t('dis.review.files.clean.status')}</span>{' '}
              {editable ? (
                <button type="button" disabled={busy} onClick={() => remove(file)}>
                  {t('dis.review.files.remove.action', { name: file.fileName })}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
