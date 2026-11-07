import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { SectionCard, StickyActions } from '../../ui';
import { BackLink, ProjectFormFields, SuggestionPanel } from './components';
import { useCreateProject, useMasterOptions, useProject, useUnits } from './hooks';
import { problemMessage } from './labels';
import { AREA_TYPES, CREATE_PERMISSION, EMPTY_FORM, LIST_PATH, PROGRAM_TYPES, PROJECT_TYPE_TYPES, SECTOR_TYPES, createBody, describeProblem, validateForm, workspaceLink } from './model';
import type { ProjectField, ProjectForm } from './model';
import './prj.css';

/** PRJ-02: a project is created in the stage CONCEPT; the group the rule data suggests for it, and the rule's confirmation, are shown once it exists. */
export default function ProjectCreateScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form, the units and the entries it offers belong to one membership: a switch starts the screen over.
  return <ProjectCreateContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProjectCreateContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const canCreate = (permissions === undefined || permissions.includes(CREATE_PERMISSION)) && !frozen;
  const units = useUnits();
  const areas = useMasterOptions(AREA_TYPES);
  const sectors = useMasterOptions(SECTOR_TYPES);
  const projectTypes = useMasterOptions(PROJECT_TYPE_TYPES);
  const programs = useMasterOptions(PROGRAM_TYPES);
  const create = useCreateProject();
  const [form, setForm] = useState<ProjectForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<ProjectField, ReturnType<typeof validateForm>[ProjectField]>>>({});
  const [createdId, setCreatedId] = useState<string | undefined>(undefined);
  const created = useProject(createdId);
  const problem = create.isError ? describeProblem(create.error) : undefined;

  const setField = (field: ProjectField, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending || !canCreate || createdId !== undefined) return;
    const found = validateForm(form, 'create');
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    // The investor is the owner unit unless another one is chosen.
    const body = createBody({
      ...form,
      investorUnitId: form.investorUnitId === '' ? form.ownerUnitId : form.investorUnitId,
    });
    create.mutate(body, {
      onSuccess: (result) => setCreatedId(result.resource_id),
    });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={LIST_PATH}>{t('prj.back.list.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.create.page.title')}</h1>
          <p>{t('prj.create.page.subtitle')}</p>
        </div>
      </div>
      <div className="prj-grid">
        <form onSubmit={save} noValidate aria-label={t('prj.create.form.title')}>
          <SectionCard title={t('prj.create.form.title')}>
            {!canCreate ? (
              <p className="callout warning" role="status">
                {frozen ? t('prj.readOnly.frozen.notice') : t('prj.readOnly.denied.notice')}
              </p>
            ) : null}
            {problem === undefined ? null : (
              <p className="callout warning" role="alert">
                {problemMessage(t, problem)}
              </p>
            )}
            <ProjectFormFields
              mode="create"
              form={form}
              errors={errors}
              onChange={setField}
              units={units.data ?? []}
              areas={areas.data ?? []}
              sectors={sectors.data ?? []}
              projectTypes={projectTypes.data ?? []}
              programs={programs.data ?? []}
              disabled={!canCreate || createdId !== undefined}
            />
            <StickyActions
              primary={
                <button type="submit" className="ui-button ui-button--primary" disabled={!canCreate || create.isPending || createdId !== undefined}>
                  {create.isPending ? t('prj.create.submit.pending') : t('prj.create.submit.action')}
                </button>
              }
              secondary={[
                <Link key="cancel" className="ui-button ui-button--outline" to={LIST_PATH}>
                  {t('prj.create.cancel.action')}
                </Link>,
              ]}
            />
          </SectionCard>
        </form>
        <aside aria-label={t('prj.create.rules.title')}>
          <SectionCard title={t('prj.create.rules.title')}>
            <dl className="prj-facts">
              <dt>{t('prj.create.group.label')}</dt>
              <dd>{t('prj.create.group.text')}</dd>
              <dt>{t('prj.create.nationalCode.label')}</dt>
              <dd>{t('prj.create.nationalCode.text')}</dd>
              <dt>{t('prj.create.stage.label')}</dt>
              <dd>{t('prj.create.stage.text')}</dd>
            </dl>
            {createdId === undefined ? null : (
              <div className="rule" data-testid="created">
                <h3>{t('prj.create.done.title')}</h3>
                <p role="status">{t('prj.create.done.text')}</p>
                {created.data === undefined || created.data === null ? (
                  created.isError ? (
                    <p className="callout warning" role="alert">
                      {t('prj.create.done.suggestionError')}
                    </p>
                  ) : null
                ) : (
                  <SuggestionPanel suggestion={created.data.suggestion} />
                )}
                <p>
                  <Link className="ui-button ui-button--primary" to={workspaceLink(createdId)}>
                    {t('prj.create.done.open')}
                  </Link>
                </p>
              </div>
            )}
          </SectionCard>
        </aside>
      </div>
      <p className="prototype-note">
        {t('prj.create.footer.reference', {
          id: route.id,
          req: route.req ?? '',
        })}
      </p>
    </section>
  );
}
