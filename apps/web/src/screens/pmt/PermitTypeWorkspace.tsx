import { useMemo } from 'react';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { PermitTypeForm } from './PermitTypeForm';
import { PermitTypeTable } from './PermitTypeTable';
import { CATALOGUE_MANAGE_PERMISSION, groupTypes, phaseOf, vietnamToday } from './model';
import type { PermitTypeView } from './model';

export interface PermitTypeWorkspaceProps {
  /** Every version of the catalogue, as the read model gives them. */
  types: readonly PermitTypeView[];
  /** The Vietnam date the screen is judged on; the clock of the browser by default. */
  today?: string;
}

/**
 * PMT-03, the catalogue of permit types as dated legal data. It shows what applies today, flags the versions that still wait for their
 * confirmation, and lets the business owner publish the next revision of a regulation or end a version. The page that loads the versions
 * hands them over, so the same content serves every state of that page.
 */
export function PermitTypeWorkspace({ types, today: given }: PermitTypeWorkspaceProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const today = given ?? vietnamToday();
  const frozen = mode === 'READ_ONLY';
  const mayManage = (permissions === undefined || permissions.includes(CATALOGUE_MANAGE_PERMISSION)) && !frozen;
  const groups = useMemo(() => groupTypes(types, today), [types, today]);
  const existingCodes = useMemo(() => new Set(groups.map((group) => group.code)), [groups]);
  const unconfirmed = types.filter((type) => type.cxnRef !== null && phaseOf(type, today) !== 'ended').length;

  return (
    <div className="stack">
      {unconfirmed === 0 ? null : (
        <p className="callout warning" role="status" data-testid="unconfirmed-banner">
          {t('pmt.type.unconfirmed.banner', { count: unconfirmed })}
        </p>
      )}
      {groups.length === 0 ? (
        <p className="sub" data-testid="empty-catalogue">
          {t('pmt.type.empty.text')}
        </p>
      ) : (
        <PermitTypeTable groups={groups} today={today} mayRetire={mayManage} />
      )}
      {mayManage ? <PermitTypeForm today={today} existingCodes={existingCodes} /> : <p className="sub">{t('pmt.type.readonly.text')}</p>}
    </div>
  );
}
