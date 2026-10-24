import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useOpenDossier } from './dossier-commands';
import { permitFieldMessage, permitProblemMessage } from './dossier-labels';
import { describePermitProblem } from './dossier-model';
import type { FieldProblem, ProjectOption } from './dossier-model';
import './pmt.css';

export interface OpenDossierFormProps {
  /** The projects of the caller that have no dossier yet. */
  projects: readonly ProjectOption[];
  /** Called with the id of the dossier that was opened. */
  onOpened?: (dossierId: string) => void;
}

/**
 * Opens the legal dossier of a project (PMT-01): the system plans a permit for every permit type that applies to the project today.
 * The dossier is kept by the unit that owns the project.
 */
export function OpenDossierForm({ projects, onOpened }: OpenDossierFormProps) {
  const { t } = useTranslation();
  const open = useOpenDossier();
  const [projectId, setProjectId] = useState('');
  const [problem, setProblem] = useState<FieldProblem | undefined>(undefined);
  const refused = open.isError ? describePermitProblem(open.error) : undefined;

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (open.isPending) return;
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) {
      setProblem('required');
      return;
    }
    // The project leaves the list once it has a dossier, and with the last one the form is gone: the parent is told through the promise.
    // A refusal is shown from the state of the mutation; there is nothing more to do with it here.
    void open.mutateAsync({ projectId: project.id, body: { owner_unit_id: project.ownerUnitId } }).then(
      (answer) => {
        setProjectId('');
        if (answer.resource_id !== undefined) onOpened?.(answer.resource_id);
      },
      () => undefined,
    );
  };

  if (projects.length === 0) {
    return (
      <p className="sub" data-testid="every-project-has-one">
        {t('pmt.dossier.open.none.text')}
      </p>
    );
  }
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('pmt.dossier.open.aria')}>
      <h2>{t('pmt.dossier.open.title')}</h2>
      <p className="sub">{t('pmt.dossier.open.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {permitProblemMessage(t, refused)}
        </p>
      )}
      <Field id="open-project" label={t('pmt.dossier.open.project.label')} error={problem === undefined ? undefined : permitFieldMessage(t, problem)}>
        <select
          id="open-project"
          value={projectId}
          aria-invalid={problem !== undefined}
          onChange={(event) => {
            setProjectId(event.target.value);
            setProblem(undefined);
            if (open.isError) open.reset();
          }}
        >
          <option value="">{t('pmt.dossier.open.project.placeholder')}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.code} · {project.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={open.isPending}>
          {t('pmt.dossier.open.action')}
        </button>
      </div>
    </form>
  );
}
