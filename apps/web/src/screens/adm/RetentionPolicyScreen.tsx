import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useRetentionHolds, useRetentionPolicies, useRetentionReview } from './retention/hooks';
import { READ_HOLD_PERMISSION, READ_RETENTION_PERMISSION } from './retention/model';
import { RetentionWorkspace } from './RetentionWorkspace';

// A tenant without a rule still gets the form: an empty register is not the "empty" state of the screen.
const NEVER_EMPTY = (): boolean => false;
const NONE: never[] = [];

/** ADM-12: the retention rules, the legal holds that override them and the records that wait for a decision (ST-ADM-017). */
export default function RetentionPolicyScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_RETENTION_PERMISSION);
  const canReadHolds = permissions === undefined || permissions.includes(READ_HOLD_PERMISSION);
  const policies = useRetentionPolicies(canRead);
  const review = useRetentionReview(canRead);
  // The holds only say what overrides the rules: the screen is usable without them, and says so.
  const holds = useRetentionHolds(canRead && canReadHolds);
  const queryState = useScreenState({
    isLoading: policies.isLoading || review.isLoading,
    error: policies.error ?? review.error ?? undefined,
    data: policies.data === undefined || review.data === undefined ? undefined : policies.data,
    isEmpty: NEVER_EMPTY,
  });
  // Without adm.retention.read nothing is requested and the screen is denied, not empty.
  const state = canRead ? queryState : 'denied';
  const retry = () => {
    if (policies.isError) void policies.refetch();
    if (review.isError) void review.refetch();
  };
  return (
    <StateBoundary state={state} onRetry={retry}>
      {holds.isError || !canReadHolds ? (
        <p className="callout warning" role="alert">
          {t('adm.retention.holds.error')}
        </p>
      ) : null}
      <RetentionWorkspace route={route} policies={policies.data ?? NONE} review={review.data ?? NONE} holds={holds.data ?? NONE} />
    </StateBoundary>
  );
}
