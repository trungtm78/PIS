import { useTranslation } from '../../../i18n';
import type { ProjectOption } from '../read-hooks';

export interface ProjectPickerProps {
  id: string;
  projects: readonly ProjectOption[];
  value: string | undefined;
  onChange(projectId: string): void;
}

/** The project the screen shows: the projects of the register in the scope of the caller, by internal code. */
export function ProjectPicker({ id, projects, value, onChange }: ProjectPickerProps) {
  const { t } = useTranslation();
  return (
    <div className="card">
      <div className="field">
        <label htmlFor={id}>{t('lnd.progress.project.label')}</label>
        <select id={id} value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('lnd.progress.project.choose')}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {`${project.code} · ${project.name}`}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
