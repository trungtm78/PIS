import { ApiError } from '@machvon/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { businessToday } from './org-tree/business-date';
import { useOrgUnits, useUnitCommands } from './org-tree/hooks';
import { problemMessage } from './org-tree/labels';
import type { CreateUnitBody, UpdateUnitBody } from './org-tree/hooks';
import { MoveDialog } from './org-tree/MoveDialog';
import type { MoveValues } from './org-tree/MoveDialog';
import { describeProblem } from './org-tree/problems';
import type { ProblemView } from './org-tree/problems';
import { buildUnitTree, expandableIds } from './org-tree/tree-model';
import { MANAGE_UNITS_PERMISSION } from './org-tree/types';
import type { FormField, OrgUnit } from './org-tree/types';
import { changedFields, UnitForm } from './org-tree/UnitForm';
import type { FormValues } from './org-tree/UnitForm';
import { UnitTree } from './org-tree/UnitTree';
import { SectionCard } from '../../ui';
import './adm-kit.css';
import './org-tree/org-tree.css';

type Mode = 'idle' | 'create' | 'edit';

/** A refusal (session lapsed, no permission) is final: unlike a network or server failure it never leaves the editor open. */
function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'SESSION_EXPIRED' || error.status === 401 || error.status === 403);
}

// A refusal of a move names the create-form fields; the move dialog calls them by their own names.
const MOVE_FIELD: Readonly<Partial<Record<FormField, FormField>>> = { parent_id: 'new_parent_id', valid_from: 'effective_from' };

function createBody(values: FormValues): CreateUnitBody {
  return {
    code: values.code,
    name: values.name,
    parent_id: values.parent_id,
    unit_type: values.unit_type,
    valid_from: values.valid_from,
    ...(values.is_investor ? { is_investor: true } : {}),
    ...(values.administrative_code === '' ? {} : { administrative_code: values.administrative_code }),
    ...(values.legal_basis_ref === '' ? {} : { legal_basis_ref: values.legal_basis_ref }),
  };
}

