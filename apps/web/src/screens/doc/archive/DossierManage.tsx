import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Info } from '../../gov11/gov11-kit';
import { useRetentionRules } from './hooks';
import { classLabel, dossierStatusLabel, fieldMessage, problemMessage } from './labels';
import { useAddDocument, useCloseDossier, useCreateDossier, useDossierDetail, useUnitChoices } from './manage-hooks';
import { EMPTY_ITEM, closeBody, dossierCreateBody, dossierCreateHasProblems, emptyDossierCreate, itemBody, itemHasProblems, ruleForClosing, validateDossierCreate, validateItem, validateSettlement } from './dossier-forms';
import type { DossierCreateForm, ItemForm } from './dossier-forms';
import { describeProblem } from './rules';
import type { Dossier } from './types';

export const MANAGE_DOSSIER_PERMISSION = 'doc.dossier.manage';

/** The day of the browser as `YYYY-MM-DD`. */
const today = (): string => new Date().toLocaleDateString('sv');

function Refusal({ error }: { error: unknown }) {
  const { t } = useTranslation();
  return (
    <p className="callout warning" role="alert" data-testid="refusal">
      {problemMessage(t, describeProblem(error))}
    </p>
  );
}

function FieldError({ message }: { message: string | undefined }) {
  return message === undefined ? null : <small role="alert">{message}</small>;
}

/**
 * Makes a dossier (DOC F11): its code and year, the title, the unit that keeps it and the category that decides how long it is kept. A dossier starts open; documents are put into it, and closing it fixes the retention rule in
 * force. The server refuses a code used twice in the year (409 `DOSSIER_CODE_DUPLICATE`).
 */
export function CreateDossierAction({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const create = useCreateDossier();
  const units = useUnitChoices(true);
  const rules = useRetentionRules(true);
  const [form, setForm] = useState<DossierCreateForm>(() => emptyDossierCreate(new Date().getFullYear()));
  const [attempted, setAttempted] = useState(false);
  const problems = attempted ? validateDossierCreate(form) : {};
  const categories = [...new Set((rules.data ?? []).filter((rule) => rule.status === 'PUBLISHED').map((rule) => rule.categoryCode))].sort();
  const set = (change: Partial<DossierCreateForm>): void => setForm({ ...form, ...change });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (create.isPending || dossierCreateHasProblems(validateDossierCreate(form))) return;
    create.mutate(dossierCreateBody(form), { onSuccess: onClose });
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('doc.dossier.create.title')} data-testid="create-dossier-form">
      <h2>{t('doc.dossier.create.title')}</h2>
      <p className="sub">{t('doc.dossier.create.help')}</p>
      {create.isError ? <Refusal error={create.error} /> : null}
      <div className="field">
        <label htmlFor="dossier-code">{t('doc.dossier.create.code')}</label>
        <input id="dossier-code" value={form.dossierCode} aria-invalid={problems.dossierCode !== undefined} onChange={(event) => set({ dossierCode: event.target.value })} />
        <FieldError message={fieldMessage(t, problems.dossierCode)} />
      </div>
      <div className="field">
        <label htmlFor="dossier-year">{t('doc.dossier.create.year')}</label>
        <input id="dossier-year" inputMode="numeric" value={form.year} aria-invalid={problems.year !== undefined} onChange={(event) => set({ year: event.target.value })} />
        <FieldError message={fieldMessage(t, problems.year)} />
      </div>
      <div className="field">
        <label htmlFor="dossier-title">{t('doc.dossier.create.name')}</label>
        <input id="dossier-title" value={form.title} aria-invalid={problems.title !== undefined} onChange={(event) => set({ title: event.target.value })} />
        <FieldError message={fieldMessage(t, problems.title)} />
      </div>
      <div className="field">
        <label htmlFor="dossier-unit">{t('doc.dossier.create.unit')}</label>
        {units.isError ? (
          <>
            <input id="dossier-unit" autoComplete="off" value={form.unitId} aria-invalid={problems.unitId !== undefined} onChange={(event) => set({ unitId: event.target.value.trim() })} />
            <small className="sub" data-testid="unit-typed">
              {t('doc.dossier.create.unit.typed')}
            </small>
          </>
        ) : (
          <select id="dossier-unit" value={form.unitId} disabled={units.isLoading} aria-invalid={problems.unitId !== undefined} onChange={(event) => set({ unitId: event.target.value })}>
            <option value="">{units.isLoading ? t('doc.dossier.create.unit.loading') : t('doc.dossier.create.unit.choose')}</option>
            {(units.data ?? []).map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.label}
              </option>
            ))}
          </select>
        )}
        <FieldError message={fieldMessage(t, problems.unitId)} />
      </div>
      <div className="field">
        <label htmlFor="dossier-category">{t('doc.dossier.create.category')}</label>
        {categories.length > 0 ? (
          <select id="dossier-category" value={form.categoryCode} aria-invalid={problems.categoryCode !== undefined} onChange={(event) => set({ categoryCode: event.target.value })}>
            <option value="">{t('doc.dossier.create.category.choose')}</option>
            {categories.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        ) : (
          <input id="dossier-category" value={form.categoryCode} aria-invalid={problems.categoryCode !== undefined} onChange={(event) => set({ categoryCode: event.target.value.toUpperCase() })} />
        )}
        <small className="sub">{rules.isError ? t('doc.dossier.create.category.typed') : t('doc.dossier.create.category.hint')}</small>
        <FieldError message={fieldMessage(t, problems.categoryCode)} />
      </div>
      <div className="field">
        <label htmlFor="dossier-module">{t('doc.dossier.create.subjectModule')}</label>
        <input id="dossier-module" value={form.subjectModule} aria-invalid={problems.subjectModule !== undefined} onChange={(event) => set({ subjectModule: event.target.value })} />
        <FieldError message={fieldMessage(t, problems.subjectModule)} />
      </div>
      <div className="field">
        <label htmlFor="dossier-subject">{t('doc.dossier.create.subjectId')}</label>
        <input id="dossier-subject" value={form.subjectId} aria-invalid={problems.subjectId !== undefined} onChange={(event) => set({ subjectId: event.target.value })} />
        <FieldError message={fieldMessage(t, problems.subjectId)} />
      </div>
      <div className="formfooter">
        <button type="button" onClick={onClose}>
          {t('doc.archive.action.cancel')}
        </button>
        <button type="submit" className="primary" disabled={create.isPending}>
          {t('doc.dossier.create.submit')}
        </button>
      </div>
    </form>
  );
}

