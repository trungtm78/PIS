import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../../i18n';
import type { ScreenProps } from '../../../../routes/types';
import { useSession } from '../../../../session/SessionContext';
import { StateBoundary } from '../../../../states/StateBoundary';
import { useScreenState } from '../../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../../ui';
import { KitTable } from '../../../../screens/adm/KitTable';
import { moneyText } from '../shared/format';
import { DataGuide } from './DataGuide';
import { useCreateLine, useEquipmentLines, useProjectOptions } from './hooks';
import { DETAIL_PATH, EMPTY_CREATE, EQUIPMENT_STAGES, MANAGE_PERMISSION, describeProblem, stageTone, toCreateBody, validateCreate } from './model';
import type { CreateField, CreateForm, EquipmentStage } from './model';
import '../shared/shared.css';

const NEVER_EMPTY = (): boolean => false;

/**
 * EQP-01: the equipment procurement of the projects of the Ban Thuong mai (CN.02): for each line of the plan, the package, the choice of contractor, the contract value and the money paid, read from BID, CTR and PAY in the scope of
 * the caller. A figure the caller may not read says so; it is never shown as zero. The block "how to get data" says what state the file import of the national network is in.
 */
export default function EquipmentListScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <EquipmentListContent key={tenantId ?? 'none'} route={route} />;
}

function EquipmentListContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const mayManage = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const [stage, setStage] = useState<EquipmentStage | undefined>(undefined);
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const lines = useEquipmentLines({ projectId: undefined, stage, includeCancelled });
  const state = useScreenState({ isLoading: lines.isLoading, error: lines.error, data: lines.data, isEmpty: NEVER_EMPTY });
  const items = lines.data?.items ?? [];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="ent2-page">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('eqp.list.title')}</h1>
          <p>{t('eqp.list.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void lines.refetch()}>
        {lines.data === undefined ? null : <DataGuide guide={lines.data.guide} />}
        <SectionCard title={t('eqp.list.section')}>
          <div className="ent2-filter">
            <div className="field">
              <label htmlFor="eqp-stage">{t('eqp.filter.stage')}</label>
              <select id="eqp-stage" value={stage ?? ''} onChange={(event) => setStage(event.target.value === '' ? undefined : (event.target.value as EquipmentStage))}>
                <option value="">{t('eqp.filter.allStages')}</option>
                {EQUIPMENT_STAGES.map((name) => (
                  <option key={name} value={name}>
                    {t(`eqp.stage.${name}`)}
                  </option>
                ))}
              </select>
            </div>
            <label className="ent2-check">
              <input type="checkbox" checked={includeCancelled} onChange={(event) => setIncludeCancelled(event.target.checked)} /> {t('eqp.filter.cancelled')}
            </label>
          </div>
          {items.length === 0 ? (
            <p className="ent2-none" data-testid="empty-lines">
              {t('eqp.list.empty')}
            </p>
          ) : (
            <KitTable caption={t('eqp.list.caption')} testId="lines">
              <thead>
                <tr>
                  <th scope="col">{t('eqp.col.line')}</th>
                  <th scope="col">{t('eqp.col.project')}</th>
                  <th scope="col">{t('eqp.col.unit')}</th>
                  <th scope="col">{t('eqp.col.planned')}</th>
                  <th scope="col">{t('eqp.col.package')}</th>
                  <th scope="col">{t('eqp.col.selection')}</th>
                  <th scope="col">{t('eqp.col.contract')}</th>
                  <th scope="col">{t('eqp.col.paid')}</th>
                  <th scope="col">{t('eqp.col.stage')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((line) => (
                  <tr key={line.id} data-line-id={line.id} data-stage={line.stage}>
                    <th scope="row">
                      <Link to={`${DETAIL_PATH}?line=${line.id}`}>{line.code}</Link>
                      <div className="sub">{line.name}</div>
                    </th>
                    <td>{line.project.code}</td>
                    <td>{line.ownerUnit.name}</td>
                    <td>{moneyText(line.plannedValueVnd, locale)}</td>
                    <td>{line.package === null ? '–' : line.package.code}</td>
                    <td>{line.selection === null ? '–' : t(`eqp.outcome.${line.selection.outcome}`)}</td>
                    <td>{line.masked.includes('CONTRACT') ? <span className="sub">{t('eqp.list.masked')}</span> : moneyText(line.contractValueVnd, locale)}</td>
                    <td>
                      {line.masked.includes('PAYMENT') ? (
                        <span className="sub">{t('eqp.list.masked')}</span>
                      ) : (
                        <>
                          {moneyText(line.paidVnd, locale)}
                          {line.disbursementPercent === null ? '' : ` (${line.disbursementPercent}%)`}
                        </>
                      )}
                    </td>
                    <td>
                      <StatusPill tone={stageTone(line.stage)}>{t(`eqp.stage.${line.stage}`)}</StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          )}
          <p className="sub" data-testid="count">
            {t('eqp.list.count', { count: items.length })}
          </p>
        </SectionCard>
        {mayManage ? <CreateCard /> : null}
      </StateBoundary>
      <p className="prototype-note">{t('eqp.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function CreateCard() {
  const { t } = useTranslation();
  const create = useCreateLine();
  const projects = useProjectOptions(true);
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE);
  const [errors, setErrors] = useState<Partial<Record<CreateField, string>>>({});
  const [saved, setSaved] = useState(false);
  const refused = create.isError ? describeProblem(create.error) : undefined;
  const change = (patch: Partial<CreateForm>): void => {
    setForm((previous) => ({ ...previous, ...patch }));
    setErrors({});
    setSaved(false);
    if (create.isError) create.reset();
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validateCreate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(toCreateBody(form), {
      onSuccess: () => {
        setForm(EMPTY_CREATE);
        setSaved(true);
      },
    });
  };
  const text = (field: 'code' | 'name' | 'plannedValueVnd' | 'planRef', id: string, label: string) => (
    <div className="field" data-field={field}>
      <label htmlFor={id}>{label}</label>
      <input id={id} value={form[field]} aria-invalid={errors[field as CreateField] !== undefined} onChange={(event) => change({ [field]: event.target.value })} />
      {errors[field as CreateField] === undefined ? null : (
        <small role="alert" className="field-error">
          {t(`eqp.problem.${errors[field as CreateField]}`)}
        </small>
      )}
    </div>
  );
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('eqp.form.aria')}>
      <h2>{t('eqp.form.title')}</h2>
      <p className="sub">{t('eqp.form.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {t(`eqp.refused.${refused}`)}
        </p>
      )}
      <div className="field" data-field="projectId">
        <label htmlFor="eqp-project">{t('eqp.form.project')}</label>
        <select id="eqp-project" value={form.projectId} aria-invalid={errors.projectId !== undefined} onChange={(event) => change({ projectId: event.target.value })}>
          <option value="">{t('eqp.form.projectPick')}</option>
          {(projects.data ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.code} · {project.name}
            </option>
          ))}
        </select>
        {errors.projectId === undefined ? null : (
          <small role="alert" className="field-error">
            {t(`eqp.problem.${errors.projectId}`)}
          </small>
        )}
      </div>
      {text('code', 'eqp-code', t('eqp.form.code'))}
      {text('name', 'eqp-name', t('eqp.form.name'))}
      {text('plannedValueVnd', 'eqp-value', t('eqp.form.value'))}
      {text('planRef', 'eqp-plan-ref', t('eqp.form.planRef'))}
      <div className="actions">
        <button type="submit" className="btn primary" disabled={create.isPending}>
          {t('eqp.form.save')}
        </button>
        {saved ? (
          <span role="status" className="sub">
            {t('eqp.form.saved')}
          </span>
        ) : null}
      </div>
    </form>
  );
}
