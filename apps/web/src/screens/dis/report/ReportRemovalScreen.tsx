import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { Field } from '../components';
import '../dis.css';
import { DETAIL_PATH, formatMoment } from './decision-model';
import { useDeleteDraft, useRestoreDraft, useWithdraw } from './hooks';
import { DELETION_REASON_MIN, WITHDRAWAL_REASON_MIN, canDelete, canRestore, canStillRestore, canWithdraw, describeRemoval, restoreDeadline, validateRemovalReason } from './lifecycle-model';
import type { ReasonProblem, RemovalProblem } from './lifecycle-model';
import { EDIT_PATH, REPORTS_PATH } from './model';
import type { ReportDetail } from './model';
import { StepFrame } from './StepFrame';

type T = Translator['t'];

function problemMessage(t: T, problem: RemovalProblem): string {
  switch (problem) {
    case 'stateChanged':
      return t('dis.reportRemoval.problem.stateChanged');
    case 'periodLocked':
      return t('dis.reportRemoval.problem.periodLocked');
    case 'windowExpired':
      return t('dis.reportRemoval.problem.windowExpired');
    case 'versionConflict':
      return t('dis.reportRemoval.problem.versionConflict');
    case 'scopeDenied':
      return t('dis.reportRemoval.problem.scopeDenied');
    case 'reasonInvalid':
      return t('dis.reportRemoval.problem.reasonInvalid');
    case 'notFound':
      return t('dis.reportRemoval.problem.notFound');
    case 'general':
      return t('dis.reportRemoval.problem.general');
  }
}

function reasonMessage(t: T, problem: ReasonProblem, min: number): string {
  switch (problem) {
    case 'required':
      return t('dis.reportRemoval.reason.required.error');
    case 'tooShort':
      return t('dis.reportRemoval.reason.tooShort.error', { min });
    case 'tooLong':
      return t('dis.reportRemoval.reason.tooLong.error');
  }
}

/**
 * DIS-09: the confirmation that names the report before anything is undone (ST-DIS-007, DIS 3 F3; it fixes the source defect SRC-06, a deletion that did not say what it deleted): the code of the
 * report, the period and the project, and the reason. A draft is deleted softly and can be restored for 30 days; a report that was handed in and is not being reviewed is taken back; a report that was
 * reviewed is never deleted.
 */
export default function ReportRemovalScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenantId = useSession().tenant?.id;
  return (
    <StepFrame
      key={tenantId ?? 'none'}
      route={route}
      texts={{
        back: t('dis.reportRemoval.back.link'),
        title: t('dis.reportRemoval.page.title'),
        subtitle: t('dis.reportRemoval.page.subtitle'),
        choose: t('dis.reportRemoval.choose.text'),
        footer: t('dis.reportRemoval.footer.reference', { id: route.id, req: route.req ?? '' }),
      }}
    >
      {(detail) => <Removal key={detail.id} detail={detail} />}
    </StepFrame>
  );
}

/** What the confirmation names: the report by its code, its period and its project, so that nobody confirms what they did not read. */
function Named({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  return (
    <dl className="aud-facts" data-testid="removal-facts">
      <dt>{t('dis.reportRemoval.code.label')}</dt>
      <dd data-testid="removal-code">{t('dis.reportRemoval.code.value', { project: detail.project.code, period: detail.period.code, revision: detail.revision })}</dd>
      <dt>{t('dis.reportEdit.period.label')}</dt>
      <dd data-testid="removal-period">{t('dis.reportEdit.period.value', { code: detail.period.code, start: detail.period.startDate, end: detail.period.endDate })}</dd>
      <dt>{t('dis.reportEdit.project.label')}</dt>
      <dd data-testid="removal-project">{`${detail.project.code} · ${detail.project.name}`}</dd>
    </dl>
  );
}

function Removal({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  if (canDelete(permissions, mode, detail)) return <Delete detail={detail} />;
  if (canRestore(permissions, mode, detail)) return <Restore detail={detail} />;
  if (canWithdraw(permissions, mode, detail.status)) return <Withdraw detail={detail} />;
  return (
    <div className="card">
      <Named detail={detail} />
      <p className="callout warning" role="status" data-testid="removal-not-allowed">
        {t('dis.reportRemoval.notAllowed.text')}
      </p>
      <p>
        <Link to={`${DETAIL_PATH}?report=${detail.id}`}>{t('dis.reportRemoval.detail.link')}</Link>
      </p>
    </div>
  );
}

/** The form of a reason with its confirmation: the same for a deletion and for a withdrawal. */
function ReasonForm({
  detail,
  min,
  title,
  help,
  action,
  pending,
  refusal,
  busy,
  onConfirm,
  cancel,
}: {
  detail: ReportDetail;
  min: number;
  title: string;
  help: string;
  action: string;
  pending: string;
  refusal: RemovalProblem | undefined;
  busy: boolean;
  onConfirm(reason: string): void;
  cancel: string;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problem = validateRemovalReason(reason, min);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (busy || problem !== undefined) return;
    onConfirm(reason);
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="removal-title" data-testid="removal-form">
      <h2 id="removal-title">{title}</h2>
      <Named detail={detail} />
      <p className="sub">{help}</p>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="removal-refusal">
          {problemMessage(t, refusal)}
        </p>
      )}
      <Field id="removal-reason" label={t('dis.reportRemoval.reason.label')} error={submitted && problem !== undefined ? reasonMessage(t, problem, min) : undefined}>
        <textarea id="removal-reason" rows={3} value={reason} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" disabled={busy}>
          {busy ? pending : action}
        </button>
        <Link to={`${DETAIL_PATH}?report=${detail.id}`}>{cancel}</Link>
      </div>
    </form>
  );
}

