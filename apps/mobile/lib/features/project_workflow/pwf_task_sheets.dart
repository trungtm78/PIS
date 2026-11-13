import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/components.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/filter_chips.dart';
import '../../core/widgets/sheets.dart';
import 'pwf_commands.dart';
import 'pwf_models.dart';

/// The sheets of the work on a task (MOB-79). Each asks for what the command needs, tells what will happen in a few facts and returns what the
/// person decided, or null when they left. Nothing here talks to the server or the queue: the screen does, with the result.

/// A confirmation with an optional (or, for a decision, required) sentence of the person. Returns the sentence ("" when none), or null when the
/// person left. A reason shorter than [minLength] is refused here first; the server judges the same again.
Future<String?> showPwfNoteSheet(
  BuildContext context, {
  required String title,
  required List<String> facts,
  required String confirmLabel,
  required String noteLabel,
  bool noteRequired = false,
  int minLength = 0,
  bool destructive = false,
}) {
  return showActionSheet<String>(
    context,
    title: title,
    builder: (BuildContext sheet) => _NoteSheet(facts: facts, confirmLabel: confirmLabel, noteLabel: noteLabel, noteRequired: noteRequired, minLength: minLength, destructive: destructive),
  );
}

class _NoteSheet extends StatefulWidget {
  const _NoteSheet({required this.facts, required this.confirmLabel, required this.noteLabel, required this.noteRequired, required this.minLength, required this.destructive});

  final List<String> facts;
  final String confirmLabel;
  final String noteLabel;
  final bool noteRequired;
  final int minLength;
  final bool destructive;

  @override
  State<_NoteSheet> createState() => _NoteSheetState();
}

class _NoteSheetState extends State<_NoteSheet> {
  final TextEditingController _note = TextEditingController();
  bool _tried = false;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  String? _problem(BuildContext context) {
    final String value = _note.text.trim();
    if (widget.noteRequired && value.isEmpty) return context.t('mob.pwf.sheet.note.required');
    if (widget.minLength > 0 && value.isNotEmpty && value.length < widget.minLength) return context.t('mob.pwf.sheet.note.short', <String, Object>{'min': widget.minLength});
    if (widget.minLength > 0 && widget.noteRequired && value.length < widget.minLength) return context.t('mob.pwf.sheet.note.short', <String, Object>{'min': widget.minLength});
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String? problem = _tried ? _problem(context) : null;
    final ButtonStyle confirmStyle = widget.destructive
        ? v2PrimaryButtonStyle(v2).copyWith(backgroundColor: WidgetStatePropertyAll<Color>(v2.palette.lateMark), foregroundColor: WidgetStatePropertyAll<Color>(v2.palette.onPrimary))
        : v2PrimaryButtonStyle(v2);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final String fact in widget.facts)
          Padding(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Icon(Icons.check_circle_outline, size: 18, color: v2.palette.primaryStrong)),
                const SizedBox(width: MachvonV2Space.s8),
                Expanded(child: Text(fact, style: text.body)),
              ],
            ),
          ),
        const SizedBox(height: MachvonV2Space.s4),
        TextField(controller: _note, maxLines: 3, maxLength: 500, onChanged: (String _) => setState(() {}), decoration: InputDecoration(labelText: widget.noteLabel, errorText: problem)),
        const SizedBox(height: MachvonV2Space.s8),
        FilledButton(
          onPressed: () {
            setState(() => _tried = true);
            if (_problem(context) == null) Navigator.pop(context, _note.text.trim());
          },
          style: confirmStyle,
          child: Text(widget.confirmLabel, textAlign: TextAlign.center),
        ),
        const SizedBox(height: MachvonV2Space.s8),
        OutlinedButton(onPressed: () => Navigator.pop(context), style: v2QuietButtonStyle(v2), child: Text(context.t('mob.pwf.sheet.cancel'), textAlign: TextAlign.center)),
      ],
    );
  }
}

// ---- Evidence ---------------------------------------------------------------------------------------------------------------------

/// What the person gives as evidence: the kind, what it is for (an item of the checklist, a legal document type or a form of the task), the
/// reference to it and a note. The server needs a reference or a form (`document_id`, `form_template_code` or `external_ref`).
final class PwfEvidenceForm {
  const PwfEvidenceForm({required this.kind, this.itemCode, this.legalDocType, this.formTemplateCode, this.externalRef, this.note});

  final String kind;
  final String? itemCode;
  final String? legalDocType;
  final String? formTemplateCode;
  final String? externalRef;
  final String? note;
}

/// The kinds the person may pick: those the checklist of the task names, and `DOCUMENT` first.
List<String> pwfEvidenceKinds(PwfTaskDetail task, {String? itemCode}) {
  final Set<String> kinds = <String>{'DOCUMENT'};
  for (final PwfChecklistItem item in task.checklist) {
    if (itemCode == null || item.code == itemCode) kinds.addAll(item.evidenceKinds);
  }
  return kinds.toList();
}

