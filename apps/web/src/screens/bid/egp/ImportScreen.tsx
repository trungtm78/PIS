import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { ContextBar, StatusPill } from '../../../ui';
import { AcceptanceBadge } from './import-components';
import { useEgpConnection } from './import-hooks';
import { PATH_CONNECTION, PATH_MAPPING } from './import-model';
import { ImportFlow } from './ImportFlow';
import { ImportHistory } from './ImportHistory';
import './import.css';

/**
 * BID-24: the import runs of the files of the national e-procurement network. The platform never opens a connection to the network: a person downloads the file and hands it over. The file is uploaded, read by a dry run that writes nothing
 * (BR-BID-13), and applied once per file (a second time answers "already loaded"); the history keeps every run with its counts and the rows it refused. The layouts are a working assumption until the operator's sample arrives (PENDING-EXTERNAL).
 */
export default function ImportScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The flow and the history belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ImportContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ImportContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const connection = useEgpConnection();
  const conn = connection.data;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="egpi-import">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('egp.import.page.title')}</h1>
          <p>{t('egp.import.page.subtitle')}</p>
        </div>
        <div className="egpi-links">
          <Link to={PATH_CONNECTION}>{t('egp.import.link.connection')}</Link>
          <Link to={PATH_MAPPING}>{t('egp.import.link.mapping')}</Link>
        </div>
      </div>
      <div className="egpi-badges" data-testid="import-badges">
        <span data-testid="adapter-note">
          <StatusPill tone="neutral">{t('egp.import.adapter.note')}</StatusPill>
        </span>
        <AcceptanceBadge acceptance={conn?.acceptance ?? 'PENDING_EXTERNAL'} />
      </div>
      <ContextBar items={[{ label: t('egp.import.context.scope.label'), value: tenant?.name ?? '' }]} />
      <ImportFlow connection={connection} />
      <ImportHistory />
      <p className="prototype-note">{t('egp.import.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
