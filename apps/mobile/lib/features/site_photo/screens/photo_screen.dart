import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/attachments/attachment_upload.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/session/session.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/machvon_semantic.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../../core/widgets/sheets.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/field_contract.dart';
import '../../command_support/field_widgets.dart';
import '../../field_evidence/evidence_photos.dart';
import '../../field_evidence/evidence_photos_field.dart';
import '../../field_evidence/field_place.dart';
import '../../field_evidence/place_consent_field.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/offline.dart';
import '../../site_diary/contract_models.dart';
import '../photo_models.dart';
import '../photo_service.dart';

/// QMS-10: a site photograph with the checks of its file and its place (ST-QMS-003, QMS 3.4, BR-QMS-06). The person takes or chooses
/// photographs, links them to a contract and, if they wish, a diary of it, writes a caption, and sees the flags the phone can know
/// before anything is kept: no place, no time of capture, the same file already registered for the contract. The place is read and kept
/// only after the person agreed (the rationale of MOB-06 first), and taking the consent back takes the place and the time out of the
/// photographs at once (UAT-AC367). A flag is a note for review and never stops a photograph.
///
/// The camera comes first: the photographs are the first block, the contract and the caption follow, and the one action is in the sticky
/// bar at the foot ("Save and upload"; with no connection "Save, send when online"). Choosing a contract makes it the contract the quick
/// "Report" sheet offers first.
///
/// Saving works with no connection: the capture is kept in the encrypted store and its photographs go up in chunks, are scanned, and wait
/// as clean uploads (MOB-19). The registration in the site photo register (`registerSitePhoto`) is not made from the phone, because it
/// takes the key of a file in the file service and the server gives the phone none for a site photograph: the capture is kept with
/// everything the registration needs. `?contract=<id>` and `?diary=<id>` open the form with the contract and the diary chosen.
Widget buildPhotoScreen(BuildContext context, ScreenContext screen) =>
    PhotoScreen(contractId: screen.queryParameters['contract'], diaryId: screen.queryParameters['diary']);

class PhotoScreen extends StatefulWidget {
  const PhotoScreen({this.contractId, this.diaryId, super.key});

  final String? contractId;
  final String? diaryId;

  @override
  State<PhotoScreen> createState() => _PhotoScreenState();
}

class _PhotoScreenState extends State<PhotoScreen> {
  int _reload = 0;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.sitepic.title'),
      body: DataView<List<ContractLine>>(
        cacheKey: 'diary.contracts',
        reloadKey: _reload,
        read: readContracts,
        parse: (Object? raw) => parseContracts(raw),
        builder: (BuildContext context, Loaded<List<ContractLine>> loaded) => loaded.value.isEmpty
            ? StateView(
                kind: StateKind.empty,
                body: context.t('mob.sitepic.contracts.empty.body'),
                actionLabel: context.t('mob.states.retry.action'),
                onAction: () => setState(() => _reload += 1),
              )
            : _CaptureForm(contracts: loaded.value, initialContract: widget.contractId, initialDiary: widget.diaryId),
      ),
    );
  }
}

/// The diaries of a contract the photographs may be linked to; null when they could not be read (the form says so and goes on).
final diaryOptionsProvider = FutureProvider.autoDispose.family<List<DiaryOption>?, String>((Ref ref, String contractId) async {
  try {
    return parseDiaryOptions(await ref.watch(apiClientProvider).getResourcesSiteDiary(query: <String, Object?>{'contract_id': contractId, 'limit': 30}));
  } on Object {
    return null;
  }
});

/// The files already registered for a contract, by hash; null when they could not be read (offline, or no right to see them).
final registeredHashesProvider = FutureProvider.autoDispose.family<Set<String>?, String>((Ref ref, String contractId) async {
  try {
    return parseRegisteredHashes(await readRegisteredPhotos(ref.watch(apiClientProvider), contractId));
  } on Object {
    return null;
  }
});

class _CaptureForm extends ConsumerStatefulWidget {
  const _CaptureForm({required this.contracts, this.initialContract, this.initialDiary});

  final List<ContractLine> contracts;
  final String? initialContract;
  final String? initialDiary;

  @override
  ConsumerState<_CaptureForm> createState() => _CaptureFormState();
}

