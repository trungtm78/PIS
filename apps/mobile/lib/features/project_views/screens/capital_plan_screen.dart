import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../../read_support/wire.dart';
import '../capital_models.dart';

/// MOB-12: the lines of a capital plan by fund source: what was allocated, the part of it that is CTMTQG ("of which", never
/// added) and what was disbursed. Read-only reference data: an amount is never an input here. A line whose disbursement is
/// not known says so and is not shown as zero.
Widget buildCapitalPlanScreen(BuildContext context, ScreenContext screen) => CapitalPlanScreen(requestedPlan: screen.queryParameters['plan']);

class CapitalPlanScreen extends StatefulWidget {
  const CapitalPlanScreen({this.requestedPlan, super.key});

  final String? requestedPlan;

  @override
  State<CapitalPlanScreen> createState() => _CapitalPlanScreenState();
}

class _CapitalPlanScreenState extends State<CapitalPlanScreen> {
  String? _chosen;

  String? get _planId => _chosen ?? widget.requestedPlan;

  @override
  Widget build(BuildContext context) {
    final String? planId = _planId;
    return ScreenFrame(
      title: context.t('mob.prj.capital.title'),
      body: DataView<CapitalPlan>(
        cacheKey: 'projects.capital.${planId ?? 'default'}',
        read: (MachvonApiClient client) => _read(client, planId),
        parse: parseCapitalPlan,
        asOf: (CapitalPlan plan) => plan.asOf,
        isEmpty: (CapitalPlan plan) => plan.lines.isEmpty,
        builder: (BuildContext context, Loaded<CapitalPlan> loaded) => _PlanBody(plan: loaded.value, onPlan: (String id) => setState(() => _chosen = id)),
      ),
    );
  }

  /// The register of plans, then the lines of the plan asked for, or of the published plan of the newest year. A reader with
  /// no published plan has nothing to open: the lines are null and the screen is empty.
  static Future<Object?> _read(MachvonApiClient client, String? requested) async {
    final Json plans = await readMerged(client, 'get_resources_plan_version', query: <String, Object?>{'limit': 200});
    final List<PlanChoice> choices = <PlanChoice>[for (final Object? row in listOf(plans['items'])) ?parsePlanChoice(row)];
    final String? id = requested ?? defaultPlan(choices)?.id;
    final Json? lines = id == null ? null : await readMerged(client, 'listCapitalPlanLines', path: <String, Object?>{'id': id}, query: <String, Object?>{'limit': 200});
    return <String, Object?>{'plans': plans['items'], 'lines': lines, 'as_of': plans['as_of']};
  }
}

class _PlanBody extends StatelessWidget {
  const _PlanBody({required this.plan, required this.onPlan});

  final CapitalPlan plan;
  final ValueChanged<String> onPlan;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final List<PlanChoice> choices = <PlanChoice>[for (final PlanChoice choice in plan.plans) if (choice.published) choice];
    final String? disbursed = plan.disbursedVnd;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        if (choices.length > 1)
          Padding(
            padding: const EdgeInsets.all(MachvonSpace.space16),
            child: DropdownButtonFormField<String>(
              initialValue: choices.any((PlanChoice choice) => choice.id == plan.plan?.id) ? plan.plan?.id : null,
              isExpanded: true,
              decoration: InputDecoration(labelText: context.t('mob.prj.capital.plan.label')),
              items: <DropdownMenuItem<String>>[for (final PlanChoice choice in choices) DropdownMenuItem<String>(value: choice.id, child: Text(_optionLabel(context, choice)))],
              onChanged: (String? id) {
                if (id != null) onPlan(id);
              },
            ),
          ),
        SectionCard(
          title: context.t('mob.prj.capital.totals.title'),
          children: <Widget>[
            KpiTile(label: context.t('mob.prj.capital.allocated'), value: moneyLabel(context, plan.allocatedVnd)),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
              child: Text(context.t('mob.prj.capital.ctmtqg', <String, Object>{'value': moneyLabel(context, plan.ctmtqgVnd)}), style: theme.textTheme.bodyMedium),
            ),
            if (disbursed == null)
              FactLine(label: context.t('mob.prj.capital.disbursed'), value: context.t('mob.prj.capital.disbursed.none'))
            else
              KpiTile(label: context.t('mob.prj.capital.disbursed'), value: moneyLabel(context, disbursed)),
            if (plan.truncated) Text(context.t('mob.prj.capital.truncated'), style: theme.textTheme.bodySmall),
          ],
        ),
        for (final SourceTotals source in plan.bySource) _SourceCard(source: source),
      ],
    );
  }

  String _optionLabel(BuildContext context, PlanChoice choice) => choice.year == null
      ? context.t('mob.prj.capital.plan.optionNoYear', <String, Object>{'code': choice.code, 'revision': choice.revision})
      : context.t('mob.prj.capital.plan.option', <String, Object>{'code': choice.code, 'year': choice.year!, 'revision': choice.revision});
}

class _SourceCard extends StatelessWidget {
  const _SourceCard({required this.source});

  final SourceTotals source;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String? disbursed = source.disbursedVnd;
    return SectionCard(
      title: context.t('mob.prj.capital.source.title', <String, Object>{'source': source.label}),
      children: <Widget>[
        KpiTile(label: context.t('mob.prj.capital.allocated'), value: moneyLabel(context, source.allocatedVnd)),
        if (source.ctmtqgVnd != '0')
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space8),
            child: Text(context.t('mob.prj.capital.ctmtqg', <String, Object>{'value': moneyLabel(context, source.ctmtqgVnd)}), style: theme.textTheme.bodyMedium),
          ),
        const SizedBox(height: MachvonSpace.space8),
        if (disbursed == null)
          FactLine(label: context.t('mob.prj.capital.disbursed'), value: context.t('mob.prj.capital.disbursed.none'))
        else
          KpiTile(label: context.t('mob.prj.capital.disbursed'), value: moneyLabel(context, disbursed)),
        const Divider(),
        for (final CapitalLine line in source.lines)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(context.t('mob.prj.capital.line', <String, Object>{'code': line.projectCode, 'name': line.projectName}), style: theme.textTheme.bodyLarge),
                  Text(
                    '${context.t('mob.prj.capital.allocated')}: ${moneyLabel(context, line.allocatedVnd)} · '
                    '${context.t('mob.prj.capital.disbursed')}: ${line.disbursedVnd == null ? context.t('mob.prj.capital.disbursed.none') : moneyLabel(context, line.disbursedVnd)}',
                    style: theme.textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
