import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/underline_tabs.dart';
import '../../acceptance_handover/widgets/fact_row.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/widgets.dart';
import '../reads_models.dart';

/// The read-only views of the phone for delegations and absences (MOB-75), the KPI register (MOB-76) and the report catalogue (MOB-77).
/// They only read: the commands (granting, revoking, declaring an absence, issuing a report) stay on the computer. Each figure and rule is
/// shown as the server sends it, with the day it is of (the line of context above the list says it).

Widget buildDelegationsScreen(BuildContext context, ScreenContext screen) => const DelegationsScreen();

Widget buildKpiRegisterScreen(BuildContext context, ScreenContext screen) => const KpiRegisterScreen();

Widget buildReportCatalogueScreen(BuildContext context, ScreenContext screen) => const ReportCatalogueScreen();

/// A read that may be refused or fail without taking the whole screen with it: the part is then null and the screen says so.
Future<Object?> _optional(Future<Object?> Function() read) async {
  try {
    return await read();
  } on ApiError {
    return null;
  }
}

/// The note every one of these views opens with: nothing here can be changed on the phone.
class _ReadOnlyNote extends StatelessWidget {
  const _ReadOnlyNote({this.extra = const <String>[], this.warning});

  final List<String> extra;

  /// A caution the data carries (a rule that is not verified, a demo environment).
  final String? warning;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        StatusBanner(text: context.t('mob.reads.readonly'), icon: Icons.lock_outline),
        if (warning != null) StatusBanner(text: warning!, tone: BannerTone.warning),
        for (final String line in extra)
          Padding(
            padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s8, MachvonV2Space.s16, 0),
            child: Text(line, style: context.v2text.caption.copyWith(color: v2.palette.ink2)),
          ),
      ],
    );
  }
}

/// A part that could not be read, or that the person may not see: said in words, with a way to try again; never drawn as an empty list.
class _Unavailable extends StatelessWidget {
  const _Unavailable({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return StateView(
      kind: StateKind.denied,
      title: context.t('mob.reads.part.unavailable.title'),
      body: context.t('mob.reads.part.unavailable'),
      actionLabel: context.t('mob.read.refresh.action'),
      onAction: onRetry,
    );
  }
}

/// A list with nothing in it: says why (the changes are made on the computer) and offers to read again.
class _Nothing extends StatelessWidget {
  const _Nothing({required this.onRetry, this.clearLabel, this.onClear});

  final VoidCallback onRetry;

  /// When a filter hid every row: the action that clears it.
  final String? clearLabel;
  final VoidCallback? onClear;

  @override
  Widget build(BuildContext context) {
    return StateView(
      kind: StateKind.empty,
      title: context.t('mob.reads.empty.none'),
      body: context.t('mob.reads.empty.body'),
      actionLabel: clearLabel ?? context.t('mob.read.refresh.action'),
      onAction: onClear ?? onRetry,
    );
  }
}

String _phase(BuildContext context, String phase) {
  switch (phase) {
    case 'SCHEDULED':
      return context.t('mob.reads.dele.phase.scheduled');
    case 'ACTIVE':
      return context.t('mob.reads.dele.phase.active');
    case 'OVER':
      return context.t('mob.reads.dele.phase.over');
  }
  return phase;
}

String _coverage(BuildContext context, String coverage) {
  switch (coverage) {
    case 'COVERED':
      return context.t('mob.reads.dele.coverage.covered');
    case 'PARTIAL':
      return context.t('mob.reads.dele.coverage.partial');
    case 'UNCOVERED':
      return context.t('mob.reads.dele.coverage.uncovered');
    case 'NOT_APPLICABLE':
      return context.t('mob.reads.dele.coverage.notApplicable');
  }
  return coverage;
}

MachvonTone _coverageTone(String coverage) => switch (coverage) {
      'COVERED' => MachvonTone.success,
      'PARTIAL' => MachvonTone.warning,
      'UNCOVERED' => MachvonTone.danger,
      _ => MachvonTone.neutral,
    };

String _day(String value) => value.isEmpty ? '' : (value.length > 10 ? formatMoment(value) : formatDay(value));

/// A row of these views: it carries the facts and is read as one sentence; it opens nothing.
Widget _row(BuildContext context, {required String title, required List<String> lines, required IconData icon, required int index, Widget? trailing}) => FactRow(
      title: title,
      icon: icon,
      lines: lines,
      trailing: trailing,
      dividerAbove: index > 0,
      semanticLabel: <String>[title, ...lines].join('. '),
      onTap: null,
    );

/// MOB-75: delegations (timeboxed and permanent), absences of the recipients of alerts with their cover, and the replacements asked for.
/// Three tabs, one for each of the three lists the server answers.
class DelegationsScreen extends StatefulWidget {
  const DelegationsScreen({super.key});

