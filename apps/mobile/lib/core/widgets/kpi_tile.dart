import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../l10n/app_strings.dart';
import '../theme/machvon_semantic.dart';
import 'skeleton.dart';
import 'status_pill.dart';

/// One figure of a management screen (design.md "KpiTile"): a 12 px label, the value in 28 px with tabular digits, its unit and,
/// when there is one, a pill that says how it compares (icon and text). A [value] of null is "still loading": grey bars, never
/// a 0. The tile reads as one sentence ("label: value unit, note") and, with [onTap], as one button at least 48 dp high.
class KpiTile extends StatelessWidget {
  const KpiTile({
    required this.label,
    required this.value,
    this.unit,
    this.note,
    this.noteTone = MachvonTone.neutral,
    this.onTap,
    super.key,
  });

  final String label;

  /// The value already formatted, or null while it loads.
  final String? value;
  final String? unit;

  /// How the figure compares ("+4.2% against plan"); shown as a [StatusPill].
  final String? note;
  final MachvonTone noteTone;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final TextTheme text = Theme.of(context).textTheme;
    final bool loading = value == null;
    final String spoken = loading
        ? '$label: ${context.t('mob.states.loading.label')}'
        : '$label: ${<String>[value!, if (unit != null) unit!].join(' ')}${note == null ? '' : ', $note'}';
    final Widget body = Padding(
      padding: const EdgeInsets.all(MachvonSpace.space16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(label, style: text.bodySmall),
          const SizedBox(height: MachvonSpace.space8),
          if (loading)
            const SkeletonBar(width: 96, height: 32)
          else
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.end,
              spacing: MachvonSpace.space4,
              children: <Widget>[
                Text(value!, style: text.headlineMedium),
                if (unit != null) Text(unit!, style: text.bodySmall),
              ],
            ),
          if (note != null && !loading) ...<Widget>[
            const SizedBox(height: MachvonSpace.space8),
            StatusPill(label: note!, tone: noteTone),
          ],
        ],
      ),
    );
    final ShapeBorder shape = (Theme.of(context).cardTheme.shape ?? const RoundedRectangleBorder());
    return Semantics(
      container: true,
      button: onTap != null,
      label: spoken,
      excludeSemantics: true,
      child: Card(
        margin: EdgeInsets.zero,
        clipBehavior: Clip.antiAlias,
        shape: shape,
        child: onTap == null
            ? body
            : InkWell(onTap: onTap, child: ConstrainedBox(constraints: const BoxConstraints(minHeight: MachvonTouch.androidDp), child: body)),
      ),
    );
  }
}
