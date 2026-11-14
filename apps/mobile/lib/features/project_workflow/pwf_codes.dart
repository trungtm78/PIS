import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';

/// The names people read for the codes a workflow carries (roles, kinds of evidence, legal document types, grades, the events of the log, the stages of the shipped
/// templates, the part a person has in a task). Each code is looked up with its own literal key, so the table of words can be checked against the code that uses it.
/// A template of a province may use a code this table has no name for: the code itself is then shown, never a guessed name.

String pwfRoleName(BuildContext context, String code) => switch (code.trim().toUpperCase()) {
      'INVESTOR_REP' => context.t('mob.pwf6.role.investorRep'),
      'DECISION_AUTHORITY' => context.t('mob.pwf6.role.decisionAuthority'),
      'PMB_MANAGER' => context.t('mob.pwf6.role.pmbManager'),
      'PMB_PLANNER' => context.t('mob.pwf6.role.pmbPlanner'),
      'PMB_ACCOUNTANT' => context.t('mob.pwf6.role.pmbAccountant'),
      'PROCUREMENT_OFFICER' => context.t('mob.pwf6.role.procurementOfficer'),
      'SITE_ENGINEER' => context.t('mob.pwf6.role.siteEngineer'),
      'SUPERVISOR' => context.t('mob.pwf6.role.supervisor'),
      'DPI_APPRAISER' => context.t('mob.pwf6.role.dpiAppraiser'),
      'FINANCE_APPRAISER' => context.t('mob.pwf6.role.financeAppraiser'),
      'LEGAL_OFFICER' => context.t('mob.pwf6.role.legalOfficer'),
      'AUDITOR' => context.t('mob.pwf6.role.auditor'),
      _ => code,
    };

String pwfEvidenceKindName(BuildContext context, String code) => switch (code.trim().toUpperCase()) {
      'DOCUMENT' => context.t('mob.pwf6.evidence.document'),
      'DECISION_DOCUMENT' => context.t('mob.pwf6.evidence.decisionDocument'),
      'MILESTONE' => context.t('mob.pwf6.evidence.milestone'),
      'ATTESTATION' => context.t('mob.pwf6.evidence.attestation'),
      'STORED' => context.t('mob.pwf6.evidence.stored'),
      _ => code,
    };

String pwfDocTypeName(BuildContext context, String code) => switch (code.trim().toUpperCase()) {
      'INVESTMENT_POLICY_DECISION' => context.t('mob.pwf6.doc.investmentPolicyDecision'),
      'PRE_FEASIBILITY_REPORT' => context.t('mob.pwf6.doc.preFeasibilityReport'),
      'FEASIBILITY_REPORT' => context.t('mob.pwf6.doc.feasibilityReport'),
      'APPRAISAL_REPORT' => context.t('mob.pwf6.doc.appraisalReport'),
      'INVESTMENT_DECISION' => context.t('mob.pwf6.doc.investmentDecision'),
      'CAPITAL_PLAN_DECISION' => context.t('mob.pwf6.doc.capitalPlanDecision'),
      'DESIGN_APPROVAL' => context.t('mob.pwf6.doc.designApproval'),
      'BIDDING_PLAN_DECISION' => context.t('mob.pwf6.doc.biddingPlanDecision'),
      'BID_RESULT_DECISION' => context.t('mob.pwf6.doc.bidResultDecision'),
      'CONSTRUCTION_CONTRACT' => context.t('mob.pwf6.doc.constructionContract'),
      'ACCEPTANCE_MINUTES' => context.t('mob.pwf6.doc.acceptanceMinutes'),
      'PAYMENT_REQUEST' => context.t('mob.pwf6.doc.paymentRequest'),
      'TREASURY_CONTROL' => context.t('mob.pwf6.doc.treasuryControl'),
      'HANDOVER_MINUTES' => context.t('mob.pwf6.doc.handoverMinutes'),
      'SETTLEMENT_REPORT' => context.t('mob.pwf6.doc.settlementReport'),
      'SETTLEMENT_DECISION' => context.t('mob.pwf6.doc.settlementDecision'),
      'POST_EVALUATION_REPORT' => context.t('mob.pwf6.doc.postEvaluationReport'),
      _ => code,
    };

