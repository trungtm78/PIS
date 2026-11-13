import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/state_view.dart';
import '../../core/widgets/tap_target.dart';
import '../read_support/widgets.dart';
import 'ai_models.dart';

/// Every surface that shows what the model said carries this notice: it is a proposal and an expert verifies it at the source. Nothing
/// on these screens applies, approves, rejects or sends anything (BR-LLM, BR-BID-09); the notice is one live region.
class AiNotice extends StatelessWidget {
  const AiNotice({super.key});

  @override
  Widget build(BuildContext context) => StatusBanner(text: context.t('mob.ai.notice.text'), icon: Icons.auto_awesome_outlined);
}

/// The shape and the tone of what the model proposed, so that the verdict is never told by colour alone: a glyph, the words and the tone.
({IconData icon, MachvonTone tone}) findingTone(String status) {
  switch (status) {
    case 'SUPPORTED':
      return (icon: Icons.check_circle_outline, tone: MachvonTone.success);
    case 'CONTRADICTED':
      return (icon: Icons.error_outline, tone: MachvonTone.danger);
    case 'MISSING':
      return (icon: Icons.help_outline, tone: MachvonTone.warning);
    default:
      return (icon: Icons.hourglass_empty, tone: MachvonTone.info);
  }
}

/// A row of a list of this feature: a title, the lines under it and, when it opens something, the chevron. At least 64 high, one tap
/// target, read as one button with [semanticLabel].
class AiRow extends StatelessWidget {
  const AiRow({required this.title, this.subtitle, this.caption, this.onTap, this.semanticLabel, this.dividerAbove = true, super.key});

  final String title;
  final String? subtitle;
  final String? caption;
  final VoidCallback? onTap;
  final String? semanticLabel;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final Widget content = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: MachvonV2Size.rowMinHeight),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(title, style: text.bodyStrong),
                  if (subtitle != null) Text(subtitle!, style: text.body),
                  if (caption != null) Text(caption!, style: text.caption.copyWith(color: v2.palette.ink2)),
                ],
              ),
            ),
            if (onTap != null) ExcludeSemantics(child: Icon(Icons.chevron_right, color: v2.palette.ink2)),
          ],
        ),
      ),
    );
    final Widget row = onTap == null
        ? Semantics(container: true, label: semanticLabel, excludeSemantics: semanticLabel != null, child: content)
        : TapTarget(onTap: onTap, semanticLabel: semanticLabel, radius: 0, child: SizedBox(width: double.infinity, child: content));
    if (!dividerAbove) return row;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[SizedBox(height: 1, child: ColoredBox(color: v2.palette.line)), row],
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
  Widget build(BuildContext context) => Wrap(spacing: MachvonV2Space.s8, runSpacing: MachvonV2Space.s4, children: pills);
}