/**
 * One dossier in full (`getDossier`): its contents, the retention rule that was applied, the legal hold; while it is open, a document is added to it and it is closed. Closing fixes the retention rule in force on the day
 * and starts the clock of the handover to the archive: the rule that would apply is shown before the person confirms.
 */
export function DossierDetailPanel({ dossier, frozen, onClose }: { dossier: Dossier; frozen: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const detail = useDossierDetail(dossier.id);
  const rules = useRetentionRules(dossier.status === 'OPEN');
  const add = useAddDocument();
  const close = useCloseDossier();
  const [item, setItem] = useState<ItemForm>(EMPTY_ITEM);
  const [settlement, setSettlement] = useState('');
  const [itemAttempted, setItemAttempted] = useState(false);
  const [closeAttempted, setCloseAttempted] = useState(false);
  const live = detail.data?.dossier ?? dossier;
  const itemProblems = itemAttempted ? validateItem(item) : {};
  const day = today();
  const settlementProblem = closeAttempted ? validateSettlement(settlement, day) : undefined;
  const plan = ruleForClosing(rules.data ?? [], live.categoryCode, day);
  const submitItem = (event: FormEvent): void => {
    event.preventDefault();
    setItemAttempted(true);
    if (add.isPending || itemHasProblems(validateItem(item))) return;
    add.mutate(
      { id: live.id, version: live.version, body: itemBody(item) },
      {
        onSuccess: () => {
          setItem(EMPTY_ITEM);
          setItemAttempted(false);
        },
      },
    );
  };
  const submitClose = (event: FormEvent): void => {
    event.preventDefault();
    setCloseAttempted(true);
    if (close.isPending || validateSettlement(settlement, day) !== undefined) return;
    close.mutate({ id: live.id, version: live.version, body: closeBody(settlement) }, { onSuccess: onClose });
  };
  const retention =
    live.status === 'OPEN'
      ? t('doc.dossier.detail.retention.open')
      : live.provisional
        ? t('doc.archive.retention.provisional')
        : `${live.retentionClass === null ? '—' : classLabel(t, live.retentionClass)}${live.retentionEndsOn === null ? '' : ` · ${t('doc.archive.retention.until', { date: live.retentionEndsOn })}`}`;
  return (
    <section className="card" aria-label={t('doc.dossier.detail.title', { code: dossier.dossierCode })} data-testid="dossier-detail">
      <h2>{t('doc.dossier.detail.title', { code: dossier.dossierCode })}</h2>
      {detail.isLoading ? (
        <div className="skeleton" role="status" aria-busy="true" aria-label={t('states.loading.label')} />
      ) : detail.isError || detail.data === undefined ? (
        <p className="callout warning" role="alert" data-testid="detail-error">
          {t('doc.dossier.detail.failed')}{' '}
          <button type="button" onClick={() => void detail.refetch()}>
            {t('doc.dossier.retry')}
          </button>
        </p>
      ) : (
        <>
          <p>
            <span className="pill green">{dossierStatusLabel(t, live.status)}</span>
            {live.holdActive ? <span className="pill red">{t('doc.archive.hold.active')}</span> : null}
          </p>
          <p data-testid="detail-retention">
            {t('doc.dossier.detail.retention')}: {retention}{' '}
            <Info name={t('doc.dossier.detail.retention')} rule={undefined} fallbackFormula={t('doc.dossier.detail.retention.formula')} owner={t('doc.dossier.detail.retention.owner')} asOf={detail.data.closedAt ?? day} />
          </p>
          {detail.data.items.length === 0 ? (
            <p className="callout" role="status" data-testid="detail-empty">
              {t('doc.dossier.detail.empty')}
            </p>
          ) : (
            <div className="tablewrap">
              <table aria-label={t('doc.dossier.detail.items')} data-testid="dossier-items">
                <thead>
                  <tr>
                    <th scope="col">{t('doc.dossier.detail.col.ordinal')}</th>
                    <th scope="col">{t('doc.dossier.detail.col.title')}</th>
                    <th scope="col">{t('doc.dossier.detail.col.kind')}</th>
                    <th scope="col">{t('doc.dossier.detail.col.issued')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.items.map((row) => (
                    <tr key={row.id}>
                      <td>{row.ordinal}</td>
                      <td>{row.title}</td>
                      <td>{row.docKind === '' ? row.docTypeCode : `${row.docKind} · ${row.docTypeCode}`}</td>
                      <td>{row.issuedOn ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {frozen ? null : (
            <>
              {live.mayAddDocument ? (
                <form onSubmit={submitItem} noValidate aria-label={t('doc.dossier.item.title')} data-testid="add-document-form">
                  <h3>{t('doc.dossier.item.title')}</h3>
                  {add.isError ? <Refusal error={add.error} /> : null}
                  <div className="field">
                    <label htmlFor="item-document">{t('doc.dossier.item.document')}</label>
                    <input id="item-document" value={item.documentId} aria-invalid={itemProblems.documentId !== undefined} onChange={(event) => setItem({ ...item, documentId: event.target.value })} />
                    <FieldError message={fieldMessage(t, itemProblems.documentId)} />
                  </div>
                  <div className="field">
                    <label htmlFor="item-ordinal">{t('doc.dossier.item.ordinal')}</label>
                    <input id="item-ordinal" inputMode="numeric" value={item.ordinal} aria-invalid={itemProblems.ordinal !== undefined} onChange={(event) => setItem({ ...item, ordinal: event.target.value })} />
                    <FieldError message={fieldMessage(t, itemProblems.ordinal)} />
                  </div>
                  <button type="submit" className="primary" disabled={add.isPending}>
                    {t('doc.dossier.item.submit')}
                  </button>
                </form>
              ) : null}
              {live.mayClose ? (
                <form onSubmit={submitClose} noValidate aria-label={t('doc.dossier.close.title')} data-testid="close-dossier-form">
                  <h3>{t('doc.dossier.close.title')}</h3>
                  <p className="sub" data-testid="close-rule">
                    {rules.isLoading
                      ? t('doc.dossier.close.rule.loading')
                      : rules.isError
                        ? t('doc.dossier.close.rule.failed')
                        : plan.rule === undefined
                          ? t('doc.dossier.close.rule.none')
                          : plan.provisional
                            ? t('doc.dossier.close.rule.unconfirmed', { class: classLabel(t, plan.rule.classCode) })
                            : t('doc.dossier.close.rule.found', { class: classLabel(t, plan.rule.classCode), basis: plan.rule.legalBasis })}
                  </p>
                  {close.isError ? <Refusal error={close.error} /> : null}
                  <div className="field">
                    <label htmlFor="close-settlement">{t('doc.dossier.close.settlement')}</label>
                    <input id="close-settlement" type="date" max={day} value={settlement} aria-invalid={settlementProblem !== undefined} onChange={(event) => setSettlement(event.target.value)} />
                    <small className="sub">{t('doc.dossier.close.settlement.hint')}</small>
                    <FieldError message={fieldMessage(t, settlementProblem)} />
                  </div>
                  <button type="submit" className="primary" disabled={close.isPending}>
                    {t('doc.dossier.close.submit')}
                  </button>
                </form>
              ) : null}
            </>
          )}
        </>
      )}
      <div className="formfooter">
        <button type="button" onClick={onClose}>
          {t('doc.dossier.detail.close')}
        </button>
      </div>
    </section>
  );
}
