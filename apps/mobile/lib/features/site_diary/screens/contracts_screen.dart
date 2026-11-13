import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/status_pill.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/field_contract.dart';
import '../../diary_hub/field_report_sheet.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/wire.dart';
import '../contract_models.dart';
import '../diary_labels.dart';
import '../diary_widgets.dart';

/// MOB-61: the contracts the person works on and their payment milestones. A contractor who was invited as a guest sees only the
/// contracts they were invited to (the server judges the scope; the phone filters nothing), and a contract outside it cannot be
/// opened: the server answers 404 `RESOURCE_NOT_FOUND`, the same as for a contract that does not exist. With `?contract=` the screen
/// shows that one contract. A contract is a row, and tapping the row opens the site diary of MOB-62 (the thing the person came to do);
/// the quantity, the quality check, the photographs and the milestones are quiet actions under it. Opening anything of a contract makes it
/// the contract the quick "Report" sheet offers first.
Widget buildContractsScreen(BuildContext context, ScreenContext screen) =>
    ContractsScreen(contractId: screen.queryParameters['contract']);

class ContractsScreen extends ConsumerStatefulWidget {
  const ContractsScreen({this.contractId, super.key});

  final String? contractId;

  @override
  ConsumerState<ContractsScreen> createState() => _ContractsScreenState();
}

class _ContractsScreenState extends ConsumerState<ContractsScreen> {
  int _reload = 0;

  @override
  void initState() {
    super.initState();
    final String? id = widget.contractId;
    if (id != null) {
      WidgetsBinding.instance.addPostFrameCallback((Duration _) {
        if (mounted) ref.read(lastFieldContractProvider.notifier).remember(id);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final String? id = widget.contractId;
    return AppScaffold(
      title: context.t('mob.dry.contracts.title'),
      actions: <Widget>[
        AppBarAction(icon: Icons.edit_note_outlined, label: context.t('mob.dry.contracts.hub.action'), onPressed: () => openScreen(context, 'QMS-09', stacked: true)),
        AppBarAction(icon: Icons.photo_camera_outlined, label: context.t('mob.dry.contracts.photo.action'), onPressed: () => openScreen(context, 'QMS-10', stacked: true)),
      ],
      floatingAction: FloatingPill(icon: Icons.add_a_photo_outlined, label: context.t('mob.field.report.title'), onPressed: () => showFieldReportSheet(context)),
      body: id == null
          ? DataView<List<ContractLine>>(
              cacheKey: 'diary.contracts',
              reloadKey: _reload,
              read: readContracts,
              parse: (Object? raw) => parseContracts(raw),
              builder: (BuildContext context, Loaded<List<ContractLine>> loaded) => _List(contracts: loaded.value, onReload: () => setState(() => _reload += 1)),
            )
          : DataView<ContractLine>(
              cacheKey: 'diary.contract.$id',
              reloadKey: _reload,
              read: (MachvonApiClient client) => client.getResourcesContractId(id: id),
              parse: parseContract,
              builder: (BuildContext context, Loaded<ContractLine> loaded) => _List(contracts: <ContractLine>[loaded.value], onReload: () => setState(() => _reload += 1)),
            ),
    );
  }
}

class _List extends StatelessWidget {
  const _List({required this.contracts, required this.onReload});

  final List<ContractLine> contracts;
  final VoidCallback onReload;

  @override
  Widget build(BuildContext context) {
    if (contracts.isEmpty) {
      return StateView(
        kind: StateKind.empty,
        body: context.t('mob.dry.contracts.empty.body'),
        actionLabel: context.t('mob.states.retry.action'),
        onAction: onReload,
      );
    }
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        for (int position = 0; position < contracts.length; position += 1) _ContractBlock(contract: contracts[position], first: position == 0),
      ],
    );
  }
}

/// One contract: its row, its facts, what else can be done and, on request, its milestones (read when they are opened: a contract may have
/// many lines, and most are never opened).
class _ContractBlock extends ConsumerStatefulWidget {
  const _ContractBlock({required this.contract, required this.first});

  final ContractLine contract;
  final bool first;

