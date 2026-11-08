import { randomBytes } from 'node:crypto';
import { defineModule } from '../module-descriptor';
import { ORCHESTRATION_OPTIONS } from '../orchestration';
import type { OrchestrationOptions } from '../orchestration';
import { AlertCoverController } from './alert-cover.controller';
import { AlertEscalationController } from './alert-escalation.controller';
import { AlertHealthController } from './alert-health.controller';
import { AlertProfileController } from './alert-profile.controller';
import { CommandCenterController } from './command-center.controller';
import { ChannelHealthController } from './channel-health.controller';
import { HomeChangesController } from './changes.controller';
import { HomeDrillController } from './drill.controller';
import { KpiRegisterController } from './kpi-register.controller';
import { RagController } from './rag.controller';
import { MyWorkController } from './my-work.controller';
import { WorkActionClockController } from './work-action-clock.controller';
import { WorkActionController } from './work-action.controller';
import { HomeRankingsController } from './rankings.controller';
import { HomeWarningsController } from './warnings.controller';
import { HOME_CONTEXT_KEY } from './tokens';

/**
 * HOME, the command center of the leader: it owns one table, `work_action` (what people decided about an item of the alert centre: claim, assign, snooze), and reads the frozen snapshots of DIS, the registers of PRJ and CAP and the tables of the other modules that raise work, in the scope of the reader (ST-HOME-001). The context tokens of its tiles are signed
 * with the key of the application (the one that signs the contexts of background work; a token of one kind never passes for the other), or with a key of the process when none is configured.
 */
export const homeModule = defineModule({
  code: 'HOME',
  controllers: [ChannelHealthController, CommandCenterController, HomeChangesController, HomeDrillController, KpiRegisterController, RagController, HomeWarningsController, HomeRankingsController, MyWorkController, WorkActionController, WorkActionClockController, AlertHealthController, AlertEscalationController, AlertProfileController, AlertCoverController],
  providers: [
    {
      provide: HOME_CONTEXT_KEY,
      useFactory: (options?: OrchestrationOptions): Buffer => options?.contextKey ?? randomBytes(32),
      inject: [{ token: ORCHESTRATION_OPTIONS, optional: true }],
    },
  ],
});
