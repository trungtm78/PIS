import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/state/empty_state_view.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../../read_support/wire.dart';
import '../handover_models.dart';
import '../handover_support.dart';

/// MOB-66: the works handed over and the warranty they carry. Without a parameter it lists the handovers in the scope of the
/// reader (recipient unit, defects still on the punch list, warranty), those with open critical defects first; with
/// `?handover=<id>` it shows one handover with its punch list and its warranty obligations. It only reads: a copy kept on the
/// device says the moment it describes, and the deadlines are the server's words (the status of a warranty is the server's for the
/// day, never counted with the clock of the phone).
Widget buildHandoverScreen(BuildContext context, ScreenContext screen) {
  final String? id = screen.queryParameters['handover'];
  return id == null || id.isEmpty ? const _HandoverListScreen() : _HandoverScreen(handoverId: id);
}

/// The warranty obligations, or none and a mark that the reader may not read them: that right is separate from the handovers'.
Future<(Json?, bool)> _warranties(MachvonApiClient client, {String? handoverId}) async {
  try {
    final Json page = await readMerged(client, 'listWarrantyObligations', query: <String, Object?>{'limit': 200, 'handover_id': handoverId});
    return (page, false);
  } on ApiError catch (error) {
    if (error.status == 403 && error.code != 'LICENSE_EXPIRED') return (null, true);
    rethrow;
  }
}

Future<Object?> _readRegister(MachvonApiClient client) async {
  final Json handovers = await readMerged(client, 'get_resources_handover', query: <String, Object?>{'limit': 200});
  final (Json? warranties, bool refused) = await _warranties(client);
  return <String, Object?>{'handovers': handovers, 'warranties': warranties, 'warranties_refused': refused};
}

Future<Object?> _readTrace(MachvonApiClient client, String id) async {
  final Object? trace = await client.getHandoverTrace(id: id);
  final (Json? warranties, bool refused) = await _warranties(client, handoverId: id);
  return <String, Object?>{'trace': trace, 'warranties': warranties, 'warranties_refused': refused};
}

class _HandoverListScreen extends StatefulWidget {
  const _HandoverListScreen();

  @override
  State<_HandoverListScreen> createState() => _HandoverListScreenState();
}

