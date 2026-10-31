import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useCreateLayout, useLayoutProfiles, usePublishLayout } from './layout/hooks';
import { EMPTY_FORM, MARGINS, MARGIN_RANGES, SEAL_OVERLAP_TARGET, SEAL_OVERLAP_TOLERANCE, SIZE_RANGES, boxOfForm, canPublish, describeProblem, formFrom, hasProblems, layoutBody, sealOverlapRatio, validateForm } from './layout/rules';
import type { BoxForm, FieldProblem, FormProblems, LayoutForm, LayoutProblem } from './layout/rules';
import { APPROVE_LAYOUT_PERMISSION, ELEMENTS, MANAGE_LAYOUT_PERMISSION, READ_LAYOUT_PERMISSION } from './layout/types';
import type { Element, LayoutStatus } from './layout/types';

type T = Translator['t'];
const TEMPLATES_PATH = '/doc/doc-14';
const NONE = '—';

function problemMessage(t: T, problem: LayoutProblem): string {
  switch (problem) {
    case 'outOfRange':
      return t('doc.layout.problem.outOfRange');
    case 'legalBasis':
      return t('doc.layout.problem.legalBasis');
    case 'selfApproval':
      return t('doc.layout.problem.selfApproval');
    case 'state':
      return t('doc.layout.problem.state');
    case 'overlap':
      return t('doc.layout.problem.overlap');
    case 'conflict':
      return t('doc.layout.problem.conflict');
    case 'invalid':
      return t('doc.layout.problem.invalid');
    case 'scope':
      return t('doc.layout.problem.scope');
    case 'notFound':
      return t('doc.layout.problem.notFound');
    case 'general':
      return t('doc.layout.problem.general');
  }
}

function statusLabel(t: T, status: LayoutStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('doc.layout.status.draft');
    case 'PUBLISHED':
      return t('doc.layout.status.published');
    case 'SUPERSEDED':
      return t('doc.layout.status.superseded');
  }
}

function elementLabel(t: T, element: Element): string {
  switch (element) {
    case 'nationalTitle':
      return t('doc.layout.element.nationalTitle');
    case 'motto':
      return t('doc.layout.element.motto');
    case 'agency':
      return t('doc.layout.element.agency');
    case 'number':
      return t('doc.layout.element.number');
    case 'placeDate':
      return t('doc.layout.element.placeDate');
    case 'docTypeName':
      return t('doc.layout.element.docTypeName');
    case 'summary':
      return t('doc.layout.element.summary');
    case 'body':
      return t('doc.layout.element.body');
    case 'signerTitle':
      return t('doc.layout.element.signerTitle');
    case 'signerName':
      return t('doc.layout.element.signerName');
    case 'recipientsLabel':
      return t('doc.layout.element.recipientsLabel');
    case 'recipientsList':
      return t('doc.layout.element.recipientsList');
    case 'pageNumber':
      return t('doc.layout.element.pageNumber');
  }
}

function marginLabel(t: T, margin: (typeof MARGINS)[number]): string {
  switch (margin) {
    case 'top':
      return t('doc.layout.margin.top');
    case 'bottom':
      return t('doc.layout.margin.bottom');
    case 'left':
      return t('doc.layout.margin.left');
    case 'right':
      return t('doc.layout.margin.right');
  }
}

function fieldMessage(t: T, problem: FieldProblem | undefined): string | undefined {
  switch (problem) {
    case undefined:
      return undefined;
    case 'required':
      return t('doc.layout.field.required.error');
    case 'invalid':
      return t('doc.layout.field.invalid.error');
    case 'outOfRange':
      return t('doc.layout.field.outOfRange.error');
  }
}

const range = (min: number, max: number): string => (min === max ? String(min) : `${min}–${max}`);

/** DOC-16: the formatting of Appendix I of Decree 30/2020 as data (ST-DOC-016, BR-DOC-13). A revision is drafted with every value inside its legal range and published by someone else. */
export default function LayoutProfilesScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The form being filled belongs to one tenant: a switch starts the screen over.
  return <LayoutProfilesContent key={tenantId ?? 'none'} route={route} />;
}

function LayoutProfilesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const frozen = mode === 'READ_ONLY';
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const mayRead = holds(READ_LAYOUT_PERMISSION);
  const mayManage = holds(MANAGE_LAYOUT_PERMISSION) && !frozen;
  const mayApprove = holds(APPROVE_LAYOUT_PERMISSION) && !frozen;
  const list = useLayoutProfiles(mayRead);
  const create = useCreateLayout();
  const publish = usePublishLayout();
  const [form, setForm] = useState<LayoutForm>(EMPTY_FORM);
  const [attempted, setAttempted] = useState(false);
  const [saved, setSaved] = useState(false);
  const profiles = list.data ?? [];
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const base = profiles.find((profile) => profile.id === form.baseId);
  const problems: FormProblems = attempted ? validateForm(form) : { margins: {}, sizes: {} };
  const leader = boxOfForm(form.leader);
  const seal = boxOfForm(form.seal);
  const failure = create.isError ? create : publish.isError ? publish : undefined;
  const refusal = failure === undefined ? undefined : describeProblem(failure.error);

  const set = (patch: Partial<LayoutForm>): void => {
    setSaved(false);
    setForm((value) => ({ ...value, ...patch }));
  };
  const setBox = (which: 'leader' | 'seal', patch: Partial<BoxForm>): void => set({ [which]: { ...form[which], ...patch } } as Partial<LayoutForm>);
  const choose = (id: string): void => {
    const chosen = profiles.find((profile) => profile.id === id);
    setAttempted(false);
    setSaved(false);
    setForm(chosen === undefined ? EMPTY_FORM : formFrom(chosen));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (base === undefined || create.isPending) return;
    if (hasProblems(validateForm(form))) return;
    create.mutate(layoutBody(form, base), {
      onSuccess: () => {
        setForm(EMPTY_FORM);
        setAttempted(false);
        setSaved(true);
      },
    });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="back-link">
        <Link to={TEMPLATES_PATH}>
          <span aria-hidden="true">← </span>
          {t('doc.layout.back.link')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.layout.page.title')}</h1>
          <p>{t('doc.layout.page.subtitle')}</p>
        </div>
      </div>
      {!mayRead ? (
        <p className="callout warning" role="status" data-testid="no-read">
          {t('doc.layout.read.denied')}
        </p>
      ) : (
        <>
          <section className="card" aria-labelledby="layout-ranges-title">
            <h2 id="layout-ranges-title">{t('doc.layout.ranges.title')}</h2>
            <p className="sub">{t('doc.layout.ranges.hint')}</p>
            <div className="tablewrap">
              <table aria-label={t('doc.layout.ranges.title')} data-testid="ranges">
                <thead>
                  <tr>
                    <th scope="col">{t('doc.layout.ranges.col.part')}</th>
                    <th scope="col">{t('doc.layout.ranges.col.allowed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {MARGINS.map((margin) => (
                    <tr key={margin}>
                      <td>{marginLabel(t, margin)}</td>
                      <td>{t('doc.layout.ranges.mm', { range: range(MARGIN_RANGES[margin].min, MARGIN_RANGES[margin].max) })}</td>
                    </tr>
                  ))}
                  {ELEMENTS.map((element) => (
                    <tr key={element}>
                      <td>{elementLabel(t, element)}</td>
                      <td>{t('doc.layout.ranges.pt', { range: range(SIZE_RANGES[element].min, SIZE_RANGES[element].max) })}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>{t('doc.layout.ranges.seal.part')}</td>
                    <td>{t('doc.layout.ranges.seal.allowed', { target: (SEAL_OVERLAP_TARGET * 100).toFixed(1), tolerance: (SEAL_OVERLAP_TOLERANCE * 100).toFixed(0) })}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="refusal">
              {problemMessage(t, refusal)}
            </p>
          )}
          <StateBoundary state={state} onRetry={() => void list.refetch()}>
            <div className="tablewrap">
              <table aria-label={t('doc.layout.list.aria')} data-testid="profiles">
                <thead>
                  <tr>
                    <th scope="col">{t('doc.layout.col.code')}</th>
                    <th scope="col">{t('doc.layout.col.revision')}</th>
                    <th scope="col">{t('doc.layout.col.period')}</th>
                    <th scope="col">{t('doc.layout.col.status')}</th>
                    <th scope="col">{t('doc.layout.col.confirmation')}</th>
                    <th scope="col">
                      <span className="sr-only">{t('doc.layout.col.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map((profile) => (
                    <tr key={profile.id} data-profile={profile.id} data-status={profile.status}>
                      <td>{profile.profileCode}</td>
                      <td>{profile.revision}</td>
                      <td>{t('doc.layout.period', { from: profile.effectiveFrom, until: profile.effectiveUntil ?? NONE })}</td>
                      <td>
                        <span className={profile.status === 'PUBLISHED' ? 'pill green' : 'pill gray'}>{statusLabel(t, profile.status)}</span>
                      </td>
                      <td>{profile.confirmationStatus === 'CONFIRMED' ? t('doc.layout.confirmation.confirmed') : t('doc.layout.confirmation.pending')}</td>
                      <td>
                        {mayApprove && canPublish(profile, tenant?.membershipId) ? (
                          <button type="button" disabled={publish.isPending} onClick={() => publish.mutate({ id: profile.id, version: profile.version })}>
                            {t('doc.layout.publish.action')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </StateBoundary>

          {mayManage ? (
            <form className="card" onSubmit={submit} noValidate aria-label={t('doc.layout.form.title')}>
              <h2>{t('doc.layout.form.title')}</h2>
              <p className="sub">{t('doc.layout.form.help')}</p>
              {saved ? (
                <p className="callout" role="status" data-testid="saved">
                  {t('doc.layout.form.saved')}
                </p>
              ) : null}
              <div className="field">
                <label htmlFor="layout-base">{t('doc.layout.field.base.label')}</label>
                <select id="layout-base" value={form.baseId} onChange={(event) => choose(event.target.value)}>
                  <option value="">{NONE}</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {t('doc.layout.field.base.option', { code: profile.profileCode, revision: profile.revision })}
                    </option>
                  ))}
                </select>
                <small>{t('doc.layout.field.base.hint')}</small>
              </div>
              {base === undefined ? null : (
                <>
                  <div className="field">
                    <label htmlFor="layout-code">{t('doc.layout.field.code.label')}</label>
                    <input id="layout-code" value={form.profileCode} onChange={(event) => set({ profileCode: event.target.value })} />
                    {fieldMessage(t, problems.profileCode) === undefined ? null : <small role="alert">{fieldMessage(t, problems.profileCode)}</small>}
                  </div>
                  <div className="field">
                    <label htmlFor="layout-from">{t('doc.layout.field.from.label')}</label>
                    <input id="layout-from" type="date" value={form.effectiveFrom} onChange={(event) => set({ effectiveFrom: event.target.value })} />
                    {fieldMessage(t, problems.effectiveFrom) === undefined ? null : <small role="alert">{fieldMessage(t, problems.effectiveFrom)}</small>}
                  </div>
                  <div className="field">
                    <label htmlFor="layout-until">{t('doc.layout.field.until.label')}</label>
                    <input id="layout-until" type="date" value={form.effectiveUntil} onChange={(event) => set({ effectiveUntil: event.target.value })} />
                    {fieldMessage(t, problems.effectiveUntil) === undefined ? null : <small role="alert">{fieldMessage(t, problems.effectiveUntil)}</small>}
                  </div>
                  <div className="field">
                    <label htmlFor="layout-basis">{t('doc.layout.field.basis.label')}</label>
                    <textarea id="layout-basis" rows={2} value={form.legalBasis} onChange={(event) => set({ legalBasis: event.target.value })} />
                    {fieldMessage(t, problems.legalBasis) === undefined ? null : <small role="alert">{fieldMessage(t, problems.legalBasis)}</small>}
                  </div>
                  <fieldset>
                    <legend>{t('doc.layout.margins.title')}</legend>
                    {MARGINS.map((margin) => (
                      <div className="field" key={margin}>
                        <label htmlFor={`layout-margin-${margin}`}>{t('doc.layout.field.margin.label', { margin: marginLabel(t, margin) })}</label>
                        <input id={`layout-margin-${margin}`} inputMode="decimal" value={form.margins[margin]} aria-invalid={problems.margins[margin] !== undefined} onChange={(event) => set({ margins: { ...form.margins, [margin]: event.target.value } })} />
                        <small role={problems.margins[margin] === undefined ? undefined : 'alert'}>
                          {fieldMessage(t, problems.margins[margin]) ?? t('doc.layout.ranges.mm', { range: range(MARGIN_RANGES[margin].min, MARGIN_RANGES[margin].max) })}
                        </small>
                      </div>
                    ))}
                  </fieldset>
                  <fieldset>
                    <legend>{t('doc.layout.sizes.title')}</legend>
                    {ELEMENTS.map((element) => (
                      <div className="field" key={element}>
                        <label htmlFor={`layout-size-${element}`}>{t('doc.layout.field.size.label', { element: elementLabel(t, element) })}</label>
                        <input id={`layout-size-${element}`} inputMode="decimal" value={form.sizes[element]} aria-invalid={problems.sizes[element] !== undefined} onChange={(event) => set({ sizes: { ...form.sizes, [element]: event.target.value } })} />
                        <small role={problems.sizes[element] === undefined ? undefined : 'alert'}>
                          {fieldMessage(t, problems.sizes[element]) ?? t('doc.layout.ranges.pt', { range: range(SIZE_RANGES[element].min, SIZE_RANGES[element].max) })}
                        </small>
                      </div>
                    ))}
                  </fieldset>
                  <fieldset>
                    <legend>{t('doc.layout.boxes.title')}</legend>
                    {(['leader', 'seal'] as const).map((which) => (
                      <div key={which} className="formgrid">
                        {(['x', 'y', 'width', 'height'] as const).map((side) => (
                          <div className="field" key={side}>
                            <label htmlFor={`layout-${which}-${side}`}>{t('doc.layout.field.box.label', { box: which === 'leader' ? t('doc.layout.box.leader') : t('doc.layout.box.seal'), side: boxSideLabel(t, side) })}</label>
                            <input id={`layout-${which}-${side}`} inputMode="decimal" value={form[which][side]} onChange={(event) => setBox(which, { [side]: event.target.value })} />
                          </div>
                        ))}
                      </div>
                    ))}
                    <p className="sub" data-testid="seal-overlap">
                      {leader === undefined || seal === undefined ? NONE : t('doc.layout.seal.overlap', { share: (sealOverlapRatio(leader, seal) * 100).toFixed(1) })}
                    </p>
                    {problems.boxes === undefined && problems.seal === undefined ? null : (
                      <p className="field-error" role="alert">
                        {problems.boxes !== undefined ? fieldMessage(t, problems.boxes) : t('doc.layout.field.seal.error')}
                      </p>
                    )}
                  </fieldset>
                  <div className="formfooter">
                    <button type="submit" className="primary" disabled={create.isPending}>
                      {t('doc.layout.form.submit.action')}
                    </button>
                  </div>
                </>
              )}
            </form>
          ) : null}
        </>
      )}
      <p className="prototype-note">{t('doc.layout.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function boxSideLabel(t: T, side: 'x' | 'y' | 'width' | 'height'): string {
  switch (side) {
    case 'x':
      return t('doc.layout.box.x');
    case 'y':
      return t('doc.layout.box.y');
    case 'width':
      return t('doc.layout.box.width');
    case 'height':
      return t('doc.layout.box.height');
  }
}