String pwfGradeName(BuildContext context, String code) => switch (code.trim().toUpperCase()) {
      'EXCELLENT' => context.t('mob.pwf6.grade.excellent'),
      'GOOD' => context.t('mob.pwf6.grade.good'),
      'FAIR' => context.t('mob.pwf6.grade.fair'),
      'WEAK' => context.t('mob.pwf6.grade.weak'),
      'POOR' => context.t('mob.pwf6.grade.poor'),
      _ => code,
    };

/// What happened to a task, in words. A kind of event this table has no word for is "Cập nhật": the log is the server's and its codes are not shown.
String pwfHistoryName(BuildContext context, String kind) => switch (kind.trim().toUpperCase()) {
      'START' => context.t('mob.pwf7.history.start'),
      'STARTED' => context.t('mob.pwf7.history.started'),
      'COMPLETE_REQUESTED' => context.t('mob.pwf7.history.completeRequested'),
      'COMPLETED' => context.t('mob.pwf7.history.completed'),
      'APPROVED' => context.t('mob.pwf7.history.approved'),
      'RETURNED' => context.t('mob.pwf7.history.returned'),
      'CANCELLED' => context.t('mob.pwf7.history.cancelled'),
      'CHECKLIST_DONE' => context.t('mob.pwf7.history.checklistDone'),
      'EVIDENCE_ATTACHED' => context.t('mob.pwf7.history.evidenceAttached'),
      'EXCEPTION_REQUESTED' => context.t('mob.pwf7.history.exceptionRequested'),
      'EXCEPTION_DECIDED' => context.t('mob.pwf7.history.exceptionDecided'),
      'ASSIGNED' => context.t('mob.pwf7.history.assigned'),
      'PAUSE_APPROVED' => context.t('mob.pwf7.history.pauseApproved'),
      'PROGRESS' => context.t('mob.pwf7.history.progress'),
      'RESUMED' => context.t('mob.pwf7.history.resumed'),
      'RESCHEDULED' => context.t('mob.pwf7.history.rescheduled'),
      _ => context.t('mob.pwf7.history.other'),
    };

/// The name of a stage of the shipped templates, for a screen that has only its code (MOB-79). A stage a province named itself keeps its code.
String pwfPhaseName(BuildContext context, String code) => switch (code.trim().toUpperCase()) {
      'PREPARATION' => context.t('mob.pwf7.phase.preparation'),
      'FEASIBILITY' => context.t('mob.pwf7.phase.feasibility'),
      'APPROVAL' => context.t('mob.pwf7.phase.approval'),
      'IMPLEMENTATION' => context.t('mob.pwf7.phase.implementation'),
      'ACCEPTANCE' => context.t('mob.pwf7.phase.acceptance'),
      'SETTLEMENT' => context.t('mob.pwf7.phase.settlement'),
      'ENDED' => context.t('mob.pwf7.phase.ended'),
      _ => code,
    };

/// The part a person has in a task (responsible, accountable, consulted, informed), in words.
String pwfPartName(BuildContext context, String role) => switch (role.trim().toUpperCase()) {
      'RESPONSIBLE' => context.t('mob.pwf7.part.responsible'),
      'ACCOUNTABLE' => context.t('mob.pwf7.part.accountable'),
      'CONSULTED' => context.t('mob.pwf7.part.consulted'),
      'INFORMED' => context.t('mob.pwf7.part.informed'),
      _ => context.t('mob.pwf7.part.other'),
    };

/// "System default" for version 0 of a rule (the shipped default has no version of the tenant), else "version N".
String pwfVersionText(BuildContext context, int version) => version == 0 ? context.t('mob.pwf6.version.default') : context.t('mob.pwf6.version.numbered', <String, Object>{'version': version});
