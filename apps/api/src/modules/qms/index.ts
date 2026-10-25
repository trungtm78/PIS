import { defineModule } from '../module-descriptor';
import { InspectionController, InspectionReadsController } from './inspection.controller';

/**
 * QMS, quality management: the inspections of work under a contract, requested by a contractor or the supervisor, given the regime and the checklist in force on the day of the request,
 * scheduled with the people who take part and recorded against the checklist (ST-QMS-004).
 */
export const qmsModule = defineModule({
  code: 'QMS',
  controllers: [InspectionController, InspectionReadsController],
});
