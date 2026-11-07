import { defineModule } from '../module-descriptor';
import { DirectiveController, SteeringMeetingController } from './directive.controller';
import { DirectiveReadsController, SteeringMeetingReadsController } from './directive-reads.controller';

/**
 * DIR, the directives of the investment steering meetings (roadmap CN.03 and QT.02, "chỉ đạo giao ban"): the meeting with its minutes (DIR-01, DIR-02), the directives it gives, who must do them and by when, the board
 * that follows them (DIR-03), the directive with its timeline, extensions and closing (DIR-04), and the directives of a period as the input of the next report (DIR-05). The clock of each due day feeds the alert centre
 * as the source `DIRECTIVE` (packages/db/src/home-directive-sources.ts, hooked in HomeWorkStore).
 */
export const dirModule = defineModule({
  code: 'DIR',
  controllers: [SteeringMeetingController, SteeringMeetingReadsController, DirectiveController, DirectiveReadsController],
});
