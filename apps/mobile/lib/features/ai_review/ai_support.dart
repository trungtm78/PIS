import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import '../read_support/widgets.dart';
import 'ai_models.dart';

/// Every surface that shows what the model said carries this notice: it is a proposal and an expert verifies it at the source. Nothing
/// on these screens applies, approves, rejects or sends anything (BR-LLM, BR-BID-09); the notice is one live region.
class AiNotice extends StatelessWidget {
  const AiNotice({super.key});

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
      color: MachvonColors.selected,
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space12),
        child: Semantics(
          container: true,
          child: Text(context.t('mob.ai.notice.text'), style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: MachvonColors.ink)),
        ),
      ),
    );
  }
}

String findingStatusLabel(BuildContext context, String status) {
  switch (status) {
    case 'SUPPORTED':
      return context.t('mob.ai.status.supported');
    case 'CONTRADICTED':
      return context.t('mob.ai.status.contradicted');
    case 'MISSING':
      return context.t('mob.ai.status.missing');
    default:
      return context.t('mob.ai.status.needsReview');
  }
}

String confidenceLabel(BuildContext context, String type) {
  switch (type) {
    case 'CALIBRATED':
      return context.t('mob.ai.signal.calibrated');
    case 'HEURISTIC':
      return context.t('mob.ai.signal.heuristic');
    default:
      return context.t('mob.ai.signal.none');
  }
}

String runStatusLabel(BuildContext context, String status) {
  switch (status) {
    case 'QUEUED':
      return context.t('mob.ai.run.queued');
    case 'RUNNING':
      return context.t('mob.ai.run.running');
    case 'AWAITING_REVIEW':
      return context.t('mob.ai.run.awaitingReview');
    case 'COMPLETED':
      return context.t('mob.ai.run.completed');
    case 'FAILED':
      return context.t('mob.ai.run.failed');
    case 'CANCELLED':
      return context.t('mob.ai.run.cancelled');
    default:
      return context.t('mob.ai.run.rejected');
  }
}

String reviewStatusLabel(BuildContext context, String status) {
  switch (status) {
    case 'AUTO_ACCEPTED':
      return context.t('mob.ai.page.review.auto');
    case 'CONFIRMED':
      return context.t('mob.ai.page.review.confirmed');
    case 'CORRECTED':
      return context.t('mob.ai.page.review.corrected');
    default:
      return context.t('mob.ai.page.review.waiting');
  }
}

/// One citation line, the same on a card and on the source viewer: where it points and whether the server found the words on the page.
String evidenceWhere(BuildContext context, Evidence evidence) {
  if (!evidence.hasSource) {
    return evidence.calcId == null ? context.t('mob.ai.evidence.noPage') : context.t('mob.ai.evidence.figure', <String, Object>{'id': evidence.calcId!});
  }
  return context.t('mob.ai.evidence.where', <String, Object>{'file': shortId(evidence.documentVersionId!), 'page': evidence.pageIndex! + 1});
}

/// A short status in a pill, wrapped so that a long label never overflows at a large text scale.
class Pills extends StatelessWidget {
  const Pills({required this.pills, super.key});

  final List<StatusPill> pills;

  @override
  Widget build(BuildContext context) => Wrap(spacing: MachvonSpace.space8, runSpacing: MachvonSpace.space4, children: pills);
}