Future<PwfEvidenceForm?> showPwfEvidenceSheet(BuildContext context, PwfTaskDetail task, {String? itemCode}) {
  return showActionSheet<PwfEvidenceForm>(
    context,
    title: context.t('mob.pwf.evidence.title'),
    builder: (BuildContext sheet) => _EvidenceSheet(task: task, itemCode: itemCode),
  );
}

class _EvidenceSheet extends StatefulWidget {
  const _EvidenceSheet({required this.task, this.itemCode});

  final PwfTaskDetail task;
  final String? itemCode;

  @override
  State<_EvidenceSheet> createState() => _EvidenceSheetState();
}

class _EvidenceSheetState extends State<_EvidenceSheet> {
  final TextEditingController _reference = TextEditingController();
  final TextEditingController _note = TextEditingController();
  late String _kind = pwfEvidenceKinds(widget.task, itemCode: widget.itemCode).first;
  late String _for = widget.itemCode == null ? '' : 'item:${widget.itemCode}';
  bool _tried = false;

  @override
  void dispose() {
    _reference.dispose();
    _note.dispose();
    super.dispose();
  }

  bool get _isForm => _for.startsWith('form:');

  /// A reference is needed unless the evidence is a form of the task, which is itself the reference.
  bool get _referenceMissing => !_isForm && _reference.text.trim().isEmpty;

  void _send(BuildContext context) {
    setState(() => _tried = true);
    if (_referenceMissing) return;
    String? after(String prefix) => _for.startsWith(prefix) ? _for.substring(prefix.length) : null;
    Navigator.pop(
      context,
      PwfEvidenceForm(
        kind: _kind,
        itemCode: after('item:'),
        legalDocType: after('legal:'),
        formTemplateCode: after('form:'),
        externalRef: _reference.text.trim().isEmpty ? null : _reference.text.trim(),
        note: _note.text.trim().isEmpty ? null : _note.text.trim(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final PwfTaskDetail task = widget.task;
    final List<String> kinds = pwfEvidenceKinds(task, itemCode: widget.itemCode);
    final List<ChipOption<String>> targets = <ChipOption<String>>[
      ChipOption<String>(value: '', label: context.t('mob.pwf.evidence.for.none')),
      if (widget.itemCode == null)
        for (final PwfChecklistItem item in task.checklist) ChipOption<String>(value: 'item:${item.code}', label: item.name)
      else
        for (final PwfChecklistItem item in task.checklist.where((PwfChecklistItem i) => i.code == widget.itemCode)) ChipOption<String>(value: 'item:${item.code}', label: item.name),
      for (final PwfRequirement doc in task.legalDocTypes) ChipOption<String>(value: 'legal:${doc.code}', label: doc.code),
      for (final PwfRequirement form in task.formTemplates) ChipOption<String>(value: 'form:${form.code}', label: form.code),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(context.t('mob.pwf.evidence.kind'), style: text.label),
        FilterChips<String>(options: <ChipOption<String>>[for (final String kind in kinds) ChipOption<String>(value: kind, label: kind)], selected: _kind, onChanged: (String next) => setState(() => _kind = next), padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8)),
        if (targets.length > 1) ...<Widget>[
          Text(context.t('mob.pwf.evidence.for'), style: text.label),
          FilterChips<String>(options: targets, selected: _for, onChanged: (String next) => setState(() => _for = next), padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8)),
        ],
        TextField(
          controller: _reference,
          maxLength: 300,
          onChanged: (String _) => setState(() {}),
          decoration: InputDecoration(labelText: context.t('mob.pwf.evidence.reference'), helperText: context.t('mob.pwf.evidence.reference.help'), errorText: _tried && _referenceMissing ? context.t('mob.pwf.evidence.reference.required') : null),
        ),
        TextField(controller: _note, maxLines: 2, maxLength: 500, decoration: InputDecoration(labelText: context.t('mob.pwf.evidence.note'))),
        Text(context.t('mob.pwf.evidence.files'), style: text.caption),
        const SizedBox(height: MachvonV2Space.s12),
        FilledButton(onPressed: () => _send(context), style: v2PrimaryButtonStyle(v2), child: Text(context.t('mob.pwf.evidence.send'), textAlign: TextAlign.center)),
        const SizedBox(height: MachvonV2Space.s8),
        OutlinedButton(onPressed: () => Navigator.pop(context), style: v2QuietButtonStyle(v2), child: Text(context.t('mob.pwf.sheet.cancel'), textAlign: TextAlign.center)),
      ],
    );
  }
}

// ---- A request for more time or a pause --------------------------------------------------------------------------------------------

/// What the person asks for: "more time" (the delay is from an outside party and is not counted against them once someone else approves it) or a
/// pause, for a reason of at least [kPwfMinReasonLength] characters.
final class PwfExceptionForm {
  const PwfExceptionForm({required this.kind, required this.reason, this.validFrom, this.validTo});

