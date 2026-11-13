import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/session/session.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../../core/widgets/status_pill.dart';
import '../../../core/widgets/tap_target.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/field_widgets.dart';
import '../../offline/offline_labels.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../issue_draft.dart';
import '../issue_labels.dart';
import '../issue_lookups.dart';
import '../issue_providers.dart';
import '../issue_service.dart';

/// MOB-28: the capture form of an obstacle, on one screen. The project, the responsible unit, the category and the severity are chosen from
/// what the server offers (kept on the device, so the form can be filled in without a network), the title and the description are written,
/// the photographs are added from the same screen (one tap opens the camera) and everything is saved on the device as the person types: a
/// report is a draft until it is sent (MOB-30), and a draft survives the app being closed. The one action stays in the bar at the foot
/// ("Review and send"). A report that is waiting for the network is listed here, and opens in MOB-31.
Widget buildCaptureScreen(BuildContext context, ScreenContext screen) => CaptureScreen(draftId: screen.queryParameters['draft']);

/// Categories are shown as chips while there are few of them; a long list of them is a menu.
const int kCategoryChipsMax = 6;

class CaptureScreen extends StatelessWidget {
  const CaptureScreen({this.draftId, super.key});

  final String? draftId;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.fld.capture.title'),
      body: DataView<IssueLookups>(
        cacheKey: 'issues.lookups',
        read: readIssueLookups,
        parse: parseIssueLookups,
        isEmpty: (IssueLookups lookups) => lookups.isEmpty,
        builder: (BuildContext context, Loaded<IssueLookups> loaded) => _CaptureForm(key: ValueKey<String?>(draftId), lookups: loaded.value, draftId: draftId),
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

  /// Opens a step of this report (the photographs, the place and the check) with the draft kept first; [start] makes the photograph
  /// screen open the camera or the gallery at once, so adding a photograph is one tap.
  Future<void> _goTo(String screenId, {String? start}) async {
    final String? id = await _persist();
    if (id == null || !mounted) return;
    await context.push<void>(locationOfScreen(context, screenId, pathSuffix: '/$id', query: <String, String>{'start': ?start}));
    if (mounted) await _refresh();
  }

  Future<void> _review() async {
    final IssueDraft draft = _draft!;
    final Map<String, IssueProblem> problems = checkIssue(draft, manualPlaceLabel: manualPlaceLabel(context));
    setState(() => _problems = problems);
    if (problems.isEmpty) await _goTo('MOB-30');
  }

  void _pick(Choice? choice, IssueDraft Function(IssueDraft draft, Choice choice) apply) {
    final IssueDraft? draft = _draft;
    if (choice == null || draft == null) return;
    _change(apply(draft, choice));
  }

  String? _errorText(BuildContext context, String field) => _problems[field] == null ? null : issueProblemText(context, _problems[field]!);

  @override
  Widget build(BuildContext context) {
    final IssueDraft? draft = _draft;
    if (draft == null) return const Center(child: CircularProgressIndicator());
    final IssueLookups lookups = widget.lookups;
    final bool readOnly = ref.watch(sessionProvider).isReadOnly;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
            children: <Widget>[
              if (readOnly) NoticePanel(title: context.t('mob.fld.capture.readOnly.notice')),
              if (_storeFailure != null) NoticePanel(tone: NoticeTone.warning, title: context.t('mob.fld.capture.store.notice')),
              FormSection(
                title: context.t('mob.fld.capture.form.title'),
                first: true,
                children: <Widget>[
                  _ChoiceDropdown(
                    label: context.t('mob.fld.capture.project.label'),
                    options: lookups.projects,
                    value: draft.projectId,
                    error: _errorText(context, 'project'),
                    onChanged: (Choice? choice) => _pick(choice, (IssueDraft d, Choice c) => d.copyWith(projectId: c.id, projectLabel: c.label)),
                  ),
                  _ChoiceDropdown(
                    label: context.t('mob.fld.capture.unit.label'),
                    options: lookups.units,
                    value: draft.ownerUnitId,
                    error: _errorText(context, 'unit'),
                    onChanged: (Choice? choice) => _pick(choice, (IssueDraft d, Choice c) => d.copyWith(ownerUnitId: c.id, ownerUnitLabel: c.label)),
                  ),
                  if (lookups.categories.length <= kCategoryChipsMax)
                    _ChoiceChips(
                      label: context.t('mob.fld.capture.category.label'),
                      options: lookups.categories,
                      value: draft.categoryVersionId,
                      error: _errorText(context, 'category'),
                      onChanged: (Choice choice) => _pick(choice, (IssueDraft d, Choice c) => d.copyWith(categoryVersionId: c.id, categoryLabel: c.label)),
                    )
                  else
                    _ChoiceDropdown(
                      label: context.t('mob.fld.capture.category.label'),
                      options: lookups.categories,
                      value: draft.categoryVersionId,
                      error: _errorText(context, 'category'),
                      onChanged: (Choice? choice) => _pick(choice, (IssueDraft d, Choice c) => d.copyWith(categoryVersionId: c.id, categoryLabel: c.label)),
                    ),
                  _ChoiceChips(
                    label: context.t('mob.fld.capture.severity.label'),
                    options: <Choice>[for (final String severity in kSeverities) Choice(id: severity, label: severityText(context, severity))],
                    value: draft.severity,
                    onChanged: (Choice choice) => _pick(choice, (IssueDraft d, Choice c) => d.copyWith(severity: c.id)),
                  ),
                  const SizedBox(height: MachvonV2Space.s16),
                  TextField(
                    controller: _title,
                    maxLength: kTitleMax,
                    textInputAction: TextInputAction.next,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: InputDecoration(labelText: context.t('mob.fld.capture.title.label'), errorText: _errorText(context, 'title')),
                    onChanged: (String value) => _change(draft.copyWith(title: value)),
                  ),
                  const SizedBox(height: MachvonV2Space.s8),
                  TextField(
                    controller: _description,
                    maxLines: 5,
                    maxLength: kDescriptionMax,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: InputDecoration(labelText: context.t('mob.fld.capture.description.label'), errorText: _errorText(context, 'description')),
                    onChanged: (String value) => _change(draft.copyWith(description: value)),
                  ),
                ],
              ),
              FormSection(
                title: context.t('mob.fld.capture.photos.title'),
                caption: draft.photos.isEmpty ? context.t('mob.fld.capture.photos.none') : context.t('mob.fld.capture.photos.count', <String, Object>{'count': draft.photos.length}),
                children: <Widget>[
                  if (draft.photos.isNotEmpty)
                    SizedBox(
                      height: 72,
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        itemCount: draft.photos.length,
                        separatorBuilder: (BuildContext _, int _) => const SizedBox(width: MachvonV2Space.s8),
                        itemBuilder: (BuildContext context, int index) => _Thumb(photo: draft.photos[index], number: index + 1, onTap: () => _goTo('MOB-29')),
                      ),
                    ),
                  const SizedBox(height: MachvonV2Space.s8),
                  Wrap(
                    spacing: MachvonV2Space.s8,
                    runSpacing: MachvonV2Space.s8,
                    children: <Widget>[
                      OutlinedButton.icon(onPressed: () => _goTo('MOB-29', start: 'camera'), icon: const Icon(Icons.photo_camera_outlined), label: Text(context.t('mob.fld.photo.take.action'))),
                      OutlinedButton(onPressed: () => _goTo('MOB-29', start: 'gallery'), child: Text(context.t('mob.fld.photo.choose.action'))),
                    ],
                  ),
                ],
              ),
              FormSection(
                title: context.t('mob.fld.capture.place.title'),
                children: <Widget>[
                  Text(placeSummary(context, draft.place), style: context.v2text.body),
                  const SizedBox(height: MachvonV2Space.s8),
                  Align(alignment: Alignment.centerLeft, child: OutlinedButton(onPressed: () => _goTo('MOB-30'), child: Text(context.t('mob.fld.capture.place.action')))),
                ],
              ),
              _Waiting(
                exceptDraftId: _draftId,
                onResume: (String id) => context.go(locationOfScreen(context, 'MOB-28', query: <String, String>{'draft': id})),
              ),
            ],
          ),
        ),
        FieldSendBar(label: context.t('mob.fld.capture.review.action'), onSend: _review),
      ],
    );
  }
}