class _HandoverListScreenState extends State<_HandoverListScreen> {
  bool _onlyOpen = false;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.handover.list.title'),
      body: DataView<HandoverRegister>(
        cacheKey: 'handover.register',
        read: _readRegister,
        parse: parseHandoverRegister,
        asOf: (HandoverRegister register) => register.asOf,
        isEmpty: (HandoverRegister register) => register.handovers.isEmpty,
        builder: (BuildContext context, Loaded<HandoverRegister> loaded) {
          final HandoverRegister register = loaded.value;
          final List<HandoverLine> shown = <HandoverLine>[
            for (final HandoverLine line in register.handovers)
              if (!_onlyOpen || line.status == 'PUNCH_PENDING' || line.openCriticalCount > 0) line,
          ];
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              CheckboxListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
                value: _onlyOpen,
                title: Text(context.t('mob.handover.list.filter.open')),
                onChanged: (bool? value) => setState(() => _onlyOpen = value ?? false),
              ),
              if (register.warrantiesRefused)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
                  child: Text(context.t('mob.handover.list.warrantyRefused'), style: Theme.of(context).textTheme.bodyMedium),
                ),
              Expanded(
                child: shown.isEmpty
                    ? EmptyStateView(activeFilters: <String>[context.t('mob.handover.list.filter.open')], onClearFilters: () => setState(() => _onlyOpen = false))
                    : ListView(
                        children: <Widget>[
                          for (final HandoverLine line in shown) _HandoverRow(line: line, warranties: register.warrantiesOf(line.id), warrantiesRefused: register.warrantiesRefused),
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

class _HandoverRow extends StatelessWidget {
  const _HandoverRow({required this.line, required this.warranties, required this.warrantiesRefused});

  final HandoverLine line;
  final List<WarrantyLine> warranties;
  final bool warrantiesRefused;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String status = handoverStatusLabel(context, line.status);
    final String defects = context.t('mob.handover.list.row.defects', <String, Object>{'count': line.itemCount, 'critical': line.openCriticalCount});
    final String warranty = warrantiesRefused
        ? context.t('mob.handover.list.row.warrantyHidden')
        : warranties.isEmpty
            ? context.t('mob.handover.list.row.warrantyNone')
            : context.t('mob.handover.list.row.warranty', <String, Object>{'count': warranties.length, 'until': formatDay(_latestEnd(warranties))});
    final String unit = context.t('mob.handover.list.row.unit', <String, Object>{'unit': line.recipientName});
    return TappableRow(
      semanticLabel: context.t('mob.handover.list.row.aria', <String, Object>{'no': line.handoverNo, 'contract': line.contractCode, 'status': status, 'unit': line.recipientName, 'defects': defects, 'warranty': warranty}),
      onTap: () => openScreen(context, 'MOB-66', query: <String, String>{'handover': line.id}, stacked: true),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(line.handoverNo, style: theme.textTheme.bodyLarge),
                Text(context.t('mob.handover.list.row.facts', <String, Object>{'contract': line.contractCode, 'kind': handoverKindLabel(context, line.kind)}), style: theme.textTheme.bodyMedium),
                Text(unit, style: theme.textTheme.bodyMedium),
                Wrap(
                  spacing: MachvonSpace.space8,
                  children: <Widget>[
                    StatusPill(label: status),
                    if (line.openCriticalCount > 0) StatusPill(label: context.t('mob.handover.list.row.critical', <String, Object>{'count': line.openCriticalCount}), warn: true),
                  ],
                ),
                Text(defects, style: theme.textTheme.bodySmall),
                Text(warranty, style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}

/// The last day of the warranties that carry the longest term, as the server wrote it (days compare as text).
String _latestEnd(List<WarrantyLine> warranties) => warranties.map((WarrantyLine w) => w.endsOn).reduce((String a, String b) => a.compareTo(b) >= 0 ? a : b);

class _HandoverScreen extends StatelessWidget {
  const _HandoverScreen({required this.handoverId});

  final String handoverId;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.handover.detail.title'),
      body: DataView<HandoverTrace>(
        cacheKey: 'handover.trace.$handoverId',
        read: (MachvonApiClient client) => _readTrace(client, handoverId),
        parse: parseHandoverTrace,
        builder: (BuildContext context, Loaded<HandoverTrace> loaded) => _TraceBody(trace: loaded.value),
      ),
    );
  }
}

class _TraceBody extends StatelessWidget {
  const _TraceBody({required this.trace});

  final HandoverTrace trace;

  @override
  Widget build(BuildContext context) {
    final HandoverLine line = trace.handover;
    final ThemeData theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: context.t('mob.handover.detail.summary.title'),
          children: <Widget>[
            FactLine(label: context.t('mob.handover.detail.no'), value: line.handoverNo),
            FactLine(label: context.t('mob.handover.detail.contract'), value: line.contractCode),
            FactLine(label: context.t('mob.handover.detail.kind'), value: handoverKindLabel(context, line.kind)),
            FactLine(label: context.t('mob.handover.detail.unit'), value: line.recipientName),
            FactLine(label: context.t('mob.handover.detail.status'), value: handoverStatusLabel(context, line.status)),
            if (line.plannedOn != null) FactLine(label: context.t('mob.handover.detail.planned'), value: formatDay(line.plannedOn!)),
            if (line.handedOn != null) FactLine(label: context.t('mob.handover.detail.handed'), value: formatDay(line.handedOn!)),
            if (line.acceptedAt != null) FactLine(label: context.t('mob.handover.detail.accepted'), value: formatMoment(line.acceptedAt!)),
            if (line.rejectionReason != null) Text(context.t('mob.handover.detail.rejection', <String, Object>{'reason': line.rejectionReason!}), style: theme.textTheme.bodyMedium),
          ],
        ),
        SectionCard(
          title: context.t('mob.handover.detail.punch.title'),
          children: <Widget>[
            Text(context.t('mob.handover.detail.punch.counts', <String, Object>{'open': trace.openItems, 'total': trace.items.length, 'critical': line.openCriticalCount}), style: theme.textTheme.bodyMedium),
            if (trace.items.isEmpty) Text(context.t('mob.handover.detail.punch.none'), style: theme.textTheme.bodyMedium),
            for (final PunchItem item in trace.items) _PunchLine(item: item),
          ],
        ),
        SectionCard(
          title: context.t('mob.handover.detail.warranty.title'),
          children: <Widget>[
            if (trace.warrantiesRefused)
              Text(context.t('mob.handover.list.warrantyRefused'), style: theme.textTheme.bodyMedium)
            else if (trace.warranties.isEmpty)
              Text(context.t('mob.handover.detail.warranty.none'), style: theme.textTheme.bodyMedium),
            for (final WarrantyLine warranty in trace.warranties) _WarrantyLineView(warranty: warranty),
          ],
        ),
      ],
    );
  }
}

class _PunchLine extends StatelessWidget {
  const _PunchLine({required this.item});

  final PunchItem item;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String severity = severityLabel(context, item.severity);
    final String status = punchStatusLabel(context, item.status);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
      child: MergeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(context.t('mob.handover.detail.punch.item', <String, Object>{'no': item.itemNo, 'description': item.description}), style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
            Text(context.t('mob.handover.detail.punch.state', <String, Object>{'severity': severity, 'status': status}), style: theme.textTheme.bodySmall),
            if (item.locationText != null) Text(context.t('mob.handover.detail.punch.place', <String, Object>{'place': item.locationText!}), style: theme.textTheme.bodySmall),
            if (item.contractorName != null) Text(context.t('mob.handover.detail.punch.contractor', <String, Object>{'name': item.contractorName!}), style: theme.textTheme.bodySmall),
            if (item.dueOn != null) Text(context.t('mob.handover.detail.punch.due', <String, Object>{'day': formatDay(item.dueOn!)}), style: theme.textTheme.bodySmall),
            if (item.overdue && item.isOpen) Text(context.t('mob.handover.detail.punch.overdue'), style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w700)),
          ],
        ),
      ),
    );
  }
}

class _WarrantyLineView extends StatelessWidget {
  const _WarrantyLineView({required this.warranty});

  final WarrantyLine warranty;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
      child: MergeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(warranty.assetName == null ? warranty.scope : context.t('mob.handover.detail.warranty.asset', <String, Object>{'scope': warranty.scope, 'asset': warranty.assetName!}), style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
            Text(context.t('mob.handover.detail.warranty.term', <String, Object>{'from': formatDay(warranty.startsOn), 'to': formatDay(warranty.endsOn), 'months': warranty.periodMonths}), style: theme.textTheme.bodySmall),
            Text(context.t('mob.handover.detail.warranty.state', <String, Object>{'status': warrantyStatusLabel(context, warranty.status), 'open': warranty.openClaims, 'total': warranty.totalClaims}), style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}
