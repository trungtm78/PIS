import { DocumentStore, OutgoingDraftStore, PaySettlementFormStore } from '@machvon/db';
import type { OutgoingDocumentRecord, ScopeBuilder, SettlementFormRequest, SettlementFormView, TenantTx } from '@machvon/db';
import { DomainError, SETTLEMENT_DECISION_FORM, payloadSha256, settlementFormPayload, settlementFormsAskedFor } from '@machvon/kernel';
import type { MetricsSink, PdfRenderer, SettlementFormCode, SettlementFormFacts } from '@machvon/kernel';
import { DocumentRenderService } from '../doc/render-service';
import type { RenderOutcome } from '../doc/render-service';
import { normalisedPayload } from '../doc/outgoing-rules';
import type { DocumentFilePort } from '../doc/file-port';
import type { StateText } from '../doc/pdf-renderer';

export interface GenerateSettlementFormsInput {
  formCodes: readonly string[];
  /** Where the forms are made out, the place of the place-and-date line. */
  place: string;
}

export interface GeneratedSettlementForms {
  request: SettlementFormRequest;
  forms: SettlementFormView[];
  /** The draft of the decision 10/QTDA that DOC holds for the settlement, when that form was drawn. */
  decisionDraft: OutgoingDocumentRecord | undefined;
}

const MAX_PLACE = 100;

/**
 * Draws the forms of a settlement that is verified (ST-PAY-012, PAY 3.5 step 3): for each form asked for, the template in force on the day that DOC holds under the form code, only if it is confirmed
 * (`TEMPLATE_UNCONFIRMED`, CXN-09) and in force (`TEMPLATE_NOT_EFFECTIVE`); the payload is made from the figures of the settlement by the server; the file is stored by DOC and PAY keeps the proof of it.
 * The decision 10/QTDA is drawn the same way, as the draft of a document that DOC issues by its own steps. The forms asked for are all drawn or none is: a refusal names the form, and nothing is kept.
 */
export class SettlementFormService {
  private readonly forms = new PaySettlementFormStore();
  private readonly drafts = new OutgoingDraftStore();
  private readonly documents = new DocumentStore();
  private readonly rendering: DocumentRenderService;

  constructor(files: DocumentFilePort, renderer: PdfRenderer, text: StateText, metrics: MetricsSink) {
    this.rendering = new DocumentRenderService({ files, renderer, text, metrics, documents: this.documents });
  }

  async generate(tx: TenantTx, tenantId: string, settlementId: string, input: GenerateSettlementFormsInput, actor: string, scope: ScopeBuilder, today: string): Promise<GeneratedSettlementForms> {
    const place = input.place.trim();
    if (place === '' || place.length > MAX_PLACE) throw new DomainError('VALIDATION_FAILED', 422, 'place');
    const request = await this.forms.lockVerified(tx, settlementId, scope);
    const asked = settlementFormsAskedFor(request.scope, input.formCodes);
    const drawn: SettlementFormView[] = [];
    let decisionDraft: OutgoingDocumentRecord | undefined;
    for (const formCode of asked) {
      const done = await this.draw(tx, tenantId, request, formCode, place, actor, today);
      drawn.push(done.form);
      if (formCode === SETTLEMENT_DECISION_FORM) decisionDraft = await this.draftDecision(tx, request, done.payload, done.outcome, actor);
    }
    return { request, forms: drawn, decisionDraft };
  }

  /**
   * The decision 10/QTDA is a document that DOC issues (AC-ST-PAY-012-1, UAT-AC340): next to the file drawn as the proof of the form, an outgoing document is drafted for the unit that owns the project, with the template
   * and the payload the form was drawn from and the settlement as its subject. It stays a draft (not issued) until DOC takes it through review, signature and issue. One decision is drafted for a settlement while one that is
   * not cancelled stands; drawing the form again does not draft a second.
   */
  private async draftDecision(tx: TenantTx, request: SettlementFormRequest, payload: Record<string, unknown>, outcome: RenderOutcome, actor: string): Promise<OutgoingDocumentRecord | undefined> {
    const [standing] = await tx.query<{ id: string }>(
      "select o.id from machvon.outgoing_document o join machvon.document d on d.tenant_id = o.tenant_id and d.id = o.document_id join machvon.document_template t on t.tenant_id = o.tenant_id and t.id = o.template_id where d.subject_module = 'PAY' and d.subject_id = $1::uuid and t.form_code = $2 and o.status <> 'CANCELLED' limit 1",
      [request.id, SETTLEMENT_DECISION_FORM],
    );
    if (standing !== undefined) return undefined;
    const { template } = outcome;
    const normalised = normalisedPayload(payload);
    const draft = await this.drafts.createDraft(tx, {
      docTypeCode: template.docTypeCode,
      title: String(payload.summary),
      draftingUnitId: request.draftingUnitId,
      templateId: template.id,
      layoutProfileId: template.layoutProfileId,
      urgency: 'NORMAL',
      circulation: 'INTERNAL_CIRCULATION',
      classification: 'INTERNAL',
      payload: normalised.payload,
      payloadSha256: normalised.sha256,
      recipients: [],
      signerUserId: null,
      signerTitle: null,
      signingMode: 'DIRECT',
      delegationId: null,
      subjectModule: 'PAY',
      subjectId: request.id,
      replyToIncomingId: null,
      reviewDueOn: null,
      actor,
    });
    await this.drafts.appendEvent(tx, { outgoingDocumentId: draft.id, kind: 'CREATED', fromStatus: null, toStatus: 'DRAFT', actor, documentVersion: draft.version, occurredAt: new Date(), details: { template_id: template.id, subject_module: 'PAY', subject_id: request.id } });
    return draft;
  }

  private async draw(
    tx: TenantTx,
    tenantId: string,
    request: SettlementFormRequest,
    formCode: SettlementFormCode,
    place: string,
    actor: string,
    today: string,
  ): Promise<{ form: SettlementFormView; payload: Record<string, unknown>; outcome: RenderOutcome }> {
    const payload = settlementFormPayload({ ...request.facts, place, scope: request.facts.scope as SettlementFormFacts['scope'] }, formCode);
    try {
      const outcome = await this.rendering.render(tx, tenantId, { formCode, requireConfirmed: true, asOfDate: today, payload, issuerUnitId: request.draftingUnitId, output: 'PDF', actor });
      // The proof names the revision the render drew from, not one looked up again: a revision published in between cannot make the proof disagree with the file.
      const { template } = outcome;
      const form = await this.forms.record(tx, {
        settlementId: request.id,
        formCode,
        template: { id: template.id, code: template.templateCode, revision: template.revision, legalBasis: await this.forms.legalBasisOf(tx, template.id) },
        document: { documentId: outcome.documentId, versionId: outcome.version.id, checksum: outcome.version.checksum },
        payloadSha256: payloadSha256(payload),
        inputSha256: outcome.inputSha256,
        actor,
      });
      return { form, payload, outcome };
    } catch (error) {
      // The refusal of the library of templates names the form it was about, so the officer knows which one to ask the legal officer about.
      if (error instanceof DomainError && (error.code === 'TEMPLATE_UNCONFIRMED' || error.code === 'TEMPLATE_NOT_EFFECTIVE')) {
        throw new DomainError(error.code, 422, 'form_codes', { extensions: { form_code: formCode } });
      }
      throw error;
    }
  }
}