  @override
  State<DelegationsScreen> createState() => _DelegationsScreenState();
}

class _DelegationsScreenState extends State<DelegationsScreen> {
  int _tab = 0;
  int _reload = 0;

  void _retry() => setState(() => _reload += 1);

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.reads.dele.title'),
      body: DataView<DelegationsView>(
        cacheKey: 'reads.delegations',
        reloadKey: _reload,
        read: (MachvonApiClient client) async {
          final Object? grants = await _optional(() => client.getResourcesDelegationGrant(query: <String, Object?>{'limit': 50}));
          final Object? absences = await _optional(() => client.listAlertAbsences(query: <String, Object?>{'mine': false}));
          return <String, Object?>{'grants': grants, 'absences': absences};
        },
        parse: (Object? raw) => raw is Map ? parseDelegations(grants: raw['grants'], absences: raw['absences']) : null,
        asOf: (DelegationsView view) => view.asOf,
        builder: (BuildContext context, Loaded<DelegationsView> loaded) => _delegations(context, loaded.value),
      ),
    );
  }

  Widget _delegations(BuildContext context, DelegationsView view) {
    final Widget content;
    switch (_tab) {
      case 0:
        content = _grants(context, view.grants);
      case 1:
        content = _absences(context, view.absences);
      default:
        content = _covers(context, view.covers);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _ReadOnlyNote(
          extra: <String>[if (view.ruleCode != null) context.t('mob.reads.dele.rule.line', <String, Object>{'code': view.ruleCode!, 'version': view.ruleVersion ?? ''})],
          warning: view.unverified ? context.t('mob.reads.dele.rule.unverified') : null,
        ),
        UnderlineTabs(
          tabs: <TabOption>[
            TabOption(label: context.t('mob.reads.dele.tab.grants'), count: view.grants?.length),
            TabOption(label: context.t('mob.reads.dele.tab.absences'), count: view.absences?.length),
            TabOption(label: context.t('mob.reads.dele.tab.covers'), count: view.covers?.length),
          ],
          index: _tab,
          onChanged: (int index) => setState(() => _tab = index),
        ),
        Expanded(child: content),
      ],
    );
  }

  Widget _grants(BuildContext context, List<DelegationLine>? grants) {
    if (grants == null) return _Unavailable(onRetry: _retry);
    if (grants.isEmpty) return _Nothing(onRetry: _retry);
    return ListView(
      children: <Widget>[
        for (int index = 0; index < grants.length; index += 1)
          _row(
            context,
            index: index,
            icon: Icons.verified_user_outlined,
            title: context.t('mob.reads.dele.grants.line', <String, Object>{'status': grants[index].status, 'from': _day(grants[index].validFrom), 'until': _day(grants[index].validUntil), 'count': grants[index].permissions}),
            lines: <String>[if (grants[index].reason != null) context.t('mob.reads.dele.grants.reason', <String, Object>{'reason': grants[index].reason!})],
          ),
      ],
    );
  }

  Widget _absences(BuildContext context, List<AbsenceLine>? absences) {
    if (absences == null) return _Unavailable(onRetry: _retry);
    if (absences.isEmpty) return _Nothing(onRetry: _retry);
    return ListView(
      children: <Widget>[
        for (int index = 0; index < absences.length; index += 1)
          _row(
            context,
            index: index,
            icon: Icons.event_busy_outlined,
            title: absences[index].name ?? context.t('mob.reads.dele.absences.noName'),
            lines: <String>[
              context.t('mob.reads.dele.absences.span', <String, Object>{'phase': _phase(context, absences[index].phase), 'from': _day(absences[index].validFrom), 'until': _day(absences[index].validUntil)}),
            ],
            trailing: StatusPill(label: _coverage(context, absences[index].coverage), tone: _coverageTone(absences[index].coverage)),
          ),
      ],
    );
  }

  Widget _covers(BuildContext context, List<CoverLine>? covers) {
    if (covers == null) return _Unavailable(onRetry: _retry);
    if (covers.isEmpty) return _Nothing(onRetry: _retry);
    return ListView(
      children: <Widget>[
        for (int index = 0; index < covers.length; index += 1)
          _row(
            context,
            index: index,
            icon: Icons.people_alt_outlined,
            title: context.t('mob.reads.dele.covers.line', <String, Object>{
              'absent': covers[index].absent ?? '',
              'deputy': covers[index].deputy ?? '',
              'status': covers[index].status,
              'from': _day(covers[index].validFrom),
              'until': _day(covers[index].validUntil),
            }),
            lines: const <String>[],
            trailing: covers[index].inForce ? StatusPill(label: context.t('mob.reads.dele.covers.inForce'), tone: MachvonTone.success) : null,
          ),
      ],
    );
  }
}

