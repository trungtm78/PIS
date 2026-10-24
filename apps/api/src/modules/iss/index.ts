import { defineModule } from '../module-descriptor';
import { IssSlaPolicyController } from './iss-sla-policy.controller';
import { IssSlaPolicyReadsController } from './iss-sla-policy-reads.controller';

/** ISS, issues and field work: the SLA policies by category, severity and unit (ST-ISS-001). */
export const issModule = defineModule({
  code: 'ISS',
  controllers: [IssSlaPolicyController, IssSlaPolicyReadsController],
});
