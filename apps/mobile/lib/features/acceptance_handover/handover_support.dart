import 'package:flutter/material.dart';

import '../../core/l10n/app_strings.dart';

String handoverKindLabel(BuildContext context, String kind) {
  switch (kind) {
    case 'COMPLETION':
      return context.t('mob.handover.kind.completion');
    case 'ASSET_TRANSFER':
      return context.t('mob.handover.kind.assetTransfer');
    default:
      return context.t('mob.handover.kind.partial');
  }
}

String handoverStatusLabel(BuildContext context, String status) {
  switch (status) {
    case 'INSPECTING':
      return context.t('mob.handover.status.inspecting');
    case 'PUNCH_PENDING':
      return context.t('mob.handover.status.punchPending');
    case 'ACCEPTED':
      return context.t('mob.handover.status.accepted');
    case 'REJECTED':
      return context.t('mob.handover.status.rejected');
    case 'CANCELLED':
      return context.t('mob.handover.status.cancelled');
    default:
      return context.t('mob.handover.status.draft');
  }
}

String severityLabel(BuildContext context, String severity) {
  switch (severity) {
    case 'CRITICAL':
      return context.t('mob.handover.severity.critical');
    case 'MAJOR':
      return context.t('mob.handover.severity.major');
    default:
      return context.t('mob.handover.severity.minor');
  }
}

String punchStatusLabel(BuildContext context, String status) {
  switch (status) {
    case 'FIXED':
      return context.t('mob.handover.punch.fixed');
    case 'VERIFIED':
      return context.t('mob.handover.punch.verified');
    case 'WAIVED':
      return context.t('mob.handover.punch.waived');
    default:
      return context.t('mob.handover.punch.open');
  }
}

String warrantyStatusLabel(BuildContext context, String status) {
  switch (status) {
    case 'EXPIRED':
      return context.t('mob.handover.warranty.status.expired');
    case 'CLOSED':
      return context.t('mob.handover.warranty.status.closed');
    default:
      return context.t('mob.handover.warranty.status.active');
  }
}
