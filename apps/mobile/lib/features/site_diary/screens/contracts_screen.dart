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
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../../read_support/wire.dart';
import '../contract_models.dart';
import '../diary_labels.dart';

/// MOB-61: the contracts the person works on and their payment milestones. A contractor who was invited as a guest sees only the
/// contracts they were invited to (the server judges the scope; the phone filters nothing), and a contract outside it cannot be
/// opened: the server answers 404 `RESOURCE_NOT_FOUND`, the same as for a contract that does not exist. With `?contract=` the screen
/// shows that one contract. A contract opens the site diary of MOB-62.
Widget buildContractsScreen(BuildContext context, ScreenContext screen) =>
    ContractsScreen(contractId: screen.queryParameters['contract']);

class ContractsScreen extends StatelessWidget {
  const ContractsScreen({this.contractId, super.key});

  final String? contractId;

  @override
  Widget build(BuildContext context) {
    final String? id = contractId;
    return ScreenFrame(
      title: context.t('mob.dry.contracts.title'),
      actions: <Widget>[
        IconButton(tooltip: context.t('mob.dry.contracts.hub.action'), icon: const Icon(Icons.edit_note_outlined), onPressed: () => openScreen(context, 'QMS-09', stacked: true)),
        IconButton(tooltip: context.t('mob.dry.contracts.photo.action'), icon: const Icon(Icons.photo_camera_outlined), onPressed: () => openScreen(context, 'QMS-10', stacked: true)),
      ],
      body: id == null
          ? DataView<List<ContractLine>>(
              cacheKey: 'diary.contracts',
              read: readContracts,
              parse: (Object? raw) => parseContracts(raw),
              isEmpty: (List<ContractLine> contracts) => contracts.isEmpty,
              builder: (
                BuildContext context,
                Loaded<List<ContractLine>> loaded,
              ) => _List(contracts: loaded.value),
            )
          : DataView<ContractLine>(
              cacheKey: 'diary.contract.$id',
              read: (MachvonApiClient client) =>
                  client.getResourcesContractId(id: id),
              parse: parseContract,
              builder: (BuildContext context, Loaded<ContractLine> loaded) =>
                  _List(contracts: <ContractLine>[loaded.value]),
            ),
    );
  }
}

class _List extends StatelessWidget {
  const _List({required this.contracts});

  final List<ContractLine> contracts;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        for (final ContractLine contract in contracts)
          _ContractCard(contract: contract),
      ],
    );
  }
}

class _ContractCard extends StatelessWidget {
  const _ContractCard({required this.contract});

  final ContractLine contract;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return SectionCard(
      title: contract.label,
      semanticLabel: context.t('mob.dry.contract.aria', <String, Object>{
        'code': contract.code,
        'status': contractStatusText(context, contract.status),
      }),
      children: <Widget>[
        StatusPill(
          label: contractStatusText(context, contract.status),
          warn:
              contract.status == 'SUSPENDED' || contract.status == 'TERMINATED',
        ),
        const SizedBox(height: MachvonSpace.space8),
        if (contract.projectName != null)
          FactLine(
            label: context.t('mob.dry.contract.project'),
            value: contract.projectName!,
          ),
        if (contract.contractorName != null)
          FactLine(
            label: context.t('mob.dry.contract.contractor'),
            value: contract.contractorName!,
          ),
        if (contract.completionDue != null)
          FactLine(
            label: context.t('mob.dry.contract.due'),
            value: formatDay(contract.completionDue!),
          ),
        const SizedBox(height: MachvonSpace.space8),
        _Milestones(contractId: contract.id),
        const SizedBox(height: MachvonSpace.space8),
        FilledButton(
          onPressed: () => openScreen(
            context,
            'MOB-62',
            pathSuffix: '/${contract.id}',
            stacked: true,
          ),
          child: Text(context.t('mob.dry.contract.diary.action')),
        ),
        Text(
          context.t('mob.dry.contract.diary.hint'),
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: MachvonSpace.space8),
        Wrap(
          spacing: MachvonSpace.space8,
          children: <Widget>[
            OutlinedButton(
              onPressed: () => openScreen(context, 'MOB-63', pathSuffix: '/${contract.id}', stacked: true),
              child: Text(context.t('mob.dry.contract.quantity.action')),
            ),
            OutlinedButton(
              onPressed: () => openScreen(context, 'MOB-64', pathSuffix: '/${contract.id}', stacked: true),
              child: Text(context.t('mob.dry.contract.inspection.action')),
            ),
          ],
        ),
      ],
    );
  }
}

/// The milestones of one contract, read when the person opens them (a contract may have many lines, and most are never opened).
class _Milestones extends ConsumerStatefulWidget {
  const _Milestones({required this.contractId});

  final String contractId;

  @override
  ConsumerState<_Milestones> createState() => _MilestonesState();
}

class _MilestonesState extends ConsumerState<_Milestones> {
  bool _open = false;
  bool _loading = false;
  List<Milestone>? _milestones;
  ProblemView? _problem;

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _problem = null;
    });
    try {
      final Json raw = await readMilestones(
        ref.read(apiClientProvider),
        widget.contractId,
      );
      final List<Milestone>? parsed = parseMilestones(raw);
      if (parsed == null)
        throw const ContractMismatch(
          'get_resources_boq_line',
          'does not hold what the screen needs',
        );
      if (mounted) setState(() => _milestones = parsed);
    } on Object catch (error) {
      if (mounted)
        setState(
          () => _problem = ProblemView.from(
            error,
            reachability: ref.read(reachabilityProvider),
          ),
        );
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
    final ThemeData theme = Theme.of(context);
    final List<Milestone>? milestones = _milestones;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        OutlinedButton(
          onPressed: _toggle,
          child: Text(
            _open
                ? context.t('mob.dry.milestones.hide')
                : context.t('mob.dry.milestones.show'),
          ),
        ),
        if (_open) ...<Widget>[
          if (_loading)
            const Padding(
              padding: EdgeInsets.all(MachvonSpace.space8),
              child: LinearProgressIndicator(),
            ),
          if (_problem != null)
            Semantics(
              liveRegion: true,
              container: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(context.t('mob.dry.milestones.problem')),
                  Text(_problem!.code, style: theme.textTheme.bodySmall),
                  TextButton(
                    onPressed: _load,
                    child: Text(context.t('mob.states.retry.action')),
                  ),
                ],
              ),
            ),
          if (milestones != null && milestones.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: MachvonSpace.space8),
              child: Text(context.t('mob.dry.milestones.none')),
            ),
          if (milestones != null)
            for (final Milestone milestone in milestones)
              MergeSemantics(
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    vertical: MachvonSpace.space4,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(milestone.code, style: theme.textTheme.titleSmall),
                      if (milestone.description.isNotEmpty)
                        Text(milestone.description),
                      Text(
                        milestone.dueOn == null
                            ? context.t('mob.dry.milestone.noDue')
                            : context.t(
                                'mob.dry.milestone.due',
                                <String, Object>{
                                  'day': formatDay(milestone.dueOn!),
                                },
                              ),
                        style: theme.textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
              ),
        ],
      ],
    );
  }
}
