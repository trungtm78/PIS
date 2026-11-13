import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/attachments/attachment_policy.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/session/session.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/components.dart';
import '../../../core/theme/machvon_semantic.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../../core/widgets/status_pill.dart';
import '../../command_support/field_widgets.dart';
import '../../field_evidence/device_sources.dart';
import '../../field_evidence/evidence_photos_field.dart' show evidenceRefusalText;
import '../../field_evidence/field_place.dart';
import '../../permissions/permission_providers.dart';
import '../../permissions/permission_service.dart';
import '../../read_support/navigate.dart';
import '../../read_support/offline.dart';
import '../issue_draft.dart';
import '../issue_labels.dart';
import '../issue_providers.dart';
import '../issue_service.dart';

/// MOB-30: where the obstacle is, and the check of the report before it is sent. The position of the phone is read only after the
/// person agreed to keep it and the phone allowed it (never in the background); when the phone cannot give one, or the person
/// does not want to, a place can be typed, and it is always labelled as typed by hand (BR-MOB-06). Taking the consent back takes
/// the position, and the place and time of the photographs, with it. The check is a list of rows with their state, and what needs
/// the person's attention is a flag with the action that fixes it; the report is sent from the bar at the foot, to the queue,
/// whether or not there is a network ("Save, send when online").
Widget buildPlaceScreen(BuildContext context, ScreenContext screen) => PlaceScreen(draftId: screen.pathParameters['draftId'] ?? '');

class PlaceScreen extends StatelessWidget {
  const PlaceScreen({required this.draftId, super.key});

  final String draftId;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.fld.place.title'),
      body: DraftBoundary(draftId: draftId, builder: (BuildContext context, StoredIssueDraft stored) => _Place(stored: stored)),
    );
  }
}

class _Place extends ConsumerStatefulWidget {
  const _Place({required this.stored});

  final StoredIssueDraft stored;

  @override
  ConsumerState<_Place> createState() => _PlaceState();
}

class _PlaceState extends ConsumerState<_Place> {
  final TextEditingController _manual = TextEditingController();
  bool _locating = false;
  bool _sending = false;

  /// The consent was taken back and the photographs are being rewritten without their place and time: nothing is sent until they are clean.
  bool _withdrawing = false;
  String? _locateNotice;
  String? _manualProblem;
  String? _sendRefusal;
  IssueNotReady? _notReady;

  @override
  void initState() {
    super.initState();
    _manual.text = widget.stored.draft.place.manualText ?? '';
  }

  @override
  void dispose() {
    _manual.dispose();
    super.dispose();
  }

  IssueDraft get _draft => widget.stored.draft;

  IssueService get _service => ref.read(issueServiceProvider);

  Future<void> _save(IssueDraft next) async {
    await _service.save(next, draftId: widget.stored.id);
    ref.invalidate(issueDraftProvider(widget.stored.id));
  }

  Future<void> _consent(bool given) async {
    setState(() {
      _locateNotice = null;
      _withdrawing = !given;
    });
    try {
      IssueDraft next = _draft.copyWith(place: _draft.place.withConsent(given));
      if (!given) {
        // The withdrawal is on the phone before anything else is done: a send that reads the draft from now on finds no consent.
        await _save(next);
        // Taking the consent back takes the place and the time out of the photographs too.
        next = await _service.enforceConsent(next);
      }
      await _save(next);
    } finally {
      if (mounted) setState(() => _withdrawing = false);
    }
  }

  Future<void> _locate() async {
    if (_locating || !_draft.place.consent) return;
    setState(() {
      _locating = true;
      _locateNotice = null;
    });
    try {
      final PermissionOutcome outcome = await requestPermissions(context, ref, <AppPermission>[AppPermission.location]);
      if (!mounted) return;
      if (outcome.manualLocation != null) {
        await _useManual(outcome.manualLocation!);
        return;
      }
      if (!outcome.isGranted(AppPermission.location)) {
        setState(() => _locateNotice = 'denied');
        return;
      }
      final DevicePosition? position = await ref.read(positionSourceProvider).current();
      if (!mounted) return;
      if (position == null) {
        setState(() => _locateNotice = 'unavailable');
        return;
      }
      // The consent may have been taken back while the phone was looking: a reading nobody agreed to keep is dropped.
      final StoredIssueDraft? fresh = await _service.load(widget.stored.id);
      if (fresh == null || !fresh.draft.place.consent) return;
      await _save(fresh.draft.copyWith(place: fresh.draft.place.withDevicePosition(position)));
    } finally {
      if (mounted) setState(() => _locating = false);
    }
  }