function Delete({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const remove = useDeleteDraft();
  return (
    <ReasonForm
      detail={detail}
      min={DELETION_REASON_MIN}
      title={t('dis.reportRemoval.delete.title')}
      help={t('dis.reportRemoval.delete.help', { days: 30 })}
      action={t('dis.reportRemoval.delete.action')}
      pending={t('dis.reportRemoval.delete.pending')}
      cancel={t('dis.reportRemoval.cancel.action')}
      refusal={remove.isError ? describeRemoval(remove.error) : undefined}
      busy={remove.isPending}
      onConfirm={(reason) => remove.mutate({ detail, reason }, { onSuccess: () => void navigate(REPORTS_PATH) })}
    />
  );
}

function Withdraw({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const withdraw = useWithdraw();
  return (
    <ReasonForm
      detail={detail}
      min={WITHDRAWAL_REASON_MIN}
      title={t('dis.reportRemoval.withdraw.title')}
      help={t('dis.reportRemoval.withdraw.help')}
      action={t('dis.reportRemoval.withdraw.action')}
      pending={t('dis.reportRemoval.withdraw.pending')}
      cancel={t('dis.reportRemoval.cancel.action')}
      refusal={withdraw.isError ? describeRemoval(withdraw.error) : undefined}
      busy={withdraw.isPending}
      onConfirm={(reason) => withdraw.mutate({ detail, reason }, { onSuccess: () => void navigate(`${DETAIL_PATH}?report=${detail.id}`) })}
    />
  );
}

function Restore({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const restore = useRestoreDraft();
  const deletedAt = detail.deletedAt;
  const open = deletedAt !== null && canStillRestore(deletedAt, new Date());
  return (
    <div className="card" data-testid="restore-panel">
      <h2>{t('dis.reportRemoval.restore.title')}</h2>
      <Named detail={detail} />
      <p data-testid="restore-reason">{t('dis.reportRemoval.restore.reason.text', { reason: detail.deletedReason ?? '' })}</p>
      {deletedAt === null ? null : (
        <p className={open ? 'sub' : 'callout warning'} data-testid="restore-window">
          {open ? t('dis.reportRemoval.restore.until.text', { at: formatMoment(restoreDeadline(deletedAt).toISOString()) }) : t('dis.reportRemoval.restore.expired.text')}
        </p>
      )}
      {restore.isError ? (
        <p className="callout warning" role="alert" data-testid="removal-refusal">
          {problemMessage(t, describeRemoval(restore.error))}
        </p>
      ) : null}
      <div className="formfooter">
        {open ? (
          <button type="button" disabled={restore.isPending} onClick={() => restore.mutate({ detail }, { onSuccess: () => void navigate(`${EDIT_PATH}?report=${detail.id}`) })}>
            {restore.isPending ? t('dis.reportRemoval.restore.pending') : t('dis.reportRemoval.restore.action')}
          </button>
        ) : null}
        <Link to={REPORTS_PATH}>{t('dis.reportRemoval.cancel.action')}</Link>
      </div>
    </div>
  );
}
