import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { problemMessage as recordProblemMessage } from '../../qms/inspection/labels';
import { describeProblem as describeRecordProblem, emptyResult, hasProblems, resultBody, validateResult } from '../../qms/inspection/model';
import type { ResultForm } from '../../qms/inspection/model';
import { useRecordInspectionResult } from '../../qms/inspection/hooks';
import { useCategories, useUnits } from '../hooks';
import { describeProblem as describeIssueProblem } from '../issue-model';
import type { FormErrors } from '../issue-model';
import { useMoment } from '../issue-components';
import '../iss.css';
import { ChecklistPanel } from './ChecklistPanel';
import { RaisePanel } from './RaisePanel';
import type { ItemProgress } from './RaisePanel';
import { useRaiseIssue, useSiteChecks } from './hooks';
import { EMPTY_RAISE, ISSUE_CREATE_PERMISSION, READ_PERMISSION, RECORD_PERMISSION, holds, idsOf, isWorkable, itemsFromForm, itemsFromRecorded, raiseBody, validateRaise } from './model';
import type { RaiseForm, SiteCheck } from './model';

/**
 * ISS-05: a field inspection recorded against its checklist (ST-ISS-007). Saving the result raises one issue for every failed item, each under the quality module as its source and the item as its object; the position of
 * the inspector goes with the issues only if the inspector consented to it (BR-ISS-06, NFR-PRIVACY-02), and the screen does not even hold it after the consent is taken back. Recording the result and raising the issues are two
 * commands: when the second is left unfinished (a refusal, a lost connection) the inspection stays in the list with its failed items, and raising again finds the issues that exist (`DUPLICATE_SOURCE_OPEN`) and opens the rest.
 */
