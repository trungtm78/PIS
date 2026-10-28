import { defineModule } from '../module-descriptor';
import { LlmEvalController } from './eval.controller';
import { LlmFinopsController } from './finops.controller';
import { LlmKeyController } from './key.controller';
import { MockEvalRunner } from './mock-eval-runner';
import { InMemoryVault, MockLiteLlm } from './mock-key-ports';
import { LlmRegistryController } from './registry.controller';
import { LLM_ADMIN, LLM_EVAL_RUNNER, LLM_VAULT } from './tokens';

/**
 * LLM, the AI gateway: the providers and models a tenant may send data to and the classification matrix that routes each class of data (ST-LLM-001), the virtual keys that let a service call a model (ST-LLM-002), the budgets, price versions and spend (ST-LLM-003), and the prompts, evaluations and profiles with their release gate (ST-LLM-004).
 * Until LiteLLM and the vault are deployed (the operability gate of ST-LLM-002) the keys are made by stand-ins in memory: the adapters of the real services are bound to LLM_ADMIN and LLM_VAULT where they exist.
 */
export const llmModule = defineModule({
  code: 'LLM',
  controllers: [LlmRegistryController, LlmKeyController, LlmFinopsController, LlmEvalController],
  providers: [
    { provide: LLM_ADMIN, useClass: MockLiteLlm },
    { provide: LLM_VAULT, useClass: InMemoryVault },
    { provide: LLM_EVAL_RUNNER, useClass: MockEvalRunner },
  ],
});
