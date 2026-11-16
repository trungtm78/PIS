import { ApiError } from '@machvon/api-client';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import type { TenantCandidate } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { StepUpPrompt } from '../adm/roles/StepUpPrompt';
import { selectability, safeNext } from './tenant-chooser/candidate-model';
import { CandidateCard } from './tenant-chooser/CandidateCard';
import { useCandidates } from './tenant-chooser/hooks';
import { problemMessage } from './tenant-chooser/labels';

const HOME = 'HOME-01';
const MFA_REQUIRED = 'MFA_REQUIRED';

/**
 * IAM-04: the memberships of the signed-in person as cards; choosing one asks the API for a tenant-scoped session
 * (selectTenantContext) and continues at the screen the person came for (`?next=`, a local address only). A suspended
 * tenant is offered in read-only mode; a membership or tenant that cannot be used is shown and cannot be chosen.
 */
export default function TenantChooserScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const session = useSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const next = safeNext(search.get('next'), routeById(HOME)?.path ?? '/');
  const candidates = useCandidates();
  const state = useScreenState({ isLoading: candidates.isLoading, error: candidates.error, data: candidates.data });

  const [choosing, setChoosing] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<unknown>(undefined);
  const [stepUpFor, setStepUpFor] = useState<TenantCandidate | undefined>(undefined);
  const mounted = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const choose = async (candidate: TenantCandidate): Promise<void> => {
    // A double click is one choice: the second click finds the first still running.
    if (busy.current) return;
    busy.current = true;
    setProblem(undefined);
    setChoosing(candidate.membership_id);
    try {
      const current = sessionRef.current;
      if (current.selectTenant === undefined) current.switchTenant(candidate.tenant_id);
      else await current.selectTenant(candidate);
      navigate(next, { replace: true });
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ApiError && failure.code === MFA_REQUIRED) setStepUpFor(candidate);
      else setProblem(failure);
    } finally {
      busy.current = false;
      if (mounted.current) setChoosing(undefined);
    }
  };

  const confirmStepUp = async (): Promise<void> => {
    const target = stepUpFor;
    setStepUpFor(undefined);
    // With a real sign-in this leaves for the provider and never resolves here; the development session resolves at once.
    await sessionRef.current.requestStepUp?.();
    // A step-up changes the identity token the server judges: the retry is a new intention, with a new idempotency key.
    if (target !== undefined) await choose(target);
  };

  // A person who belongs to ONE organisation that can be chosen has nothing to choose: it is chosen for them, once (a failure leaves the card and its message).
  // Only on the way in: a person who already works in an organisation and opens this screen on purpose sees it, and is not sent away.
  const only = candidates.data?.length === 1 ? candidates.data[0] : undefined;
  const autoChosen = useRef(false);
  useEffect(() => {
    if (only === undefined || autoChosen.current || sessionRef.current.tenant !== undefined || selectability(only, Date.now()) !== 'selectable') return;
    autoChosen.current = true;
    void choose(only);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `choose` reads the session through a ref; the effect follows the candidate alone
  }, [only]);

  const now = Date.now();
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('iam.tenantChooser.page.title')}</h1>
          <p>{t('iam.tenantChooser.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void candidates.refetch()}>
        {problem === undefined ? null : (
          <p className="callout warning" role="alert">
            {problemMessage(t, problem)}
          </p>
        )}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          {(candidates.data ?? []).map((candidate) => (
            <CandidateCard
              key={candidate.membership_id}
              candidate={candidate}
              selectability={selectability(candidate, now)}
              busy={choosing !== undefined}
              choosing={choosing === candidate.membership_id}
              onChoose={(picked) => void choose(picked)}
            />
          ))}
        </div>
      </StateBoundary>
      {stepUpFor === undefined ? null : <StepUpPrompt onConfirm={() => void confirmStepUp()} onCancel={() => setStepUpFor(undefined)} />}
    </section>
  );
}
