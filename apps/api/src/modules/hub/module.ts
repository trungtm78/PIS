import { registerBuiltInHubAdapters } from '@machvon/db';
import { registerBuiltInConnectors } from '@machvon/kernel';
import { defineModule } from '../module-descriptor';
import { HubController } from './hub.controller';
import { HubReadsController } from './hub-reads.controller';

// The connectors that exist on main and the adapters that move their switches are known to every process; a lane that adds a connector registers its descriptor the same way.
registerBuiltInConnectors();
registerBuiltInHubAdapters();

/**
 * HUB, the Integration Hub (HUB-1): one catalogue of every connection to an outside system with its health, runs, incidents, ETL pipelines, mappings, rejects and collector agents. It reads the connector tables of
 * other lanes through descriptors and adapters and writes only its own tables.
 */
export const hubModule = defineModule({
  code: 'HUB',
  controllers: [HubController, HubReadsController],
});