  final String kind;
  final String reason;
  final String? validFrom;
  final String? validTo;
}

/// [today] is the Vietnam day the form starts from (the clock of the phone is only used to offer a default; the server decides every date).
Future<PwfExceptionForm?> showPwfExceptionSheet(BuildContext context, PwfTaskDetail task, {required String today}) {
  return showActionSheet<PwfExceptionForm>(
    context,
    title: context.t('mob.pwf.exception.title'),
    builder: (BuildContext sheet) => _ExceptionSheet(task: task, today: today),
  );
}

class _ExceptionSheet extends StatefulWidget {
  const _ExceptionSheet({required this.task, required this.today});

  final PwfTaskDetail task;
  final String today;

  @override
  State<_ExceptionSheet> createState() => _ExceptionSheetState();
}

class _ExceptionSheetState extends State<_ExceptionSheet> {
  final TextEditingController _reason = TextEditingController();
  String _kind = 'EXTERNAL_DELAY';
  late String _from = widget.today;
  String? _to;
  bool _tried = false;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  bool get _reasonOk => pwfReasonIsLongEnough(_reason.text);
  bool get _rangeOk => _to != null ? _to!.compareTo(_from) >= 0 : _kind == 'PAUSE';

  Future<void> _pick(BuildContext context, {required bool start}) async {
    final DateTime base = DateTime.parse(start ? _from : (_to ?? _from));
    final DateTime? picked = await showDatePicker(context: context, initialDate: base, firstDate: DateTime.parse(widget.today).subtract(const Duration(days: 30)), lastDate: DateTime.parse(widget.today).add(const Duration(days: 730)));
    if (picked == null) return;
    final String value = '${picked.year.toString().padLeft(4, '0')}-${picked.month.toString().padLeft(2, '0')}-${picked.day.toString().padLeft(2, '0')}';
    setState(() => start ? _from = value : _to = value);
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String language = AppStrings.of(context).language;
    final bool delay = _kind == 'EXTERNAL_DELAY';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        FilterChips<String>(
          options: <ChipOption<String>>[
            ChipOption<String>(value: 'EXTERNAL_DELAY', label: context.t('mob.pwf.exception.kind.delay')),
            ChipOption<String>(value: 'PAUSE', label: context.t('mob.pwf.exception.kind.pause')),
          ],
          selected: _kind,
          onChanged: (String next) => setState(() => _kind = next),
          padding: const EdgeInsets.only(bottom: MachvonV2Space.s8),
        ),
        Text(delay ? context.t('mob.pwf.exception.delay.body') : context.t('mob.pwf.exception.pause.body'), style: text.caption),
        const SizedBox(height: MachvonV2Space.s8),
        OutlinedButton(onPressed: () => _pick(context, start: true), style: v2QuietButtonStyle(v2), child: Text(context.t('mob.pwf.exception.from', <String, Object>{'date': formatDay(_from, language: language)}), textAlign: TextAlign.center)),
        const SizedBox(height: MachvonV2Space.s8),
        OutlinedButton(
          onPressed: () => _pick(context, start: false),
          style: v2QuietButtonStyle(v2),
          child: Text(_to == null ? context.t('mob.pwf.exception.to.pick') : context.t('mob.pwf.exception.to', <String, Object>{'date': formatDay(_to!, language: language)}), textAlign: TextAlign.center),
        ),
        if (_tried && !_rangeOk) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(context.t('mob.pwf.exception.range'), style: text.caption.copyWith(color: v2.palette.lateFg))),
        const SizedBox(height: MachvonV2Space.s8),
        TextField(
          controller: _reason,
          maxLines: 3,
          maxLength: 1000,
          onChanged: (String _) => setState(() {}),
          decoration: InputDecoration(labelText: context.t('mob.pwf.exception.reason'), errorText: _tried && !_reasonOk ? context.t('mob.pwf.sheet.note.short', <String, Object>{'min': kPwfMinReasonLength}) : null),
        ),
        const SizedBox(height: MachvonV2Space.s8),
        FilledButton(
          onPressed: () {
            setState(() => _tried = true);
            if (_reasonOk && _rangeOk) Navigator.pop(context, PwfExceptionForm(kind: _kind, reason: _reason.text.trim(), validFrom: _from, validTo: _to));
          },
          style: v2PrimaryButtonStyle(v2),
          child: Text(context.t('mob.pwf.exception.send'), textAlign: TextAlign.center),
        ),
        const SizedBox(height: MachvonV2Space.s8),
        OutlinedButton(onPressed: () => Navigator.pop(context), style: v2QuietButtonStyle(v2), child: Text(context.t('mob.pwf.sheet.cancel'), textAlign: TextAlign.center)),
      ],
    );
  }
}
