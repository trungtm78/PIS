import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { WebRoute } from '../../../routes/types';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { SectionCard } from '../../../ui';
import { InfoFormula } from '../../../ui';
import type { InfoFormulaLabels } from '../../../ui';
import { REPORT_CATEGORIES, dayText, dongText, word } from './prjModel';
import type { PublicOc4ids, PublicPortalInfo, PublicProject, PublicProjects, ReportStatus, SubmittedReport } from './prjModel';
import './prj.css';

const TEXT_MIN = 20;
const TEXT_MAX = 8000;
const PAGE = 50;
const OC4IDS_PAGE_CAP = 20;

export type Fetcher = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

interface Answer<T> {
  status: number;
  body: T | undefined;
  code: string | undefined;
  retryAfter: number | undefined;
}

/**
 * A call to the public surface. The page has no session and no token: it sends nothing but what the person typed, with no cookie and no header that names a person, and it keeps no copy of what comes back beyond the screen.
 * A refusal is read from its code only.
 */
async function call<T>(fetcher: Fetcher, method: 'GET' | 'POST', url: string, body?: unknown): Promise<Answer<T>> {
  const response = await fetcher(url, { method, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  const retry = Number(response.headers.get('Retry-After'));
  const code = !response.ok && typeof parsed === 'object' && parsed !== null && 'code' in parsed ? String((parsed as { code: unknown }).code) : undefined;
  return { status: response.status, body: response.ok ? (parsed as T) : undefined, code, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined };
}

const base = (): string => import.meta.env.VITE_API_BASE_URL ?? '';
const defaultFetcher: Fetcher = (input, init) => fetch(input, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' });

function failureText(t: Translator['t'], answer: { status: number; code: string | undefined; retryAfter: number | undefined }): string {
  if (answer.status === 429) return answer.retryAfter === undefined ? t('prj.public.error.rate') : t('prj.public.error.rateAfter', { seconds: answer.retryAfter });
  if (answer.status === 404) return t('prj.public.error.notFound');
  if (answer.status === 409) return t('prj.public.error.closed');
  if (answer.status === 400 || answer.status === 422) return t('prj.public.error.invalid');
  return t('prj.public.error.generic');
}

function Info({ info }: { info: PublicPortalInfo }) {
  const { t } = useTranslation();
  const labels: InfoFormulaLabels = {
    open: t('prj.info.panel.open', { name: t('prj.public.info.name') }),
    close: t('prj.info.panel.close'),
    formula: t('prj.info.panel.formula'),
    numerator: t('prj.info.panel.numerator'),
    denominator: t('prj.info.panel.denominator'),
    exclusions: t('prj.info.panel.exclusions'),
    source: t('prj.info.panel.source'),
    asOf: t('prj.info.panel.asOf'),
    owner: t('prj.info.panel.owner'),
    version: t('prj.info.panel.version'),
    unverified: t('prj.info.panel.unverified'),
  };
  return <InfoFormula name={t('prj.public.info.name')} formula={t('prj.public.info.formula', { count: info.record_count })} source={t('prj.public.info.source', { publisher: info.publisher })} asOf={dayText(info.as_of)} owner={info.publisher} version={t('prj.public.info.version', { version: info.oc4ids_version })} labels={labels} />;
}

function FieldValue({ name, value }: { name: string; value: string | number | null }) {
  const { t } = useTranslation();
  if (value === null) return <>–</>;
  if (name === 'budget_vnd') return <>{t('prj.public.value.dong', { amount: dongText(value) })}</>;
  if (name === 'sector') return <>{t(`prj.portal.sector.${word(String(value))}`)}</>;
  if (name === 'project_type') return <>{t(`prj.portal.type.${word(String(value))}`)}</>;
  if (name === 'purpose') return <>{t(`prj.portal.purpose.${word(String(value))}`)}</>;
  if (name === 'updated_on') return <>{dayText(String(value))}</>;
  return <>{String(value)}</>;
}

const KNOWN_FIELDS = new Set(['project_code', 'title', 'summary', 'status', 'project_group', 'sector', 'project_type', 'purpose', 'start_year', 'end_year', 'budget_vnd', 'authority_name', 'updated_on']);

export interface PublicPortalProps {
  route?: WebRoute;
  slug?: string;
  fetcher?: Fetcher;
}

/**
 * PRJ-33, the public portal (G4-9): read-only, no sign-in, shown outside the shell of the application. It lists the published projects with only the fields that the publisher allowed, offers the OC4IDS file, and takes an anonymous
 * report (G4-12) without keeping an address, a device or a name. The page says what it keeps (nothing about the person) and that the access code is shown once.
 */
export default function PublicPortalScreen({ slug: slugProp, fetcher = defaultFetcher }: PublicPortalProps) {
  const { t } = useTranslation();
  const params = useParams();
  const [search] = useSearchParams();
  const slug = slugProp ?? params.slug ?? search.get('slug') ?? undefined;
  const [state, setState] = useState<ScreenState>('loading');
  const [info, setInfo] = useState<PublicPortalInfo | undefined>(undefined);
  const [projects, setProjects] = useState<PublicProject[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [slugInput, setSlugInput] = useState('');

  const load = useCallback(async (): Promise<void> => {
    if (slug === undefined) return;
    setState('loading');
    setNotice(undefined);
    try {
      const head = await call<PublicPortalInfo>(fetcher, 'GET', `${base()}/public/portals/${encodeURIComponent(slug)}`);
      if (head.body === undefined) {
        setInfo(undefined);
        if (head.status === 404) setState('empty');
        else {
          setNotice(failureText(t, head));
          setState('error');
        }
        return;
      }
      const list = await call<PublicProjects>(fetcher, 'GET', `${base()}/public/portals/${encodeURIComponent(slug)}/projects?limit=${PAGE}`);
      if (list.body === undefined) {
        setNotice(failureText(t, list));
        setState('error');
        return;
      }
      setInfo(head.body);
      setProjects(list.body.items);
      setNext(list.body.next_after);
      setState('default');
    } catch {
      setState('offline');
    }
  }, [slug, fetcher, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const more = async (): Promise<void> => {
    if (slug === undefined || next === null) return;
    const list = await call<PublicProjects>(fetcher, 'GET', `${base()}/public/portals/${encodeURIComponent(slug)}/projects?limit=${PAGE}&after=${encodeURIComponent(next)}`);
    if (list.body === undefined) {
      setNotice(failureText(t, list));
      return;
    }
    setProjects([...projects, ...list.body.items]);
    setNext(list.body.next_after);
  };

  if (slug === undefined) {
    return (
      <main className="prj-public" data-screen-id="PRJ-33" aria-labelledby="screen-title">
        <h1 id="screen-title">{t('prj.public.page.title')}</h1>
        <form
          className="prj-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (slugInput.trim() !== '') window.location.assign(`/public/portals/${encodeURIComponent(slugInput.trim().toLowerCase())}`);
          }}
        >
          <label>
            {t('prj.public.slug.label')}
            <input type="text" value={slugInput} data-testid="public-slug" onChange={(event) => setSlugInput(event.target.value)} />
          </label>
          <button type="submit" className="ui-button ui-button--primary">
            {t('prj.public.slug.open')}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="prj-public" data-screen-id="PRJ-33" aria-labelledby="screen-title">
      <header>
        <h1 id="screen-title">{info?.title ?? t('prj.public.page.title')}</h1>
        {info === undefined ? null : (
          <p data-testid="public-publisher">
            {t('prj.public.publisher', { publisher: info.publisher })} <Info info={info} />
          </p>
        )}
      </header>
      {notice === undefined ? null : (
        <p className="callout" role="alert" data-testid="public-notice">
          {notice}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void load()}>
        {info !== undefined && (
          <>
            <Summary info={info} />
            <SectionCard title={t('prj.public.projects.section')}>
              {projects.length === 0 ? (
                <p className="prj-muted" data-testid="public-empty">
                  {t('prj.public.projects.empty')}
                </p>
              ) : (
                <ul className="prj-list" data-testid="public-projects">
                  {projects.map((project) => (
                    <li key={project.code} className="prj-list__item" data-testid={`public-project-${project.code}`}>
                      <dl>
                        {Object.entries(project.fields)
                          .filter(([name]) => KNOWN_FIELDS.has(name))
                          .map(([name, value]) => (
                            <div key={name} className="prj-public__field">
                              <dt>{t(`prj.public.field.${word(name)}`)}</dt>
                              <dd>
                                <FieldValue name={name} value={value} />
                              </dd>
                            </div>
                          ))}
                      </dl>
                      <span className="prj-muted">{t('prj.public.projects.revision', { revision: project.revision, day: dayText(project.published_at) })}</span>
                    </li>
                  ))}
                </ul>
              )}
              {next === null ? null : (
                <button type="button" className="ui-button ui-button--outline" data-testid="public-more" onClick={() => void more()}>
                  {t('prj.public.projects.more')}
                </button>
              )}
            </SectionCard>
            <Oc4idsSection slug={slug} fetcher={fetcher} />
            {info.reports_open ? <ReportSection slug={slug} fetcher={fetcher} /> : <p className="prj-muted" data-testid="reports-closed">{t('prj.public.report.closed')}</p>}
          </>
        )}
      </StateBoundary>
    </main>
  );
}

function Summary({ info }: { info: PublicPortalInfo }) {
  const { t } = useTranslation();
  return (
    <dl className="prj-facts">
      <div className="prj-facts__item">
        <dt>{t('prj.public.summary.count')}</dt>
        <dd data-testid="public-count">{info.record_count}</dd>
      </div>
      <div className="prj-facts__item">
        <dt>{t('prj.public.summary.last')}</dt>
        <dd>{dayText(info.last_published_at)}</dd>
      </div>
      <div className="prj-facts__item">
        <dt>{t('prj.public.summary.license')}</dt>
        <dd>
          <a href={info.license_uri} rel="noreferrer noopener">
            {info.license_uri}
          </a>
        </dd>
      </div>
      <div className="prj-facts__item">
        <dt>{t('prj.public.summary.policy')}</dt>
        <dd>
          <a href={info.publication_policy_uri} rel="noreferrer noopener">
            {info.publication_policy_uri}
          </a>
        </dd>
      </div>
      <div className="prj-facts__item">
        <dt>{t('prj.public.summary.fields')}</dt>
        <dd data-testid="public-fields">{info.fields.map((name) => t(`prj.public.field.${word(name)}`)).join(', ')}</dd>
      </div>
    </dl>
  );
}

function Oc4idsSection({ slug, fetcher }: { slug: string; fetcher: Fetcher }) {
  const { t } = useTranslation();
  const [href, setHref] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const prepare = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      let after: string | null = null;
      let first: Record<string, unknown> | undefined;
      const projects: unknown[] = [];
      for (let page = 0; page < OC4IDS_PAGE_CAP; page += 1) {
        const answer: Answer<PublicOc4ids> = await call<PublicOc4ids>(fetcher, 'GET', `${base()}/public/portals/${encodeURIComponent(slug)}/oc4ids?limit=500${after === null ? '' : `&after=${encodeURIComponent(after)}`}`);
        if (answer.body === undefined) {
          setError(failureText(t, answer));
          return;
        }
        first ??= answer.body.package;
        const list = answer.body.package.projects;
        if (Array.isArray(list)) projects.push(...(list as unknown[]));
        after = answer.body.next_after;
        if (after === null) break;
      }
      setHref(`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({ ...(first ?? {}), projects }, null, 2))}`);
    } catch {
      setError(t('prj.public.error.generic'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard title={t('prj.public.oc4ids.section')}>
      <p>{t('prj.public.oc4ids.text')}</p>
      <button type="button" className="ui-button ui-button--outline" data-testid="oc4ids-prepare" disabled={busy} onClick={() => void prepare()}>
        {t('prj.public.oc4ids.prepare')}
      </button>{' '}
      {href === undefined ? null : (
        <a className="ui-button ui-button--primary" download="oc4ids.json" href={href} data-testid="oc4ids-download">
          {t('prj.public.oc4ids.download')}
        </a>
      )}
      {error === undefined ? null : (
        <p className="callout" role="alert" data-testid="oc4ids-error">
          {error}
        </p>
      )}
    </SectionCard>
  );
}

function ReportSection({ slug, fetcher }: { slug: string; fetcher: Fetcher }) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<string>(REPORT_CATEGORIES[0]);
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState<SubmittedReport | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<ReportStatus | undefined>(undefined);
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
  const [reply, setReply] = useState('');
  const [sent, setSent] = useState(false);
  const base2 = `${base()}/public/portals/${encodeURIComponent(slug)}/reports`;

  const submit = async (): Promise<void> => {
    if (text.trim().length < TEXT_MIN || text.length > TEXT_MAX) {
      setError(t('prj.public.report.tooShort', { min: TEXT_MIN }));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const answer = await call<SubmittedReport>(fetcher, 'POST', base2, { category, text: text.trim() });
      if (answer.body === undefined) setError(failureText(t, answer));
      else {
        setSubmitted(answer.body);
        setText('');
      }
    } catch {
      setError(t('prj.public.error.generic'));
    } finally {
      setBusy(false);
    }
  };

  const read = async (): Promise<void> => {
    setStatusError(undefined);
    setSent(false);
    try {
      const answer = await call<ReportStatus>(fetcher, 'POST', `${base2}/status`, { access_code: code.trim() });
      if (answer.body === undefined) {
        setStatus(undefined);
        setStatusError(answer.status === 404 ? t('prj.public.report.unknownCode') : failureText(t, answer));
      } else setStatus(answer.body);
    } catch {
      setStatusError(t('prj.public.error.generic'));
    }
  };

  const answer = async (): Promise<void> => {
    if (reply.trim() === '') return;
    try {
      const result = await call<{ seq: number }>(fetcher, 'POST', `${base2}/reply`, { access_code: code.trim(), body: reply.trim() });
      if (result.body === undefined) setStatusError(failureText(t, result));
      else {
        setReply('');
        setSent(true);
        await read();
      }
    } catch {
      setStatusError(t('prj.public.error.generic'));
    }
  };

  return (
    <SectionCard title={t('prj.public.report.section')}>
      <p className="callout" role="note" data-testid="report-promise">
        {t('prj.public.report.promise')}
      </p>
      {submitted === undefined ? (
        <div className="prj-form">
          <label>
            {t('prj.public.report.category')}
            <select value={category} data-testid="report-category" onChange={(event) => setCategory(event.target.value)}>
              {REPORT_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {t(`prj.public.category.${word(value)}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('prj.public.report.text')}
            <textarea value={text} maxLength={TEXT_MAX} data-testid="report-text" onChange={(event) => setText(event.target.value)} />
          </label>
          <p className="prj-muted">{t('prj.public.report.noContact')}</p>
          <button type="button" className="ui-button ui-button--primary" data-testid="report-submit" disabled={busy} onClick={() => void submit()}>
            {t('prj.public.report.submit')}
          </button>
          {error === undefined ? null : (
            <p className="callout" role="alert" data-testid="report-error">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="callout" role="status" data-testid="report-receipt">
          <p>{t('prj.public.report.receipt', { day: dayText(submitted.received_on) })}</p>
          <p>
            <span className="prj-code" data-testid="report-code">
              {submitted.access_code}
            </span>
          </p>
          <p>
            <strong>{t('prj.public.report.shownOnce')}</strong>
          </p>
          <p>{t('prj.public.report.due', { acknowledge: dayText(submitted.acknowledge_due_on), resolve: dayText(submitted.resolve_due_on) })}</p>
        </div>
      )}
      <h3>{t('prj.public.status.section')}</h3>
      <div className="prj-inline">
        <label>
          {t('prj.public.status.code')}
          <input type="text" autoComplete="off" value={code} data-testid="status-code" onChange={(event) => setCode(event.target.value)} />
        </label>
        <button type="button" className="ui-button ui-button--outline" data-testid="status-read" disabled={code.trim() === ''} onClick={() => void read()}>
          {t('prj.public.status.read')}
        </button>
      </div>
      {statusError === undefined ? null : (
        <p className="callout" role="alert" data-testid="status-error">
          {statusError}
        </p>
      )}
      {status === undefined ? null : (
        <div data-testid="status-result">
          <dl className="prj-facts">
            <div className="prj-facts__item">
              <dt>{t('prj.public.status.state')}</dt>
              <dd data-testid="status-state">{t(`prj.public.status.${word(status.status)}`)}</dd>
            </div>
            <div className="prj-facts__item">
              <dt>{t('prj.public.status.receivedOn')}</dt>
              <dd>{dayText(status.received_on)}</dd>
            </div>
            <div className="prj-facts__item">
              <dt>{t('prj.public.status.acknowledgeDue')}</dt>
              <dd>{dayText(status.acknowledge_due_on)}</dd>
            </div>
            <div className="prj-facts__item">
              <dt>{t('prj.public.status.resolveDue')}</dt>
              <dd>{dayText(status.resolve_due_on)}</dd>
            </div>
          </dl>
          {status.note === null ? null : <p data-testid="status-note">{status.note}</p>}
          <ul className="prj-list" data-testid="status-thread">
            {status.thread.map((message) => (
              <li key={message.seq} className="prj-list__item">
                <strong>{message.from === 'HANDLER' ? t('prj.public.status.fromHandler') : t('prj.public.status.fromYou')}</strong> <span className="prj-muted">{dayText(message.sent_on)}</span>
                <span>{message.body}</span>
              </li>
            ))}
          </ul>
          {status.status === 'RESOLVED' || status.status === 'DISMISSED' ? null : (
            <div className="prj-form">
              <label>
                {t('prj.public.status.reply')}
                <textarea value={reply} data-testid="status-reply" onChange={(event) => setReply(event.target.value)} />
              </label>
              <button type="button" className="ui-button ui-button--primary" data-testid="status-send" disabled={reply.trim() === ''} onClick={() => void answer()}>
                {t('prj.public.status.send')}
              </button>
              {sent ? <p role="status">{t('prj.public.status.sent')}</p> : null}
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
