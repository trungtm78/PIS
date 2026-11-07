import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, SectionCard } from '../../../ui';
import { LegalChip, ParamsForm, periodText } from './components';
import { useCatalogue, useCreateDraft, useEffective, useRule, useVersions } from './hooks';
import { problemText, refusalText } from './labels';
import { MANAGE_PERMISSION, READ_PERMISSION, REASON_MAX, REASON_MIN, allProblems, blankParams, dayText, describeRefusal, draftOfParams, isDay, isReason, isRuleCode, isRuleType, isUuid, momentText, paramsOfDraft, periodNotices, resourceIdOf, textParam } from './model';
import type { Draft, PeriodNotice, Problem, Refusal } from './model';
import '../adm-kit.css';
import './governance.css';

interface Written {
  id: string;
  code: string;
  ruleType: string;
  time: string;
}

/**
 * ADM-21: write the next version of a governance rule (G0-1). The form is generated from the schema of the rule type, so a number is a number with its range and unit and a day is a day; it starts from what is in
 * force (or from the version chosen) so that a change is a small edit, warns before it is written when the period would overlap an approved version or begin in the past, and asks for a reason. Writing a draft
 * changes nothing that governs: it must be submitted and approved by a third person (ADM-20).
 */
export default function RuleDraftScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <DraftContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DraftContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const [params] = useSearchParams();
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const canWrite = mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(MANAGE_PERMISSION));
  const fromId = textParam(params.get('from'));
  const [ruleType, setRuleType] = useState(textParam(params.get('type')) ?? '');
  const [code, setCode] = useState(textParam(params.get('code')) ?? '');
  const [unit, setUnit] = useState(textParam(params.get('unit_id')) ?? '');
  const [edited, setEdited] = useState<Draft | undefined>(undefined);
  const [fromDay, setFromDay] = useState<string | undefined>(undefined);
  const [toDay, setToDay] = useState('');
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  const [written, setWritten] = useState<Written | undefined>(undefined);
  const create = useCreateDraft();

  const typeOk = isRuleType(ruleType);
  const codeOk = isRuleCode(code);
  const unitOk = unit === '' || isUuid(unit);
  const unitId = unit !== '' && unitOk ? unit : undefined;
  const catalogue = useCatalogue(mayRead && canWrite);
  const entry = catalogue.data?.find((one) => one.ruleType === ruleType);
  const schema = entry?.schema;
  const base = useRule(fromId !== undefined && isUuid(fromId) ? fromId : undefined);
  const effective = useEffective(typeOk ? ruleType : undefined, codeOk ? code : undefined, unitId, mayRead && canWrite && typeOk && codeOk);
  const versions = useVersions(typeOk ? ruleType : undefined, codeOk ? code : undefined, unitId, mayRead && canWrite && typeOk && codeOk);
  const baseLoading = (fromId !== undefined && isUuid(fromId) && base.isLoading) || (typeOk && codeOk && effective.isLoading);
  const baseParams = base.data?.params ?? effective.data?.params;
  const today = effective.data?.asOf ?? '';
  const draft: Draft | undefined = edited ?? (schema === undefined ? undefined : baseLoading ? undefined : baseParams === undefined ? blankParams(schema) : draftOfParams(schema, baseParams));
  const from = fromDay ?? today;
  const toOk = toDay === '' || (isDay(toDay) && (!isDay(from) || toDay > from));
  const queryState = useScreenState({ isLoading: catalogue.isLoading, error: catalogue.error, data: catalogue.data, isEmpty: () => false });
  const state = !mayRead || !canWrite ? 'denied' : queryState;

  const problems: Problem[] = schema === undefined || draft === undefined ? [] : allProblems(ruleType, schema, draft);
  const serverProblem: Problem[] = refusal?.kind === 'params' && refusal.path !== undefined ? [{ path: refusal.path, code: 'server' }] : [];
  const shown = attempted ? [...problems, ...serverProblem] : serverProblem;
  const periodProblems: string[] = [];
  if (attempted) {
    if (!typeOk) periodProblems.push(t('gova1.form.error.type'));
    if (!codeOk) periodProblems.push(t('gova1.form.error.code'));
    if (!unitOk) periodProblems.push(t('gova1.form.error.unit'));
    if (!isDay(from)) periodProblems.push(t('gova1.form.error.from'));
    if (!toOk) periodProblems.push(t('gova1.form.error.to'));
    if (!isReason(reason)) periodProblems.push(t('gova1.form.error.reason', { min: REASON_MIN, max: REASON_MAX }));
  }
  const notices = isDay(from) && (toDay === '' || isDay(toDay)) ? periodNotices(versions.data ?? [], from, toDay === '' ? null : toDay, today) : [];

  const reset = (): void => {
    setEdited(undefined);
    setAttempted(false);
    setRefusal(undefined);
    setWritten(undefined);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    setRefusal(undefined);
    const ready = schema !== undefined && draft !== undefined && typeOk && codeOk && unitOk && isDay(from) && toOk && isReason(reason) && allProblems(ruleType, schema, draft).length === 0;
    if (!ready || schema === undefined || draft === undefined) return;
    create.mutate(
      { ruleType, code, unitId, params: paramsOfDraft(schema, draft), effectiveFrom: from, effectiveTo: toDay === '' ? undefined : toDay, reason: reason.trim() },
      {
        onSuccess: (result) => setWritten({ id: resourceIdOf(result) ?? '', code, ruleType, time: momentText(new Date().toISOString(), locale) }),
        onError: (error) => setRefusal(describeRefusal(error)),
      },
    );
  };

  const locked = create.isPending || written !== undefined;
  const summary = [...problems.map((problem) => ({ path: problem.path, text: `${problem.path}: ${problemText(t, problem)}` })), ...periodProblems.map((text) => ({ path: text, text }))];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gova1.form.title')}</h1>
          <p>{t('gova1.form.subtitle')}</p>
        </div>
        <nav className="gova1-links" aria-label={t('gova1.links.label')}>
          <Link to="/adm/adm-19" data-testid="link-catalogue">
            {t('gova1.detail.link.catalogue')}
          </Link>
          {typeOk && codeOk ? (
            <Link to={`/adm/adm-20?type=${encodeURIComponent(ruleType)}&code=${encodeURIComponent(code)}`} data-testid="link-versions">
              {t('gova1.form.link.versions')}
            </Link>
          ) : null}
        </nav>
      </div>
      <ContextBar items={[{ label: t('gova1.ctx.scope'), value: tenant?.name ?? t('gova1.ctx.scopeAll') }, ...(typeOk ? [{ label: t('gova1.ctx.type'), value: ruleType }] : []), ...(codeOk ? [{ label: t('gova1.ctx.code'), value: code }] : [])]} />
      <StateBoundary state={state} onRetry={() => void catalogue.refetch()}>
        {written !== undefined ? (
          <div className="gova1-callout gova1-callout--ok" role="status" data-testid="written">
            <p>{t('gova1.form.written', { code: written.code, time: written.time })}</p>
            <p className="gova1-actions">
              <Link to={`/adm/adm-20?type=${encodeURIComponent(written.ruleType)}&code=${encodeURIComponent(written.code)}`} data-testid="open-versions">
                {t('gova1.form.written.open')}
              </Link>
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={reset} data-testid="again">
                {t('gova1.form.written.again')}
              </button>
            </p>
          </div>
        ) : null}
        {refusal === undefined ? null : (
          <p className="gova1-callout gova1-callout--error" role="alert" data-testid="refusal">
            {refusalText(t, refusal)}
          </p>
        )}
        {attempted && summary.length > 0 ? (
          <div className="gova1-callout gova1-callout--error" role="alert" data-testid="summary">
            <p>{t('gova1.form.summary', { count: summary.length })}</p>
            <ul>
              {summary.map((item) => (
                <li key={item.text}>{item.text}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <form onSubmit={submit} noValidate aria-label={t('gova1.form.title')}>
          <SectionCard title={t('gova1.form.target.title')}>
            <div className="gova1-head">
              <div className="gova1-field">
                <label htmlFor="gova1-type">{t('gova1.form.type')}</label>
                <select
                  id="gova1-type"
                  value={ruleType}
                  disabled={locked}
                  aria-invalid={attempted && !typeOk}
                  data-testid="type"
                  onChange={(event) => {
                    setRuleType(event.target.value);
                    setEdited(undefined);
                  }}
                >
                  <option value="">{t('gova1.form.choose')}</option>
                  {(catalogue.data ?? []).filter((one) => one.registered).map((one) => (
                    <option key={one.ruleType} value={one.ruleType}>
                      {one.ruleType}
                    </option>
                  ))}
                </select>
              </div>
              <div className="gova1-field">
                <label htmlFor="gova1-code">{t('gova1.form.code')}</label>
                <input
                  id="gova1-code"
                  type="text"
                  list="gova1-codes"
                  autoComplete="off"
                  value={code}
                  disabled={locked}
                  aria-invalid={attempted && !codeOk}
                  data-testid="code"
                  onChange={(event) => {
                    setCode(event.target.value.toUpperCase());
                    setEdited(undefined);
                  }}
                />
                <datalist id="gova1-codes">
                  {(entry?.codes ?? []).map((one) => (
                    <option key={one.code} value={one.code} />
                  ))}
                </datalist>
                <span className="gova1-hint">{t('gova1.form.code.hint')}</span>
              </div>
              <div className="gova1-field">
                <label htmlFor="gova1-unit">
                  {t('gova1.form.unit')} <span className="gova1-optional">({t('gova1.form.optional')})</span>
                </label>
                <input id="gova1-unit" type="text" autoComplete="off" value={unit} disabled={locked} aria-invalid={attempted && !unitOk} data-testid="unit" onChange={(event) => setUnit(event.target.value.trim())} />
                <span className="gova1-hint">{t('gova1.form.unit.hint')}</span>
              </div>
            </div>
            {entry === undefined || entry.legalStatus === null ? null : (
              <p className="gova1-chips">
                {entry.legalStatus === 'UNVERIFIED' ? <LegalChip status="UNVERIFIED" /> : null}
                <span className="adm-kit-sub">{entry.formula ?? ''}</span>
              </p>
            )}
          </SectionCard>
          {ruleType === '' ? (
            <p className="gova1-callout" role="status" data-testid="pick-type">
              {t('gova1.form.pickType')}
            </p>
          ) : entry === undefined ? (
            <p className="gova1-callout gova1-callout--error" role="alert" data-testid="unknown-type">
              {t('gova1.detail.unknownType', { type: ruleType })}
            </p>
          ) : schema === undefined ? (
            <p className="gova1-callout gova1-callout--error" role="alert" data-testid="no-schema">
              {t('gova1.form.noSchema', { type: ruleType })}
            </p>
          ) : (
            <>
              <SectionCard title={t('gova1.form.params.title')}>
                {baseLoading || draft === undefined ? (
                  <div role="status" aria-busy="true" aria-label={t('states.loading.label')} className="skeleton" data-testid="params-loading" />
                ) : (
                  <>
                    <p className="adm-kit-sub" data-testid="params-base">
                      {fromId !== undefined && base.data !== null && base.data !== undefined
                        ? t('gova1.form.base.version', { version: base.data.version })
                        : effective.data === null || effective.data === undefined
                          ? t('gova1.form.base.blank')
                          : effective.data.source === 'RULE'
                            ? t('gova1.form.base.rule', { version: effective.data.version })
                            : t('gova1.form.base.default')}
                    </p>
                    <ParamsForm ruleType={ruleType} schema={schema} draft={draft} onChange={setEdited} problems={shown} disabled={locked} />
                  </>
                )}
              </SectionCard>
              <SectionCard title={t('gova1.form.period.title')}>
                <div className="gova1-head">
                  <div className="gova1-field">
                    <label htmlFor="gova1-from">{t('gova1.form.from')}</label>
                    <input id="gova1-from" type="date" value={from} disabled={locked} aria-invalid={attempted && !isDay(from)} data-testid="from" onChange={(event) => setFromDay(event.target.value)} />
                    <span className="gova1-hint">{t('gova1.form.from.hint')}</span>
                  </div>
                  <div className="gova1-field">
                    <label htmlFor="gova1-to">
                      {t('gova1.form.to')} <span className="gova1-optional">({t('gova1.form.optional')})</span>
                    </label>
                    <input id="gova1-to" type="date" value={toDay} disabled={locked} aria-invalid={attempted && !toOk} data-testid="to" onChange={(event) => setToDay(event.target.value)} />
                    <span className="gova1-hint">{t('gova1.form.to.hint')}</span>
                  </div>
                </div>
                <div data-testid="notices">
                  {notices.map((notice) => (
                    <Notice key={noticeKey(notice)} notice={notice} />
                  ))}
                </div>
                {isDay(from) ? <p className="adm-kit-sub">{periodText(t, from, toDay === '' ? null : toDay)}</p> : null}
              </SectionCard>
              <SectionCard title={t('gova1.form.reason.title')}>
                <div className="gova1-field">
                  <label htmlFor="gova1-reason">{t('gova1.form.reason')}</label>
                  <textarea id="gova1-reason" rows={3} value={reason} disabled={locked} aria-invalid={attempted && !isReason(reason)} aria-describedby="gova1-reason-hint" data-testid="reason" onChange={(event) => setReason(event.target.value)} />
                  <span className="gova1-hint" id="gova1-reason-hint">
                    {t('gova1.form.reason.hint', { min: REASON_MIN, max: REASON_MAX })}
                  </span>
                </div>
              </SectionCard>
              <p className="gova1-actions">
                <button type="submit" className="ui-button ui-button--primary" disabled={locked} data-testid="save">
                  {create.isPending ? t('gova1.form.saving') : t('gova1.form.save')}
                </button>
                <span className="adm-kit-sub">{t('gova1.form.save.hint')}</span>
              </p>
            </>
          )}
        </form>
        <p className="adm-kit-foot" data-testid="footer">
          {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
        </p>
      </StateBoundary>
    </section>
  );
}

const noticeKey = (notice: PeriodNotice): string => (notice.kind === 'takeover' || notice.kind === 'conflict' ? `${notice.kind}:${notice.version}` : notice.kind);

/** A warning about the period, in words with a glyph: a takeover is information, an overlap or a day in the past is a warning (the server judges again when the version is approved). */
function Notice({ notice }: { notice: PeriodNotice }) {
  const { t } = useTranslation();
  switch (notice.kind) {
    case 'takeover':
      return (
        <p className="gova1-callout" role="status" data-testid="notice-takeover">
          <span aria-hidden="true">ⓘ </span>
          {t('gova1.notice.takeover', { version: notice.version, day: dayText(notice.endsOn) })}
        </p>
      );
    case 'conflict':
      return (
        <p className="gova1-callout gova1-callout--warn" role="status" data-testid="notice-conflict">
          <span aria-hidden="true">⚠ </span>
          {t('gova1.notice.conflict', { version: notice.version, from: dayText(notice.from), to: notice.to === null ? t('gova1.period.noEnd') : dayText(notice.to) })}
        </p>
      );
    case 'startPast':
      return (
        <p className="gova1-callout gova1-callout--warn" role="status" data-testid="notice-past">
          <span aria-hidden="true">⚠ </span>
          {t('gova1.notice.startPast')}
        </p>
      );
    case 'endBeforeStart':
      return (
        <p className="gova1-callout gova1-callout--error" role="status" data-testid="notice-end">
          <span aria-hidden="true">⚠ </span>
          {t('gova1.notice.endBeforeStart')}
        </p>
      );
  }
}
