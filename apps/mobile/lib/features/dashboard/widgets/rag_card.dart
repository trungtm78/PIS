import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../read_support/moment.dart';
import '../../read_support/widgets.dart';
import '../home_insight.dart';

/// How many units the card explains at once: the worst ones, red first. The rest are counted and left to the computer.
const int ragUnitsShown = 3;

/// A number as the screen writes it: at most two decimals, the decimal sign of the language.
String ragNumber(double value, String language) {
  String text = value.toStringAsFixed(2);
  if (text.contains('.')) {
    text = text
        .replaceFirst(RegExp(r'0+$'), '')
        .replaceFirst(RegExp(r'\.$'), '');
  }
  return language == 'en' ? text : text.replaceAll('.', ',');
}

/// The name of a colour in words: a colour is never told by its tint alone.
String ragBandLabel(BuildContext context, RagBand band) {
  switch (band) {
    case RagBand.red:
      return context.t('mob.home.rag.band.red');
    case RagBand.amber:
      return context.t('mob.home.rag.band.amber');
    case RagBand.green:
      return context.t('mob.home.rag.band.green');
    case RagBand.noData:
      return context.t('mob.home.rag.band.noData');
  }
}

/// Red is danger, amber is warning, green is success, "not enough data" is neutral (never green).
MachvonTone ragBandTone(RagBand band) {
  switch (band) {
    case RagBand.red:
      return MachvonTone.danger;
    case RagBand.amber:
      return MachvonTone.warning;
    case RagBand.green:
      return MachvonTone.success;
    case RagBand.noData:
      return MachvonTone.neutral;
  }
}

/// The name of a factor of the rules; a factor the phone has no name for is shown by its code, not hidden.
String ragFactorName(BuildContext context, String code) {
  switch (code) {
    case factorRatePace:
      return context.t('mob.home.rag.factor.ratePace');
    case factorCritical:
      return context.t('mob.home.rag.factor.critical');
    case factorOverdue:
      return context.t('mob.home.rag.factor.overdue');
    case factorNoDataShare:
      return context.t('mob.home.rag.factor.noDataShare');
    default:
      return code;
  }
}

/// The value of a factor against its line, in words: "is 0.55 (green from 0.9, amber from 0.6)". A factor with no value says so.
String ragFactorLine(BuildContext context, RagFactor factor) {
  if (factor.value == null) return context.t('mob.home.rag.factor.noValue');
  final String language = AppStrings.of(context).language;
  final String suffix = factor.code == factorNoDataShare ? '%' : '';
  final Map<String, Object> values = <String, Object>{
    'value': '${ragNumber(factor.value!, language)}$suffix',
    'green': '${ragNumber(factor.green, language)}$suffix',
    'amber': '${ragNumber(factor.amber, language)}$suffix',
  };
  return factor.higherIsBetter
      ? context.t('mob.home.rag.line.higher', values)
      : context.t('mob.home.rag.line.lower', values);
}

/// The colours of the units with the reason for each (G3-2, the web's "colours with their reasons" on the leader home): the count of units by colour, then
/// the worst units, each with the one to three factors that moved its colour, how much of the data was there, the score of the week before and the
/// override beside the colour of the rules. A unit with too little data is "not enough data", never green and never a score of 0. The card is read only:
/// overriding a colour and scoring the week are done on the computer. A failure to read it is named here, with a retry, and never turns into a colour.
class RagCard extends StatelessWidget {
  const RagCard({
    required this.reading,
    required this.errorCode,
    required this.onRetry,
    super.key,
  });

