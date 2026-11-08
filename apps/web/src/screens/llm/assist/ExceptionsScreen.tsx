import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { ScreenFrame } from './assist-components';
import { useAssistProviders, usePermit } from './assist-hooks';
import { EXCEPTION_APPROVE, EXCEPTION_READ, EXCEPTION_REQUEST, PROVIDER_MANAGE, PROVIDER_READ } from './assist-model';
import { ExceptionsSection, PolicyBanner, ProvidersSection } from './exception-views';

/**
 * LLM-27, the providers outside the customer servers (AI.07): what the edition says about them, where each one keeps its data and whether it attested that it does not train on it, the requests for an exception to use one,
 * who approved them and until when, and the log of every use. An external provider is off by default where the edition keeps processing on the customer servers; using one needs an approved exception, and every use is logged.
 */
export default function ExceptionsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ExceptionsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ExceptionsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const permit = usePermit();
  const providers = useAssistProviders();
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const allowed = [EXCEPTION_READ, EXCEPTION_REQUEST, EXCEPTION_APPROVE, PROVIDER_READ, PROVIDER_MANAGE].some((permission) => permit.has(permission));
  const asOf = providers.dataUpdatedAt;
  return (
    <ScreenFrame screenId={route.id} title={t('llm.exceptions.page.title')} subtitle={t('llm.exceptions.page.subtitle')} {...(asOf > 0 ? { asOf: new Date(asOf).toLocaleString('vi-VN') } : {})}>
      {!allowed ? (
        <StateBoundary state="denied" />
      ) : (
        <div className="assist-page">
          <PolicyBanner />
          {receipt === undefined ? null : (
            <p className="callout assist-receipt" role="status" data-testid="exception-receipt">
              {receipt}
            </p>
          )}
          <ProvidersSection providers={providers} onReceipt={setReceipt} />
          <ExceptionsSection providers={providers.data ?? []} onReceipt={setReceipt} />
        </div>
      )}
    </ScreenFrame>
  );
}