  @override
  ConsumerState<_ContractBlock> createState() => _ContractBlockState();
}

class _ContractBlockState extends ConsumerState<_ContractBlock> {
  bool _open = false;
  bool _loading = false;
  List<Milestone>? _milestones;
  ProblemView? _problem;

  /// Opens a screen of the contract and makes it the contract the quick "Report" sheet offers.
  void _go(String screenId, {String pathSuffix = '', Map<String, String> query = const <String, String>{}}) {
    ref.read(lastFieldContractProvider.notifier).remember(widget.contract.id);
    openScreen(context, screenId, pathSuffix: pathSuffix, query: query, stacked: true);
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _problem = null;
    });
    try {
      final Json raw = await readMilestones(ref.read(apiClientProvider), widget.contract.id);
      final List<Milestone>? parsed = parseMilestones(raw);
      if (parsed == null) throw const ContractMismatch('get_resources_boq_line', 'does not hold what the screen needs');
      if (mounted) setState(() => _milestones = parsed);
    } on Object catch (error) {
      if (mounted) setState(() => _problem = ProblemView.from(error, reachability: ref.read(reachabilityProvider)));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _toggle() {
    setState(() => _open = !_open);
    if (_open && _milestones == null && !_loading) _load();
  }

  @override
  Widget build(BuildContext context) {
    final ContractLine contract = widget.contract;
    final String status = contractStatusText(context, contract.status);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        WorkRow(
          title: contract.label,
          subtitle: contract.projectName,
          leading: const FieldGlyph(icon: Icons.description_outlined),
          trailing: StatusPill(label: status, tone: contractTone(contract.status)),
          semanticLabel: <String>[context.t('mob.dry.contract.aria', <String, Object>{'code': contract.code, 'status': status}), ?contract.projectName].join('. '),
          dividerAbove: !widget.first,
          onTap: () => _go('MOB-62', pathSuffix: '/${contract.id}'),
        ),
        InfoRow(label: context.t('mob.dry.contract.contractor'), value: contract.contractorName),
        InfoRow(label: context.t('mob.dry.contract.due'), value: contract.completionDue == null ? null : formatDay(contract.completionDue!)),
        ActionLinks(
          actions: <QuietAction>[
            QuietAction(label: context.t('mob.dry.contract.quantity.action'), onTap: () => _go('MOB-63', pathSuffix: '/${contract.id}')),
            QuietAction(label: context.t('mob.dry.contract.inspection.action'), onTap: () => _go('MOB-64', pathSuffix: '/${contract.id}')),
            QuietAction(label: context.t('mob.dry.contract.photo.action'), onTap: () => _go('QMS-10', query: <String, String>{'contract': contract.id})),
            QuietAction(label: _open ? context.t('mob.dry.milestones.hide') : context.t('mob.dry.milestones.show'), onTap: _toggle),
          ],
        ),
        if (_open) ..._milestoneRows(context),
      ],
    );
  }

  List<Widget> _milestoneRows(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final List<Milestone>? milestones = _milestones;
    return <Widget>[
      if (_loading) const WorkRowSkeleton(),
      if (_problem != null)
        NoticePanel(
          tone: NoticeTone.problem,
          title: context.t('mob.dry.milestones.problem'),
          code: _problem!.code,
          actionLabel: context.t('mob.states.retry.action'),
          onAction: _load,
        ),
      if (milestones != null && milestones.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
          child: Text(context.t('mob.dry.milestones.none'), style: context.v2text.caption.copyWith(color: v2.palette.ink2)),
        ),
      if (milestones != null)
        for (int position = 0; position < milestones.length; position += 1)
          WorkRow(
            title: milestones[position].code,
            subtitle: milestones[position].description.isEmpty ? null : milestones[position].description,
            trailing: Text(
              milestones[position].dueOn == null
                  ? context.t('mob.dry.milestone.noDue')
                  : context.t('mob.dry.milestone.due', <String, Object>{'day': formatDay(milestones[position].dueOn!)}),
              style: context.v2text.caption,
              textAlign: TextAlign.end,
            ),
            dividerAbove: true,
          ),
    ];
  }
}
