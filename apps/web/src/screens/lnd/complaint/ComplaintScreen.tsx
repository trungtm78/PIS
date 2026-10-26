import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useHouseholds } from '../household/hooks';
import { todayInVietnam } from '../model';
import { usePlans } from '../plan/hooks';
import { useProjectOptions } from '../read-hooks';
import { FileDialog, ResolveDialog } from './dialogs';
import { useComplaints } from './hooks';
import { complaintChannelLabel, complaintStatusLabel, complaintSubjectLabel } from './labels';
import { COMPLAINT_STATUSES, canFile, canResolve, complaintsOf, isAnswerable, isOverdue } from './model';
import type { ComplaintLine, ComplaintStatus } from './model';
import '../lnd.css';

type Dialog = { kind: 'file' } | { kind: 'resolve'; complaint: ComplaintLine };

/**
 * LND-08: the complaints of the households about the clearance of their land (ST-LND-008, UAT-AC384). Each complaint has its number, the household, what it says (read only inside the unit of the household), the day
 * it is to be answered by with the days left, its status and the issue that ISS opened for it, which holds the number and nothing the complainant said. A complaint is answered with a reply document, or escalated with a note.
 * The server counts the days and judges every request again.
 */
export default function ComplaintScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The complaints and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ComplaintContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ComplaintContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const today = todayInVietnam();
  const projects = useProjectOptions();
  const complaints = useComplaints(projectId);
  const mayFile = canFile(permissions, mode);
  const mayResolve = canResolve(permissions, mode);
  const households = useHouseholds(mayFile && projectId !== undefined ? projectId : undefined);
  const plans = usePlans(mayFile && projectId !== undefined ? projectId : undefined);
  const [status, setStatus] = useState<'' | ComplaintStatus>('');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const state = useScreenState({ isLoading: complaints.isLoading, error: complaints.error, data: complaints.data, isEmpty: () => false });
  const shown = useMemo(() => complaintsOf(complaints.data ?? [], status), [complaints.data, status]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('lnd.complaints.page.title')}</h1>
          <p>{t('lnd.complaints.page.subtitle')}</p>
        </div>
        {mayFile && projectId !== undefined ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'file' })}>
              {t('lnd.complaints.file.action')}
            </button>
          </div>
        ) : null}
      </div>
      <p className="callout" data-testid="privacy-note">
        {t('lnd.complaints.privacy.note')}
      </p>
      <div className="card">
        <div className="field">
          <label htmlFor="complaint-project">{t('lnd.complaints.project.label')}</label>
          <select
            id="complaint-project"
            value={projectId ?? ''}
            onChange={(event) => {
              setStatus('');
              setParams(event.target.value === '' ? {} : { project: event.target.value });
            }}
          >
            <option value="">{t('lnd.complaints.project.choose')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {`${project.code} · ${project.name}`}
              </option>
            ))}
          </select>
        </div>
      </div>
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="choose-project">
          {t('lnd.complaints.project.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void complaints.refetch()}>
          <div className="card">
            <form className="lnd-filters" role="search" aria-label={t('lnd.complaints.filters.title')} onSubmit={(event) => event.preventDefault()}>
              <div className="field">
                <label htmlFor="complaint-status">{t('lnd.complaints.status.label')}</label>
                <select id="complaint-status" value={status} onChange={(event) => setStatus(event.target.value as '' | ComplaintStatus)}>
                  <option value="">{t('lnd.complaints.status.all')}</option>
                  {COMPLAINT_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {complaintStatusLabel(t, value)}
                    </option>
                  ))}
                </select>
              </div>
            </form>
            {shown.length === 0 ? (
              <p className="callout" role="status" data-testid="no-match">
                {(complaints.data ?? []).length === 0 ? t('lnd.complaints.empty.notice') : t('lnd.complaints.noMatch.notice')}
              </p>
            ) : (
              <table className="table" data-testid="complaints">
                <thead>
                  <tr>
                    <th scope="col">{t('lnd.complaints.column.number')}</th>
                    <th scope="col">{t('lnd.complaints.column.household')}</th>
                    <th scope="col">{t('lnd.complaints.column.subject')}</th>
                    <th scope="col">{t('lnd.complaints.column.description')}</th>
                    <th scope="col">{t('lnd.complaints.column.due')}</th>
                    <th scope="col">{t('lnd.complaints.column.status')}</th>
                    <th scope="col">{t('lnd.complaints.column.issue')}</th>
                    <th scope="col">{t('lnd.complaints.column.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((complaint) => (
                    <ComplaintRow key={complaint.id} complaint={complaint} canAnswer={mayResolve && isAnswerable(complaint)} onResolve={() => setDialog({ kind: 'resolve', complaint })} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </StateBoundary>
      )}
      {dialog?.kind === 'file' && projectId !== undefined ? <FileDialog projectId={projectId} households={households.data ?? []} plans={plans.data ?? []} today={today} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'resolve' ? <ResolveDialog complaint={dialog.complaint} today={today} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('lnd.complaints.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function ComplaintRow({ complaint, canAnswer, onResolve }: { complaint: ComplaintLine; canAnswer: boolean; onResolve(): void }) {
  const { t } = useTranslation();
  const none = t('lnd.complaints.value.none');
  return (
    <tr data-complaint-id={complaint.id}>
      <th scope="row" data-testid="number">
        {complaint.complaintNo}
        <br />
        <small className="sub">{complaintChannelLabel(t, complaint.channel)}</small>
      </th>
      <td data-testid="household">{complaint.householdCode}</td>
      <td data-testid="subject">{complaintSubjectLabel(t, complaint.subject)}</td>
      <td data-testid="description">
        {complaint.description}
        {complaint.resolutionNote === null ? null : (
          <>
            <br />
            <small className="sub" data-testid="resolution">
              {t('lnd.complaints.row.resolution', { date: complaint.resolvedOn ?? '', note: complaint.resolutionNote })}
            </small>
          </>
        )}
      </td>
      <td data-testid="due">
        {complaint.dueOn}
        {complaint.remainingDays === null ? null : (
          <>
            <br />
            <small className={isOverdue(complaint) ? 'sub lnd-late' : 'sub'} data-testid="left">
              {isOverdue(complaint) ? t('lnd.complaints.due.late', { days: -complaint.remainingDays }) : t('lnd.complaints.due.left', { days: complaint.remainingDays })}
            </small>
          </>
        )}
      </td>
      <td>
        <span className="lnd-badge" data-testid="status">
          {complaintStatusLabel(t, complaint.status)}
        </span>
      </td>
      <td data-testid="issue">{complaint.issueId ?? none}</td>
      <td>
        {canAnswer ? (
          <button type="button" className="button" aria-label={t('lnd.complaints.resolve.aria', { number: complaint.complaintNo })} onClick={onResolve}>
            {t('lnd.complaints.resolve.action')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}
