import { defineModule } from '../module-descriptor';
import { LlmRegistryController } from './registry.controller';

/** LLM, the AI gateway: the providers and models a tenant may send data to and the classification matrix that routes each class of data (ST-LLM-001). */
export const llmModule = defineModule({
  code: 'LLM',
  controllers: [LlmRegistryController],
});
