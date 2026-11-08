import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { StatusPill } from '../../ui';
import type { Tone } from '../../ui';
import { statusWord, vietnamDateTime } from './model';
import type { Delivery, Draft, FileInfo, Issue, Preview, Refusal } from './model';
import { refusalOf } from './model';

/** The one sentence a refused command is answered with: each refusal the report engine can give has its own words, and the rest say the command could not be done. */
export function refusalText(t: Translator['t'], error: unknown): string {
  const refusal: Refusal = refusalOf(error);
  switch (refusal.code) {
    case 'REPORT_OUT_OF_DATE':
      return refusal.currentRevision === undefined ? t('rpt.common.error.outOfDate.plain') : t('rpt.common.error.outOfDate.text', { revision: refusal.currentRevision });
    case 'ALREADY_DELIVERED':
      return t('rpt.common.error.alreadyDelivered.text');
    case 'TEMPLATE_UNCONFIRMED':
      return refusal.detail === 'demo_not_acceptable' ? t('rpt.common.error.demoNotAcceptable.text') : t('rpt.common.error.demoOff.text');
    case 'SELF_APPROVAL_DENIED':
      return t('rpt.common.error.selfApproval.text');
    case 'REPORT_STATE_INVALID':
      return refusal.detail === 'not_delivered' ? t('rpt.common.error.notDelivered.text') : t('rpt.common.error.stateInvalid.text');
    case 'VERSION_CONFLICT':
      return t('rpt.common.error.versionConflict.text');
    case 'SCOPE_DENIED':
      return t('rpt.common.error.scope.text');
    case 'VALIDATION_FAILED':
      return refusal.detail === 'reason' ? t('rpt.common.error.reasonNeeded.text') : t('rpt.common.error.validation.text');
    default:
      return t('rpt.common.error.generic.text');
  }
}

/** Whether a refusal says that a reason is missing: the dialog then asks for one. */
export const needsReason = (error: unknown): boolean => {
  const refusal = refusalOf(error);
  return refusal.code === 'VALIDATION_FAILED' && refusal.detail === 'reason';
};

export const stateTone = (state: Draft['state']): Tone => (state === 'ISSUED' ? 'success' : state === 'APPROVED' ? 'info' : state === 'CHECKED' ? 'warning' : 'neutral');

/** The state of a draft as a pill: always a word, the colour is a second cue. */
export function StatePill({ state }: { state: Draft['state'] }) {
  const { t } = useTranslation();
  return <StatusPill tone={stateTone(state)}>{t(`rpt.common.state.${statusWord(state)}`)}</StatusPill>;
}

/** The mark of a demo form: the words the files carry, always visible, with the sentence that says a demo copy is never accepted (R18). */
export function DemoBadge({ mark }: { mark: string | null }) {
  const { t } = useTranslation();
  if (mark === null) return null;
  return (
    <span className="rpt-demo" data-testid="demo-mark">
      <StatusPill tone="danger">{mark}</StatusPill>
      <span className="rpt-demo__note">{t('rpt.common.demo.notAccepted')}</span>
    </span>
  );
}

/** The whole sha256, selectable, never cut: the reader compares it with the file. */
export function HashLine({ sha, testId }: { sha: string; testId?: string }) {
  return (
    <code className="rpt-hash" data-testid={testId} title={sha}>
      {sha}
    </code>
  );
}

