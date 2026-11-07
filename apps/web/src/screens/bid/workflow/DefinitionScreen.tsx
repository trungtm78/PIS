import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, MakerCheckerBadge, SectionCard, StatusPill } from '../../../ui';
import { useCreateDraft, useEffectiveRule, useMoveRule, useRuleVersions } from './hooks';
import type { RuleVersion } from './hooks';
import { errorText, evidenceKindLabel, methodLabel, milestoneLabel } from './labels';
import { GOVERNANCE_APPROVE, GOVERNANCE_MANAGE, METHODS } from './model';
import './workflow.css';

/**
 * BID-31, "Định nghĩa quy trình" (PRC-1): the steps of the workflow of each selection method, with their checklists, durations and evidence, as the governance rule `PROCUREMENT_WORKFLOW` keeps them. A new version is a
 * draft that another person submits and a third approves; a package that already started keeps the version it started under. The built-in default is shown with its source and "chưa kiểm chứng": it is configuration, not law.
 */
export default function DefinitionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <DefinitionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

interface ItemParams {
  code: string;
  name: string;
  required: boolean;
  owner_role: string;
  due_offset_working_days: number;
  evidence_kinds: string[];
  evidence_required: boolean;
  milestone_kind?: string;
}
interface StepParams {
  code: string;
  name: string;
  entry_condition: string;
  exit_condition: string;
  responsible_role: string;
  standard_working_days: number;
  evidence_kinds: string[];
  milestone_kind?: string;
  maker_checker: boolean;
  checklist: ItemParams[];
}
interface Params {
  method: string;
  name: string;
  stalled_after_working_days: number;
  checklist_warn_days: number;
  steps: StepParams[];
}

const asParams = (raw: Record<string, unknown>): Params | undefined => (Array.isArray(raw.steps) && typeof raw.method === 'string' ? (JSON.parse(JSON.stringify(raw)) as Params) : undefined);