/** ADM-01: the organisation tree of the tenant with its unit form (create, edit, move) inside the mockup's page frame. */
export default function OrgTreeScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, tenant, mode: sessionMode } = useSession();
  const tenantId = tenant?.id;
  const units = useOrgUnits();
  const { create, update, move, refresh } = useUnitCommands();
  // A transient failure of a background refresh is a banner, not a state: while the list is cached the editor stays mounted.
  // A refusal (lapsed session, missing permission) is a state even with cached data: the editor must not stay usable.
  const refused = isRefusal(units.error);
  const state = useScreenState({ isLoading: units.isLoading, error: units.data === undefined || refused ? units.error : undefined, data: units.data });
  const refreshFailed = units.data !== undefined && units.error !== null && units.error !== undefined && !refused;
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const readOnly = sessionMode === 'READ_ONLY' || (permissions !== undefined && !permissions.includes(MANAGE_UNITS_PERMISSION));

  const [asOf, setAsOf] = useState(() => businessToday());
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string> | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<Mode>('idle');
  const [moving, setMoving] = useState(false);
  const [problem, setProblem] = useState<ProblemView | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [formEpoch, setFormEpoch] = useState(0);
  // The unit as it was when the user started editing. The draft, its changed fields and its If-Match version all come from
  // this snapshot, so a change another admin made meanwhile is never restored over and never silently overwritten.
  const [base, setBase] = useState<OrgUnit | undefined>(undefined);
  // What the user has typed in the open form. It lives here, not in the form, because the form is unmounted while the
  // list reloads (for example after a tenant switch) and the typed values must come back with it.
  const draft = useRef<FormValues | undefined>(undefined);
  const remountForm = useCallback((): void => {
    setFormEpoch((epoch) => epoch + 1);
  }, []);
  const resetForm = useCallback((): void => {
    draft.current = undefined;
    remountForm();
  }, [remountForm]);
  const clearFeedback = useCallback((): void => {
    setProblem(undefined);
    setNotice(undefined);
  }, []);

  const all = units.data ?? [];
  const forest = buildUnitTree(all, asOf);
  const expanded = expandedIds ?? expandableIds(forest);
  const selected = all.find((unit) => unit.id === selectedId);
  const pending = create.isPending || update.isPending || move.isPending;
  const baseUnit = mode === 'edit' && base !== undefined && base.id === selectedId ? base : selected;
  const serverChanged = mode === 'edit' && baseUnit !== undefined && selected !== undefined && selected.version !== baseUnit.version;
  const hasEdits = draft.current !== undefined && baseUnit !== undefined && Object.keys(changedFields(baseUnit, draft.current)).length > 0;

  // Nothing typed yet: adopt the server's newer unit as the snapshot (kept, not dropped, so a later change is still noticed).
  // Typed edits stay, with a notice, and are checked by the server's If-Match.
  useEffect(() => {
    if (serverChanged && !hasEdits) {
      setBase(selected);
      resetForm();
    }
  }, [serverChanged, hasEdits, selected, resetForm]);

  // Another tenant has other units: an edit draft never follows the switch (a new unit's typed values do, minus the parent).
  const lastTenant = useRef(tenantId);
  useEffect(() => {
    if (lastTenant.current === tenantId) return;
    lastTenant.current = tenantId;
    clearFeedback();
    if (mode === 'edit') {
      draft.current = undefined;
      setSelectedId(undefined);
      setBase(undefined);
      setMoving(false);
      setMode('idle');
    } else if (mode === 'create' && draft.current !== undefined) {
      draft.current = { ...draft.current, parent_id: '' };
      remountForm();
    }
  }, [tenantId, mode, clearFeedback, remountForm]);

  const toggle = (unitId: string): void => {
    const next = new Set(expanded);
    if (next.has(unitId)) next.delete(unitId);
    else next.add(unitId);
    setExpandedIds(next);
  };

  const select = (unitId: string): void => {
    // The unit that is open stays as it is: its draft and its snapshot belong to the form on screen.
    if (unitId === selectedId && mode === 'edit') return;
    draft.current = undefined;
    clearFeedback();
    setBase(all.find((unit) => unit.id === unitId));
    setSelectedId(unitId);
    setMode('edit');
    setMoving(false);
  };

  const fail = (error: unknown): void => {
    const view = describeProblem(error);
    setProblem(view);
    if (view.kind === 'conflict') void refresh();
  };

  const succeed = (message: string): void => {
    setProblem(undefined);
    setNotice(message);
  };

  const submitCreate = (values: FormValues): void => {
    if (pending) return;
    clearFeedback();
    create.mutate(createBody(values), {
      onSuccess: (result) => {
        succeed(t('adm.orgUnit.saved.notice'));
        const created = (result as { resource_id?: string }).resource_id;
        if (created !== undefined) setSelectedId(created);
        setMode('edit');
        resetForm();
      },
      onError: fail,
    });
  };

  const submitUpdate = (unit: OrgUnit, values: FormValues): void => {
    if (pending) return;
    clearFeedback();
    update.mutate(
      { unit, body: changedFields(unit, values) as UpdateUnitBody },
      {
        onSuccess: (result) => {
          succeed(t('adm.orgUnit.saved.notice'));
          // What the server now holds is what was sent, at the version it answered with: the next edit starts from there.
          const version = (result as { resource_version?: number }).resource_version;
          setBase(version === undefined ? undefined : { ...unit, ...(changedFields(unit, values) as UpdateUnitBody), version });
        },
        onError: fail,
      },
    );
  };

  const submitMove = (unit: OrgUnit, values: MoveValues): void => {
    if (pending) return;
    clearFeedback();
    move.mutate(
      { unit, body: values },
      {
        onSuccess: () => {
          succeed(t('adm.orgUnit.moved.notice'));
          setMoving(false);
          resetForm();
        },
        onError: fail,
      },
    );
  };

  const reload = (): void => {
    setProblem(undefined);
    setBase(undefined);
    resetForm();
    void refresh();
  };

  const messageOf = (view: ProblemView | undefined): string | undefined =>
    view === undefined ? undefined : problemMessage(t, view);
  const fieldErrors = (view: ProblemView | undefined, forMove: boolean): Partial<Record<FormField, string>> => {
    if (view?.field === undefined) return {};
    const field = forMove ? (MOVE_FIELD[view.field] ?? view.field) : view.field;
    return { [field]: problemMessage(t, view) };
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.orgUnit.page.title')}</h1>
          <p>{t('adm.orgUnit.page.subtitle')}</p>
        </div>
        {readOnly || state !== 'default' ? null : (
          <div className="actions">
            <button
              type="button"
              className="ui-button ui-button--primary"
              onClick={() => {
                clearFeedback();
                setMode('create');
                setMoving(false);
                resetForm();
              }}
            >
              {t('adm.orgUnit.create.action')}
            </button>
          </div>
        )}
      </div>
      <StateBoundary state={state} onRetry={() => void units.refetch()}>
        {refreshFailed ? (
          <p className="callout warning" role="alert">
            {t('adm.orgUnit.refresh.error')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void units.refetch()}>
              {t('states.retry.action')}
            </button>
          </p>
        ) : null}
        <div className="two">
          <SectionCard
            title={t('adm.orgUnit.tree.title')}
            actions={
              <div className="field">
                <label htmlFor="as-of">{t('adm.orgUnit.asOf.label')}</label>
                <input id="as-of" type="date" value={asOf} onChange={(event) => event.target.value !== '' && setAsOf(event.target.value)} />
              </div>
            }
          >
            <p className="adm-kit-sub">{t('adm.orgUnit.asOf.hint')}</p>
            <UnitTree forest={forest} expanded={expanded} onToggle={toggle} selectedId={selectedId} onSelect={select} />
          </SectionCard>
          <SectionCard title={mode === 'create' ? t('adm.orgUnit.form.new.title') : t('adm.orgUnit.form.edit.title')}>
            {notice === undefined ? null : <p className="callout" role="status">{notice}</p>}
            {mode === 'idle' || (mode === 'edit' && selected === undefined) ? (
              <p className="muted">{t('adm.orgUnit.form.idle.hint')}</p>
            ) : (
              <>
                <UnitForm
                  key={`${mode}-${mode === 'edit' ? selected?.id : 'new'}-${formEpoch}`}
                  mode={mode === 'create' ? 'create' : 'edit'}
                  unit={mode === 'edit' ? baseUnit : undefined}
                  units={all}
                  defaultParentId={selectedId}
                  readOnly={readOnly}
                  pending={pending}
                  draft={draft.current}
                  onDraft={(values) => {
                    draft.current = values;
                    // The first edit freezes the snapshot it was typed against, so a newer server version cannot move it.
                    if (mode === 'edit' && base === undefined && selected !== undefined && Object.keys(changedFields(selected, values)).length > 0) setBase(selected);
                  }}
                  errors={moving ? {} : fieldErrors(problem, false)}
                  message={moving || problem?.kind === 'field' ? undefined : messageOf(problem)}
                  onSubmit={(values) => (mode === 'edit' && baseUnit !== undefined ? submitUpdate(baseUnit, values) : submitCreate(values))}
                  onMove={() => {
                    clearFeedback();
                    setMoving(true);
                  }}
                />
                {serverChanged && hasEdits && problem?.kind !== 'conflict' && !moving ? (
                  <p className="callout warning" role="status">
                    {t('adm.orgUnit.stale.message', { version: selected?.version ?? '' })}
                  </p>
                ) : null}
                {(problem?.kind === 'conflict' || (serverChanged && hasEdits)) && !moving ? (
                  <button type="button" className="ui-button ui-button--outline" onClick={reload}>
                    {t('adm.orgUnit.conflict.reload')}
                  </button>
                ) : null}
                {moving && selected !== undefined ? (
                  <MoveDialog
                    key={`move-${selected.id}-${formEpoch}`}
                    unit={selected}
                    units={all}
                    pending={pending}
                    errors={fieldErrors(problem, true)}
                    message={problem?.kind === 'field' ? undefined : messageOf(problem)}
                    onSubmit={(values) => submitMove(selected, values)}
                    onCancel={() => {
                      clearFeedback();
                      setMoving(false);
                    }}
                  />
                ) : null}
              </>
            )}
          </SectionCard>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('adm.orgUnit.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
