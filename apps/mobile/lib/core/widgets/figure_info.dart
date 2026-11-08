import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../l10n/app_strings.dart';
import 'status_pill.dart';

/// The definition a number is made by (G0-4): the words of the register behind a figure, as the web gives them in its "i" panel. The phone reads them
/// from the same API answer (the `kpi` member of a figure), so a leader gets the same formula, source and day on both.
final class FigureInfo {
  const FigureInfo({
    required this.name,
    required this.formula,
    required this.source,
    required this.asOf,
    required this.owner,
    this.numerator,
    this.denominator,
    this.exclusions = const <String>[],
    this.version = 0,
    this.isDefault = false,
    this.unverified = false,
  });

  /// The name of the figure: the title of the panel and part of the name of the button.
  final String name;
  final String formula;

  /// What is above and below the line, when the definition says (a count has neither).
  final String? numerator;
  final String? denominator;
  final List<String> exclusions;
  final String source;

  /// The day the figure is counted up to, as the caller writes it (a day `YYYY-MM-DD` is shown as day, month, year).
  final String asOf;
  final String owner;
  final int version;

  /// The version is the built-in one: nobody of the tenant approved a rule.
  final bool isDefault;

  /// The numbers of the definition are a starting value nobody confirmed.
  final bool unverified;

  /// The definition of a `kpi` member of an API figure, or null when there is nothing to open: without a code and a formula there is no definition,
  /// and a figure with no definition has no "i" rather than an empty one (the web does the same).
  static FigureInfo? parse(Object? raw) {
    if (raw is! Map) return null;
    final String? code = _filled(raw['code']);
    final String? formula = _filled(raw['formula']);
    if (code == null || formula == null) return null;
    final Object? exclusions = raw['exclusions'];
    final Object? version = raw['version'];
    return FigureInfo(
      name: _filled(raw['name']) ?? code,
      formula: formula,
      numerator: _filled(raw['numerator']),
      denominator: _filled(raw['denominator']),
      exclusions: exclusions is List
          ? <String>[
              for (final Object? item in exclusions)
                if (_filled(item) != null) item! as String,
            ]
          : const <String>[],
      source: _filled(raw['source']) ?? '',
      asOf: _filled(raw['asOf']) ?? '',
      owner: _filled(raw['owner']) ?? '',
      version: version is int && version >= 0 ? version : 0,
      isDefault: raw['origin'] == 'DEFAULT',
      unverified: raw['unverified'] == true,
    );
  }

  static String? _filled(Object? value) =>
      value is String && value.trim().isNotEmpty ? value : null;
}

String _dayText(String value) => RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(value)
    ? '${value.substring(8, 10)}/${value.substring(5, 7)}/${value.substring(0, 4)}'
    : value;

/// The "i" of a figure: one button, at least 48 dp square, named "Formula and source of <figure>", that opens the definition the number is made by in a
/// sheet (the formula in words, what is above and below the line, what is left out, the source, the day, who answers for it, the version, and the note
/// when the definition is a starting value). It reads nothing of its own and says nothing the register did not say; the sheet has a close button, and the
/// back gesture closes it.
class FigureInfoButton extends StatelessWidget {
  const FigureInfoButton({required this.info, super.key});

  final FigureInfo info;

  @override
  Widget build(BuildContext context) {
    final String label = context.t(
      'mob.info.figure.open.action',
      <String, Object>{'name': info.name},
    );
    return IconButton(
      tooltip: label,
      constraints: const BoxConstraints(
        minWidth: MachvonTouch.androidDp,
        minHeight: MachvonTouch.androidDp,
      ),
      icon: const Icon(Icons.info_outline),
      onPressed: () => showFigureInfoSheet(context, info),
    );
  }
}

/// Opens the definition of a figure in a bottom sheet.
Future<void> showFigureInfoSheet(BuildContext context, FigureInfo info) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (BuildContext sheet) => FigureInfoSheet(info: info),
  );
}

/// The content of the sheet of a definition.
class FigureInfoSheet extends StatelessWidget {
  const FigureInfoSheet({required this.info, super.key});

  final FigureInfo info;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String version = info.isDefault
        ? context.t('mob.info.figure.version.default', <String, Object>{
            'version': info.version,
          })
        : context.t('mob.info.figure.version.value', <String, Object>{
            'version': info.version,
          });
    final List<({String label, String value})> rows =
        <({String label, String value})>[
          (
            label: context.t('mob.info.figure.formula.label'),
            value: info.formula,
          ),
          if (info.numerator != null)
            (
              label: context.t('mob.info.figure.numerator.label'),
              value: info.numerator!,
            ),
          if (info.denominator != null)
            (
              label: context.t('mob.info.figure.denominator.label'),
              value: info.denominator!,
            ),
          (
            label: context.t('mob.info.figure.source.label'),
            value: info.source.isEmpty ? '—' : info.source,
          ),
          (
            label: context.t('mob.info.figure.asOf.label'),
            value: info.asOf.isEmpty ? '—' : _dayText(info.asOf),
          ),
          (
            label: context.t('mob.info.figure.owner.label'),
            value: info.owner.isEmpty ? '—' : info.owner,
          ),
          (label: context.t('mob.info.figure.version.label'), value: version),
        ];
    return Semantics(
      scopesRoute: true,
      explicitChildNodes: true,
      namesRoute: true,
      label: info.name,
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Semantics(
              header: true,
              child: Text(info.name, style: theme.textTheme.titleMedium),
            ),
            const SizedBox(height: MachvonSpace.space8),
            for (final ({String label, String value}) row in rows)
              Padding(
                padding: const EdgeInsets.only(bottom: MachvonSpace.space8),
                child: MergeSemantics(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        row.label,
                        style: theme.textTheme.labelMedium?.copyWith(
                          color: MachvonColors.textSecondary,
                        ),
                      ),
                      Text(row.value, style: theme.textTheme.bodyLarge),
                    ],
                  ),
                ),
              ),
            if (info.exclusions.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: MachvonSpace.space8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      context.t('mob.info.figure.exclusions.label'),
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: MachvonColors.textSecondary,
                      ),
                    ),
                    for (final String item in info.exclusions)
                      Text('• $item', style: theme.textTheme.bodyLarge),
                  ],
                ),
              ),
            if (info.unverified)
              Padding(
                padding: const EdgeInsets.only(bottom: MachvonSpace.space8),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: StatusPill(
                    label: context.t('mob.info.figure.unverified.note'),
                    warn: true,
                  ),
                ),
              ),
            OutlinedButton(
              onPressed: () => Navigator.of(context).pop(),
              child: Text(context.t('mob.info.figure.close.action')),
            ),
          ],
        ),
      ),
    );
  }
}
