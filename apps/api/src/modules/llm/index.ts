import { AuditWriter, TenantDatabase } from '@machvon/db';
import { FileService } from '../files';
import { defineModule } from '../module-descriptor';
import { LlmEmergencyController } from './emergency.controller';
import { LlmEvalController } from './eval.controller';
import { LlmFinopsController } from './finops.controller';
import { LlmGatewayController } from './gateway.controller';
import { LlmGatewayService } from './gateway.service';
import { LlmKeyController } from './key.controller';
import { LlmKnowledgeController, LlmKnowledgeReadsController } from './knowledge.controller';
import { LLM_DOCUMENT_TEXT, LLM_EMBEDDING, MockEmbeddingPort, OcrDocumentTextPort } from './knowledge-ports';
import type { AiEmbeddingPort, DocumentTextPort } from './knowledge-ports';
import { AiKnowledgeService } from './knowledge.service';
import { MockEvalRunner } from './mock-eval-runner';
import { MockAiGateway } from './mock-gateway';
import { InMemoryVault, MockLiteLlm } from './mock-key-ports';
import { LlmReconcileController } from './reconcile.controller';
import { LlmRegistryController } from './registry.controller';
import { LLM_ADMIN, LLM_EVAL_RUNNER, LLM_GATEWAY, LLM_VAULT } from './tokens';

/**
 * LLM, the AI gateway: the providers and models a tenant may send data to and the classification matrix that routes each class of data (ST-LLM-001), the virtual keys that let a service call a model (ST-LLM-002), the budgets, price versions and spend (ST-LLM-003), and the prompts, evaluations and profiles with their release gate (ST-LLM-004).
 * Until LiteLLM and the vault are deployed (the operability gate of ST-LLM-002) the keys are made by stand-ins in memory: the adapters of the real services are bound to LLM_ADMIN and LLM_VAULT where they exist.
 */
export const llmModule = defineModule({
  code: 'LLM',
  controllers: [
    LlmRegistryController,
    LlmKeyController,
    LlmFinopsController,
    LlmEvalController,
    LlmGatewayController,
    LlmEmergencyController,
    LlmKnowledgeController,
    LlmKnowledgeReadsController,
    LlmReconcileController,
  ],
  providers: [
    { provide: LLM_ADMIN, useClass: MockLiteLlm },
    { provide: LLM_VAULT, useClass: InMemoryVault },
    { provide: LLM_EVAL_RUNNER, useClass: MockEvalRunner },
    { provide: LLM_GATEWAY, useClass: MockAiGateway },
    LlmGatewayService,
    // The embeddings come from a stand-in until the gateway goes through LiteLLM; the text of a document is the text the OCR of the document module recorded (ST-LLM-007).
    { provide: LLM_EMBEDDING, useClass: MockEmbeddingPort },
    { provide: LLM_DOCUMENT_TEXT, useFactory: (files: FileService): DocumentTextPort => new OcrDocumentTextPort(files), inject: [FileService] },
    {
      provide: AiKnowledgeService,
      useFactory: (embeddings: AiEmbeddingPort, texts: DocumentTextPort, files: FileService, tenants: TenantDatabase) => new AiKnowledgeService(embeddings, texts, files, new AuditWriter(tenants)),
      inject: [LLM_EMBEDDING, LLM_DOCUMENT_TEXT, FileService, TenantDatabase],
    },
  ],
});
