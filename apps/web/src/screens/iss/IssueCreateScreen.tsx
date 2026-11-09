import { useState } from 'react';
import { camel } from '../mdm/catalogues';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { isDefinitiveRefusal } from '../../api/attempt-registry';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { Field } from './components';
import { useCategories, useCreateIssue, useProjects, useUnits } from './hooks';
import { BackLink } from './issue-components';
import { issueFieldMessage, issueProblemMessage, sourceLabel } from './issue-labels';
import { EMPTY_FORM, FIELD_OF_DETAIL, ISSUE_CREATE_PERMISSION, LIST_PATH, describeProblem, hasPermission, toCreateBody, validateForm, workspaceLink } from './issue-model';
import type { FieldProblem, IssueField, IssueForm } from './issue-model';
import { severityLabel } from './labels';
import { SEVERITIES, splitCategories } from './model';
import type { Severity } from './model';
import './iss.css';

const newOperationId = (): string => globalThis.crypto.randomUUID();

/**
 * ISS-02: an issue is opened with its project, its category, its severity and the unit that answers for it; the system fixes the SLA policy
 * and the deadlines. The position is stored only with the consent of the person who gives it, and the operation id that the form keeps until
 * the issue is accepted makes a send repeated after a lost answer the same issue (UAT-AC355).
 */
