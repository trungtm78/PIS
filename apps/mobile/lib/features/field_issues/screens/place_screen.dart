import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/attachments/attachment_policy.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/session/session.dart';
import '../../field_evidence/device_sources.dart';
import '../../field_evidence/evidence_photos_field.dart' show evidenceRefusalText;
import '../../field_evidence/field_place.dart';
import '../../permissions/permission_providers.dart';
import '../../permissions/permission_service.dart';
import '../../read_support/navigate.dart';
import '../../read_support/offline.dart';
import '../../read_support/widgets.dart';
import '../issue_draft.dart';
import '../issue_labels.dart';
import '../issue_providers.dart';
import '../issue_service.dart';

/// MOB-30: where the obstacle is, and the check of the report before it is sent. The position of the phone is read only after the
/// person agreed to keep it and the phone allowed it (never in the background); when the phone cannot give one, or the person
/// does not want to, a place can be typed, and it is always labelled as typed by hand (BR-MOB-06). Taking the consent back takes
/// the position, and the place and time of the photographs, with it. The checklist tells what is missing; the report is sent
/// from here, to the queue, whether or not there is a network.
Widget buildPlaceScreen(BuildContext context, ScreenContext screen) =>
    PlaceScreen(draftId: screen.pathParameters['draftId'] ?? '');

class PlaceScreen extends StatelessWidget {
  const PlaceScreen({required this.draftId, super.key});

  final String draftId;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.fld.place.title'),
      body: DraftBoundary(
        draftId: draftId,
        builder: (BuildContext context, StoredIssueDraft stored) =>
            _Place(stored: stored),
      ),
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
      final PermissionOutcome outcome = await requestPermissions(
        context,
        ref,
        <AppPermission>[AppPermission.location],
      );
      if (!mounted) return;
      if (outcome.manualLocation != null) {
        await _useManual(outcome.manualLocation!);
        return;
      }
      if (!outcome.isGranted(AppPermission.location)) {
        setState(() => _locateNotice = 'denied');
        return;
      }
      final DevicePosition? position = await ref
          .read(positionSourceProvider)
          .current();
      if (!mounted) return;
      if (position == null) {
        setState(() => _locateNotice = 'unavailable');
        return;
      }
      // The consent may have been taken back while the phone was looking: a reading nobody agreed to keep is dropped.
      final StoredIssueDraft? fresh = await _service.load(widget.stored.id);
      if (fresh == null || !fresh.draft.place.consent) return;
      await _save(
        fresh.draft.copyWith(
          place: fresh.draft.place.withDevicePosition(position),
        ),
      );
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
      final QueuedCommand command = await _service.send(
        widget.stored.id,
        manualPlaceLabel: manualPlaceLabel(context),
      );
      if (mounted) openScreen(context, 'MOB-31', pathSuffix: '/${command.id}');
    } on IssueNotReady catch (notReady) {
      if (mounted) setState(() => _notReady = notReady);
    } on AttachmentRefused catch (refusal) {
      if (mounted) setState(() => _sendRefusal = refusal.code);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final IssueDraft draft = _draft;
    final FieldPlace place = draft.place;
    final bool readOnly = ref.watch(sessionProvider).isReadOnly;
    final bool offline = isOffline(ref);
    final String label = manualPlaceLabel(context);
    final List<FieldCheck> checks = fieldChecklist(
      draft,
      manualPlaceLabel: label,
    );
    final bool ready = canSend(checks);
    final ThemeData theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: context.t('mob.fld.place.position.title'),
          children: <Widget>[
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(context.t('mob.fld.place.consent.label')),
              subtitle: Text(context.t('mob.fld.place.consent.hint')),
              value: place.consent && !_withdrawing,
              onChanged: _withdrawing ? null : _consent,
            ),
            Text(
              placeSummary(context, place),
              style: theme.textTheme.bodyLarge,
            ),
            if (place.hasDevicePosition)
              Text(
                place.isLowAccuracy
                    ? context.t('mob.fld.place.accuracy.low')
                    : context.t('mob.fld.place.accuracy.ok'),
              ),
            const SizedBox(height: MachvonSpace.space8),
            FilledButton(
              onPressed: place.consent && !_locating ? _locate : null,
              child: Text(
                _locating
                    ? context.t('mob.fld.place.locating')
                    : context.t('mob.fld.place.locate.action'),
              ),
            ),
            if (!place.consent)
              Padding(
                padding: const EdgeInsets.only(top: MachvonSpace.space4),
                child: Text(context.t('mob.fld.place.locate.needsConsent')),
              ),
            if (_locateNotice != null)
              Semantics(
                liveRegion: true,
                child: Text(
                  _locateNotice == 'denied'
                      ? context.t('mob.fld.place.locate.denied')
                      : context.t('mob.fld.place.locate.unavailable'),
                ),
              ),
          ],
        ),
        SectionCard(
          title: context.t('mob.fld.place.manual.title'),
          children: <Widget>[
            Text(context.t('mob.fld.place.manual.hint')),
            const SizedBox(height: MachvonSpace.space8),
            TextField(
              controller: _manual,
              maxLength: ManualLocation.maxLength,
              decoration: InputDecoration(
                labelText: context.t('mob.fld.place.manual.field'),
                helperText: context.t('mob.fld.place.manual.sourceLabel'),
                errorText: _manualProblem == null
                    ? null
                    : context.t('mob.fld.place.manual.invalid'),
              ),
            ),
            OutlinedButton(
              onPressed: _manualPressed,
              child: Text(context.t('mob.fld.place.manual.action')),
            ),
            if (place.hasPlace)
              TextButton(
                onPressed: _clear,
                child: Text(context.t('mob.fld.place.clear.action')),
              ),
          ],
        ),
        SectionCard(
          title: context.t('mob.fld.check.title'),
          children: <Widget>[
            for (final FieldCheck check in checks)
              MergeSemantics(
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    vertical: MachvonSpace.space4,
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      StatusPill(
                        label: checkStatusText(context, check.status),
                        warn: check.status != CheckStatus.ok,
                      ),
                      const SizedBox(width: MachvonSpace.space8),
                      Expanded(child: Text(checkText(context, check))),
                    ],
                  ),
                ),
              ),
          ],
        ),
        if (readOnly)
          Padding(
            padding: const EdgeInsets.all(MachvonSpace.space16),
            child: Semantics(
              liveRegion: true,
              child: Text(context.t('mob.fld.send.readOnly.notice')),
            ),
          ),
        if (offline)
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: MachvonSpace.space16,
            ),
            child: Text(context.t('mob.fld.send.offline.notice')),
          ),
        if (_notReady != null)
          Padding(
            padding: const EdgeInsets.all(MachvonSpace.space16),
            child: Semantics(
              liveRegion: true,
              child: Text(context.t('mob.fld.send.notReady.notice')),
            ),
          ),
        if (_sendRefusal != null)
          Padding(
            padding: const EdgeInsets.all(MachvonSpace.space16),
            child: Semantics(
              liveRegion: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(evidenceRefusalText(context, _sendRefusal!)),
                  Text(_sendRefusal!, style: theme.textTheme.bodySmall),
                ],
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: MachvonSpace.space16,
            vertical: MachvonSpace.space8,
          ),
          child: FilledButton(
            onPressed: ready && !readOnly && !_sending && !_withdrawing ? _send : null,
            child: Text(
              _sending
                  ? context.t('mob.fld.send.pending')
                  : context.t('mob.fld.send.action'),
            ),
          ),
        ),
      ],
    );
  }
}
