import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../home_insight.dart';

/// The screen of the work of the person: the one place a line of the block can be opened to on the phone.
const String kChangesMyWorkScreenId = 'MOB-08';

/// The magnitude of a change as text: the direction says up or down, so the sign of a delta is not said twice.
String changeMagnitude(String? value) =>
    (value ?? '').replaceFirst(RegExp(r'^[+-]'), '');

/// One line as a sentence from the templates of the screen: its numbers are the ones of the server, the direction picks the words.
String changeSentence(BuildContext context, ChangeLine line) {
  final Map<String, String> p = line.params;
  final String delta = changeMagnitude(p['delta']);
  final Map<String, Object> numbers = <String, Object>{
    'from': p['from'] ?? '',
    'to': p['to'] ?? '',
    'delta': delta,
  };
  switch (line.kind) {
    case ChangeKind.unitsToRed:
      return context.t('mob.home.changes.unitsToRed', <String, Object>{
        'count': p['count'] ?? '',
      });
    case ChangeKind.unitsRecovered:
      return context.t('mob.home.changes.unitsRecovered', <String, Object>{
        'count': p['count'] ?? '',
      });
    case ChangeKind.rateChange:
      return line.up
          ? context.t('mob.home.changes.rate.up', numbers)
          : context.t('mob.home.changes.rate.down', numbers);
    case ChangeKind.warningsDelta:
      return line.up
          ? context.t('mob.home.changes.warnings.up', numbers)
          : context.t('mob.home.changes.warnings.down', numbers);
    case ChangeKind.overdueDelta:
      return line.up
          ? context.t('mob.home.changes.overdue.up', numbers)
          : context.t('mob.home.changes.overdue.down', numbers);
    case ChangeKind.noDataDelta:
      return line.up
          ? context.t('mob.home.changes.noData.up', numbers)
          : context.t('mob.home.changes.noData.down', numbers);
    case ChangeKind.disbursedWeek:
      final String amount = formatDong(
        changeMagnitude(p['amount_vnd']),
        AppStrings.of(context).language,
      );
      return line.up
          ? context.t('mob.home.changes.disbursed.up', <String, Object>{
              'amount': amount,
            })
          : context.t('mob.home.changes.disbursed.down', <String, Object>{
              'amount': amount,
            });
  }
}

/// Where a line can be checked, in words: the phone opens the work of the person, and says where the other lines are checked (never a link that
/// opens nothing).
String changeCheckText(BuildContext context, ChangeLink link) {
  switch (link) {
    case ChangeLink.drill:
      return context.t('mob.home.changes.check.drill');
    case ChangeLink.rag:
      return context.t('mob.home.changes.check.rag');
    case ChangeLink.warnings:
      return context.t('mob.home.changes.check.warnings');
    case ChangeLink.myWork:
      return context.t('mob.home.changes.check.myWork');
    case ChangeLink.ranking:
      return context.t('mob.home.changes.check.ranking');
  }
}

/// "What changed since last week" (G3-4, the web's block on the leader home): at most five sentences the server made by rules from this week's snapshot and
/// the week before, each with its numbers and where it can be checked. A failed read is an error with a retry, never "no change"; a week with no week
/// before says so; a week where nothing moved says so.
class ChangesBlock extends StatelessWidget {
  const ChangesBlock({
    required this.changes,
    required this.errorCode,
    required this.onRetry,
    super.key,
  });

  final HomeChanges? changes;
  final String? errorCode;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final HomeChanges? read = changes;
    if (read == null) {
      final bool denied =
          errorCode == 'SCOPE_DENIED' || errorCode == 'PERMISSION_DENIED';
      final bool noSnapshot = errorCode == 'RESOURCE_NOT_FOUND';
      return SectionCard(
        title: context.t('mob.home.changes.title'),
        children: <Widget>[
          Semantics(
            liveRegion: true,
            container: true,
            child: denied
                ? Text(
                    context.t('mob.home.changes.denied.text'),
                    style: theme.textTheme.bodyMedium,
                  )
                : noSnapshot
                ? Text(
                    context.t('mob.home.changes.noSnapshot.text'),
                    style: theme.textTheme.bodyMedium,
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        context.t(
                          'mob.home.changes.error.text',
                          <String, Object>{'code': errorCode ?? 'UNKNOWN'},
                        ),
                        style: theme.textTheme.bodyMedium,
                      ),
                      const SizedBox(height: MachvonSpace.space8),
                      OutlinedButton(
                        onPressed: onRetry,
                        child: Text(context.t('mob.home.changes.retry.action')),
                      ),
                    ],
                  ),
          ),
        ],
      );
    }
    return SectionCard(
      title: context.t('mob.home.changes.title'),
      children: <Widget>[
        if (read.previousWeekStart.isNotEmpty)
          Text(
            context.t('mob.home.changes.range.text', <String, Object>{
              'week': formatDay(read.weekStart),
              'previous': formatDay(read.previousWeekStart),
            }),
            style: theme.textTheme.bodySmall,
          ),
        const SizedBox(height: MachvonSpace.space8),
        if (read.noPreviousWeek)
          Semantics(
            liveRegion: true,
            child: Text(
              context.t('mob.home.changes.noPrevious.text'),
              style: theme.textTheme.bodyMedium,
            ),
          )
        else if (read.lines.isEmpty)
          Semantics(
            liveRegion: true,
            child: Text(
              context.t('mob.home.changes.none.text'),
              style: theme.textTheme.bodyMedium,
            ),
          )
        else
          for (final ChangeLine line in read.lines) _LineRow(line: line),
      ],
    );
  }
}

class _LineRow extends StatelessWidget {
  const _LineRow({required this.line});

  final ChangeLine line;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String sentence = changeSentence(context, line);
    final String check = changeCheckText(context, line.link);
    final Widget body = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        // The arrow is a picture of what the sentence says; the sentence says rose or fell.
        ExcludeSemantics(
          child: Icon(
            line.up ? Icons.arrow_upward : Icons.arrow_downward,
            size: 20,
          ),
        ),
        const SizedBox(width: MachvonSpace.space8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(sentence, style: theme.textTheme.bodyMedium),
              Text(check, style: theme.textTheme.bodySmall),
            ],
          ),
        ),
        if (line.link == ChangeLink.myWork)
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
      ],
    );
    if (line.link == ChangeLink.myWork) {
      return TappableRow(
        semanticLabel: '$sentence $check',
        onTap: () => openScreen(context, kChangesMyWorkScreenId),
        child: body,
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
      child: MergeSemantics(child: body),
    );
  }
}
