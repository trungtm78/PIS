import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';

/// The names people read for the codes a workflow carries (roles, kinds of evidence, legal document types, grades). Each code is looked up with its own literal key,
/// so the table of words can be checked against the code that uses it (a key built from parts is refused by the registry test). A template of a province may use a
/// code this table has no name for: the code itself is then shown, never a guessed name.

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

/// "System default" for version 0 of a rule (the shipped default has no version of the tenant), else "version N".
String pwfVersionText(BuildContext context, int version) => version == 0 ? context.t('mob.pwf6.version.default') : context.t('mob.pwf6.version.numbered', <String, Object>{'version': version});