  Future<void> _useManual(ManualLocation typed) async {
    await _save(_draft.copyWith(place: _draft.place.withManual(typed)));
    if (mounted) {
      setState(() {
        _manual.text = typed.text;
        _manualProblem = null;
      });
    }
  }

  Future<void> _manualPressed() async {
    final ManualLocation? typed = ManualLocation.tryParse(_manual.text);
    if (typed == null) {
      setState(() => _manualProblem = 'invalid');
      return;
    }
    await _useManual(typed);
  }

  Future<void> _clear() async {
    setState(() => _manual.clear());
    await _save(_draft.copyWith(place: _draft.place.clearPlace()));
  }

  Future<void> _send() async {
    if (_sending || _withdrawing) return;
    setState(() {
      _sending = true;
      _sendRefusal = null;
      _notReady = null;
    });
    try {
      final QueuedCommand command = await _service.send(widget.stored.id, manualPlaceLabel: manualPlaceLabel(context));
      if (mounted) openScreen(context, 'MOB-31', pathSuffix: '/${command.id}');
    } on IssueNotReady catch (notReady) {
      if (mounted) setState(() => _notReady = notReady);
    } on AttachmentRefused catch (refusal) {
      if (mounted) setState(() => _sendRefusal = refusal.code);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// What the check found that the person can act on, each with the screen that fixes it: a missing detail opens the form, a missing
  /// photograph opens the camera, a photograph that still says where it was taken opens the photographs.
  List<Widget> _flags(BuildContext context, List<FieldCheck> checks) {
    CheckStatus statusOf(String id) => checks.firstWhere((FieldCheck check) => check.id == id).status;
    final String id = widget.stored.id;
    return <Widget>[
      if (statusOf('chosen') != CheckStatus.ok || statusOf('details') != CheckStatus.ok)
        NoticePanel(
          tone: NoticeTone.problem,
          title: context.t('mob.fld.check.flag.form'),
          actionLabel: context.t('mob.fld.check.flag.form.action'),
          onAction: () => openScreen(context, 'MOB-28', query: <String, String>{'draft': id}),
        ),
      if (statusOf('metadata') != CheckStatus.ok)
        NoticePanel(
          tone: NoticeTone.problem,
          title: context.t('mob.fld.check.flag.metadata'),
          actionLabel: context.t('mob.fld.check.flag.metadata.action'),
          onAction: () => openScreen(context, 'MOB-29', pathSuffix: '/$id', stacked: true),
        ),
      if (statusOf('photo') != CheckStatus.ok)
        NoticePanel(
          tone: NoticeTone.warning,
          title: context.t('mob.fld.check.flag.photo'),
          actionLabel: context.t('mob.fld.check.flag.photo.action'),
          onAction: () => openScreen(context, 'MOB-29', pathSuffix: '/$id', query: <String, String>{'start': 'camera'}, stacked: true),
        ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final IssueDraft draft = _draft;
    final FieldPlace place = draft.place;
    final bool readOnly = ref.watch(sessionProvider).isReadOnly;
    final bool offline = isOffline(ref);
    final List<FieldCheck> checks = fieldChecklist(draft, manualPlaceLabel: manualPlaceLabel(context));
    final bool ready = canSend(checks);
    final String? why = readOnly
        ? context.t('mob.fld.send.readOnly.notice')
        : _withdrawing
        ? context.t('mob.fld.send.withdrawing.why')
        : (!ready ? context.t('mob.fld.send.notReady.notice') : null);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
            children: <Widget>[
              FormSection(
                title: context.t('mob.fld.place.position.title'),
                first: true,
                children: <Widget>[
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(context.t('mob.fld.place.consent.label'), style: text.bodyStrong),
                    subtitle: Text(context.t('mob.fld.place.consent.hint'), style: text.caption.copyWith(color: v2.palette.ink2)),
                    value: place.consent && !_withdrawing,
                    onChanged: _withdrawing ? null : _consent,
                  ),
                  Padding(padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8), child: Text(placeSummary(context, place), style: text.body)),
                  if (place.hasDevicePosition)
                    place.isLowAccuracy
                        ? NoticePanel(tone: NoticeTone.warning, title: context.t('mob.fld.place.accuracy.low'), margin: const EdgeInsets.only(bottom: MachvonV2Space.s8))
                        : Padding(padding: const EdgeInsets.only(bottom: MachvonV2Space.s8), child: Text(context.t('mob.fld.place.accuracy.ok'), style: text.caption.copyWith(color: v2.palette.ink2))),
                  FilledButton(
                    style: v2QuietButtonStyle(v2).copyWith(backgroundColor: WidgetStatePropertyAll<Color>(v2.palette.surface), elevation: const WidgetStatePropertyAll<double>(0)),
                    onPressed: place.consent && !_locating ? _locate : null,
                    child: Text(_locating ? context.t('mob.fld.place.locating') : context.t('mob.fld.place.locate.action')),
                  ),
                  if (!place.consent)
                    Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.fld.place.locate.needsConsent'), style: text.caption.copyWith(color: v2.palette.ink2))),
                  if (_locateNotice != null)
                    NoticePanel(
                      title: _locateNotice == 'denied' ? context.t('mob.fld.place.locate.denied') : context.t('mob.fld.place.locate.unavailable'),
                      margin: const EdgeInsets.only(top: MachvonV2Space.s8),
                    ),
                ],
              ),
              FormSection(
                title: context.t('mob.fld.place.manual.title'),
                caption: context.t('mob.fld.place.manual.hint'),
                children: <Widget>[
                  TextField(
                    controller: _manual,
                    maxLength: ManualLocation.maxLength,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: InputDecoration(
                      labelText: context.t('mob.fld.place.manual.field'),
                      helperText: context.t('mob.fld.place.manual.sourceLabel'),
                      errorText: _manualProblem == null ? null : context.t('mob.fld.place.manual.invalid'),
                    ),
                  ),
                  Wrap(
                    spacing: MachvonV2Space.s8,
                    runSpacing: MachvonV2Space.s8,
                    children: <Widget>[
                      OutlinedButton(onPressed: _manualPressed, child: Text(context.t('mob.fld.place.manual.action'))),
                      if (place.hasPlace) OutlinedButton(onPressed: _clear, child: Text(context.t('mob.fld.place.clear.action'))),
                    ],
                  ),
                ],
              ),
              FormSection(title: context.t('mob.fld.check.title'), children: const <Widget>[]),
              for (int index = 0; index < checks.length; index += 1)
                InfoRow(
                  label: checkText(context, checks[index]),
                  value: checkStatusText(context, checks[index].status),
                  valueWidget: StatusPill(label: checkStatusText(context, checks[index].status), tone: _toneOf(checks[index].status)),
                  divider: index > 0,
                ),
              ..._flags(context, checks),
              if (offline) NoticePanel(icon: Icons.cloud_off_outlined, title: context.t('mob.fld.send.offline.notice')),
              if (_notReady != null) NoticePanel(tone: NoticeTone.problem, title: context.t('mob.fld.send.notReady.notice')),
              if (_sendRefusal != null)
                NoticePanel(tone: NoticeTone.problem, title: evidenceRefusalText(context, _sendRefusal!), code: _sendRefusal, actionLabel: context.t('mob.fld.waiting.retry.action'), onAction: _send),
            ],
          ),
        ),
        FieldSendBar(
          label: context.t('mob.fld.send.action'),
          onSend: ready && !readOnly && !_sending && !_withdrawing ? _send : null,
          sending: _sending,
          offline: offline,
          why: why,
        ),
      ],
    );
  }
}

MachvonTone _toneOf(CheckStatus status) {
  switch (status) {
    case CheckStatus.ok:
      return MachvonTone.success;
    case CheckStatus.warning:
      return MachvonTone.warning;
    case CheckStatus.missing:
      return MachvonTone.danger;
  }
}
