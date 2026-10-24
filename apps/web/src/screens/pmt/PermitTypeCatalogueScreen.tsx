import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { PermitTypeWorkspace } from './PermitTypeWorkspace';
import { usePermitTypes } from './hooks';

const NEVER_EMPTY = (): boolean => false;

/** PMT-03: the catalogue of permit types as dated legal data, read for the tenant and handed to the workspace that shows and changes it. */
export default function PermitTypeCatalogueScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The catalogue belongs to one tenant: a switch starts the screen over.
  return <PermitTypeCatalogueContent key={tenant?.id ?? 'none'} route={route} />;
}

function PermitTypeCatalogueContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const types = usePermitTypes();
  // An empty catalogue is still a screen: the workspace says so and offers the form that publishes the first version.
  const state = useScreenState({ isLoading: types.isLoading, error: types.error, data: types.data, isEmpty: NEVER_EMPTY });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pmt.type.page.title')}</h1>
          <p>{t('pmt.type.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void types.refetch()}>
        <PermitTypeWorkspace types={types.data ?? []} />
      </StateBoundary>
    </section>
  );
}
