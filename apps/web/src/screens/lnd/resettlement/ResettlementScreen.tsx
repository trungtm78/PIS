import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../prj/components';
import '../../prj/prj.css';
import { useProjectOptions } from '../read-hooks';
import '../lnd.css';
import { ScrollRegion } from '../../scroll-region';
import { useAllocate, useAllocations, useCandidates } from './hooks';
import { CODE_MAX, EMPTY_FORM, SITE_MAX, UNIT_KINDS, allocationBody, canAllocate, describeRefusal, validateForm } from './model';
import type { AllocationForm, Candidate, EligibilityReason, FormField, FormProblem, ItemKind, Refusal, Status, UnitKind } from './model';

type T = Translator['t'];
const NONE = '—';

function unitText(t: T, kind: UnitKind): string {
  switch (kind) {
    case 'PLOT':
      return t('lnd.resettlement.unit.plot');
    case 'APARTMENT':
      return t('lnd.resettlement.unit.apartment');
    case 'HOUSE':
      return t('lnd.resettlement.unit.house');
  }
}

function statusText(t: T, status: Status): string {
  switch (status) {
    case 'ELIGIBLE':
      return t('lnd.resettlement.status.eligible');
    case 'ALLOCATED':
      return t('lnd.resettlement.status.allocated');
    case 'HANDED_OVER':
      return t('lnd.resettlement.status.handedOver');
    case 'DECLINED':
      return t('lnd.resettlement.status.declined');
  }
}

function itemText(t: T, kind: ItemKind): string {
  return kind === 'RESETTLEMENT_LAND' ? t('lnd.resettlement.item.land') : t('lnd.resettlement.item.house');
}

function reasonText(t: T, reason: EligibilityReason | undefined): string {
  switch (reason) {
    case 'NO_PLAN_ITEM':
      return t('lnd.resettlement.reason.noItem');
    case 'PLAN_ITEM_NOT_FOUND':
      return t('lnd.resettlement.reason.itemNotFound');
    case 'PLAN_ITEM_OF_ANOTHER_HOUSEHOLD':
      return t('lnd.resettlement.reason.otherHousehold');
    case 'PLAN_NOT_APPROVED':
      return t('lnd.resettlement.reason.notApproved');
    case 'NOT_A_RESETTLEMENT_ITEM':
      return t('lnd.resettlement.reason.notResettlement');
    case 'UNIT_KIND_MISMATCH':
      return t('lnd.resettlement.reason.kindMismatch');
    case 'ALREADY_ALLOCATED':
      return t('lnd.resettlement.reason.alreadyAllocated');
    case undefined:
      return t('lnd.resettlement.reason.unknown');
  }
}

function refusalText(t: T, refusal: Refusal): string {
  switch (refusal.problem) {
    case 'unitTaken':
      return t('lnd.resettlement.problem.unitTaken');
    case 'notEligible':
      return t('lnd.resettlement.problem.notEligible', { reason: reasonText(t, refusal.reason) });
    case 'scopeDenied':
      return t('lnd.resettlement.problem.scopeDenied');
    case 'notFound':
      return t('lnd.resettlement.problem.notFound');
    case 'validation':
      return t('lnd.resettlement.problem.validation');
    case 'general':
      return t('lnd.resettlement.problem.general');
  }
}

const fieldText = (t: T, problem: FormProblem | undefined): string | undefined =>
  problem === undefined ? undefined : problem === 'required' ? t('lnd.resettlement.field.required.error') : t('lnd.resettlement.field.invalid.error');

/**
 * LND-12: the resettlement of the households (ST-LND-012, LND 3.1, UAT-PLAN-31). A plot, a flat or a house is allocated to one household at a time, on the item of its approved plan that gives it resettlement. The households are shown in their
 * masked form only (the code and the masked name of the head); a candidate is an item with no unit yet; a unit that is taken, a plan that is not approved and a kind of unit the item does not give are refused in words. The server judges every request again.
 */
