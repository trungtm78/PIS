import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/amounts.dart';
import '../../read_support/data_view.dart';
import '../../read_support/widgets.dart';
import '../funding.dart';

/// MOB-58: the funding structure. The capital published for a year, in cards by source (central budget, local budget, ODA, the others) and by
/// origin (year capital, carried over, support, revenue increase). CTMTQG is "of which" under NSTW, read from the plan
/// lines, and is in no total: a total never adds it again (UAT-AC240: 420 million, never 460). What has no figure says
/// "no data" and is never zero.
Widget buildFundingStructureScreen(BuildContext context, ScreenContext screen) => FundingStructureScreen(requestedYear: int.tryParse(screen.queryParameters['year'] ?? ''));

class FundingStructureScreen extends StatefulWidget {
  const FundingStructureScreen({this.requestedYear, super.key});

  final int? requestedYear;

  @override
  State<FundingStructureScreen> createState() => _FundingStructureScreenState();
}

class _FundingStructureScreenState extends State<FundingStructureScreen> {
  int? _chosen;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.home.funding.title'),
      body: DataView<FundingRegister>(
        cacheKey: 'home.funding',
        read: _read,
        parse: parseFundingRegister,
        isEmpty: (FundingRegister register) => register.years.isEmpty,
        builder: (BuildContext context, loaded) {
          final FundingRegister register = loaded.value;
          final List<int> years = register.years;
          final int year = _pick(years);
          return _FundingBody(register: register, year: year, years: years, onYear: (int next) => setState(() => _chosen = next));
        },
      ),
    );
  }

  /// The year the reader chose, else the one in the address, else the newest that has capital.
  int _pick(List<int> years) {
    for (final int? candidate in <int?>[_chosen, widget.requestedYear]) {
      if (candidate != null && years.contains(candidate)) return candidate;
    }
    return years.first;
  }

  /// The register, and the allocation lines the part that is CTMTQG is read from. When the lines cannot be read (the reader
  /// may not read them, or the read failed) the part is "no data" and not zero; it never fails the screen. A connection that
  /// fails is not that: it fails the read, so that the copy kept on the device is shown instead.
  static Future<Object?> _read(MachvonApiClient client) async {
    final List<Object?> appropriations = await client.readAll('listAppropriations');
    List<Object?>? lines;
    try {
      lines = await client.readAll('get_resources_allocation_line');
    } on ApiError catch (error) {
      if (error.code == networkErrorCode) rethrow;
    }
    return <String, Object?>{'appropriations': appropriations, 'lines': lines};
  }
}

class _FundingBody extends StatelessWidget {
  const _FundingBody({required this.register, required this.year, required this.years, required this.onYear});

  final FundingRegister register;
  final int year;
  final List<int> years;
  final ValueChanged<int> onYear;

  @override
  Widget build(BuildContext context) {
    final Funding funding = fundingOf(register, year);
    final ThemeData theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: context.t('mob.home.funding.year.label'),
          children: <Widget>[
            Wrap(
              spacing: MachvonSpace.space8,
              children: <Widget>[
                for (final int option in years)
                  ChoiceChip(
                    label: Text(context.t('mob.home.funding.year.option', <String, Object>{'year': option})),
                    selected: option == year,
                    onSelected: (bool selected) => onYear(option),
                  ),
              ],
            ),
          ],
        ),
        SectionCard(
          title: context.t('mob.home.funding.total.title', <String, Object>{'year': year}),
          children: <Widget>[
            _Amount(vnd: funding.totalVnd, large: true),
            Text(context.t('mob.home.funding.total.note'), style: theme.textTheme.bodySmall),
          ],
        ),
        SectionCard(
          title: context.t('mob.home.funding.sources.title'),
          children: <Widget>[for (final SourceCard card in funding.sources) _SourceCardView(card: card)],
        ),
        SectionCard(
          title: context.t('mob.home.funding.origins.title'),
          children: <Widget>[for (final OriginCard card in funding.origins) _OriginCardView(card: card)],
        ),
      ],
    );
  }
}

class _Amount extends StatelessWidget {
  const _Amount({required this.vnd, this.large = false});

  final String? vnd;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return MergeSemantics(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(millionsLabel(context, vnd), style: (large ? theme.textTheme.headlineSmall : theme.textTheme.titleMedium)?.copyWith(fontWeight: FontWeight.w700)),
          if (vnd != null) Text(dongLabel(context, vnd), style: theme.textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _SourceCardView extends StatelessWidget {
  const _SourceCardView({required this.card});

  final SourceCard card;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final SubsetFigure? subset = card.subset;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Semantics(header: true, child: Text(_category(context, card.category), style: theme.textTheme.bodyLarge)),
          _Amount(vnd: card.vnd),
          if (card.count > 0) Text(context.t('mob.home.funding.card.count', <String, Object>{'count': card.count}), style: theme.textTheme.bodySmall),
          if (subset != null)
            Text(
              subset.vnd == null
                  ? context.t('mob.home.funding.subset.none')
                  : context.t('mob.home.funding.subset.line', <String, Object>{'value': millionsLabel(context, subset.vnd)}),
              style: theme.textTheme.bodyMedium,
            ),
          if (subset != null && subset.partial && subset.vnd != null) Text(context.t('mob.home.funding.subset.partial'), style: theme.textTheme.bodySmall),
        ],
      ),
    );
  }

  String _category(BuildContext context, FundCategory category) {
    switch (category) {
      case FundCategory.nstw:
        return context.t('mob.home.funding.category.nstw');
      case FundCategory.nsdp:
        return context.t('mob.home.funding.category.nsdp');
      case FundCategory.oda:
        return context.t('mob.home.funding.category.oda');
      case FundCategory.ctmtqg:
      case FundCategory.other:
        return context.t('mob.home.funding.category.other');
    }
  }
}

class _OriginCardView extends StatelessWidget {
  const _OriginCardView({required this.card});

  final OriginCard card;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Semantics(header: true, child: Text(_origin(context, card.origin), style: theme.textTheme.bodyLarge)),
          _Amount(vnd: card.vnd),
          if (card.count > 0) Text(context.t('mob.home.funding.card.count', <String, Object>{'count': card.count}), style: theme.textTheme.bodySmall),
        ],
      ),
    );
  }

  String _origin(BuildContext context, CapitalOrigin origin) {
    switch (origin) {
      case CapitalOrigin.pmAssigned:
        return context.t('mob.home.funding.origin.pmAssigned');
      case CapitalOrigin.localAdded:
        return context.t('mob.home.funding.origin.localAdded');
      case CapitalOrigin.carryover:
        return context.t('mob.home.funding.origin.carryover');
      case CapitalOrigin.centralSupport:
        return context.t('mob.home.funding.origin.centralSupport');
      case CapitalOrigin.revenueIncrease:
        return context.t('mob.home.funding.origin.revenueIncrease');
    }
  }
}
