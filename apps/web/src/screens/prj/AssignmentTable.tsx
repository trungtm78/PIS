import { useTranslation } from '../../i18n';
import { assignmentStatusLabel, roleLabel } from './accountability-labels';
import { canEndAssignment } from './accountability-model';
import type { AssignmentLine } from './accountability-model';
import './prj.css';

export interface AssignmentTableProps {
  lines: readonly AssignmentLine[];
  /** The caller may administer assignments and the session is not read-only. */
  canEnd: boolean;
  onEnd(line: AssignmentLine): void;
}

/**
 * The register of assignments of PRJ-17: who answers for each project, in which role, on what document and for which period, with the ended ones kept
 * as history. A state is told in words, never by colour alone.
 */
export function AssignmentTable({ lines, canEnd, onEnd }: AssignmentTableProps) {
  const { t } = useTranslation();
  if (lines.length === 0) {
    return (
      <p role="status" data-testid="assignments-empty">
        {t('prj.accountability.table.empty.notice')}
      </p>
    );
  }
  return (
    <table className="table" aria-label={t('prj.accountability.table.aria')} data-testid="assignments">
      <thead>
        <tr>
          <th scope="col">{t('prj.accountability.column.project')}</th>
          <th scope="col">{t('prj.accountability.column.leader')}</th>
          <th scope="col">{t('prj.accountability.column.role')}</th>
          <th scope="col">{t('prj.accountability.column.document')}</th>
          <th scope="col">{t('prj.accountability.column.validity')}</th>
          <th scope="col">{t('prj.accountability.column.status')}</th>
          <th scope="col">{t('prj.accountability.column.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.id} data-assignment-id={line.id} data-status={line.status} data-role={line.role}>
            <th scope="row">
              {line.projectCode}
              <small className="sub"> {line.projectName}</small>
            </th>
            <td>{line.leaderName ?? t('prj.accountability.leader.unknown')}</td>
            <td>{roleLabel(t, line.role)}</td>
            <td>{line.documentId ?? t('prj.accountability.document.none')}</td>
            <td>
              {line.validFrom} → {line.validUntil ?? t('prj.accountability.validity.open')}
              {line.endReason === null ? null : <small className="sub"> {t('prj.accountability.end.reason.text', { reason: line.endReason })}</small>}
            </td>
            <td>{assignmentStatusLabel(t, line.status)}</td>
            <td>
              {canEndAssignment(line, canEnd) ? (
                <button type="button" onClick={() => onEnd(line)}>
                  {t('prj.accountability.end.action', { project: line.projectCode })}
                </button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