/// MOB-76: the definitions of the KPI register: formula, parts, unit, period, source, owner, version and certification. A filter narrows them
/// to the certified ones or to those that are not.
class KpiRegisterScreen extends StatefulWidget {
  const KpiRegisterScreen({super.key});

  @override
  State<KpiRegisterScreen> createState() => _KpiRegisterScreenState();
}

class _KpiRegisterScreenState extends State<KpiRegisterScreen> {
  /// null: every indicator; true: the certified ones; false: those that are not.
  bool? _certified;
  int _reload = 0;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.reads.kpi.title'),
      body: DataView<KpiRegister>(
        cacheKey: 'reads.kpi',
        reloadKey: _reload,
        read: (MachvonApiClient client) => client.getKpiRegister(),
        parse: parseKpiRegister,
        asOf: (KpiRegister register) => register.asOf,
        isEmpty: (KpiRegister register) => register.items.isEmpty,
        builder: (BuildContext context, Loaded<KpiRegister> loaded) {
          final List<KpiDefinition> all = loaded.value.items;
          final int certified = all.where((KpiDefinition kpi) => kpi.certification == 'CERTIFIED').length;
          final List<KpiDefinition> shown = <KpiDefinition>[
            for (final KpiDefinition kpi in all)
              if (_certified == null || (kpi.certification == 'CERTIFIED') == _certified) kpi,
          ];
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              _ReadOnlyNote(extra: <String>[context.t('mob.reads.kpi.count', <String, Object>{'count': all.length})]),
              FilterChips<bool?>(
                options: <ChipOption<bool?>>[
                  ChipOption<bool?>(value: null, label: context.t('mob.reads.filter.all'), count: all.length),
                  ChipOption<bool?>(value: true, label: context.t('mob.reads.kpi.certified'), count: certified),
                  ChipOption<bool?>(value: false, label: context.t('mob.reads.kpi.notCertified'), count: all.length - certified),
                ],
                selected: _certified,
                onChanged: (bool? value) => setState(() => _certified = value),
              ),
              Expanded(
                child: shown.isEmpty
                    ? _Nothing(onRetry: () => setState(() => _reload += 1), clearLabel: context.t('mob.states.empty.clearFilters.action'), onClear: () => setState(() => _certified = null))
                    : ListView(
                        children: <Widget>[
                          for (int index = 0; index < shown.length; index += 1)
                            _row(
                              context,
                              index: index,
                              icon: Icons.analytics_outlined,
                              title: shown[index].name,
                              lines: <String>[
                                context.t('mob.reads.kpi.line', <String, Object>{'code': shown[index].code, 'version': shown[index].version}),
                                if (shown[index].formula != null) context.t('mob.reads.kpi.formula', <String, Object>{'formula': shown[index].formula!}),
                                if (shown[index].numerator != null || shown[index].denominator != null)
                                  context.t('mob.reads.kpi.parts', <String, Object>{'numerator': shown[index].numerator ?? '', 'denominator': shown[index].denominator ?? ''}),
                                context.t('mob.reads.kpi.meta', <String, Object>{'unit': shown[index].unit ?? '', 'period': shown[index].period ?? '', 'source': shown[index].source ?? '', 'owner': shown[index].owner ?? ''}),
                              ],
                              trailing: Column(
                                crossAxisAlignment: CrossAxisAlignment.end,
                                mainAxisSize: MainAxisSize.min,
                                children: <Widget>[
                                  shown[index].certification == 'CERTIFIED'
                                      ? StatusPill(label: context.t('mob.reads.kpi.certified'), tone: MachvonTone.success)
                                      : StatusPill(label: context.t('mob.reads.kpi.notCertified'), tone: MachvonTone.neutral),
                                  if (shown[index].unverified) ...<Widget>[
                                    const SizedBox(height: MachvonV2Space.s4),
                                    StatusPill(label: context.t('mob.reads.kpi.unverified'), tone: MachvonTone.warning),
                                  ],
                                ],
                              ),
                            ),
                        ],
                      ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// MOB-77: the report forms the system can issue, with their version, receiver, period and whether they can be issued. Nothing is issued
/// here. A filter narrows them to those that can be issued or those that cannot.
class ReportCatalogueScreen extends StatefulWidget {
  const ReportCatalogueScreen({super.key});

  @override
  State<ReportCatalogueScreen> createState() => _ReportCatalogueScreenState();
}

class _ReportCatalogueScreenState extends State<ReportCatalogueScreen> {
  /// null: every form; true: those that can be issued; false: those that cannot.
  bool? _issuable;
  int _reload = 0;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.reads.rpt.title'),
      body: DataView<ReportCatalogue>(
        cacheKey: 'reads.reports',
        reloadKey: _reload,
        read: (MachvonApiClient client) => client.listReportCatalogue(),
        parse: parseReportCatalogue,
        asOf: (ReportCatalogue catalogue) => catalogue.asOf,
        isEmpty: (ReportCatalogue catalogue) => catalogue.items.isEmpty,
        builder: (BuildContext context, Loaded<ReportCatalogue> loaded) {
          final ReportCatalogue catalogue = loaded.value;
          final int issuable = catalogue.items.where((ReportForm form) => form.issuable).length;
          final List<ReportForm> shown = <ReportForm>[
            for (final ReportForm form in catalogue.items)
              if (_issuable == null || form.issuable == _issuable) form,
          ];
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              _ReadOnlyNote(extra: <String>[context.t('mob.reads.rpt.count', <String, Object>{'count': catalogue.items.length})], warning: catalogue.demoMode ? context.t('mob.reads.rpt.demoMode') : null),
              FilterChips<bool?>(
                options: <ChipOption<bool?>>[
                  ChipOption<bool?>(value: null, label: context.t('mob.reads.filter.all'), count: catalogue.items.length),
                  ChipOption<bool?>(value: true, label: context.t('mob.reads.rpt.issuable'), count: issuable),
                  ChipOption<bool?>(value: false, label: context.t('mob.reads.rpt.notIssuable'), count: catalogue.items.length - issuable),
                ],
                selected: _issuable,
                onChanged: (bool? value) => setState(() => _issuable = value),
              ),
              Expanded(
                child: shown.isEmpty
                    ? _Nothing(onRetry: () => setState(() => _reload += 1), clearLabel: context.t('mob.states.empty.clearFilters.action'), onClear: () => setState(() => _issuable = null))
                    : ListView(
                        children: <Widget>[
                          for (int index = 0; index < shown.length; index += 1)
                            _row(
                              context,
                              index: index,
                              icon: Icons.description_outlined,
                              title: shown[index].name,
                              lines: <String>[
                                context.t('mob.reads.rpt.line', <String, Object>{'code': shown[index].code, 'version': shown[index].version}),
                                context.t('mob.reads.rpt.meta', <String, Object>{'receiver': shown[index].receiver, 'period': shown[index].periodKind, 'edition': shown[index].edition}),
                                if (shown[index].demoMark != null) context.t('mob.reads.rpt.demo', <String, Object>{'mark': shown[index].demoMark!}),
                                shown[index].registered ? context.t('mob.reads.rpt.registered') : context.t('mob.reads.rpt.notRegistered'),
                              ],
                              trailing: shown[index].issuable
                                  ? StatusPill(label: context.t('mob.reads.rpt.issuable'), tone: MachvonTone.success)
                                  : StatusPill(label: context.t('mob.reads.rpt.notIssuable'), tone: MachvonTone.neutral),
                            ),
                        ],
                      ),
              ),
            ],
          );
        },
      ),
    );
  }
}
