import { isProductionEnvironment } from '@machvon/kernel';
import { ChannelAccountsController } from '../../omni/channel-accounts.controller';
import { ContactsController } from '../../omni/contacts/contacts.controller';
import { IDENTITY_OTP_SENDER, MockOtpSender, UnconfiguredOtpSender } from '../../omni/contacts/identity-otp';
import { CHANNEL_VERIFIER, MockChannelVerifier, UnconfiguredChannelVerifier } from '../../omni/channel-verifier';
import { defineModule } from '../module-descriptor';

/**
 * OMNI, the omnichannel center: the channel accounts of the tenant (ST-OMNI-001): connected with references to their secrets, verified against the provider, changed and closed; and the contact directory (ST-OMNI-002): contacts with verified identities, merged only on a verified identity they share. The code is in apps/api/src/omni.
 */
export const omniModule = defineModule({
  code: 'OMNI',
  controllers: [ChannelAccountsController, ContactsController],
  providers: [
    // MACHVON_ENVIRONMENT names the deployment; unset or unknown means production, where the providers are not reached by a stand-in: no account can be verified until a real verifier is provided.
    { provide: CHANNEL_VERIFIER, useFactory: () => (isProductionEnvironment(process.env.MACHVON_ENVIRONMENT) ? new UnconfiguredChannelVerifier() : new MockChannelVerifier()) },
    // Likewise the codes that verify an identity: production sends none until a provider of messages is contracted, and an identity there is verified by the provider or by a document.
    { provide: IDENTITY_OTP_SENDER, useFactory: () => (isProductionEnvironment(process.env.MACHVON_ENVIRONMENT) ? new UnconfiguredOtpSender() : new MockOtpSender()) },
  ],
});
