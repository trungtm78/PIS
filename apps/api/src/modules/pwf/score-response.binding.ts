import { Inject, Injectable, Optional } from '@nestjs/common';
import { pwfKpi } from '@machvon/kernel';
import { APPROVAL_FINAL_COMMANDS } from '../adm/approval.service';
import type { FinalCommandRegistry } from '../adm/approval.service';
import { scoreResponseHandler, scoreResponseSummary } from './score-response.flow';

/** Binds the final command of `score.response` into the registry of the approval engine when the application starts, so that the boot guard of ADM (R14) finds a real handler for the business type PWF owns. */
@Injectable()
export class PwfScoreResponseBinding {
  constructor(@Optional() @Inject(APPROVAL_FINAL_COMMANDS) commands?: FinalCommandRegistry) {
    commands?.register(pwfKpi.SCORE_RESPONSE_BUSINESS_TYPE, scoreResponseHandler());
    // What the approver reads before deciding (lane fix11): the response, the score it is about, the period and the unit.
    commands?.registerSummary(pwfKpi.SCORE_RESPONSE_BUSINESS_TYPE, scoreResponseSummary());
  }
}
