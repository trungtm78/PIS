import { defineModule } from '../module-descriptor';
import { EffectiveAccessController } from './effective-access.controller';
import { SupportTicketController } from './support-ticket.controller';

/** IAM, access and the person: what the caller may do and where (IAM-09), and the support ticket (IAM-08). Tenant selection and the membership reads still live in src/session. */
export const iamModule = defineModule({
  code: 'IAM',
  controllers: [EffectiveAccessController, SupportTicketController],
});