class _CaptureFormState extends ConsumerState<_CaptureForm> {
  final TextEditingController _caption = TextEditingController();
  String? _contractId;
  String? _diaryId;
  FieldPlace _place = FieldPlace.none;
  List<EvidencePhoto> _photos = const <EvidencePhoto>[];
  final Map<String, String> _hashes = <String, String>{};
  String _operationId = newUuidV4();
  late final SitePhotoService _service;
  Map<String, CaptureProblem> _problems = const <String, CaptureProblem>{};
  bool _saving = false;

  /// The consent was taken back and the photographs are being rewritten without their place and time: nothing is kept or changed
  /// until they are clean.
  bool _sanitizing = false;
  bool _failed = false;
  int? _saved;
  int _revision = 0;

  @override
  void initState() {
    super.initState();
    _service = ref.read(sitePhotoServiceProvider);
    if (widget.contracts.any((ContractLine contract) => contract.id == widget.initialContract)) {
      _contractId = widget.initialContract;
      _diaryId = widget.initialDiary;
      _remember(widget.initialContract!);
    }
  }

  @override
  void dispose() {
    _caption.dispose();
    // Photographs that were prepared and never kept leave nothing behind; those of a capture that is kept (or being kept) stay with it.
    if (_photos.isNotEmpty) unawaited(_service.discardUnkept(_operationId, _photos));
    super.dispose();
  }

  /// The contract the person works on is the one the quick "Report" sheet offers next.
  void _remember(String contractId) {
    WidgetsBinding.instance.addPostFrameCallback((Duration _) {
      if (mounted) ref.read(lastFieldContractProvider.notifier).remember(contractId);
    });
  }

  void _touched() {
    // Another capture from here on: a retry of this one keeps its id, a changed one is another.
    _failed = false;
    _saved = null;
  }

  Future<void> _photosChanged(List<EvidencePhoto> next) async {
    final Set<String> keptIds = next.map((EvidencePhoto photo) => photo.id).toSet();
    for (final EvidencePhoto photo in _photos) {
      if (!keptIds.contains(photo.id)) {
        _hashes.remove(photo.id);
        unawaited(removePreparedFiles(photo));
      }
    }
    setState(() {
      _photos = next;
      _problems = const <String, CaptureProblem>{};
      _touched();
    });
    for (final EvidencePhoto photo in next) {
      if (_hashes.containsKey(photo.id)) continue;
      final String hash = await fileSha256(photo.path);
      if (!mounted) return;
      setState(() => _hashes[photo.id] = hash);
    }
  }

  /// The place is the one the person chose from this moment (the withdrawal of the consent is not delayed by the work on the files);
  /// the photographs lose their place and time meanwhile, and the capture cannot be kept before they have.
  Future<void> _placeChanged(FieldPlace next) async {
    final List<EvidencePhoto> before = _photos;
    setState(() {
      _place = next;
      _sanitizing = !next.consent && before.isNotEmpty;
      _touched();
    });
    if (!_sanitizing) return;
    List<EvidencePhoto> clean = before;
    try {
      clean = await enforcePhotoConsent(before, consent: false);
    } finally {
      if (mounted) {
        setState(() {
          _photos = clean;
          _sanitizing = false;
        });
      }
    }
  }

  Set<String> _duplicateIds(Set<String>? registered) {
    final Set<String> seen = <String>{};
    final Set<String> found = <String>{};
    for (final EvidencePhoto photo in _photos) {
      final String? hash = _hashes[photo.id];
      if (hash == null) continue;
      if (!seen.add(hash) || (registered?.contains(hash) ?? false)) found.add(photo.id);
    }
    return found;
  }

  Future<void> _save() async {
    final ContractLine? contract = widget.contracts.where((ContractLine candidate) => candidate.id == _contractId).firstOrNull;
    final Map<String, CaptureProblem> problems = checkCapture(contractId: contract?.id, photos: _photos.length, caption: _caption.text);
    setState(() => _problems = problems);
    if (problems.isNotEmpty || contract == null || _saving || _sanitizing) return;
    setState(() {
      _saving = true;
      _failed = false;
      _saved = null;
    });
    final DiaryOption? diary = _diaryId == null ? null : ref.read(diaryOptionsProvider(contract.id)).value?.where((DiaryOption option) => option.id == _diaryId).firstOrNull;
    try {
      final PhotoRecord record = await _service.keep(
            PhotoRecord(
              operationId: _operationId,
              contractId: contract.id,
              contractCode: contract.code,
              siteDiaryId: diary?.id,
              diaryDate: diary?.recordDate,
              caption: _caption.text.trim(),
              place: _place,
              photos: _photos,
            ),
          );
      if (!mounted) return;
      setState(() {
        _saved = record.photos.length;
        // The files now belong to the capture that was kept; the form starts over for the next one.
        _photos = const <EvidencePhoto>[];
        _hashes.clear();
        _place = FieldPlace.none;
        _caption.clear();
        _operationId = newUuidV4();
        _saving = false;
        _revision += 1;
      });
    } on Object {
      if (mounted) {
        setState(() {
          _saving = false;
          _failed = true;
        });
      }
    }
  }

