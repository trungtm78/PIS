import { randomBytes } from 'node:crypto';
import { defineModule } from '../module-descriptor';
import { ORCHESTRATION_OPTIONS } from '../orchestration';
import type { OrchestrationOptions } from '../orchestration';
import { CommandCenterController } from './command-center.controller';
import { HomeDrillController } from './drill.controller';
import { MyWorkController } from './my-work.controller';
import { HomeRankingsController } from './rankings.controller';
import { HomeWarningsController } from './warnings.controller';
import { HOME_CONTEXT_KEY } from './tokens';

/**
 * HOME, the command center of the leader: it owns no table and reads the frozen snapshots of DIS and the registers of PRJ and CAP in the scope of the reader (ST-HOME-001). The context tokens of its tiles are signed
 * with the key of the application (the one that signs the contexts of background work; a token of one kind never passes for the other), or with a key of the process when none is configured.
 */
export const homeModule = defineModule({
  code: 'HOME',
  controllers: [CommandCenterController, HomeDrillController, HomeWarningsController, HomeRankingsController, MyWorkController],
  providers: [
    {
      provide: HOME_CONTEXT_KEY,
      useFactory: (options?: OrchestrationOptions): Buffer => options?.contextKey ?? randomBytes(32),
      inject: [{ token: ORCHESTRATION_OPTIONS, optional: true }],
    },
  ],
});
