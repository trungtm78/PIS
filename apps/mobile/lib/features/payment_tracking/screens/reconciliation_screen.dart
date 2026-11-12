import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/deadline.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/sheets.dart';
import '../../../core/widgets/stat_strip.dart';
import '../../../core/widgets/state_view.dart';
import '../../acceptance_handover/widgets/fact_row.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
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
/// the server offers it, online, under the version of the item, never from a copy; the note is confirmed in a sheet that says what it does
/// first. Writing a difference off needs the document that approves it and stays on the web (PAY-06). A refusal for a version that moved
/// offers to read the item again, never to overwrite it.
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
    return AppScaffold(
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
                      StatStrip(
                        cells: <StatCell>[
                          StatCell(value: '${board.waiting}', label: context.t('mob.treasury.board.summary.waiting')),
                          StatCell(
                            value: '${board.overdue}',
                            label: context.t('mob.treasury.board.summary.overdue'),
                            band: board.overdue > 0 ? DeadlineBand.late : null,
                            bandText: board.overdue > 0 ? context.t('mob.treasury.overdue') : null,
                          ),
                        ],
                      ),
                      InfoRow(label: context.t('mob.treasury.board.summary.difference'), value: moneyExactLabel(context, board.waitingDifferenceVnd), divider: false),
                      FilterChips<bool>(
                        options: <ChipOption<bool>>[
                          ChipOption<bool>(value: true, label: context.t('mob.treasury.board.filter.waiting')),
                          ChipOption<bool>(value: false, label: context.t('mob.treasury.board.filter.all')),
                        ],
                        selected: _onlyWaiting,
                        onChanged: (bool value) => setState(() => _onlyWaiting = value),
                      ),
                    ],
                  ),
                ),
              ),
              Expanded(
                child: shown.isEmpty
                    ? StateView(
                        kind: StateKind.empty,
                        details: <Widget>[Center(child: StatusPill(label: context.t('mob.treasury.board.filter.waiting')))],
                        actionLabel: context.t('mob.states.empty.clearFilters.action'),
                        onAction: () => setState(() => _onlyWaiting = false),
                      )
                    : ListView(
                        children: <Widget>[
                          for (int index = 0; index < shown.length; index += 1) _ItemRow(item: shown[index], dividerAbove: index > 0),
                          if (board.more) StatusBanner(text: context.t('mob.treasury.board.more'), tone: BannerTone.warning),
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
  const _ItemRow({required this.item, required this.dividerAbove});

  final ReconciliationItem item;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final String kind = reconKindLabel(context, item.kind);
    final String figures = context.t('mob.treasury.board.row.figures', <String, Object>{
      'internal': moneyOrNone(context, item.internalVnd),
      'confirmed': moneyOrNone(context, item.confirmedVnd),
      'difference': moneyOrNone(context, item.shownDifference),
    });
    final String refs = <String>[item.projectCode, if (item.requestNo != null) item.requestNo!, if (item.documentNo != null) item.documentNo!].join(' · ');
    return FactRow(
      title: kind,
      icon: Icons.compare_arrows,
      lines: <String>[refs, figures],
      trailing: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          StatusPill(label: reconStatusLabel(context, item.status), tone: reconTone(item.status)),
          if (item.overdue) ...<Widget>[const SizedBox(height: MachvonV2Space.s4), StatusPill(label: context.t('mob.treasury.overdue'), tone: MachvonTone.danger)],
        ],
      ),
      dividerAbove: dividerAbove,
      semanticLabel: context.t('mob.treasury.board.row.aria', <String, Object>{'kind': kind, 'refs': refs, 'figures': figures}),
      onTap: () => openScreen(context, 'MOB-60', query: <String, String>{'item': item.id}, stacked: true),
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
    return AppScaffold(
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

  /// Checks the form, then says in a sheet what will be written; only a confirmed note is sent.
  Future<void> _confirm() async {
    final ReconciliationItem item = widget.item;
    final Map<String, ResolveProblem> problems = checkResolution(resolution: _resolution, note: _note.text);
    setState(() => _problems = problems);
    if (problems.isNotEmpty) return;
    final String refs = <String>[item.projectCode, if (item.requestNo != null) item.requestNo!, if (item.documentNo != null) item.documentNo!].join(' · ');
    final bool explained = _resolution == 'EXPLAINED';
    final bool confirmed = await showConfirmSheet(
      context,
      title: context.t('mob.treasury.confirm.title'),
      facts: <String>[
        context.t('mob.treasury.confirm.fact.item', <String, Object>{'kind': reconKindLabel(context, item.kind), 'refs': refs}),
        context.t('mob.treasury.board.row.figures', <String, Object>{'internal': moneyOrNone(context, item.internalVnd), 'confirmed': moneyOrNone(context, item.confirmedVnd), 'difference': moneyOrNone(context, item.shownDifference)}),
        context.t('mob.treasury.confirm.fact.action', <String, Object>{'action': explained ? context.t('mob.treasury.form.explained') : context.t('mob.treasury.form.resolved')}),
        context.t('mob.treasury.confirm.fact.note', <String, Object>{'note': _note.text.trim()}),
        context.t('mob.treasury.confirm.fact.status', <String, Object>{'status': reconStatusLabel(context, explained ? 'EXPLAINED' : 'RESOLVED')}),
        context.t('mob.treasury.figures.noChoice'),
      ],
      confirmLabel: context.t('mob.treasury.confirm.action'),
      cancelLabel: context.t('mob.treasury.confirm.cancel'),
      auditNote: context.t('mob.treasury.confirm.audit'),
    );
    if (!confirmed || !mounted) return;
    _send();
  }

  /// The item moved under the person: nothing is overwritten, the item is read again and the person writes again on what is there.
  void _reload() {
    setState(() => outcome = null);
    widget.onChanged();
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
        final bool conflict = problemOf(result) == ReconciliationProblem.versionConflict;
        return OutcomeCard(
          title: reconProblemText(context, problemOf(result)),
          code: result.code,
          actionLabel: conflict ? context.t('mob.treasury.result.conflict.action') : null,
          onAction: conflict ? _reload : null,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final ReconciliationItem item = widget.item;
    final SessionSnapshot session = ref.watch(sessionProvider);
    final ReconGate gate = gateOf(offline: isOffline(ref), fromCopy: widget.fromCopy, session: session);
    final CommandOutcome? result = outcome;
    final List<String> choices = <String>[if (item.actions.explain) 'EXPLAINED', if (item.actions.resolve) 'RESOLVED'];
    final bool offered = item.isWaiting && choices.isNotEmpty;
    final bool open = gate == ReconGate.open && !sending;
    final String? difference = item.shownDifference;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (result != null) ConstrainedBox(constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.35), child: SingleChildScrollView(child: _outcome(context, result))),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
            children: <Widget>[
              SectionCard(
                title: reconKindLabel(context, item.kind),
                children: <Widget>[
                  Wrap(
                    spacing: MachvonV2Space.s8,
                    runSpacing: MachvonV2Space.s4,
                    children: <Widget>[
                      StatusPill(label: reconStatusLabel(context, item.status), tone: reconTone(item.status)),
                      if (item.overdue) StatusPill(label: context.t('mob.treasury.overdue'), tone: MachvonTone.danger),
                    ],
                  ),
                  InfoRow(label: context.t('mob.treasury.item.project'), value: item.projectCode, divider: false),
                  InfoRow(label: context.t('mob.treasury.item.contract'), value: item.contractCode),
                  InfoRow(label: context.t('mob.treasury.item.request'), value: item.requestNo),
                  InfoRow(label: context.t('mob.treasury.item.voucher'), value: item.documentNo),
                  InfoRow(label: context.t('mob.treasury.item.source'), value: item.sourceFileName),
                  InfoRow(label: context.t('mob.treasury.item.owner'), value: item.ownerName),
                  InfoRow(label: context.t('mob.treasury.item.due'), value: formatMoment(item.dueAt)),
                ],
              ),
              SectionCard(
                title: context.t('mob.treasury.figures.title'),
                children: <Widget>[
                  InfoRow(label: context.t('mob.treasury.figures.internal'), value: moneyOrNone(context, item.internalVnd), divider: false),
                  InfoRow(label: context.t('mob.treasury.figures.confirmed'), value: moneyOrNone(context, item.confirmedVnd)),
                  InfoRow(label: context.t('mob.treasury.figures.difference'), value: moneyOrNone(context, difference)),
                  Padding(
                    padding: const EdgeInsets.only(top: MachvonV2Space.s8),
                    child: StatusPill(
                      label: differenceWords(context, difference),
                      tone: difference == '0' ? MachvonTone.success : (difference == null ? MachvonTone.neutral : MachvonTone.warning),
                      icon: difference == '0' ? Icons.check_circle_outline : (difference == null ? Icons.help_outline : Icons.difference_outlined),
                    ),
                  ),
                  Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.treasury.figures.noChoice'), style: text.caption)),
                ],
              ),
              if (item.resolutionNote != null || item.resolvedAt != null)
                SectionCard(
                  title: context.t('mob.treasury.note.title'),
                  children: <Widget>[
                    if (item.resolutionNote != null) Text(item.resolutionNote!, style: text.body),
                    InfoRow(label: context.t('mob.treasury.note.closedAt'), value: item.resolvedAt == null ? null : formatMoment(item.resolvedAt!), divider: item.resolutionNote != null),
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
                    const SizedBox(height: MachvonV2Space.s8),
                    TextField(
                      controller: _note,
                      readOnly: sending,
                      maxLines: 3,
                      decoration: InputDecoration(labelText: context.t('mob.treasury.form.note.label'), errorText: _problems['note'] == null ? null : resolveProblemText(context, _problems['note']!)),
                    ),
                  ],
                ),
            ],
          ),
        ),
        if (offered)
          ActionBar(
            primary: ActionBarButton(label: sending ? context.t('mob.treasury.sending.label') : context.t('mob.treasury.form.submit.action'), onPressed: open ? _confirm : null),
            why: gate == ReconGate.open ? null : gateText(context, gate),
          ),
      ],
    );
  }
}
