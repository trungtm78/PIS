import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/deadline.dart';
import '../../../core/widgets/tap_target.dart';
import '../../read_support/widgets.dart';
import '../directive_models.dart';
import '../labels.dart';

/// A directive as one row of a list: the glyph of its band (octagon, triangle, clock or tick, so the clock is never told by colour alone), the code
/// and the text, the facts a reader needs to see who owes it and by when, the status of the directive and, when there is one to say, how its clock reads
/// in the server's days. The whole row opens the directive; at least 64 high, one tap target. With [compact] only the code, the text, the unit and the
/// day are shown (the summary of a home screen).
class DirectiveRow extends StatelessWidget {
  const DirectiveRow({required this.line, required this.onTap, this.compact = false, this.dividerAbove = true, super.key});

  final DirectiveLine line;
  final VoidCallback onTap;
  final bool compact;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String status = directiveStatusLabel(context, line.status);
    final String? clock = directiveClockLabel(context, line);
    final DeadlineBand band = directiveBandOf(line.phase);
    final TextStyle fact = text.caption.copyWith(color: v2.palette.ink2);
    final Widget content = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: MachvonV2Size.rowMinHeight),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            DeadlineGlyph(band: band),
            const SizedBox(width: MachvonV2Space.s12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(line.code, style: text.label.copyWith(color: v2.palette.ink2)),
                  Text(line.text, style: text.bodyStrong, maxLines: 2, overflow: TextOverflow.ellipsis),
                  const SizedBox(height: MachvonV2Space.s4),
                  Wrap(
                    spacing: MachvonV2Space.s8,
                    runSpacing: MachvonV2Space.s4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: <Widget>[
                      if (!compact) StatusPill(label: status, tone: directiveStatusTone(line.status)),
                      if (clock != null) DeadlineLabel(band: band, text: clock, dueDay: line.dueOn),
                    ],
                  ),
                  Text(context.t('mob.dir.row.due', <String, Object>{'due': formatDay(line.dueOn)}), style: fact),
                  Text(context.t('mob.dir.row.unit', <String, Object>{'unit': line.assigneeUnit}), style: fact),
                  if (!compact) ...<Widget>[
                    Text(line.assignee == null ? context.t('mob.dir.row.personNone') : context.t('mob.dir.row.person', <String, Object>{'name': line.assignee!}), style: fact),
                    if (line.projectCode != null) Text(context.t('mob.dir.row.project', <String, Object>{'code': line.projectCode!}), style: fact),
                    if (line.extensionPending) Text(context.t('mob.dir.row.extension'), style: text.caption.copyWith(color: v2.palette.soonFg)),
                  ],
                ],
              ),
            ),
            const SizedBox(width: MachvonV2Space.s8),
            ExcludeSemantics(child: Icon(Icons.chevron_right, color: v2.palette.ink2)),
          ],
        ),
      ),
    );
    final Widget row = TapTarget(
      onTap: onTap,
      semanticLabel: context.t('mob.dir.row.aria', <String, Object>{'code': line.code, 'status': status, 'due': formatDay(line.dueOn), 'text': line.text}),
      radius: 0,
      child: SizedBox(width: double.infinity, child: content),
    );
    if (!dividerAbove) return row;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(left: MachvonV2Space.s16 + MachvonV2Size.glyph + MachvonV2Space.s12),
          child: SizedBox(height: 1, child: ColoredBox(color: v2.palette.line)),
        ),
        row,
      ],
    );
  }
}