  String _problemText(BuildContext context, CaptureProblem problem) {
    switch (problem) {
      case CaptureProblem.contractRequired:
        return context.t('mob.sitepic.problem.contract');
      case CaptureProblem.noPhoto:
        return context.t('mob.sitepic.problem.photos');
      case CaptureProblem.captionTooLong:
        return context.t('mob.sitepic.problem.caption');
    }
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final bool readOnly = ref.watch(sessionProvider).isReadOnly;
    final bool offline = isOffline(ref);
    final bool enabled = !readOnly && !_saving;
    final bool settled = enabled && !_sanitizing;
    final String? contractId = _contractId;
    final AsyncValue<List<DiaryOption>?> diaries = contractId == null ? const AsyncData<List<DiaryOption>?>(<DiaryOption>[]) : ref.watch(diaryOptionsProvider(contractId));
    final AsyncValue<Set<String>?> registered = contractId == null ? const AsyncData<Set<String>?>(<String>{}) : ref.watch(registeredHashesProvider(contractId));
    final Set<String>? known = registered.value;
    final CaptureFlags flags = flagsOf(_photos, _place, duplicateIds: _duplicateIds(known), duplicatesChecked: contractId == null || (registered.hasValue && known != null));
    final List<DiaryOption> options = diaries.value ?? const <DiaryOption>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
            children: <Widget>[
              if (_saved != null)
                OutcomeCard(
                  title: context.t('mob.sitepic.result.title', <String, Object>{'count': _saved!}),
                  lines: <String>[context.t('mob.sitepic.result.body')],
                  tone: offline ? NoticeTone.info : NoticeTone.ok,
                ),
              if (_failed) OutcomeCard(title: context.t('mob.sitepic.result.failed'), tone: NoticeTone.problem),
              FormSection(
                first: true,
                title: context.t('mob.sitepic.photos.title'),
                caption: context.t('mob.sitepic.intro'),
                children: <Widget>[
                  EvidencePhotosField(photos: _photos, keepPlaceAndTime: _place.consent, place: _place, enabled: settled, onChanged: _photosChanged),
                  if (_problems['photos'] != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: GateNote(text: _problemText(context, _problems['photos']!))),
                ],
              ),
              FormSection(
                title: context.t('mob.sitepic.contract.label'),
                children: <Widget>[
                  DropdownButtonFormField<String>(
                    initialValue: _contractId,
                    isExpanded: true,
                    decoration: InputDecoration(
                      labelText: context.t('mob.sitepic.contract.label'),
                      hintText: context.t('mob.sitepic.contract.choose'),
                      errorText: _problems['contract'] == null ? null : _problemText(context, _problems['contract']!),
                    ),
                    items: <DropdownMenuItem<String>>[
                      for (final ContractLine contract in widget.contracts) DropdownMenuItem<String>(value: contract.id, child: Text(contract.label, overflow: TextOverflow.ellipsis)),
                    ],
                    onChanged: enabled
                        ? (String? id) {
                            if (id != null) _remember(id);
                            setState(() {
                              _contractId = id;
                              _diaryId = null;
                              _problems = const <String, CaptureProblem>{};
                              _touched();
                            });
                          }
                        : null,
                  ),
                  if (contractId != null && diaries.hasValue && diaries.value == null) ...<Widget>[
                    const SizedBox(height: MachvonV2Space.s8),
                    Text(context.t('mob.sitepic.diary.unavailable'), style: text.caption.copyWith(color: context.v2.palette.ink2)),
                  ],
                  if (contractId != null && options.isNotEmpty) ...<Widget>[
                    const SizedBox(height: MachvonV2Space.s12),
                    DropdownButtonFormField<String?>(
                      initialValue: options.any((DiaryOption option) => option.id == _diaryId) ? _diaryId : null,
                      isExpanded: true,
                      decoration: InputDecoration(labelText: context.t('mob.sitepic.diary.label')),
                      items: <DropdownMenuItem<String?>>[
                        DropdownMenuItem<String?>(child: Text(context.t('mob.sitepic.diary.none'))),
                        for (final DiaryOption option in options)
                          DropdownMenuItem<String?>(
                            value: option.id,
                            child: Text(context.t('mob.sitepic.diary.option', <String, Object>{'date': formatDay(option.recordDate), 'no': option.diaryNo}), overflow: TextOverflow.ellipsis),
                          ),
                      ],
                      onChanged: enabled
                          ? (String? id) => setState(() {
                                _diaryId = id;
                                _touched();
                              })
                          : null,
                    ),
                  ],
                  const SizedBox(height: MachvonV2Space.s12),
                  TextField(
                    controller: _caption,
                    readOnly: !enabled,
                    minLines: 2,
                    maxLines: 5,
                    textCapitalization: TextCapitalization.sentences,
                    onChanged: (String _) => setState(() {
                      _problems = const <String, CaptureProblem>{};
                      _touched();
                    }),
                    decoration: InputDecoration(labelText: context.t('mob.sitepic.caption.label'), errorText: _problems['caption'] == null ? null : _problemText(context, _problems['caption']!)),
                  ),
                ],
              ),
              FormSection(
                title: context.t('mob.sitepic.place.title'),
                children: <Widget>[PlaceConsentField(place: _place, enabled: settled, onChanged: _placeChanged)],
              ),
              FormSection(title: context.t('mob.sitepic.flags.title'), children: _flagWidgets(context, flags)),
              _Records(revision: _revision),
            ],
          ),
        ),
        FieldSendBar(
          label: context.t('mob.sitepic.submit.action'),
          onSend: settled ? _save : null,
          sending: _saving,
          offline: offline,
          why: readOnly ? context.t('mob.sitepic.gate.readOnly') : (_sanitizing ? context.t('mob.sitepic.gate.sanitizing') : null),
        ),
      ],
    );
  }

  /// The flags of the capture: what the phone can already tell about the photographs. They are notes for review, never a refusal.
  List<Widget> _flagWidgets(BuildContext context, CaptureFlags flags) {
    final MachvonV2Text text = context.v2text;
    const Widget gap = SizedBox(height: MachvonV2Space.s8);
    return <Widget>[
      if (flags.photos == 0)
        Text(context.t('mob.sitepic.flags.none'), style: text.body)
      else ...<Widget>[
        if (flags.hasAny)
          NoticePanel(
            tone: NoticeTone.warning,
            title: context.t('mob.sitepic.flags.review'),
            lines: <String>[
              if (flags.placeMissing > 0) context.t('mob.sitepic.flags.place', <String, Object>{'count': flags.placeMissing}),
              if (flags.timeMissing > 0) context.t('mob.sitepic.flags.time', <String, Object>{'count': flags.timeMissing}),
              if (flags.duplicates > 0) context.t('mob.sitepic.flags.duplicate', <String, Object>{'count': flags.duplicates}),
            ],
            live: false,
            margin: EdgeInsets.zero,
          ),
        if (!flags.duplicatesChecked) ...<Widget>[
          if (flags.hasAny) gap,
          NoticePanel(tone: NoticeTone.info, title: context.t('mob.sitepic.flags.unchecked'), live: false, margin: EdgeInsets.zero),
        ],
        if (!flags.hasAny && flags.duplicatesChecked) NoticePanel(tone: NoticeTone.ok, title: context.t('mob.sitepic.flags.clear'), live: false, margin: EdgeInsets.zero),
      ],
      gap,
      Text(context.t('mob.sitepic.flags.note'), style: text.caption.copyWith(color: context.v2.palette.ink2)),
    ];
  }
}