function Viewer({ params }: { params: Params }) {
  const { t } = useTranslation();
  return (
    <ol className="prc1-defs" aria-label={t('prc1.def.steps.label')}>
      {params.steps.map((step, index) => (
        <li key={step.code} className="prc1-def">
          <div className="prc1-def__head">
            <strong>{`${index + 1}. ${step.name}`}</strong>
            <span className="sub">{t('prc1.def.step.summary', { role: step.responsible_role, days: step.standard_working_days })}</span>
            {step.maker_checker && <StatusPill tone="info">{t('prc1.def.makerChecker.name')}</StatusPill>}
            {step.milestone_kind !== undefined && <StatusPill tone="neutral">{milestoneLabel(t, step.milestone_kind)}</StatusPill>}
          </div>
          <p className="sub">{t('prc1.def.entry.text', { text: step.entry_condition })}</p>
          <p className="sub">{t('prc1.def.exit.text', { text: step.exit_condition })}</p>
          {step.evidence_kinds.length > 0 && <p className="sub">{t('prc1.def.evidence.text', { kinds: step.evidence_kinds.map((kind) => evidenceKindLabel(t, kind)).join(', ') })}</p>}
          {step.checklist.length > 0 && (
            <details>
              <summary>{t('prc1.def.checklist.summary', { count: step.checklist.length })}</summary>
              <ul className="prc1-list">
                {step.checklist.map((item) => (
                  <li key={item.code}>{t('prc1.def.item.text', { name: item.name, required: item.required ? t('prc1.item.required.name') : t('prc1.item.optional.name'), role: item.owner_role, days: item.due_offset_working_days })}</li>
                ))}
              </ul>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}

function Editor({ base, method, onSaved, onCancel }: { base: Params; method: string; onSaved: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [params, setParams] = useState<Params>(() => JSON.parse(JSON.stringify(base)) as Params);
  const [from, setFrom] = useState('');
  const [reason, setReason] = useState('');
  const create = useCreateDraft();
  const change = (mutate: (next: Params) => void): void =>
    setParams((current) => {
      const next = JSON.parse(JSON.stringify(current)) as Params;
      mutate(next);
      return next;
    });
  const move = (index: number, by: -1 | 1): void =>
    change((next) => {
      const target = index + by;
      const one = next.steps[index];
      const other = next.steps[target];
      if (one === undefined || other === undefined) return;
      next.steps[index] = other;
      next.steps[target] = one;
    });
  const ready = from !== '' && reason.trim().length >= 5;
  return (
    <form
      className="prc1-editor"
      aria-label={t('prc1.def.editor.label')}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) create.mutate({ code: method, params: params as unknown as Record<string, unknown>, effectiveFrom: from, reason: reason.trim() }, { onSuccess: onSaved });
      }}
    >
      <div className="prc1-editor__top">
        <div className="field">
          <label htmlFor="prc1-def-name">{t('prc1.def.name.label')}</label>
          <input id="prc1-def-name" value={params.name} onChange={(event) => change((next) => { next.name = event.target.value; })} />
        </div>
        <div className="field">
          <label htmlFor="prc1-def-stalled">{t('prc1.def.stalled.label')}</label>
          <input id="prc1-def-stalled" type="number" min={1} max={365} value={params.stalled_after_working_days} onChange={(event) => change((next) => { next.stalled_after_working_days = Number(event.target.value); })} />
        </div>
        <div className="field">
          <label htmlFor="prc1-def-warn">{t('prc1.def.warn.label')}</label>
          <input id="prc1-def-warn" type="number" min={0} max={30} value={params.checklist_warn_days} onChange={(event) => change((next) => { next.checklist_warn_days = Number(event.target.value); })} />
        </div>
      </div>
      <ol className="prc1-defs">
        {params.steps.map((step, index) => (
          <li key={step.code} className="prc1-def" data-step={step.code}>
            <div className="prc1-def__head">
              <span className="prc1-def__order">{index + 1}</span>
              <div className="field">
                <label htmlFor={`prc1-s-${step.code}-name`}>{t('prc1.def.stepName.label')}</label>
                <input id={`prc1-s-${step.code}-name`} value={step.name} onChange={(event) => change((next) => { (next.steps[index] as StepParams).name = event.target.value; })} />
              </div>
              <div className="field">
                <label htmlFor={`prc1-s-${step.code}-role`}>{t('prc1.def.role.label')}</label>
                <input id={`prc1-s-${step.code}-role`} value={step.responsible_role} onChange={(event) => change((next) => { (next.steps[index] as StepParams).responsible_role = event.target.value.toUpperCase(); })} />
              </div>
              <div className="field">
                <label htmlFor={`prc1-s-${step.code}-days`}>{t('prc1.def.days.label')}</label>
                <input id={`prc1-s-${step.code}-days`} type="number" min={0} max={365} value={step.standard_working_days} onChange={(event) => change((next) => { (next.steps[index] as StepParams).standard_working_days = Number(event.target.value); })} />
              </div>
              <label className="checkbox">
                <input type="checkbox" checked={step.maker_checker} onChange={(event) => change((next) => { (next.steps[index] as StepParams).maker_checker = event.target.checked; })} /> {t('prc1.def.makerChecker.name')}
              </label>
              <span className="prc1-def__move">
                <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={index === 0} aria-label={t('prc1.def.up.label', { name: step.name })} onClick={() => move(index, -1)}>↑</button>
                <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={index === params.steps.length - 1} aria-label={t('prc1.def.down.label', { name: step.name })} onClick={() => move(index, 1)}>↓</button>
              </span>
            </div>
            <ul className="prc1-list">
              {step.checklist.map((item, position) => (
                <li key={item.code} className="prc1-def__item">
                  <input aria-label={t('prc1.def.itemName.label', { step: step.name })} value={item.name} onChange={(event) => change((next) => { ((next.steps[index] as StepParams).checklist[position] as ItemParams).name = event.target.value; })} />
                  <label className="checkbox">
                    <input type="checkbox" checked={item.required} onChange={(event) => change((next) => { ((next.steps[index] as StepParams).checklist[position] as ItemParams).required = event.target.checked; })} /> {t('prc1.item.required.name')}
                  </label>
                  <input type="number" min={0} max={365} aria-label={t('prc1.def.itemDue.label', { name: item.name })} value={item.due_offset_working_days} onChange={(event) => change((next) => { ((next.steps[index] as StepParams).checklist[position] as ItemParams).due_offset_working_days = Number(event.target.value); })} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <div className="prc1-editor__foot">
        <div className="field">
          <label htmlFor="prc1-def-from">{t('prc1.def.from.label')}</label>
          <input id="prc1-def-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="prc1-def-reason">{t('prc1.dialog.reason.label')}</label>
          <textarea id="prc1-def-reason" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} required />
          <span className="ui-dialog__hint">{t('prc1.dialog.reason.hint')}</span>
        </div>
        {create.isError && <p className="callout" role="alert">{errorText(t, create.error)}</p>}
        <div className="prc1-editor__actions">
          <button type="button" className="ui-button ui-button--outline" onClick={onCancel}>{t('prc1.dialog.cancel.action')}</button>
          <button type="submit" className="ui-button ui-button--primary" disabled={!ready || create.isPending}>{create.isPending ? t('ui.confirmDialog.pending') : t('prc1.def.save.action')}</button>
        </div>
      </div>
    </form>
  );
}

function DefinitionContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const requested = search.get('method');
  const method = requested !== null && (METHODS as readonly string[]).includes(requested) ? requested : METHODS[0];
  const effective = useEffectiveRule(method);
  const versions = useRuleVersions(method);
  const move = useMoveRule();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<{ version: RuleVersion; move: 'submit' | 'approve' | 'withdraw' } | undefined>(undefined);
  const [lastError, setLastError] = useState<unknown>(undefined);
  const canManage = permissions?.includes(GOVERNANCE_MANAGE) === true && mode !== 'READ_ONLY';
  const canApprove = permissions?.includes(GOVERNANCE_APPROVE) === true && mode !== 'READ_ONLY';
  const state = useScreenState({ isLoading: effective.isLoading, error: effective.error, data: effective.data, isEmpty: () => false });
  const params = useMemo(() => (effective.data === undefined ? undefined : asParams(effective.data.params)), [effective.data]);
  const me = tenant?.membershipId;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prc1.def.page.title')}</h1>
          <p>{t('prc1.def.page.subtitle')}</p>
        </div>
        {canManage && params !== undefined && !editing && (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setEditing(true)}>
              {t('prc1.def.edit.action')}
            </button>
          </div>
        )}
      </div>
      <div className="prc1-views" role="tablist" aria-label={t('prc1.def.methods.label')}>
        {METHODS.map((code) => (
          <button key={code} type="button" role="tab" aria-selected={code === method} tabIndex={code === method ? 0 : -1} className={`prc1-views__tab${code === method ? ' is-active' : ''}`} onClick={() => { setEditing(false); setSearch({ method: code }); }}>
            {methodLabel(t, code)}
          </button>
        ))}
      </div>
      <ContextBar items={[{ label: t('prc1.context.scope.label'), value: tenant?.name ?? t('prc1.column.none.text') }, { label: t('prc1.def.version.label'), value: effective.data === undefined ? t('prc1.column.none.text') : effective.data.version === 0 ? t('prc1.audit.definition.default') : t('prc1.audit.definition.rule', { version: effective.data.version }) }]} {...(effective.data === undefined ? {} : { asOf: effective.data.as_of })} />
      <StateBoundary state={state} onRetry={() => void effective.refetch()}>
        {effective.data !== undefined && params !== undefined && (
          <>
            <SectionCard
              title={params.name}
              status={effective.data.unverified || effective.data.provenance?.legal_status === 'UNVERIFIED' ? <StatusPill tone="warning" icon="⚠">{t('prc1.def.unverified.name')}</StatusPill> : <StatusPill tone="success">{t('prc1.def.verified.name')}</StatusPill>}
            >
              {effective.data.provenance !== null && (
                <dl className="prc1-provenance">
                  <div><dt>{t('prc1.info.formula.label')}</dt><dd>{effective.data.provenance.formula}</dd></div>
                  <div><dt>{t('prc1.info.source.label')}</dt><dd>{effective.data.provenance.source}</dd></div>
                  <div><dt>{t('prc1.info.asOf.label')}</dt><dd>{effective.data.provenance.as_of}</dd></div>
                </dl>
              )}
              <p className="sub">{t('prc1.def.help.text', { stalled: params.stalled_after_working_days, warn: params.checklist_warn_days })}</p>
              {editing ? <Editor base={params} method={method} onSaved={() => { setEditing(false); void versions.refetch(); }} onCancel={() => setEditing(false)} /> : <Viewer params={params} />}
            </SectionCard>
            <SectionCard title={t('prc1.def.versions.title')}>
              {versions.isError ? (
                <p className="callout" role="alert">{t('prc1.def.versions.error')}</p>
              ) : (versions.data ?? []).length === 0 ? (
                <p className="sub" data-testid="no-versions">{t('prc1.def.versions.none')}</p>
              ) : (
                <table className="prc1-weeks">
                  <caption className="ui-sr-only">{t('prc1.def.versions.title')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('prc1.def.versions.version')}</th>
                      <th scope="col">{t('prc1.def.versions.status')}</th>
                      <th scope="col">{t('prc1.def.versions.from')}</th>
                      <th scope="col">{t('prc1.def.versions.reason')}</th>
                      <th scope="col"><span className="ui-sr-only">{t('prc1.def.versions.actions')}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(versions.data ?? []).map((version) => {
                      const mine = me !== undefined && (version.created_by === me || version.submitted_by === me);
                      return (
                        <tr key={version.id} data-version={version.version}>
                          <th scope="row">{version.version}</th>
                          <td>{version.status}</td>
                          <td>{version.effective_from}</td>
                          <td>{version.reason}</td>
                          <td>
                            <MakerCheckerBadge maker={version.created_by === me ? t('prc1.def.maker.you') : t('prc1.def.maker.other')} checker={version.approved_by === null ? null : version.approved_by === me ? t('prc1.def.maker.you') : t('prc1.def.maker.other')} />
                            {version.status === 'DRAFT' && canManage && <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPending({ version, move: 'submit' })}>{t('prc1.def.submit.action')}</button>}
                            {version.status === 'SUBMITTED' && canManage && <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPending({ version, move: 'withdraw' })}>{t('prc1.def.withdraw.action')}</button>}
                            {version.status === 'SUBMITTED' && canApprove && <button type="button" className="ui-button ui-button--primary ui-button--small" disabled={mine} title={mine ? t('prc1.def.approve.self') : undefined} onClick={() => setPending({ version, move: 'approve' })}>{t('prc1.def.approve.action')}</button>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </SectionCard>
          </>
        )}
      </StateBoundary>
      {pending !== undefined && (
        <ConfirmDialog
          open
          title={pending.move === 'submit' ? t('prc1.def.submit.title') : pending.move === 'approve' ? t('prc1.def.approve.title') : t('prc1.def.withdraw.title')}
          context={[{ label: t('prc1.filter.method.label'), value: methodLabel(t, method) }, { label: t('prc1.def.versions.version'), value: String(pending.version.version) }]}
          confirmLabel={pending.move === 'submit' ? t('prc1.def.submit.action') : pending.move === 'approve' ? t('prc1.def.approve.action') : t('prc1.def.withdraw.action')}
          cancelLabel={t('prc1.dialog.cancel.action')}
          pending={move.isPending}
          error={lastError === undefined ? undefined : errorText(t, lastError)}
          reason={{ label: t('prc1.dialog.reason.label'), required: true, minLength: 5, hint: t('prc1.dialog.reason.hint') }}
          onCancel={() => { setPending(undefined); setLastError(undefined); }}
          onConfirm={(text) => move.mutate({ ruleId: pending.version.id, version: pending.version.resource_version, move: pending.move, reason: text ?? '' }, { onSuccess: () => { setPending(undefined); setLastError(undefined); void versions.refetch(); void effective.refetch(); }, onError: setLastError })}
        />
      )}
      <p className="prototype-note">{t('prc1.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
