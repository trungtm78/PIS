import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../../core/state/empty_state_view.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../read_support/amounts.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../payment_models.dart';
import '../payment_support.dart';
import '../reconciliation_commands.dart';

/// MOB-60: the differences between what the accounts recorded and what the Treasury confirmed. Without a parameter it lists the items
/// that wait (the late ones first, with the count and the sum of what waits as the server gives them); with `?item=<id>` it shows one:
/// the amount on the side of the accounts, the amount the Treasury confirmed and the difference, side by side.
///
/// **No figure is chosen.** The two amounts and the difference are shown as they were recorded and the screen has no way to pick the
/// larger, to correct one or to net them. What the person can do is write down what was found (explain it, or resolve it) and only where
/// the server offers it, online, under the version of the item, never from a copy. Writing a difference off needs the document that
/// approves it and stays on the web (PAY-06).
Widget buildReconciliationScreen(BuildContext context, ScreenContext screen) {
  final String? item = screen.queryParameters['item'];
  return item == null || item.isEmpty ? const _BoardScreen() : _ItemScreen(itemId: item);
}

class _BoardScreen extends StatefulWidget {
  const _BoardScreen();

  @override
  State<_BoardScreen> createState() => _BoardScreenState();
}

class _BoardScreenState extends State<_BoardScreen> {
  bool _onlyWaiting = true;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.treasury.board.title'),
      body: DataView<ReconciliationBoard>(
        cacheKey: 'treasury.board',
        read: (MachvonApiClient client) => readMerged(client, 'listReconciliationItems', query: <String, Object?>{'limit': 200}),
        parse: parseReconciliationBoard,
        asOf: (ReconciliationBoard board) => board.asOf,
        isEmpty: (ReconciliationBoard board) => board.items.isEmpty,
        builder: (BuildContext context, Loaded<ReconciliationBoard> loaded) {
          final ReconciliationBoard board = loaded.value;
          final List<ReconciliationItem> shown = <ReconciliationItem>[
            for (final ReconciliationItem item in board.items)
              if (!_onlyWaiting || item.isWaiting) item,
          ];
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // The summary and the filter scroll by themselves when the text is large, so they never push the list off the screen.
              ConstrainedBox(
                constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.45),
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                                SectionCard(
                                  title: context.t('mob.treasury.board.summary.title'),
                                  children: <Widget>[
                                    FactLine(label: context.t('mob.treasury.board.summary.waiting'), value: '${board.waiting}'),
                                    FactLine(label: context.t('mob.treasury.board.summary.overdue'), value: '${board.overdue}'),
                                    FactLine(label: context.t('mob.treasury.board.summary.difference'), value: dongLabel(context, board.waitingDifferenceVnd)),
                                  ],
                                ),
                                CheckboxListTile(
                                  contentPadding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
                                  value: _onlyWaiting,
                                  title: Text(context.t('mob.treasury.board.filter.waiting')),
                                  onChanged: (bool? value) => setState(() => _onlyWaiting = value ?? false),
                                ),

                    ],
                  ),
                ),
              ),
              Expanded(
                child: shown.isEmpty
                    ? EmptyStateView(activeFilters: <String>[context.t('mob.treasury.board.filter.waiting')], onClearFilters: () => setState(() => _onlyWaiting = false))
                    : ListView(
                        children: <Widget>[
                          for (final ReconciliationItem item in shown) _ItemRow(item: item),
                          if (board.more) Padding(padding: const EdgeInsets.all(MachvonSpace.space16), child: Text(context.t('mob.treasury.board.more'), style: Theme.of(context).textTheme.bodySmall)),
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

class _ItemRow extends StatelessWidget {
  const _ItemRow({required this.item});

  final ReconciliationItem item;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String kind = reconKindLabel(context, item.kind);
    final String figures = context.t('mob.treasury.board.row.figures', <String, Object>{
      'internal': moneyOrNone(context, item.internalVnd),
      'confirmed': moneyOrNone(context, item.confirmedVnd),
      'difference': moneyOrNone(context, item.shownDifference),
    });
    final String refs = <String>[item.projectCode, if (item.requestNo != null) item.requestNo!, if (item.documentNo != null) item.documentNo!].join(' · ');
    return TappableRow(
      semanticLabel: context.t('mob.treasury.board.row.aria', <String, Object>{'kind': kind, 'refs': refs, 'figures': figures}),
      onTap: () => openScreen(context, 'MOB-60', query: <String, String>{'item': item.id}, stacked: true),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(kind, style: theme.textTheme.bodyLarge),
                Text(refs, style: theme.textTheme.bodyMedium),
                Wrap(
                  spacing: MachvonSpace.space8,
                  children: <Widget>[
                    StatusPill(label: reconStatusLabel(context, item.status)),
                    if (item.overdue) StatusPill(label: context.t('mob.treasury.overdue'), warn: true),
                  ],
                ),
                Text(figures, style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}

class _ItemScreen extends StatefulWidget {
  const _ItemScreen({required this.itemId});

  final String itemId;

  @override
  State<_ItemScreen> createState() => _ItemScreenState();
}

class _ItemScreenState extends State<_ItemScreen> {
  int _changed = 0;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.treasury.item.title'),
      body: DataView<ReconciliationItem>(
        cacheKey: 'treasury.item.${widget.itemId}',
        reloadKey: _changed,
        read: (MachvonApiClient client) => client.getReconciliationItem(id: widget.itemId),
        parse: parseReconciliationItem,
        builder: (BuildContext context, Loaded<ReconciliationItem> loaded) => _ItemBody(item: loaded.value, fromCopy: loaded.fromCache, onChanged: () => setState(() => _changed += 1)),
      ),
    );
  }
}

class _ItemBody extends ConsumerStatefulWidget {
  const _ItemBody({required this.item, required this.fromCopy, required this.onChanged});

  final ReconciliationItem item;
  final bool fromCopy;
  final VoidCallback onChanged;

  @override
  ConsumerState<_ItemBody> createState() => _ItemBodyState();
}

class _ItemBodyState extends ConsumerState<_ItemBody> with CommandFlow<_ItemBody> {
  late final ReconciliationCommands _commands = ReconciliationCommands(client: ref.read(apiClientProvider), isOnline: () => deviceIsOnline(ref));
  final TextEditingController _note = TextEditingController();
  String? _resolution;
  Map<String, ResolveProblem> _problems = const <String, ResolveProblem>{};
  ResolveRequest? _last;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  void _send({bool again = false}) {
    final ReconciliationItem item = widget.item;
    final ResolveRequest request = again && _last != null ? _last! : ResolveRequest(itemId: item.id, version: item.version, resolution: _resolution ?? '', note: _note.text);
    if (!again) {
      final Map<String, ResolveProblem> problems = checkResolution(resolution: _resolution, note: _note.text);
      setState(() => _problems = problems);
      if (problems.isNotEmpty) return;
    }
    _last = request;
    run(
      () => _commands.resolve(request, retryAfterUnknown: again),
      onDone: () {
        _note.clear();
        setState(() => _resolution = null);
        widget.onChanged();
      },
    );
  }

  Widget _outcome(BuildContext context, CommandOutcome result) {
    switch (result) {
      case CommandDone():
        return OutcomeCard(title: context.t('mob.treasury.result.done.title'), lines: <String>[context.t('mob.treasury.result.done.body')]);
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.treasury.result.unknown.title'),
          lines: <String>[context.t('mob.treasury.result.unknown.body')],
          actionLabel: context.t('mob.treasury.result.unknown.action'),
          onAction: _last == null ? null : () => _send(again: true),
        );
      case CommandOffline():
        return OutcomeCard(title: gateText(context, ReconGate.offline));
      case CommandRefused():
        return OutcomeCard(title: reconProblemText(context, problemOf(result)), code: result.code);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ReconciliationItem item = widget.item;
    final SessionSnapshot session = ref.watch(sessionProvider);
    final ReconGate gate = gateOf(offline: isOffline(ref), fromCopy: widget.fromCopy, session: session);
    final CommandOutcome? result = outcome;
    final List<String> choices = <String>[if (item.actions.explain) 'EXPLAINED', if (item.actions.resolve) 'RESOLVED'];
    final bool offered = item.isWaiting && choices.isNotEmpty;
    final bool open = gate == ReconGate.open && !sending;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (result != null) ConstrainedBox(constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.35), child: SingleChildScrollView(child: _outcome(context, result))),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
            children: <Widget>[
              SectionCard(
                title: reconKindLabel(context, item.kind),
                children: <Widget>[
                  Wrap(
                    spacing: MachvonSpace.space8,
                    children: <Widget>[
                      StatusPill(label: reconStatusLabel(context, item.status)),
                      if (item.overdue) StatusPill(label: context.t('mob.treasury.overdue'), warn: true),
                    ],
                  ),
                  FactLine(label: context.t('mob.treasury.item.project'), value: item.projectCode),
                  if (item.contractCode != null) FactLine(label: context.t('mob.treasury.item.contract'), value: item.contractCode!),
                  if (item.requestNo != null) FactLine(label: context.t('mob.treasury.item.request'), value: item.requestNo!),
                  if (item.documentNo != null) FactLine(label: context.t('mob.treasury.item.voucher'), value: item.documentNo!),
                  if (item.sourceFileName != null) FactLine(label: context.t('mob.treasury.item.source'), value: item.sourceFileName!),
                  if (item.ownerName != null) FactLine(label: context.t('mob.treasury.item.owner'), value: item.ownerName!),
                  FactLine(label: context.t('mob.treasury.item.due'), value: formatMoment(item.dueAt)),
                ],
              ),
              SectionCard(
                title: context.t('mob.treasury.figures.title'),
                children: <Widget>[
                  FactLine(label: context.t('mob.treasury.figures.internal'), value: moneyOrNone(context, item.internalVnd)),
                  FactLine(label: context.t('mob.treasury.figures.confirmed'), value: moneyOrNone(context, item.confirmedVnd)),
                  FactLine(label: context.t('mob.treasury.figures.difference'), value: moneyOrNone(context, item.shownDifference)),
                  Text(differenceWords(context, item.shownDifference), style: theme.textTheme.bodyMedium),
                  const SizedBox(height: MachvonSpace.space4),
                  Text(context.t('mob.treasury.figures.noChoice'), style: theme.textTheme.bodySmall),
                ],
              ),
              if (item.resolutionNote != null || item.resolvedAt != null)
                SectionCard(
                  title: context.t('mob.treasury.note.title'),
                  children: <Widget>[
                    if (item.resolutionNote != null) Text(item.resolutionNote!, style: theme.textTheme.bodyMedium),
                    if (item.resolvedAt != null) FactLine(label: context.t('mob.treasury.note.closedAt'), value: formatMoment(item.resolvedAt!)),
                  ],
                ),
              if (offered)
                SectionCard(
                  title: context.t('mob.treasury.form.title'),
                  children: <Widget>[
                    DropdownButtonFormField<String>(
                      initialValue: _resolution,
                      isExpanded: true,
                      decoration: InputDecoration(labelText: context.t('mob.treasury.form.resolution.label'), errorText: _problems['resolution'] == null ? null : resolveProblemText(context, _problems['resolution']!)),
                      items: <DropdownMenuItem<String>>[
                        for (final String choice in choices)
                          DropdownMenuItem<String>(value: choice, child: Text(choice == 'EXPLAINED' ? context.t('mob.treasury.form.explained') : context.t('mob.treasury.form.resolved'))),
                      ],
                      onChanged: sending ? null : (String? value) => setState(() => _resolution = value),
                    ),
                    const SizedBox(height: MachvonSpace.space8),
                    TextField(
                      controller: _note,
                      readOnly: sending,
                      maxLines: 3,
                      decoration: InputDecoration(labelText: context.t('mob.treasury.form.note.label'), errorText: _problems['note'] == null ? null : resolveProblemText(context, _problems['note']!)),
                    ),
                    const SizedBox(height: MachvonSpace.space12),
                    if (gate != ReconGate.open) GateNote(text: gateText(context, gate)),
                    FilledButton(onPressed: open ? _send : null, child: Text(sending ? context.t('mob.treasury.sending.label') : context.t('mob.treasury.form.submit.action'))),
                  ],
                ),
            ],
          ),
        ),
      ],
    );
  }
}