/// One photograph of the draft in the strip: a thumbnail that opens the photograph screen, where it is marked or removed.
class _Thumb extends StatelessWidget {
  const _Thumb({required this.photo, required this.number, required this.onTap});

  final IssuePhoto photo;
  final int number;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return TapTarget(
      onTap: onTap,
      minHeight: 72,
      minWidth: 72,
      semanticLabel: context.t('mob.fld.capture.thumb.aria', <String, Object>{'number': number}),
      alignment: Alignment.center,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(MachvonV2Radius.control),
        child: SizedBox(
          width: 72,
          height: 72,
          child: ColoredBox(
            color: v2.palette.sunken,
            child: Image.file(
              File(photo.path),
              fit: BoxFit.cover,
              excludeFromSemantics: true,
              errorBuilder: (BuildContext _, Object _, StackTrace? _) => Icon(Icons.broken_image_outlined, color: v2.palette.ink3),
            ),
          ),
        ),
      ),
    );
  }
}

/// A choice from a long list: a menu with its label on the field and its error under it.
class _ChoiceDropdown extends StatelessWidget {
  const _ChoiceDropdown({required this.label, required this.options, required this.value, required this.onChanged, this.error});

  final String label;
  final List<Choice> options;
  final String value;
  final String? error;
  final ValueChanged<Choice?> onChanged;

