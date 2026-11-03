import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/session/session.dart';
import '../../offline/offline_labels.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../issue_draft.dart';
import '../issue_labels.dart';
import '../issue_lookups.dart';
import '../issue_providers.dart';
import '../issue_service.dart';

/// MOB-28: the capture form of an obstacle. The project, the responsible unit, the category and the severity are chosen from
/// what the server offers (kept on the device, so the form can be filled in without a network), the title and the description
/// are written, and everything is saved on the device as the person types: a report is a draft until it is sent (MOB-30), and a
/// draft survives the app being closed. A report that is waiting for the network is listed here, and opens in MOB-31.
Widget buildCaptureScreen(BuildContext context, ScreenContext screen) =>
    CaptureScreen(draftId: screen.queryParameters['draft']);

class CaptureScreen extends StatelessWidget {
  const CaptureScreen({this.draftId, super.key});

  final String? draftId;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.fld.capture.title'),
      body: DataView<IssueLookups>(
        cacheKey: 'issues.lookups',
        read: readIssueLookups,
        parse: parseIssueLookups,
        isEmpty: (IssueLookups lookups) => lookups.isEmpty,
        builder: (BuildContext context, Loaded<IssueLookups> loaded) =>
            _CaptureForm(
              key: ValueKey<String?>(draftId),
              lookups: loaded.value,
              draftId: draftId,
            ),
      ),
    );
  }
}

class _CaptureForm extends ConsumerStatefulWidget {
  const _CaptureForm({required this.lookups, required this.draftId, super.key});

  final IssueLookups lookups;
  final String? draftId;

  @override
  ConsumerState<_CaptureForm> createState() => _CaptureFormState();
}

class _CaptureFormState extends ConsumerState<_CaptureForm> {
  final TextEditingController _title = TextEditingController();
  final TextEditingController _description = TextEditingController();
  IssueDraft? _draft;
  String? _draftId;
  Map<String, IssueProblem> _problems = const <String, IssueProblem>{};
  Object? _storeFailure;
  Future<void> _writing = Future<void>.value();