export default function ResettlementScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the form belong to one membership: a switch of tenant or person starts the screen over.
  return <ResettlementContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ResettlementContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const projects = useProjectOptions();
  const list = useAllocations(projectId);
  const may = canAllocate(permissions, mode);
  const candidates = useCandidates(projectId, may);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const items = list.data ?? [];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('lnd.resettlement.page.title')}</h1>
          <p>{t('lnd.resettlement.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-testid="privacy-note">
        {t('lnd.resettlement.privacy.note')}
      </p>
      <div className="card">
        <div className="field">
          <label htmlFor="resettlement-project">{t('lnd.resettlement.project.label')}</label>
          <select id="resettlement-project" value={projectId ?? ''} onChange={(event) => setParams(event.target.value === '' ? {} : { project: event.target.value })}>
            <option value="">{t('lnd.resettlement.project.choose')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {`${project.code} · ${project.name}`}
              </option>
            ))}
          </select>
        </div>
      </div>
      {projectId === undefined ? (
        <AllocationsTable empty={t('lnd.resettlement.project.notice')} emptyTestId="choose-project">
          {null}
        </AllocationsTable>
      ) : (
        <>
          {may ? <AllocatePanel candidates={candidates.data ?? []} loading={candidates.isLoading} failed={candidates.isError} onRetry={() => void candidates.refetch()} /> : null}
          <StateBoundary state={state} onRetry={() => void list.refetch()}>
            <AllocationsTable empty={items.length === 0 ? t('lnd.resettlement.empty.notice') : undefined} emptyTestId="empty">
              {items.map((item) => (
                <tr key={item.id} data-allocation={item.id} data-status={item.status}>
                  <td>
                    <code>{item.household.code}</code> {item.household.headName}
                  </td>
                  <td data-testid="unit-kind">{unitText(t, item.unitKind)}</td>
                  <td>
                    <code data-testid="unit-code">{item.unitCode}</code>
                  </td>
                  <td>{item.siteText}</td>
                  <td>{item.areaM2 ?? NONE}</td>
                  <td data-testid="rank">{item.priorityRank === null ? NONE : `${t('lnd.resettlement.col.rank')} ${item.priorityRank}`}</td>
                  <td>{item.allocatedOn ?? NONE}</td>
                  <td data-testid="handed-on">{item.handedOn ?? NONE}</td>
                  <td>
                    <span className={`pill ${item.status === 'ALLOCATED' || item.status === 'HANDED_OVER' ? 'green' : 'gray'}`}>{statusText(t, item.status)}</span>
                  </td>
                </tr>
              ))}
            </AllocationsTable>
          </StateBoundary>
        </>
      )}
      <p className="prototype-note">{t('lnd.resettlement.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The columns of the allocations, for the one row that stands in for none. */
const COLUMNS = 9;

/** The allocations of a project: the columns stand before a project is chosen, the one row then says what to choose. */
function AllocationsTable({ empty, emptyTestId, children }: { empty: string | undefined; emptyTestId: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <ScrollRegion label={t('lnd.resettlement.list.aria')}>
      <table className="table" aria-label={t('lnd.resettlement.list.aria')} data-testid="allocations">
        <thead>
          <tr>
            <th scope="col" rowSpan={2}>
              {t('lnd.resettlement.col.household')}
            </th>
            <th scope="colgroup" colSpan={2}>
              {t('lnd.resettlement.col.unit')}
            </th>
            <th scope="col" rowSpan={2}>
              {t('lnd.resettlement.col.site')}
            </th>
            <th scope="col" rowSpan={2}>
              {t('lnd.resettlement.col.area')}
            </th>
            <th scope="col" rowSpan={2}>
              {t('lnd.resettlement.field.rank.label')}
            </th>
            <th scope="col" rowSpan={2}>
              {t('lnd.resettlement.col.allocated')}
            </th>
            <th scope="col" rowSpan={2}>
              {t('scr2.lnd.resettlement.col.handedOn')}
            </th>
            <th scope="col" rowSpan={2}>
              {t('lnd.resettlement.col.status')}
            </th>
          </tr>
          <tr>
            <th scope="col">{t('lnd.resettlement.field.kind.label')}</th>
            <th scope="col">{t('lnd.resettlement.field.code.label')}</th>
          </tr>
        </thead>
        <tbody>
          {empty === undefined ? null : (
            <tr>
              <td colSpan={COLUMNS} role="status" data-testid={emptyTestId}>
                {empty}
              </td>
            </tr>
          )}
          {children}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

function AllocatePanel({ candidates, loading, failed, onRetry }: { candidates: readonly Candidate[]; loading: boolean; failed: boolean; onRetry(): void }) {
  const { t } = useTranslation();
  const send = useAllocate();
  const [form, setForm] = useState<AllocationForm>(EMPTY_FORM);
  const [problems, setProblems] = useState<Partial<Record<FormField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const refusal = send.isError ? describeRefusal(send.error) : undefined;
  const chosen = candidates.find((candidate) => candidate.planItemId === form.planItemId);
  const set = (patch: Partial<AllocationForm>): void => {
    setForm((value) => ({ ...value, ...patch }));
    setSaved(false);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateForm(form, candidates);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(allocationBody(form, candidates), {
      onSuccess: () => {
        setForm(EMPTY_FORM);
        setSaved(true);
      },
    });
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('lnd.resettlement.form.title')}>
      <h2>{t('lnd.resettlement.form.title')}</h2>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="allocate-refusal">
          {refusalText(t, refusal)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="allocate-saved">
          {t('lnd.resettlement.form.saved')}
        </p>
      ) : null}
      {failed ? (
        <p className="callout warning" role="alert" data-testid="candidates-failed">
          {t('lnd.resettlement.candidates.failed')}{' '}
          <button type="button" onClick={onRetry}>
            {t('lnd.resettlement.candidates.retry.action')}
          </button>
        </p>
      ) : null}
      <fieldset disabled={send.isPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Field id="resettlement-candidate" label={t('lnd.resettlement.field.candidate.label')} error={fieldText(t, problems.candidate)} hint={loading ? t('lnd.resettlement.field.candidate.loading') : failed ? undefined : candidates.length === 0 ? t('lnd.resettlement.field.candidate.none') : t('lnd.resettlement.field.candidate.hint')}>
          <select id="resettlement-candidate" value={form.planItemId} onChange={(event) => set({ planItemId: event.target.value, unitKind: '' })}>
            <option value="">{NONE}</option>
            {candidates.map((candidate) => (
              <option key={candidate.planItemId} value={candidate.planItemId}>
                {`${candidate.household.code} ${candidate.household.headName} · ${itemText(t, candidate.itemKind)}`}
              </option>
            ))}
          </select>
        </Field>
        <Field id="resettlement-kind" label={t('lnd.resettlement.field.kind.label')} error={fieldText(t, problems.unitKind)}>
          <select id="resettlement-kind" value={form.unitKind} onChange={(event) => set({ unitKind: event.target.value })}>
            <option value="">{NONE}</option>
            {UNIT_KINDS.filter((kind) => chosen === undefined || chosen.unitKinds.includes(kind)).map((kind) => (
              <option key={kind} value={kind}>
                {unitText(t, kind)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="resettlement-code" label={t('lnd.resettlement.field.code.label')} error={fieldText(t, problems.unitCode)} hint={t('lnd.resettlement.field.code.hint', { max: CODE_MAX })}>
          <input id="resettlement-code" type="text" value={form.unitCode} onChange={(event) => set({ unitCode: event.target.value })} />
        </Field>
        <Field id="resettlement-site" label={t('lnd.resettlement.field.site.label')} error={fieldText(t, problems.siteText)} hint={t('lnd.resettlement.field.site.hint', { max: SITE_MAX })}>
          <input id="resettlement-site" type="text" value={form.siteText} onChange={(event) => set({ siteText: event.target.value })} />
        </Field>
        <Field id="resettlement-area" label={t('lnd.resettlement.field.area.label')} error={fieldText(t, problems.area)} hint={t('lnd.resettlement.field.area.hint')}>
          <input id="resettlement-area" type="text" inputMode="decimal" value={form.area} onChange={(event) => set({ area: event.target.value })} />
        </Field>
        <Field id="resettlement-rank" label={t('lnd.resettlement.field.rank.label')} error={fieldText(t, problems.rank)} hint={t('lnd.resettlement.field.rank.hint')}>
          <input id="resettlement-rank" type="text" inputMode="numeric" value={form.rank} onChange={(event) => set({ rank: event.target.value })} />
        </Field>
      </fieldset>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('lnd.resettlement.form.submit.action')}
        </button>
      </div>
    </form>
  );
}