export function Facts({ items }: { items: ReadonlyArray<{ label: string; value: React.ReactNode; testId?: string }> }) {
  return (
    <dl className="rpt-facts">
      {items.map((item) => (
        <div key={item.label} className="rpt-facts__item">
          <dt>{item.label}</dt>
          <dd data-testid={item.testId}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The three people of a copy, in the order of their work. */
export function Signatories({ draft }: { draft: Pick<Draft, 'prepared_by_name' | 'checked_by_name' | 'approved_by_name'> | Pick<Issue, 'prepared_by_name' | 'checked_by_name' | 'approved_by_name' | 'issued_by_name'> }) {
  const { t } = useTranslation();
  const dash = '–';
  return (
    <Facts
      items={[
        { label: t('rpt.common.people.preparer'), value: draft.prepared_by_name ?? dash, testId: 'person-preparer' },
        { label: t('rpt.common.people.checker'), value: draft.checked_by_name ?? dash, testId: 'person-checker' },
        { label: t('rpt.common.people.approver'), value: draft.approved_by_name ?? dash, testId: 'person-approver' },
        ...('issued_by_name' in draft ? [{ label: t('rpt.common.people.issuer'), value: draft.issued_by_name ?? dash, testId: 'person-issuer' }] : []),
      ]}
    />
  );
}

/** The cells the data could not fill, and why: a figure with no value is an empty cell and one of these lines, never a zero. */
export function GridIssues({ issues }: { issues: ReadonlyArray<{ ref: string; code: string; detail: string | null }> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (issues.length === 0) return <p className="callout" data-testid="issues-none">{t('rpt.common.issues.none')}</p>;
  const known = new Set(['NO_FIGURE', 'NO_DEFINITION', 'NO_DATA', 'NOT_CERTIFIED', 'OBSOLETE', 'STALE', 'PARTIAL_COVERAGE', 'UNVERIFIED_DEFINITION', 'NOT_A_NUMBER', 'DATASET_MISSING', 'META_MISSING', 'FIELD_MISSING']);
  return (
    <div data-testid="issues">
      <p className="callout warning" role="status">
        {t('rpt.common.issues.count', { count: issues.length })}{' '}
        <button type="button" className="ui-button ui-button--outline ui-button--small" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('rpt.common.issues.hide') : t('rpt.common.issues.show')}
        </button>
      </p>
      {open ? (
        <ul className="rpt-issues">
          {issues.map((issue, index) => (
            <li key={`${issue.ref}-${issue.code}-${index}`}>
              <code>{issue.ref}</code> {known.has(issue.code) ? t(`rpt.common.issue.${statusWord(issue.code)}`) : t('rpt.common.issue.other')}
              {issue.detail === null ? '' : ` (${issue.detail})`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The sheet as the file will show it: every row of the grid with its cells; a number is as the form writes it, a formula as written, an empty cell empty. */
export function PreviewTable({ preview }: { preview: Preview }) {
  const { t } = useTranslation();
  return (
    <div data-testid="preview">
      {preview.stamp === null ? null : (
        <p className="callout warning rpt-stamp" role="status" data-testid="preview-stamp">
          {preview.stamp}
        </p>
      )}
      <div className="rpt-sheet" tabIndex={0} role="region" aria-label={t('rpt.common.preview.region')}>
        <table className="rpt-sheet__table">
          <caption className="rpt-sr">{t('rpt.common.preview.caption')}</caption>
          <tbody>
            {preview.rows.map((row) => (
              <tr key={row.row} className={`rpt-sheet__row rpt-sheet__row--${row.kind.toLowerCase()}`} data-row={row.row}>
                <th scope="row">{row.row}</th>
                {Array.from({ length: preview.columns }, (_unused, index) => {
                  const cell = row.cells.find((one) => one.col === index + 1);
                  return (
                    <td key={index} className={cell?.kind === 'NUMBER' || cell?.kind === 'FORMULA' ? 'rpt-sheet__num' : undefined} data-cell={`${row.row}:${index + 1}`}>
                      {cell?.text ?? ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.truncated ? <p className="callout" role="status">{t('rpt.common.preview.truncated', { shown: preview.rows.length, total: preview.row_count })}</p> : null}
      {preview.narrative.length === 0 ? null : (
        <section className="rpt-narrative" aria-label={t('rpt.common.preview.narrative')} data-testid="preview-narrative">
          <h3>{t('rpt.common.preview.narrative')}</h3>
          {preview.narrative.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </section>
      )}
    </div>
  );
}

/** The files of a draft or a copy: the name when it has one, the format, the size, the whole hash, and a button that downloads it. */
export function FileList({ files, onDownload, busy }: { files: readonly FileInfo[]; onDownload: (format: FileInfo['format']) => void; busy: string | null }) {
  const { t } = useTranslation();
  return (
    <ul className="rpt-files" data-testid="files">
      {files.map((file) => (
        <li key={file.format} data-format={file.format}>
          <span className="rpt-files__name">{file.name ?? t(`rpt.common.file.${file.format.toLowerCase()}`)}</span>
          <span className="rpt-files__size">{t('rpt.common.file.size', { kilobytes: Math.max(1, Math.round(file.size_bytes / 1024)) })}</span>
          <HashLine sha={file.sha256} testId={`hash-${file.format.toLowerCase()}`} />
          <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={busy !== null} data-testid={`download-${file.format.toLowerCase()}`} onClick={() => onDownload(file.format)}>
            {t('rpt.common.file.download')}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One line of the delivery log: when, to whom, by which channel, what happened, and whether it counts as accepted. */
export function deliveryLine(t: Translator['t'], row: Delivery): string {
  return t('rpt.common.delivery.line', { time: vietnamDateTime(row.occurred_at), receiver: row.receiver, event: t(`rpt.common.event.${statusWord(row.event)}`), channel: t(`rpt.common.channel.${statusWord(row.channel)}`) });
}