  final RagReading? reading;
  final String? errorCode;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final RagReading? read = reading;
    if (read == null) {
      final bool denied =
          errorCode == 'SCOPE_DENIED' || errorCode == 'PERMISSION_DENIED';
      final bool noSnapshot = errorCode == 'RESOURCE_NOT_FOUND';
      return SectionCard(
        title: context.t('mob.home.rag.title'),
        children: <Widget>[
          Semantics(
            liveRegion: true,
            container: true,
            child: denied
                ? Text(
                    context.t('mob.home.rag.denied.text'),
                    style: theme.textTheme.bodyMedium,
                  )
                : noSnapshot
                ? Text(
                    context.t('mob.home.rag.noSnapshot.text'),
                    style: theme.textTheme.bodyMedium,
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        context.t('mob.home.rag.error.text', <String, Object>{
                          'code': errorCode ?? 'UNKNOWN',
                        }),
                        style: theme.textTheme.bodyMedium,
                      ),
                      const SizedBox(height: MachvonSpace.space8),
                      OutlinedButton(
                        onPressed: onRetry,
                        child: Text(context.t('mob.home.rag.retry.action')),
                      ),
                    ],
                  ),
          ),
        ],
      );
    }
    final List<RagUnit> worst = <RagUnit>[
      for (final RagUnit unit in read.units)
        if (unit.band != RagBand.green) unit,
    ];
    final List<RagUnit> shown = worst.take(ragUnitsShown).toList();
    final int rest = worst.length - shown.length;
    final String language = AppStrings.of(context).language;
    return SectionCard(
      title: context.t('mob.home.rag.title'),
      children: <Widget>[
        if (read.weekStart.isNotEmpty)
          Text(
            context.t('mob.home.rag.asOf.text', <String, Object>{
              'week': formatDay(read.weekStart),
            }),
            style: theme.textTheme.bodySmall,
          ),
        const SizedBox(height: MachvonSpace.space8),
        Semantics(
          container: true,
          label: context.t('mob.home.rag.summary.aria'),
          child: Wrap(
            spacing: MachvonSpace.space8,
            runSpacing: MachvonSpace.space4,
            children: <Widget>[
              for (final RagBand band in const <RagBand>[
                RagBand.red,
                RagBand.amber,
                RagBand.noData,
                RagBand.green,
              ])
                StatusPill(
                  label: context.t(
                    'mob.home.rag.summary.line',
                    <String, Object>{
                      'band': ragBandLabel(context, band),
                      'count': read.summary[band] ?? 0,
                    },
                  ),
                  tone: ragBandTone(band),
                ),
            ],
          ),
        ),
        if (shown.isEmpty)
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space8),
            child: Text(
              context.t('mob.home.rag.allGreen.text'),
              style: theme.textTheme.bodyMedium,
            ),
          )
        else
          for (final RagUnit unit in shown)
            _UnitBlock(
              unit: unit,
              minCoverage: read.minCoveragePct,
              language: language,
            ),
        if (rest > 0)
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space8),
            child: Text(
              context.t('mob.home.rag.more.text', <String, Object>{
                'count': rest,
              }),
              style: theme.textTheme.bodySmall,
            ),
          ),
        Padding(
          padding: const EdgeInsets.only(top: MachvonSpace.space8),
          child: Text(
            _modelLine(context, read, language),
            style: theme.textTheme.bodySmall,
          ),
        ),
        if (read.unverified)
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space4),
            child: Align(
              alignment: Alignment.centerLeft,
              child: StatusPill(
                label: context.t('mob.home.rag.model.unverified'),
                warn: true,
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.only(top: MachvonSpace.space4),
          child: Text(
            context.t('mob.home.rag.readOnly.text'),
            style: theme.textTheme.bodySmall,
          ),
        ),
      ],
    );
  }

  String _modelLine(BuildContext context, RagReading read, String language) {
    final String lines = read.scoreGreen == null || read.scoreAmber == null
        ? context.t('mob.home.rag.model.noLines')
        : context.t('mob.home.rag.model.lines', <String, Object>{
            'green': ragNumber(read.scoreGreen!, language),
            'amber': ragNumber(read.scoreAmber!, language),
          });
    return read.minCoveragePct == null
        ? lines
        : '$lines ${context.t('mob.home.rag.model.coverage', <String, Object>{'min': ragNumber(read.minCoveragePct!, language)})}';
  }
}

class _UnitBlock extends StatelessWidget {
  const _UnitBlock({
    required this.unit,
    required this.minCoverage,
    required this.language,
  });