  @override
  void initState() {
    super.initState();
    unawaited(_open());
  }

  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    super.dispose();
  }

  IssueService get _service => ref.read(issueServiceProvider);

  Future<void> _open() async {
    IssueDraft? draft;
    final String? id = widget.draftId;
    if (id != null) {
      try {
        final StoredIssueDraft? stored = await _service.load(id);
        if (stored != null) {
          draft = stored.draft;
          _draftId = stored.id;
        }
      } on Object catch (error) {
        _storeFailure = error;
      }
    }
    draft ??= _service.blank();
    if (!mounted) return;
    setState(() {
      _draft = draft;
      _title.text = draft!.title;
      _description.text = draft.description;
    });
  }

  /// Writes the draft after every change, one write after the other, so the last change is the one that stays.
  void _change(IssueDraft next) {
    setState(() {
      _draft = next;
      _problems = const <String, IssueProblem>{};
    });
    unawaited(_persist());
  }

  Future<String?> _persist() {
    final IssueDraft? draft = _draft;
    if (draft == null) return Future<String?>.value();
    final Future<String?> written = _writing.then((void _) async {
      try {
        _draftId = await _service.save(draft, draftId: _draftId);
        // The list of drafts left on the phone follows what was just written.
        ref.invalidate(openIssueDraftsProvider);
        final String? saved = _draftId;
        if (saved != null) ref.invalidate(issueDraftProvider(saved));
        if (mounted) setState(() => _storeFailure = null);
        return _draftId;
      } on Object catch (error) {
        if (mounted) setState(() => _storeFailure = error);
        return null;
      }
    });
    _writing = written.then((String? _) {});
    return written;
  }

  /// Reads the draft again after the photographs or the place were changed on another screen.
  Future<void> _refresh() async {
    final String? id = _draftId;
    if (id == null) return;
    final StoredIssueDraft? stored = await _service.load(id);
    if (stored != null && mounted) setState(() => _draft = stored.draft);
  }

  Future<void> _goTo(String screenId) async {
    final String? id = await _persist();
    if (id == null || !mounted) return;
    await context.push<void>(
      locationOfScreen(context, screenId, pathSuffix: '/$id'),
    );
    if (mounted) await _refresh();
  }

  Future<void> _review() async {
    final IssueDraft draft = _draft!;
    final Map<String, IssueProblem> problems = checkIssue(
      draft,
      manualPlaceLabel: manualPlaceLabel(context),
    );
    setState(() => _problems = problems);
    if (problems.isEmpty) await _goTo('MOB-30');
  }

  void _pick(
    Choice? choice,
    IssueDraft Function(IssueDraft draft, Choice choice) apply,
  ) {
    final IssueDraft? draft = _draft;
    if (choice == null || draft == null) return;
    _change(apply(draft, choice));
  }

  String? _errorText(BuildContext context, String field) =>
      _problems[field] == null
      ? null
      : issueProblemText(context, _problems[field]!);

  @override
  Widget build(BuildContext context) {
    final IssueDraft? draft = _draft;
    if (draft == null) return const Center(child: CircularProgressIndicator());
    final IssueLookups lookups = widget.lookups;
    final bool readOnly = ref.watch(sessionProvider).isReadOnly;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        if (readOnly)
          _Notice(text: context.t('mob.fld.capture.readOnly.notice')),
        if (_storeFailure != null)
          _Notice(text: context.t('mob.fld.capture.store.notice')),
        SectionCard(
          title: context.t('mob.fld.capture.form.title'),
          children: <Widget>[
            _ChoiceField(
              label: context.t('mob.fld.capture.project.label'),
              options: lookups.projects,
              value: draft.projectId,
              error: _errorText(context, 'project'),
              onChanged: (Choice? choice) => _pick(
                choice,
                (IssueDraft d, Choice c) =>
                    d.copyWith(projectId: c.id, projectLabel: c.label),
              ),
            ),
            _ChoiceField(
              label: context.t('mob.fld.capture.unit.label'),
              options: lookups.units,
              value: draft.ownerUnitId,
              error: _errorText(context, 'unit'),
              onChanged: (Choice? choice) => _pick(
                choice,
                (IssueDraft d, Choice c) =>
                    d.copyWith(ownerUnitId: c.id, ownerUnitLabel: c.label),
              ),
            ),
            _ChoiceField(
              label: context.t('mob.fld.capture.category.label'),
              options: lookups.categories,
              value: draft.categoryVersionId,
              error: _errorText(context, 'category'),
              onChanged: (Choice? choice) => _pick(
                choice,
                (IssueDraft d, Choice c) =>
                    d.copyWith(categoryVersionId: c.id, categoryLabel: c.label),
              ),
            ),
            _ChoiceField(
              label: context.t('mob.fld.capture.severity.label'),
              options: <Choice>[
                for (final String severity in kSeverities)
                  Choice(id: severity, label: severityText(context, severity)),
              ],
              value: draft.severity,
              onChanged: (Choice? choice) => _pick(
                choice,
                (IssueDraft d, Choice c) => d.copyWith(severity: c.id),
              ),
            ),
            const SizedBox(height: MachvonSpace.space12),
            TextField(
              controller: _title,
              maxLength: kTitleMax,
              textInputAction: TextInputAction.next,
              decoration: InputDecoration(
                labelText: context.t('mob.fld.capture.title.label'),
                errorText: _errorText(context, 'title'),
              ),
              onChanged: (String value) =>
                  _change(draft.copyWith(title: value)),
            ),
            const SizedBox(height: MachvonSpace.space12),
            TextField(
              controller: _description,
              maxLines: 5,
              maxLength: kDescriptionMax,
              decoration: InputDecoration(
                labelText: context.t('mob.fld.capture.description.label'),
                errorText: _errorText(context, 'description'),
              ),
              onChanged: (String value) =>
                  _change(draft.copyWith(description: value)),
            ),
          ],
        ),
        SectionCard(
          title: context.t('mob.fld.capture.photos.title'),
          children: <Widget>[
            Text(
              context.t('mob.fld.capture.photos.count', <String, Object>{
                'count': draft.photos.length,
              }),
            ),
            const SizedBox(height: MachvonSpace.space8),
            OutlinedButton(
              onPressed: () => _goTo('MOB-29'),
              child: Text(context.t('mob.fld.capture.photos.action')),
            ),
          ],
        ),
        SectionCard(
          title: context.t('mob.fld.capture.place.title'),
          children: <Widget>[
            Text(placeSummary(context, draft.place)),
            const SizedBox(height: MachvonSpace.space8),
            OutlinedButton(
              onPressed: () => _goTo('MOB-30'),
              child: Text(context.t('mob.fld.capture.place.action')),
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: MachvonSpace.space16,
            vertical: MachvonSpace.space8,
          ),
          child: FilledButton(
            onPressed: _review,
            child: Text(context.t('mob.fld.capture.review.action')),
          ),
        ),
        _Waiting(
          exceptDraftId: _draftId,
          onResume: (String id) => context.go(
            locationOfScreen(
              context,
              'MOB-28',
              query: <String, String>{'draft': id},
            ),
          ),
        ),
      ],
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: MachvonSpace.space16,
        vertical: MachvonSpace.space8,
      ),
      child: Semantics(liveRegion: true, child: Text(text)),
    );
  }
}

