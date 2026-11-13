import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { CHECK_IDS, PILL_CLASS, checksOf } from './signatures/checks';
import { useSignatureReport, useVerifySignatures, useVersionFacts, useVersions } from './signatures/hooks';
import { chainLabel, checkHint, checkTitle, findingLabel, overallLabel, problemMessage, profileLabel, regimeLabel, revocationLabel, roleLabel, stateLabel } from './signatures/labels';
import { describeProblem } from './signatures/problems';
import { POLICIES, VERIFY_SIGNATURES_PERMISSION } from './signatures/types';
import type { Overall, Policy, SignatureRow } from './signatures/types';
import './signatures/signatures.css';

const ARROW = '←';
const SIGNING_PATH = '/doc/doc-05';
const SHORT_CHECKSUM = 12;
const OVERALL_PILL: Readonly<Record<Overall, string>> = { VALID: 'pill', INVALID: 'pill red', INDETERMINATE: 'pill warn' };

/** DOC-07: the result of verifying the signatures of one document version, and the action to verify again. */
export default function SignatureReportScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The policy, the result of a verification and the error of one belong to one tenant: a switch starts the screen over.
  return <SignatureReportContent key={tenantId ?? 'none'} route={route} />;
}

function SignatureReportContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const versionId = params.get('version') ?? undefined;
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say: the report can be read, not renewed.
  const frozen = mode === 'READ_ONLY';
  const canVerify = (permissions === undefined || permissions.includes(VERIFY_SIGNATURES_PERMISSION)) && !frozen;
  const [policy, setPolicy] = useState<Policy>('STRICT');
  const [revalidate, setRevalidate] = useState(false);
  // The result of a verification is about one version: it is shown with that version only.
  const [verified, setVerified] = useState<{ versionId: string; overall: Overall } | undefined>(undefined);
  const report = useSignatureReport(versionId, true);
  const facts = useVersionFacts(versionId);
  const versions = useVersions(versionId === undefined);
  const verify = useVerifySignatures();
  const dateOf = (value: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date(value));
  const checks = useMemo(() => (report.data === undefined ? [] : checksOf(report.data.overall, report.data.signatures)), [report.data]);
  const reportState = useScreenState({ isLoading: report.isLoading, error: report.error, data: report.data, isEmpty: (data) => (data as { signatures: unknown[] }).signatures.length === 0 });
  const listed = useMemo(() => versions.data?.pages.flatMap((page) => page.items).filter((item) => item.mime === 'application/pdf') ?? [], [versions.data]);
  const { hasNextPage: morePages, isFetchingNextPage: fetchingPage, isFetchNextPageError: pagesStalled, fetchNextPage: fetchPage } = versions;
  // Nothing in the pages read so far is a PDF, but a later page may hold some: read on instead of declaring the list empty.
  useEffect(() => {
    if (versionId === undefined && listed.length === 0 && morePages && !fetchingPage && !pagesStalled) void fetchPage();
  }, [versionId, listed.length, morePages, fetchingPage, pagesStalled, fetchPage]);
  const listState = useScreenState({
    isLoading: versions.isLoading,
    error: versions.error,
    data: versions.data === undefined ? undefined : listed,
    // A list without a PDF is empty only when there is no later page either; otherwise the picker (and its button) stays.
    isEmpty: (data) => (data as unknown[]).length === 0 && !morePages,
  });
  // Another version is another subject: the notice and the error of a verification are shown with the version they were for.
  const problem = verify.isError && verify.variables?.versionId === versionId ? describeProblem(verify.error) : undefined;
  const notice = verified !== undefined && verified.versionId === versionId ? verified.overall : undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (versionId === undefined || verify.isPending || !canVerify) return;
    setVerified(undefined);
    verify.mutate(
      { versionId, policy, revalidateRevocation: revalidate },
      { onSuccess: (result, input) => setVerified({ versionId: input.versionId, overall: overallOfResult(result) }) },
    );
  };

  const signatureCell = (signature: SignatureRow) => (
    <td>
      <strong>{roleLabel(t, signature.role)}</strong>
      <div className="sub">{signature.subjectDn ?? t('doc.signatureReport.signer.unknown')}</div>
    </td>
  );

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="doc-back-link">
        <Link to={SIGNING_PATH}>
          <span aria-hidden="true">{ARROW} </span>
          {t('doc.signatureReport.back.link')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.signatureReport.page.title')}</h1>
          <p>{t('doc.signatureReport.page.subtitle')}</p>
        </div>
      </div>
      {versionId === undefined ? (
        <StateBoundary state={listState} onRetry={() => void versions.refetch()}>
          <div className="card">
            <h2>{t('doc.signatureReport.pick.title')}</h2>
            <p className="sub">{t('doc.signatureReport.pick.hint')}</p>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('doc.signatureReport.pick.col.version')}</th>
                    <th>{t('doc.signatureReport.pick.col.stage')}</th>
                    <th>{t('doc.signatureReport.pick.col.created')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {listed.map((item) => (
                    <tr key={item.id} data-version-id={item.id}>
                      <td>
                        <strong>{t('doc.signatureReport.pick.version.text', { version: item.version })}</strong>
                        <div className="sub">{item.checksum.slice(0, SHORT_CHECKSUM)}</div>
                      </td>
                      <td>{item.stage}</td>
                      <td>{dateOf(item.createdAt)}</td>
                      <td className="row-actions">
                        <button type="button" aria-label={t('doc.signatureReport.pick.open.label', { version: item.version })} onClick={() => setParams({ version: item.id })}>
                          {t('doc.signatureReport.pick.open.action')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {versions.hasNextPage ? (
              <button type="button" disabled={versions.isFetchingNextPage} onClick={() => void versions.fetchNextPage()}>
                {t('doc.signatureReport.pick.more.action')}
              </button>
            ) : null}
            {/* What the report of a version holds, before one is chosen: the same six checks, none of them run yet. */}
            <h3>{t('doc.signatureReport.pick.report.title')}</h3>
            <div className="checklist" data-testid="report-outline">
              {CHECK_IDS.map((id) => (
                <div className="item row between" key={id} data-check={id} data-state="none">
                  <div>
                    <div className="title">{checkTitle(t, id)}</div>
                    <div className="sub">{checkHint(t, id)}</div>
                  </div>
                  <span className={PILL_CLASS.none}>{stateLabel(t, 'none')}</span>
                </div>
              ))}
            </div>
          </div>
        </StateBoundary>
      ) : (
        <div className="two">
          <div className="card" data-version-id={versionId}>
            <h2>{t('doc.signatureReport.checks.title')}</h2>
            {canVerify ? (
              <form className="filters" onSubmit={submit} aria-label={t('doc.signatureReport.verify.form')}>
                <div>
                  <label htmlFor="signature-policy">{t('doc.signatureReport.policy.label')}</label>
                  <select id="signature-policy" value={policy} onChange={(event) => setPolicy(event.target.value as Policy)}>
                    {POLICIES.map((option) => (
                      <option key={option} value={option}>
                        {option === 'STRICT' ? t('doc.signatureReport.policy.strict') : t('doc.signatureReport.policy.lenientTime')}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="check">
                  <input id="signature-revalidate" type="checkbox" checked={revalidate} onChange={(event) => setRevalidate(event.target.checked)} />
                  <label htmlFor="signature-revalidate">{t('doc.signatureReport.revalidate.label')}</label>
                </div>
                <button type="submit" className="primary" disabled={verify.isPending}>
                  {t('doc.signatureReport.verify.action')}
                </button>
              </form>
            ) : frozen ? (
              <p className="callout warning" role="status">
                {t('doc.signatureReport.frozen.notice')}
              </p>
            ) : null}
            {notice === undefined ? null : (
              <p className="callout" role="status">
                {t('doc.signatureReport.verified.notice', { result: overallLabel(t, notice) })}
              </p>
            )}
            {problem === undefined ? null : (
              <p className="callout warning" role="alert">
                {problemMessage(t, problem)}
              </p>
            )}
            <StateBoundary state={reportState} onRetry={() => void report.refetch()}>
              {report.data === undefined ? null : (
                <>
                  <div className="checklist">
                    {checks.map((check) => (
                      <div className="item row between" key={check.id} data-check={check.id} data-state={check.state}>
                        <div>
                          <div className="title">{checkTitle(t, check.id)}</div>
                          <div className="sub">{checkHint(t, check.id)}</div>
                        </div>
                        <span className={PILL_CLASS[check.state]}>{stateLabel(t, check.state)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="tablewrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{t('doc.signatureReport.col.signer')}</th>
                          <th>{t('doc.signatureReport.col.authority')}</th>
                          <th>{t('doc.signatureReport.col.time')}</th>
                          <th>{t('doc.signatureReport.col.result')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.data.signatures.map((signature) => (
                          <tr key={signature.index} data-signature-index={signature.index} data-status={signature.status}>
                            {signatureCell(signature)}
                            <td>
                              {signature.issuerDn ?? t('doc.signatureReport.authority.unknown')}
                              <div className="sub">
                                {signature.trustRegime === null ? chainLabel(t, signature.chainStatus) : `${regimeLabel(t, signature.trustRegime)} · ${chainLabel(t, signature.chainStatus)}`}
                                {signature.profile === null ? '' : ` · ${profileLabel(t, signature.profile)}`}
                              </div>
                              <div className="sub">{revocationLabel(t, signature.revocationStatus)}</div>
                            </td>
                            <td>
                              {signature.signedAt === null ? t('doc.signatureReport.time.unknown') : dateOf(signature.signedAt)}
                              <div className="sub">{signature.timestampAt === null ? t('doc.signatureReport.time.declared') : t('doc.signatureReport.time.proven', { time: dateOf(signature.timestampAt) })}</div>
                            </td>
                            <td>
                              <span className={OVERALL_PILL[signature.status]}>{overallLabel(t, signature.status)}</span>
                              {signature.findings.length === 0 ? null : (
                                <ul className="findings">
                                  {signature.findings.map((code) => (
                                    <li key={code}>
                                      <code>{code}</code> {findingLabel(t, code)}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="callout">{t('doc.signatureReport.note.text')}</p>
                </>
              )}
            </StateBoundary>
          </div>
          <div className="card">
            <h2>{t('doc.signatureReport.related.title')}</h2>
            {facts.data === undefined ? (
              <p className="muted">{facts.isError ? t('doc.signatureReport.related.unavailable') : t('doc.signatureReport.related.loading')}</p>
            ) : (
              <dl className="facts">
                <dt>{t('doc.signatureReport.related.version')}</dt>
                <dd>{facts.data.version}</dd>
                <dt>{t('doc.signatureReport.related.stage')}</dt>
                <dd>{facts.data.stage}</dd>
                <dt>{t('doc.signatureReport.related.pages')}</dt>
                <dd>{facts.data.pageCount}</dd>
                <dt>{t('doc.signatureReport.related.checksum')}</dt>
                <dd>
                  <code>{facts.data.checksum.slice(0, SHORT_CHECKSUM)}</code>
                </dd>
                <dt>{t('doc.signatureReport.related.created')}</dt>
                <dd>{dateOf(facts.data.createdAt)}</dd>
              </dl>
            )}
          </div>
        </div>
      )}
      <p className="prototype-note">{t('doc.signatureReport.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function overallOfResult(result: unknown): Overall {
  const overall = (result as { overall?: unknown } | null)?.overall;
  return overall === 'VALID' || overall === 'INVALID' ? overall : 'INDETERMINATE';
}