// ------------------------------------------------------------------------------------------------------ what is on the phone

class _Records extends ConsumerStatefulWidget {
  const _Records({required this.revision});

  /// Changes when a capture was kept, so the list reads again.
  final int revision;

  @override
  ConsumerState<_Records> createState() => _RecordsState();
}

class _RecordsState extends ConsumerState<_Records> {
  List<StoredCapture> _captures = const <StoredCapture>[];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(_Records oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.revision != widget.revision) _load();
  }

  Future<void> _load() async {
    try {
      final List<StoredCapture> captures = await ref.read(sitePhotoServiceProvider).captures();
      if (mounted) setState(() => _captures = captures);
    } on Object {
      // The store cannot be opened (nobody is signed in): there is nothing of this person to list.
      if (mounted) setState(() => _captures = const <StoredCapture>[]);
    }
  }

  Future<void> _drop(StoredCapture capture) async {
    final bool confirmed = await showConfirmSheet(
      context,
      title: context.t('mob.sitepic.record.drop.title'),
      facts: <String>[context.t('mob.sitepic.record.drop.body')],
      confirmLabel: context.t('mob.sitepic.record.drop.confirm'),
      cancelLabel: context.t('mob.sitepic.record.drop.cancel'),
      destructive: true,
    );
    if (!confirmed) return;
    await ref.read(sitePhotoServiceProvider).drop(capture);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    if (_captures.isEmpty) return const SizedBox.shrink();
    final List<AttachmentUpload> uploads = ref.watch(attachmentUploadsProvider).value ?? const <AttachmentUpload>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const SizedBox(height: MachvonV2Space.s16),
        GroupHeader(title: context.t('mob.sitepic.records.title'), count: _captures.length),
        Padding(
          padding: const EdgeInsets.all(MachvonV2Space.s16),
          child: Text(context.t('mob.sitepic.records.note'), style: context.v2text.caption.copyWith(color: context.v2.palette.ink2)),
        ),
        for (int position = 0; position < _captures.length; position += 1)
          _RecordRow(capture: _captures[position], summary: summaryOf(uploads, _captures[position].record.operationId), first: position == 0, onDrop: () => _drop(_captures[position])),
      ],
    );
  }
}