  final RagUnit unit;
  final double? minCoverage;
  final String language;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String label = unit.code.isEmpty
        ? unit.name
        : '${unit.code} ${unit.name}'.trim();
    final bool noData = unit.band == RagBand.noData;
    final bool partial =
        !noData && unit.coveragePct != null && unit.coveragePct! < 100;
    final double? delta = unit.scoreDelta;
    final RagWeek? previous = unit.previous;
    final RagOverride? override = unit.override;
    return Padding(
      padding: const EdgeInsets.only(top: MachvonSpace.space12),
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border.all(color: MachvonColors.border),
          borderRadius: const BorderRadius.all(
            Radius.circular(MachvonRadius.control),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.all(MachvonSpace.space12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Semantics(
                header: true,
                child: Text(label, style: theme.textTheme.titleSmall),
              ),
              const SizedBox(height: MachvonSpace.space4),
              Wrap(
                spacing: MachvonSpace.space8,
                runSpacing: MachvonSpace.space4,
                children: <Widget>[
                  StatusPill(
                    label: ragBandLabel(context, unit.band),
                    tone: ragBandTone(unit.band),
                  ),
                  if (unit.overridden)
                    StatusPill(
                      label: context.t('mob.home.rag.overridden.text'),
                      tone: MachvonTone.info,
                    ),
                  if (partial)
                    StatusPill(
                      label: context.t('mob.home.rag.partial.text'),
                      warn: true,
                    ),
                ],
              ),
              if (override != null) ...<Widget>[
                const SizedBox(height: MachvonSpace.space8),
                Text(
                  context.t('mob.home.rag.override.rules', <String, Object>{
                    'band': ragBandLabel(context, unit.ruleBand),
                  }),
                  style: theme.textTheme.bodySmall,
                ),
                Text(
                  context.t('mob.home.rag.override.shown', <String, Object>{
                    'band': ragBandLabel(context, override.band),
                  }),
                  style: theme.textTheme.bodySmall,
                ),
                if (override.reason.isNotEmpty)
                  Text(
                    context.t('mob.home.rag.override.reason', <String, Object>{
                      'reason': override.reason,
                    }),
                    style: theme.textTheme.bodySmall,
                  ),
                if (override.until.isNotEmpty)
                  Text(
                    context.t('mob.home.rag.override.until', <String, Object>{
                      'day': formatDay(override.until),
                    }),
                    style: theme.textTheme.bodySmall,
                  ),
                if (override.by.isNotEmpty)
                  Text(
                    context.t('mob.home.rag.override.by', <String, Object>{
                      'name': override.by,
                    }),
                    style: theme.textTheme.bodySmall,
                  ),
              ],
              const SizedBox(height: MachvonSpace.space8),
              Text(
                unit.score == null
                    ? context.t('mob.home.rag.score.none')
                    : context.t('mob.home.rag.score.value', <String, Object>{
                        'score': ragNumber(unit.score!, language),
                      }),
                style: theme.textTheme.bodyMedium,
              ),
              if (delta != null && delta != 0)
                Text(
                  delta > 0
                      ? context.t('mob.home.rag.delta.worse', <String, Object>{
                          'delta': ragNumber(delta, language),
                        })
                      : context.t('mob.home.rag.delta.better', <String, Object>{
                          'delta': ragNumber(delta.abs(), language),
                        }),
                  style: theme.textTheme.bodySmall,
                ),
              if (unit.coveragePct != null)
                Text(
                  context.t('mob.home.rag.coverage.value', <String, Object>{
                    'value': ragNumber(unit.coveragePct!, language),
                  }),
                  style: theme.textTheme.bodySmall,
                ),
              if (previous == null)
                Text(
                  context.t('mob.home.rag.previous.none'),
                  style: theme.textTheme.bodySmall,
                )
              else
                Text(
                  previous.score == null
                      ? context.t(
                          'mob.home.rag.previous.noScore',
                          <String, Object>{
                            'band': ragBandLabel(context, previous.band),
                            'week': formatDay(previous.weekStart),
                          },
                        )
                      : context.t(
                          'mob.home.rag.previous.value',
                          <String, Object>{
                            'band': ragBandLabel(context, previous.band),
                            'score': ragNumber(previous.score!, language),
                            'week': formatDay(previous.weekStart),
                          },
                        ),
                  style: theme.textTheme.bodySmall,
                ),
              const SizedBox(height: MachvonSpace.space8),
              if (noData)
                Semantics(
                  liveRegion: true,
                  child: Text(
                    minCoverage == null || unit.coveragePct == null
                        ? context.t('mob.home.rag.noData.body')
                        : context.t(
                            'mob.home.rag.noData.coverage',
                            <String, Object>{
                              'coverage': ragNumber(
                                unit.coveragePct!,
                                language,
                              ),
                              'min': ragNumber(minCoverage!, language),
                            },
                          ),
                    style: theme.textTheme.bodyMedium,
                  ),
                )
              else if (unit.reasons.isEmpty)
                Text(
                  context.t('mob.home.rag.reasons.none'),
                  style: theme.textTheme.bodySmall,
                )
              else ...<Widget>[
                Semantics(
                  header: true,
                  child: Text(
                    context.t('mob.home.rag.reasons.title'),
                    style: theme.textTheme.labelLarge,
                  ),
                ),
                for (final RagFactor factor in unit.reasons)
                  Padding(
                    padding: const EdgeInsets.only(top: MachvonSpace.space4),
                    child: Text(
                      '${ragFactorName(context, factor.code)}: ${ragFactorLine(context, factor)} · ${context.t('mob.home.rag.points', <String, Object>{'points': ragNumber(factor.points, language)})}',
                      style: theme.textTheme.bodyMedium,
                    ),
                  ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