export default function IssueCreateScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form and what it offers belong to one membership: a switch starts the screen over.
  return <IssueCreateContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function IssueCreateContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const canCreate = hasPermission(permissions, ISSUE_CREATE_PERMISSION) && !frozen;
  const projects = useProjects(canCreate);
  const units = useUnits();
  const categories = useCategories();
  const split = splitCategories(categories.data ?? []);
  const create = useCreateIssue();
  const [form, setForm] = useState<IssueForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<IssueField, FieldProblem>>>({});
  const [createdId, setCreatedId] = useState<string | undefined>(undefined);
  const [operationId, setOperationId] = useState<string>(newOperationId);
  const [locating, setLocating] = useState<'idle' | 'busy' | 'failed'>('idle');
  const problem = create.isError ? describeProblem(create.error) : undefined;
  const serverField = problem?.reason === 'validation' && problem.field !== undefined ? FIELD_OF_DETAIL[problem.field] : undefined;
  const done = createdId !== undefined;

  const change = (patch: Partial<IssueForm>): void => {
    if (create.isError) create.reset();
    setForm((current) => ({ ...current, ...patch }));
    setErrors((current) => {
      const next = { ...current };
      for (const field of Object.keys(patch) as IssueField[]) delete next[field];
      return next;
    });
  };
  const problemOf = (field: IssueField): string | undefined => {
    const found = errors[field] ?? (serverField === field ? 'rejected' : undefined);
    return found === undefined ? undefined : issueFieldMessage(t, found);
  };

  const consent = (given: boolean): void => {
    // Taking the consent back takes the position with it: nothing the person typed or fetched is sent without it.
    change(given ? { geoConsent: true } : { geoConsent: false, geoLat: '', geoLng: '', geoAccuracy: '' });
    setLocating('idle');
  };

  const locate = (): void => {
    const geolocation = globalThis.navigator?.geolocation;
    if (geolocation === undefined) {
      setLocating('failed');
      return;
    }
    setLocating('busy');
    geolocation.getCurrentPosition(
      (position) => {
        change({ geoLat: position.coords.latitude.toFixed(6), geoLng: position.coords.longitude.toFixed(6), geoAccuracy: position.coords.accuracy.toFixed(2) });
        setLocating('idle');
      },
      () => setLocating('failed'),
    );
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending || !canCreate || done) return;
    const found = validateForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(toCreateBody(form, operationId), {
      onSuccess: (result) => {
        setCreatedId(result.resource_id);
        setOperationId(newOperationId());
      },
      // A refusal is final: the next send is a new intention. A lost answer keeps the id, so that the retry is the issue that may already exist.
      onError: (error) => {
        if (isDefinitiveRefusal(error)) setOperationId(newOperationId());
      },
    });
  };

  const disabled = !canCreate || done;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={LIST_PATH}>{t('iss.back.list.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('iss.create.page.title')}</h1>
          <p>{t('iss.create.page.subtitle')}</p>
        </div>
      </div>
      <div className="iss-grid">
        <form className="card" onSubmit={save} noValidate aria-label={t('iss.create.form.title')}>
          <h2>{t('iss.create.form.title')}</h2>
          {!canCreate && !done ? (
            <p className="callout warning" role="status">
              {frozen ? t('iss.create.frozen.notice') : t('iss.create.denied.notice')}
            </p>
          ) : null}
          {problem === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="problem">
              {issueProblemMessage(t, problem)}
            </p>
          )}
          <fieldset disabled={disabled} className="formgrid">
            <Field id="issue-project" label={t('iss.create.project.label')} error={problemOf('projectId')}>
              <select id="issue-project" value={form.projectId} aria-invalid={problemOf('projectId') !== undefined} onChange={(event) => change({ projectId: event.target.value })}>
                <option value="">{t('iss.create.choose.option')}</option>
                {(projects.data ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.code} · {project.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="issue-unit" label={t('iss.create.unit.label')} error={problemOf('ownerUnitId')} hint={t('iss.create.unit.hint')}>
              <select id="issue-unit" value={form.ownerUnitId} aria-invalid={problemOf('ownerUnitId') !== undefined} onChange={(event) => change({ ownerUnitId: event.target.value })}>
                <option value="">{t('iss.create.choose.option')}</option>
                {(units.data ?? []).map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.code} · {unit.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="issue-category" label={t('iss.create.category.label')} error={problemOf('categoryVersionId')}>
              <select id="issue-category" value={form.categoryVersionId} aria-invalid={problemOf('categoryVersionId') !== undefined} onChange={(event) => change({ categoryVersionId: event.target.value })}>
                <option value="">{t('iss.create.choose.option')}</option>
                {split.causes.map((family) => (
                  <optgroup key={family.group} label={`${t('iss.create.category.causes')} · ${t(`iss.delayCause.group.${camel(family.group)}`)}`}>
                    {family.items.map((category) => (
                      <option key={category.versionId} value={category.versionId}>
                        {category.key} · {category.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
                {split.others.map((category) => (
                  <option key={category.versionId} value={category.versionId}>
                    {category.key} · {category.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="issue-severity" label={t('iss.create.severity.label')} error={problemOf('severity')}>
              <select id="issue-severity" value={form.severity} onChange={(event) => change({ severity: event.target.value as Severity })}>
                {SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {severityLabel(t, severity)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="issue-title" label={t('iss.create.title.label')} error={problemOf('title')}>
              <input id="issue-title" value={form.title} aria-invalid={problemOf('title') !== undefined} onChange={(event) => change({ title: event.target.value })} />
            </Field>
            <Field id="issue-description" label={t('iss.create.description.label')} error={problemOf('description')}>
              <textarea id="issue-description" rows={4} value={form.description} aria-invalid={problemOf('description') !== undefined} onChange={(event) => change({ description: event.target.value })} />
            </Field>
            <p data-testid="source">
              <strong>{t('iss.create.source.label')}</strong>: {sourceLabel(t, 'MANUAL')}
            </p>
          </fieldset>
          <fieldset disabled={disabled} className="formgrid" aria-label={t('iss.create.geo.title')}>
            <legend>{t('iss.create.geo.title')}</legend>
            <label className="check">
              <input type="checkbox" checked={form.geoConsent} aria-invalid={problemOf('geoConsent') !== undefined} onChange={(event) => consent(event.target.checked)} />
              {t('iss.create.geo.consent.label')}
            </label>
            <small className="sub">{t('iss.create.geo.consent.hint')}</small>
            {problemOf('geoConsent') === undefined ? null : (
              <small role="alert" className="field-error">
                {problemOf('geoConsent')}
              </small>
            )}
            <p>
              <button type="button" className="button" disabled={!form.geoConsent || locating === 'busy'} onClick={locate}>
                {locating === 'busy' ? t('iss.create.geo.locating.text') : t('iss.create.geo.locate.action')}
              </button>
            </p>
            {locating === 'failed' ? (
              <p className="callout warning" role="status" data-testid="locate-failed">
                {t('iss.create.geo.unavailable.notice')}
              </p>
            ) : null}
            <Field id="issue-lat" label={t('iss.create.geo.lat.label')} error={problemOf('geoLat')}>
              <input id="issue-lat" inputMode="decimal" value={form.geoLat} disabled={!form.geoConsent} aria-invalid={problemOf('geoLat') !== undefined} onChange={(event) => change({ geoLat: event.target.value })} />
            </Field>
            <Field id="issue-lng" label={t('iss.create.geo.lng.label')} error={problemOf('geoLng')}>
              <input id="issue-lng" inputMode="decimal" value={form.geoLng} disabled={!form.geoConsent} aria-invalid={problemOf('geoLng') !== undefined} onChange={(event) => change({ geoLng: event.target.value })} />
            </Field>
            <Field id="issue-accuracy" label={t('iss.create.geo.accuracy.label')} error={problemOf('geoAccuracy')}>
              <input id="issue-accuracy" inputMode="decimal" value={form.geoAccuracy} disabled={!form.geoConsent} aria-invalid={problemOf('geoAccuracy') !== undefined} onChange={(event) => change({ geoAccuracy: event.target.value })} />
            </Field>
          </fieldset>
          <p className="sub">{t('iss.create.photo.notice')}</p>
          <div className="formfooter">
            <Link to={LIST_PATH}>{t('iss.create.cancel.action')}</Link>
            <button type="submit" className="button primary" disabled={disabled || create.isPending}>
              {create.isPending ? t('iss.create.submit.pending') : t('iss.create.submit.action')}
            </button>
          </div>
        </form>
        <aside className="card" aria-label={t('iss.create.rules.title')}>
          <h2>{t('iss.create.rules.title')}</h2>
          <dl className="iss-facts">
            <dt>{t('iss.create.sla.label')}</dt>
            <dd>{t('iss.create.sla.text')}</dd>
            <dt>{t('iss.create.offline.label')}</dt>
            <dd>{t('iss.create.offline.text')}</dd>
            <dt>{t('iss.create.location.label')}</dt>
            <dd>{t('iss.create.location.text')}</dd>
          </dl>
          {createdId === undefined ? null : (
            <div className="rule" data-testid="created">
              <h3>{t('iss.create.done.title')}</h3>
              <p role="status">{t('iss.create.done.text')}</p>
              <p>
                <Link className="button primary" to={workspaceLink(createdId)}>
                  {t('iss.create.done.open')}
                </Link>
              </p>
            </div>
          )}
        </aside>
      </div>
      <p className="prototype-note">{t('iss.create.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