class _RecordRow extends StatelessWidget {
  const _RecordRow({required this.capture, required this.summary, required this.first, required this.onDrop});

  final StoredCapture capture;
  final UploadSummary summary;
  final bool first;
  final VoidCallback onDrop;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final MachvonV2 v2 = context.v2;
    final PhotoRecord record = capture.record;
    final String upload = summary.total == 0
        ? ''
        : summary.problems > 0
            ? context.t('mob.sitepic.record.upload.problems', <String, Object>{'problems': summary.problems})
            : summary.isDone
                ? context.t('mob.sitepic.record.upload.done', <String, Object>{'total': summary.total})
                : context.t('mob.sitepic.record.upload.waiting', <String, Object>{'clean': summary.clean, 'total': summary.total, 'waiting': summary.waiting});
    final (String state, MachvonTone tone) = summary.problems > 0
        ? (context.t('mob.sitepic.record.state.problems'), MachvonTone.danger)
        : summary.isDone
            ? (context.t('mob.sitepic.record.state.done'), MachvonTone.success)
            : (context.t('mob.sitepic.record.state.waiting'), MachvonTone.info);
    void uploads() => openScreen(context, 'MOB-19', query: <String, String>{'owner': kSitePhotoKind, 'ref': record.operationId}, stacked: true);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        UploadRow(
          title: context.t('mob.sitepic.record.title', <String, Object>{'contract': record.contractCode, 'count': record.photos.length}),
          stateLabel: state,
          tone: tone,
          progress: summary.total == 0 ? null : summary.clean / summary.total,
          progressText: upload.isEmpty ? null : upload,
          dividerAbove: !first,
          actions: <RowAction>[
            if (summary.problems > 0) RowAction(label: context.t('mob.sitepic.record.retry.action'), onPressed: uploads),
            RowAction(label: context.t('mob.sitepic.record.uploads.action'), onPressed: uploads),
            RowAction(label: context.t('mob.sitepic.record.drop.action'), onPressed: onDrop),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(left: MachvonV2Space.s16, right: MachvonV2Space.s16, bottom: MachvonV2Space.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              if (record.diaryDate != null) Text(context.t('mob.sitepic.record.diary', <String, Object>{'date': formatDay(record.diaryDate!)}), style: text.caption.copyWith(color: v2.palette.ink2)),
              if (record.caption.isNotEmpty) Text(record.caption, style: text.body),
              Text(record.place.hasDevicePosition ? context.t('mob.sitepic.record.place.kept') : context.t('mob.sitepic.record.place.none'), style: text.caption.copyWith(color: v2.palette.ink2)),
            ],
          ),
        ),
      ],
    );
  }
}
