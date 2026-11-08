import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OPERATIONS } from '@machvon/contracts';

const OPENAPI_PATH = resolve(__dirname, '../../../Design/MACHVON_Design/03_Engineering/openapi.json');

interface Operation {
  operationId?: string;
  requestBody?: { content?: Record<string, unknown> };
}

function operationsOfTheContract(): Array<{ id: string; method: string; operation: Operation }> {
  const document = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as { paths: Record<string, Record<string, Operation>> };
  const found: Array<{ id: string; method: string; operation: Operation }> = [];
  for (const item of Object.values(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation.operationId !== undefined) found.push({ id: operation.operationId, method, operation });
    }
  }
  return found;
}

describe('the typed command surface', () => {
  const writes = operationsOfTheContract().filter((entry) => entry.method !== 'get');

  it('leaves out only the operations whose body is offered but not as JSON', () => {
    const notJson = writes
      .filter((entry) => entry.operation.requestBody !== undefined && !('application/json' in (entry.operation.requestBody.content ?? {})))
      .map((entry) => entry.id);
    expect([...notJson].sort()).toEqual(['uploadDocumentFile', 'uploadEbsFile', 'uploadEgpFile', 'uploadFinanceFeedFile', 'uploadIndicatorFile', 'uploadLandParcelFile', 'uploadMasterImportFile', 'uploadMigrationFile', 'uploadNationalCodeFile', 'uploadOcrCorrectionFile', 'uploadPortalAttachment', 'uploadProcurementFile', 'uploadProjectDocumentFile', 'uploadProposalFile', 'uploadReportFile', 'uploadReportImportFile', 'uploadSystemTenantThemeAsset', 'uploadTreasuryStatementFile']);
  });

  it('keeps every command without a request body (they are listed in OPERATIONS and typed as commands)', () => {
    const bodyless = writes.filter((entry) => entry.operation.requestBody === undefined).map((entry) => entry.id);
    expect(bodyless.length).toBeGreaterThan(30);
    for (const id of bodyless) expect(OPERATIONS).toHaveProperty(id);
    expect(bodyless).toEqual(expect.arrayContaining(['submitCapitalPlan', 'publishAvcPolicy', 'runAllocationScenario']));
  });
});
