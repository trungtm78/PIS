import { isProductionEnvironment } from '@machvon/kernel';
import { ChannelAccountsController } from '../../omni/channel-accounts.controller';
import { CHANNEL_VERIFIER, MockChannelVerifier, UnconfiguredChannelVerifier } from '../../omni/channel-verifier';
import { defineModule } from '../module-descriptor';

/**
 * OMNI, the omnichannel center: so far the channel accounts of the tenant (ST-OMNI-001): connected with references to their secrets, verified against the provider, changed and closed. The code is in apps/api/src/omni.
 */
export const omniModule = defineModule({
  code: 'OMNI',
  controllers: [ChannelAccountsController],
  providers: [
    // MACHVON_ENVIRONMENT names the deployment; unset or unknown means production, where the providers are not reached by a stand-in: no account can be verified until a real verifier is provided.
    { provide: CHANNEL_VERIFIER, useFactory: () => (isProductionEnvironment(process.env.MACHVON_ENVIRONMENT) ? new UnconfiguredChannelVerifier() : new MockChannelVerifier()) },
  ],
});
