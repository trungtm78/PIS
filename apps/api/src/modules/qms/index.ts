import { defineModule } from '../module-descriptor';
import { AcceptanceController, AcceptanceReadsController } from './acceptance.controller';
import { NonconformanceController, NonconformanceReadsController } from './nonconformance.controller';
import { DiaryController, DiaryReadsController } from './diary.controller';
import { InspectionController, InspectionReadsController } from './inspection.controller';
import { PhotoController, PhotoReadsController } from './photo.controller';

/**
 * QMS, quality management: the electronic site diary of a contract and a day, signed in turn by the contractor, the supervisor and the owner over a hash of what it says, locked, and corrected only as a new revision (ST-QMS-001); the inspections of work under a contract, requested by a contractor or the supervisor, given the regime and the checklist in force on the day of the request,
 * scheduled with the people who take part and recorded against the checklist (ST-QMS-004); and the quality acceptance minutes drafted from an inspection that passed, signed by the roles the
 * regime requires and approved by someone other than whoever drafted them (ST-QMS-005); and the non-conformances of the work with the corrective actions that put them right (ST-QMS-006); and the register of the photos of the site, with the review flags of their time, place, repetition and EXIF (ST-QMS-003).
 */
export const qmsModule = defineModule({
  code: 'QMS',
  controllers: [DiaryController, DiaryReadsController, PhotoController, PhotoReadsController, InspectionController, InspectionReadsController, AcceptanceController, AcceptanceReadsController, NonconformanceController, NonconformanceReadsController],
});
