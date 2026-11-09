import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/widgets.dart';
import '../reads_models.dart';

/// The read-only views of the phone for delegations and absences (MOB-75), the KPI register (MOB-76) and the report catalogue (MOB-77).
/// They only read: the commands (granting, revoking, declaring an absence, issuing a report) stay on the computer. Each figure and rule is
/// shown as the server sends it, with the day it is of.

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

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children, this.unavailable = false});

  final String title;
  final List<Widget> children;
  final bool unavailable;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(MachvonSpace.space16, MachvonSpace.space12, MachvonSpace.space16, MachvonSpace.space4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Semantics(header: true, child: Text(title, style: theme.textTheme.titleMedium)),
          const SizedBox(height: MachvonSpace.space4),
          if (unavailable)
            Row(
              children: <Widget>[
                const ExcludeSemantics(child: Icon(Icons.info_outline, size: 18)),
                const SizedBox(width: MachvonSpace.space8),
                Expanded(child: Text(context.t('mob.reads.part.unavailable'), style: theme.textTheme.bodyMedium)),
              ],
            )
          else if (children.isEmpty)
            Text(context.t('mob.reads.empty.none'), style: theme.textTheme.bodyMedium)
          else
            ...children,
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({this.asOf, this.extra = const <String>[]});

  final String? asOf;
  final List<String> extra;

  @override
  Widget build(BuildContext context) {
    final TextStyle? style = Theme.of(context).textTheme.bodySmall;
    return Padding(
      padding: const EdgeInsets.all(MachvonSpace.space16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(context.t('mob.reads.readonly'), style: style),
          for (final String line in extra) Text(line, style: style),
          if (asOf != null) Text(context.t('mob.reads.asOf', <String, Object>{'moment': formatMoment(asOf!)}), style: style),
        ],
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.label, required this.lines});

  final String label;
  final List<String> lines;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
      child: Semantics(
        container: true,
        label: label,
        child: ExcludeSemantics(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(lines.first, style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
              for (final String line in lines.skip(1)) Text(line, style: theme.textTheme.bodyMedium),
            ],
          ),
        ),
      ),
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

String _day(String value) => value.isEmpty ? '' : (value.length > 10 ? formatMoment(value) : formatDay(value));