  @override
  Widget build(BuildContext context) {
    final bool known = options.any((Choice choice) => choice.id == value);
    return Padding(
      padding: const EdgeInsets.only(top: MachvonV2Space.s12),
      child: DropdownButtonFormField<String>(
        key: ValueKey<String>(value),
        initialValue: known ? value : null,
        isExpanded: true,
        decoration: InputDecoration(labelText: label, errorText: error),
        items: <DropdownMenuItem<String>>[for (final Choice choice in options) DropdownMenuItem<String>(value: choice.id, child: Text(choice.label, overflow: TextOverflow.ellipsis))],
        onChanged: (String? id) => onChanged(id == null ? null : options.firstWhere((Choice choice) => choice.id == id)),
      ),
    );
  }
}

/// A choice from a short list (the severity, a few categories): a label and the chips under it, 44 high, the chosen one filled, and the
/// error under the chips the moment it is known.
class _ChoiceChips extends StatelessWidget {
  const _ChoiceChips({required this.label, required this.options, required this.value, required this.onChanged, this.error});

  final String label;
  final List<Choice> options;
  final String value;
  final String? error;
  final ValueChanged<Choice> onChanged;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return Padding(
      padding: const EdgeInsets.only(top: MachvonV2Space.s12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Semantics(header: true, child: Text(label, style: text.label.copyWith(color: v2.palette.ink2))),
          FilterChips<String>(
            padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
            options: <ChipOption<String>>[for (final Choice choice in options) ChipOption<String>(value: choice.id, label: choice.label)],
            selected: value,
            onChanged: (String id) => onChanged(options.firstWhere((Choice choice) => choice.id == id)),
          ),
          if (error != null) Semantics(liveRegion: true, child: Text(error!, style: text.caption.copyWith(color: v2.palette.lateFg))),
        ],
      ),
    );
  }
}

/// The reports of this phone that are not finished: the ones waiting for the network (or refused), which open in MOB-31, and the
/// drafts that were left half written, which open here. They are rows under a heading, and the heading is not there when there is nothing.
class _Waiting extends ConsumerWidget {
  const _Waiting({required this.onResume, this.exceptDraftId});

  final ValueChanged<String> onResume;

  /// The draft this form is working on is not listed as one that was left.
  final String? exceptDraftId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final List<QueuedCommand> waiting = <QueuedCommand>[
      for (final QueuedCommand command in ref.watch(queuedCommandsProvider).asData?.value ?? const <QueuedCommand>[])
        if (command.commandType == kIssueCreateCommand && command.state != CommandState.accepted && command.state != CommandState.discarded) command,
    ];
    final List<StoredIssueDraft> drafts = <StoredIssueDraft>[
      for (final StoredIssueDraft stored in ref.watch(openIssueDraftsProvider).asData?.value ?? const <StoredIssueDraft>[])
        if (stored.id != exceptDraftId) stored,
    ];
    if (waiting.isEmpty && drafts.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const SizedBox(height: MachvonV2Space.s16),
        GroupHeader(title: context.t('mob.fld.waiting.title'), count: waiting.length + drafts.length),
        for (int index = 0; index < waiting.length; index += 1)
          WorkRow(
            title: '${waiting[index].payload?['title'] ?? ''}',
            trailing: StatusPill(label: stateLabel(context, waiting[index].state), warn: waiting[index].state == CommandState.rejected),
            dividerAbove: index > 0,
            semanticLabel: context.t('mob.fld.waiting.row.aria', <String, Object>{'title': '${waiting[index].payload?['title'] ?? ''}', 'state': stateLabel(context, waiting[index].state)}),
            onTap: () => openScreen(context, 'MOB-31', pathSuffix: '/${waiting[index].id}', stacked: true),
          ),
        for (int index = 0; index < drafts.length; index += 1)
          WorkRow(
            title: draftTitle(context, drafts[index].draft),
            dividerAbove: waiting.isNotEmpty || index > 0,
            semanticLabel: context.t('mob.fld.waiting.draft.aria', <String, Object>{'title': draftTitle(context, drafts[index].draft)}),
            onTap: () => onResume(drafts[index].id),
          ),
      ],
    );
  }
}
