import { DocumentStore, PayFormStore } from '@machvon/db';
import type { ContractScopes, FormRequest, FormView, TenantTx } from '@machvon/db';
import { DomainError, formPayload, formsAskedFor, payloadSha256 } from '@machvon/kernel';
import type { MetricsSink, PaymentFormCode } from '@machvon/kernel';
import { DocumentRenderService } from '../doc/render-service';
import type { DocumentFilePort } from '../doc/file-port';
import type { StateText } from '../doc/pdf-renderer';
import type { PdfRenderer } from '@machvon/kernel';

export interface GenerateFormsInput {
  formCodes: readonly string[];
  /** Where the forms are made out, the place of the place-and-date line. */
  place: string;
}

export interface GeneratedForms {
  request: FormRequest;
  forms: FormView[];
}

const MAX_PLACE = 100;

/**
 * Draws the Treasury forms of a request that has been checked (ST-PAY-005, PAY 3.3 step 1): for each form asked for, the template in force on the day that DOC holds under the form code, only if it
 * is confirmed (`TEMPLATE_UNCONFIRMED`) and in force (`TEMPLATE_NOT_EFFECTIVE`); the payload is made from the figures of the request by the server; the file is stored by DOC and PAY keeps the
 * proof of it. The forms asked for are all drawn or none is: a refusal names the form, and nothing is kept.
 */
export class PaymentFormService {
  private readonly forms = new PayFormStore();
  private readonly documents = new DocumentStore();
  private readonly rendering: DocumentRenderService;

  constructor(files: DocumentFilePort, renderer: PdfRenderer, text: StateText, metrics: MetricsSink) {
    this.rendering = new DocumentRenderService({ files, renderer, text, metrics, documents: this.documents });
  }

  async generate(tx: TenantTx, tenantId: string, requestId: string, input: GenerateFormsInput, actor: string, scopes: ContractScopes, today: string): Promise<GeneratedForms> {
    const asked = formsAskedFor(input.formCodes);
    const place = input.place.trim();
    if (place === '' || place.length > MAX_PLACE) throw new DomainError('VALIDATION_FAILED', 422, 'place');
    const request = await this.forms.lockChecked(tx, requestId, scopes);
    const drawn: FormView[] = [];
    for (const formCode of asked) {
      drawn.push(await this.draw(tx, tenantId, request, formCode, place, actor, today));
    }
    return { request, forms: drawn };
  }

  private async draw(tx: TenantTx, tenantId: string, request: FormRequest, formCode: PaymentFormCode, place: string, actor: string, today: string): Promise<FormView> {
    const payload = formPayload({ ...request.facts, place }, formCode);
    try {
      const template = await this.documents.templateFor(tx, { formCode }, today);
      const outcome = await this.rendering.render(tx, tenantId, { formCode, requireConfirmed: true, asOfDate: today, payload, output: 'PDF', actor });
      return await this.forms.record(tx, {
        requestId: request.id,
        formCode,
        template: { id: template.id, code: template.templateCode, revision: template.revision, legalBasis: await this.forms.legalBasisOf(tx, template.id) },
        document: { documentId: outcome.documentId, versionId: outcome.version.id, checksum: outcome.version.checksum },
        payloadSha256: payloadSha256(payload),
        inputSha256: outcome.inputSha256,
        actor,
      });
    } catch (error) {
      // The refusal of the library of templates names the form it was about, so the accountant knows which one to ask the legal officer about.
      if (error instanceof DomainError && (error.code === 'TEMPLATE_UNCONFIRMED' || error.code === 'TEMPLATE_NOT_EFFECTIVE')) {
        throw new DomainError(error.code, 422, 'form_codes', { extensions: { form_code: formCode } });
      }
      throw error;
    }
  }
}