class _ChoiceField extends StatelessWidget {
  const _ChoiceField({
    required this.label,
    required this.options,
    required this.value,
    required this.onChanged,
    this.error,
  });

  final String label;
  final List<Choice> options;
  final String value;
  final String? error;
  final ValueChanged<Choice?> onChanged;

  @override
  Widget build(BuildContext context) {
    final bool known = options.any((Choice choice) => choice.id == value);
    return Padding(
      padding: const EdgeInsets.only(top: MachvonSpace.space12),
      child: DropdownButtonFormField<String>(
        key: ValueKey<String>(value),
        initialValue: known ? value : null,
        isExpanded: true,
        decoration: InputDecoration(labelText: label, errorText: error),
        items: <DropdownMenuItem<String>>[
          for (final Choice choice in options)
            DropdownMenuItem<String>(
              value: choice.id,
              child: Text(choice.label, overflow: TextOverflow.ellipsis),
            ),
        ],
        onChanged: (String? id) => onChanged(
          id == null
              ? null
              : options.firstWhere((Choice choice) => choice.id == id),
        ),
      ),
    );
  }
}

/// The reports of this phone that are not finished: the ones waiting for the network (or refused), which open in MOB-31, and the
/// drafts that were left half written, which open here.
class _Waiting extends ConsumerWidget {
  const _Waiting({required this.onResume, this.exceptDraftId});

  final ValueChanged<String> onResume;

  /// The draft this form is working on is not listed as one that was left.
  final String? exceptDraftId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final List<QueuedCommand> waiting = <QueuedCommand>[
      for (final QueuedCommand command
          in ref.watch(queuedCommandsProvider).asData?.value ??
              const <QueuedCommand>[])
        if (command.commandType == kIssueCreateCommand &&
            command.state != CommandState.accepted &&
            command.state != CommandState.discarded)
          command,
    ];
    final List<StoredIssueDraft> drafts =
        ref.watch(openIssueDraftsProvider).asData?.value ??
        const <StoredIssueDraft>[];
    if (waiting.isEmpty && drafts.isEmpty) return const SizedBox.shrink();
    return SectionCard(
      title: context.t('mob.fld.waiting.title'),
      children: <Widget>[
        for (final QueuedCommand command in waiting)
          TappableRow(
            semanticLabel: context.t(
              'mob.fld.waiting.row.aria',
              <String, Object>{
                'title': '${command.payload?['title'] ?? ''}',
                'state': stateLabel(context, command.state),
              },
            ),
            onTap: () => openScreen(
              context,
              'MOB-31',
              pathSuffix: '/${command.id}',
              stacked: true,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('${command.payload?['title'] ?? ''}'),
                StatusPill(
                  label: stateLabel(context, command.state),
                  warn: command.state == CommandState.rejected,
                ),
              ],
            ),
          ),
        for (final StoredIssueDraft stored in drafts)
          TappableRow(
            semanticLabel: context.t(
              'mob.fld.waiting.draft.aria',
              <String, Object>{'title': draftTitle(context, stored.draft)},
            ),
            onTap: () => onResume(stored.id),
            child: Text(draftTitle(context, stored.draft)),
          ),
      ],
    );
  }
}