/// MOB-75: delegations (timeboxed and permanent), absences of the recipients of alerts with their cover, and the replacements asked for.
class DelegationsScreen extends StatelessWidget {
  const DelegationsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.reads.dele.title'),
      body: DataView<DelegationsView>(
        cacheKey: 'reads.delegations',
        read: (MachvonApiClient client) async {
          final Object? grants = await _optional(() => client.get_resources_delegation_grant(query: <String, Object?>{'limit': 50}));
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
    final List<String> header = <String>[
      if (view.ruleCode != null) context.t('mob.reads.dele.rule.line', <String, Object>{'code': view.ruleCode!, 'version': view.ruleVersion ?? ''}),
      if (view.unverified) context.t('mob.reads.dele.rule.unverified'),
    ];
    return ListView(
      children: <Widget>[
        _Header(asOf: view.asOf, extra: header),
        _Section(
          title: context.t('mob.reads.dele.grants.title'),
          unavailable: view.grants == null,
          children: <Widget>[
            for (final DelegationLine grant in view.grants ?? const <DelegationLine>[])
              _Card(
                label: grant.status,
                lines: <String>[
                  context.t('mob.reads.dele.grants.line', <String, Object>{'status': grant.status, 'from': _day(grant.validFrom), 'until': _day(grant.validUntil), 'count': grant.permissions}),
                  if (grant.reason != null) context.t('mob.reads.dele.grants.reason', <String, Object>{'reason': grant.reason!}),
                ],
              ),
          ],
        ),
        _Section(
          title: context.t('mob.reads.dele.absences.title'),
          unavailable: view.absences == null,
          children: <Widget>[
            for (final AbsenceLine absence in view.absences ?? const <AbsenceLine>[])
              _Card(
                label: absence.name ?? context.t('mob.reads.dele.absences.noName'),
                lines: <String>[
                  context.t('mob.reads.dele.absences.line', <String, Object>{
                    'name': absence.name ?? context.t('mob.reads.dele.absences.noName'),
                    'phase': _phase(context, absence.phase),
                    'from': _day(absence.validFrom),
                    'until': _day(absence.validUntil),
                  }),
                  _coverage(context, absence.coverage),
                ],
              ),
          ],
        ),
        _Section(
          title: context.t('mob.reads.dele.covers.title'),
          unavailable: view.covers == null,
          children: <Widget>[
            for (final CoverLine cover in view.covers ?? const <CoverLine>[])
              _Card(
                label: cover.status,
                lines: <String>[
                  context.t('mob.reads.dele.covers.line', <String, Object>{
                    'absent': cover.absent ?? '',
                    'deputy': cover.deputy ?? '',
                    'status': cover.status,
                    'from': _day(cover.validFrom),
                    'until': _day(cover.validUntil),
                  }),
                  if (cover.inForce) context.t('mob.reads.dele.covers.inForce'),
                ],
              ),
          ],
        ),
        const SizedBox(height: MachvonSpace.space24),
      ],
    );
  }
}

/// MOB-76: the definitions of the KPI register: formula, parts, unit, period, source, owner, version and certification.
class KpiRegisterScreen extends StatelessWidget {
  const KpiRegisterScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.reads.kpi.title'),
      body: DataView<KpiRegister>(
        cacheKey: 'reads.kpi',
        read: (MachvonApiClient client) => client.getKpiRegister(),
        parse: parseKpiRegister,
        asOf: (KpiRegister register) => register.asOf,
        isEmpty: (KpiRegister register) => register.items.isEmpty,
        builder: (BuildContext context, Loaded<KpiRegister> loaded) {
          final KpiRegister register = loaded.value;
          return ListView(
            children: <Widget>[
              _Header(asOf: register.asOf, extra: <String>[context.t('mob.reads.kpi.count', <String, Object>{'count': register.items.length})]),
              for (final KpiDefinition kpi in register.items)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
                  child: _Card(
                    label: kpi.name,
                    lines: <String>[
                      kpi.name,
                      context.t('mob.reads.kpi.line', <String, Object>{'code': kpi.code, 'version': kpi.version}),
                      if (kpi.formula != null) context.t('mob.reads.kpi.formula', <String, Object>{'formula': kpi.formula!}),
                      if (kpi.numerator != null || kpi.denominator != null) context.t('mob.reads.kpi.parts', <String, Object>{'numerator': kpi.numerator ?? '', 'denominator': kpi.denominator ?? ''}),
                      context.t('mob.reads.kpi.meta', <String, Object>{'unit': kpi.unit ?? '', 'period': kpi.period ?? '', 'source': kpi.source ?? '', 'owner': kpi.owner ?? ''}),
                      kpi.certification == 'CERTIFIED' ? context.t('mob.reads.kpi.certified') : context.t('mob.reads.kpi.notCertified'),
                      if (kpi.unverified) context.t('mob.reads.kpi.unverified'),
                    ],
                  ),
                ),
              const SizedBox(height: MachvonSpace.space24),
            ],
          );
        },
      ),
    );
  }
}

/// MOB-77: the report forms the system can issue, with their version, receiver, period and whether they can be issued. Nothing is issued here.
class ReportCatalogueScreen extends StatelessWidget {
  const ReportCatalogueScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.reads.rpt.title'),
      body: DataView<ReportCatalogue>(
        cacheKey: 'reads.reports',
        read: (MachvonApiClient client) => client.listReportCatalogue(),
        parse: parseReportCatalogue,
        asOf: (ReportCatalogue catalogue) => catalogue.asOf,
        isEmpty: (ReportCatalogue catalogue) => catalogue.items.isEmpty,
        builder: (BuildContext context, Loaded<ReportCatalogue> loaded) {
          final ReportCatalogue catalogue = loaded.value;
          return ListView(
            children: <Widget>[
              _Header(asOf: catalogue.asOf, extra: <String>[context.t('mob.reads.rpt.count', <String, Object>{'count': catalogue.items.length}), if (catalogue.demoMode) context.t('mob.reads.rpt.demoMode')]),
              for (final ReportForm form in catalogue.items)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
                  child: _Card(
                    label: form.name,
                    lines: <String>[
                      form.name,
                      context.t('mob.reads.rpt.line', <String, Object>{'code': form.code, 'version': form.version}),
                      context.t('mob.reads.rpt.meta', <String, Object>{'receiver': form.receiver, 'period': form.periodKind, 'edition': form.edition}),
                      if (form.demoMark != null) context.t('mob.reads.rpt.demo', <String, Object>{'mark': form.demoMark!}),
                      form.registered ? context.t('mob.reads.rpt.registered') : context.t('mob.reads.rpt.notRegistered'),
                      form.issuable ? context.t('mob.reads.rpt.issuable') : context.t('mob.reads.rpt.notIssuable'),
                    ],
                  ),
                ),
              const SizedBox(height: MachvonSpace.space24),
            ],
          );
        },
      ),
    );
  }
}