export default function SiteInspectionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form, the position and the progress belong to one membership: a switch of tenant or of membership starts the screen over.
  return <SiteInspectionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SiteInspectionContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const readable = holds(permissions, READ_PERMISSION);
  const checks = useSiteChecks(readable);
  const [search, setSearch] = useSearchParams();
  const workable = useMemo(() => (checks.data ?? []).filter(isWorkable), [checks.data]);
  const chosen = workable.find((check) => check.line.id === search.get('id')) ?? workable[0];
  const state = useScreenState({
    isLoading: readable && checks.isLoading,
    error: readable ? checks.error : undefined,
    data: readable && checks.data !== undefined ? workable : undefined,
    isEmpty: (data) => (data as SiteCheck[]).length === 0,
  });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('iss.field.page.title')}</h1>
          <p>{t('iss.field.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={readable ? state : 'denied'} onRetry={() => void checks.refetch()}>
        <div className="field">
          <label htmlFor="field-inspection">{t('iss.field.inspection.label')}</label>
          <select id="field-inspection" value={chosen?.line.id ?? ''} onChange={(event) => setSearch({ id: event.target.value })}>
            {workable.map((check) => (
              <option key={check.line.id} value={check.line.id}>
                {t('iss.field.inspection.option', { no: check.line.inspectionNo, title: check.line.title })}
              </option>
            ))}
          </select>
        </div>
        {chosen === undefined ? null : <InspectionWork key={chosen.line.id} check={chosen} />}
      </StateBoundary>
      <p className="prototype-note">{t('iss.field.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function InspectionWork({ check }: { check: SiteCheck }) {
  const { t } = useTranslation();
  const moment = useMoment();
  const { permissions, mode } = useSession();
  const { line } = check;
  const frozen = mode === 'READ_ONLY';
  const recording = line.status === 'SCHEDULED';
  const canRecord = recording && holds(permissions, RECORD_PERMISSION) && !frozen;
  const canRaise = holds(permissions, ISSUE_CREATE_PERMISSION) && !frozen;
  const record = useRecordInspectionResult();
  const raise = useRaiseIssue();
  const [form, setForm] = useState<ResultForm>(() => emptyResult(line.checklist));
  const [raiseForm, setRaiseForm] = useState<RaiseForm>(EMPTY_RAISE);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  // The commands of one save belong to the visit of the screen they started in (and so to its tenant): leaving ends them, whatever is still in flight.
  const visit = useRef(0);
  useEffect(
    () => () => {
      visit.current += 1;
    },
    [],
  );
  const [progress, setProgress] = useState<Readonly<Record<string, ItemProgress | undefined>>>({});
  const items = useMemo(() => (recording ? itemsFromForm(form, line.checklist) : itemsFromRecorded(line)), [recording, form, line]);
  const units = useUnits(canRaise && items.length > 0);
  const categories = useCategories(canRaise && items.length > 0);
  const resultProblems = recording ? validateResult(form, line.checklist) : undefined;
  const raiseErrors: FormErrors | undefined = canRaise && items.length > 0 ? validateRaise(check, items, raiseForm) : undefined;
  const open = items.filter((item) => progress[item.code]?.state !== 'raised' && progress[item.code]?.state !== 'existing');
  const raisedCount = items.length - open.length;
  const mayStop = !canRecord && (!canRaise || open.length === 0);

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitted(true);
    if (busy || mayStop) return;
    if (canRecord && resultProblems !== undefined && hasProblems(resultProblems)) return;
    if (raiseErrors !== undefined && Object.keys(raiseErrors).length > 0) return;
    const mine = visit.current;
    const live = (): boolean => mine === visit.current;
    setBusy(true);
    try {
      if (canRecord) {
        try {
          await record.mutateAsync({ id: line.id, version: line.version, body: resultBody(form, line.checklist) });
        } catch {
          return;
        }
      }
      if (!canRaise) return;
      for (const item of open) {
        if (!live()) return;
        const ids = await idsOf(line.id, item.code);
        if (!live()) return;
        try {
          const answer = (await raise.mutateAsync(raiseBody(check, item, raiseForm, ids))) as { resource_id?: unknown } | undefined;
          if (!live()) return;
          setProgress((current) => ({ ...current, [item.code]: { state: 'raised', ...(typeof answer?.resource_id === 'string' ? { issueId: answer.resource_id } : {}) } }));
        } catch (error) {
          if (!live()) return;
          const problem = describeIssueProblem(error);
          setProgress((current) => ({ ...current, [item.code]: problem.reason === 'duplicateSource' ? { state: 'existing' } : { state: 'failed', problem } }));
        }
      }
    } finally {
      if (live()) setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={(event) => void save(event)} noValidate aria-label={t('iss.field.form.title')} data-inspection={line.id} data-status={line.status}>
      <h2>{t('iss.field.form.title')}</h2>
      <dl className="iss-facts" data-testid="facts">
        <dt>{t('iss.field.fact.contract')}</dt>
        <dd>{line.contract.code}</dd>
        <dt>{t('iss.field.fact.location')}</dt>
        <dd data-testid="location">{line.locationText ?? t('iss.field.fact.none')}</dd>
        <dt>{t('iss.field.fact.time')}</dt>
        <dd data-testid="time">{line.scheduledAt === null ? t('iss.field.fact.none') : moment(line.scheduledAt)}</dd>
        <dt>{t('iss.field.fact.inspectors')}</dt>
        <dd data-testid="inspectors">{line.participants.length === 0 ? t('iss.field.fact.none') : line.participants.map((person) => person.displayName).join(', ')}</dd>
      </dl>
      {record.isError ? (
        <p className="callout warning" role="alert" data-testid="record-problem">
          {recordProblemMessage(t, describeRecordProblem(record.error))}
        </p>
      ) : null}
      {recording ? (
        canRecord ? (
          <fieldset disabled={busy} className="qms-plain">
            <ChecklistPanel items={line.checklist} form={form} onChange={setForm} problems={submitted ? resultProblems : undefined} />
          </fieldset>
        ) : (
          <p className="callout warning" role="status" data-testid="cannot-record">
            {frozen ? t('iss.field.frozen.notice') : t('iss.field.denied.notice')}
          </p>
        )
      ) : (
        <p className="callout" role="status" data-testid="recorded">
          {t('iss.field.recorded.notice')}
        </p>
      )}
      {items.length === 0 ? (
        <p className="sub" data-testid="no-failed">
          {t('iss.field.noFailed.notice')}
        </p>
      ) : canRaise ? (
        <RaisePanel
          raise={raiseForm}
          onChange={setRaiseForm}
          errors={submitted ? raiseErrors : undefined}
          items={items}
          progress={progress}
          units={units.data ?? []}
          categories={categories.data ?? []}
          disabled={busy}
        />
      ) : (
        <p className="callout warning" role="status" data-testid="cannot-raise">
          {frozen ? t('iss.field.frozen.notice') : t('iss.field.raiseDenied.notice')}
        </p>
      )}
      {raisedCount === 0 ? null : (
        <p className="callout" role="status" data-testid="raised-count">
          {t('iss.field.raised.notice', { done: raisedCount, total: items.length })}
          {open.length === 0 ? (
            <>
              {' '}
              <Link to="/iss/iss-01">{t('iss.field.raised.list')}</Link>
            </>
          ) : null}
        </p>
      )}
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={busy || mayStop}>
          {busy ? t('iss.field.submit.pending') : canRecord ? t('iss.field.submit.record') : t('iss.field.submit.raise')}
        </button>
      </div>
    </form>
  );
}
