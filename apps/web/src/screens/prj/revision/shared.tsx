import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { useProjects } from '../hooks';
import { amountText } from '../model';
import type { DocumentView, Status } from './model';

type T = Translator['t'];
export const NONE = '—';

/** The project of the address (`?id=`) and the way to choose another. */
export function useProjectParam(): { projectId: string | undefined; choose(id: string): void } {
  const [params, setParams] = useSearchParams();
  return { projectId: params.get('id') ?? undefined, choose: (id) => setParams(id === '' ? {} : { id }) };
}

/** The select that names the project whose revisions are read; the choice goes to the address. */
export function ProjectChooser({ id, projectId, choose }: { id: string; projectId: string | undefined; choose(id: string): void }) {
  const { t } = useTranslation();
  const projects = useProjects();
  return (
    <div className="prj-filters">
      <label htmlFor={id}>{t('prj.revision.filter.project.label')}</label>
      <select id={id} value={projectId ?? ''} onChange={(event) => choose(event.target.value)}>
        <option value="">{NONE}</option>
        {(projects.data ?? []).map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.code} {candidate.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function statusLabel(t: T, status: Status): string {
  switch (status) {
    case 'DRAFT':
      return t('prj.revision.status.draft');
    case 'IN_REVIEW':
      return t('prj.revision.status.inReview');
    case 'APPROVED':
      return t('prj.revision.status.approved');
    case 'REJECTED':
      return t('prj.revision.status.rejected');
    case 'SUPERSEDED':
      return t('prj.revision.status.superseded');
  }
}

export const statusTone = (status: Status): 'green' | 'warn' | 'gray' | 'blue' => (status === 'APPROVED' ? 'green' : status === 'IN_REVIEW' ? 'warn' : status === 'DRAFT' ? 'blue' : 'gray');

/** The money of the project as the workspace shows it. */
export function useMoney(): (amount: string) => string {
  const { t, locale } = useTranslation();
  return (amount) => t('prj.workspace.value.amount', { amount: amountText(amount, locale) });
}

/** How a decision document is named on paper: its symbol when it has one, else its title, and the day it was issued. */
export function documentText(t: T, document: DocumentView): string {
  const name = document.symbol ?? document.title;
  return document.issuedOn === null ? name : t('prj.revision.document.issued', { name, date: document.issuedOn });
}
