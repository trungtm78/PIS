import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show ApiError;
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../read_support/moment.dart';
import '../alert_commands.dart';
import '../alerts.dart';
import '../work_policy.dart';
import 'alert_card.dart';

/// What the person chose for a snooze: until when, the reason code of the policy and the note.
final class SnoozeChoice {
  const SnoozeChoice({required this.until, required this.reasonCode, this.note});

  /// An instant, ISO 8601 in UTC.
  final String until;
  final String reasonCode;
  final String? note;
}

/// The shortest note the server accepts for a reason that needs one.
const int snoozeNoteMinLength = 5;

/// The latest instant a snooze of [item] may end at: the days the policy gives for its level, and never past its business due day
/// (a day, counted to its end in Vietnam, or an instant). Null when the policy gives no cap for the level; [now] when the alert is
/// already late (the server refuses such a snooze). Nothing here is a number of the phone: the days come from [policy].
DateTime? latestSnooze({required AlertItem item, required SnoozePolicyView policy, required DateTime now}) {
  final int? days = policy.maxDaysOf(item.severity);
  if (days == null) return null;
  if (item.overdue) return now;
  DateTime latest = now.toUtc().add(Duration(days: days));
  final String? due = item.dueOn;
  if (due != null) {
    DateTime? limit;
    if (RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(due)) {
      limit = DateTime.utc(int.parse(due.substring(0, 4)), int.parse(due.substring(5, 7)), int.parse(due.substring(8, 10)) + 1).subtract(vietnamOffset);
    } else {
      limit = DateTime.tryParse(due)?.toUtc();
    }
    if (limit != null && limit.isBefore(latest)) latest = limit;
  }
  return latest;
}

/// "Remind me later": the reason (from the policy), a note when the reason needs one, and an hour, tomorrow morning or a day, none
/// longer than the policy allows for the level of the alert. The sheet sends the snooze itself through [send] and stays open on a
/// refusal, saying why; it closes with the choice once the server recorded it, and returns null when it was closed without one.
/// Reminding later does not change the due day of the business and does not stop the escalation.
Future<SnoozeChoice?> showSnoozeSheet(
  BuildContext context, {
  required AlertItem item,
  required DateTime now,
  required Future<WorkActionResult> Function(SnoozeChoice choice) send,
}) {
  return showModalBottomSheet<SnoozeChoice>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (BuildContext sheet) => _SnoozeSheet(item: item, now: now, send: send),
  );
}

enum _Until { hour, tomorrow, day }

class _SnoozeSheet extends ConsumerStatefulWidget {
  const _SnoozeSheet({required this.item, required this.now, required this.send});

  final AlertItem item;
  final DateTime now;
  final Future<WorkActionResult> Function(SnoozeChoice choice) send;

  @override
  ConsumerState<_SnoozeSheet> createState() => _SnoozeSheetState();
}

class _SnoozeSheetState extends ConsumerState<_SnoozeSheet> {
  final TextEditingController _note = TextEditingController();
  String? _reason;
  _Until? _until;
  DateTime? _pickedDay;
  bool _sending = false;
  bool _tried = false;
  String? _failure;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  DateTime get _hour => widget.now.toUtc().add(const Duration(hours: 1));

  DateTime get _tomorrow => _morningAfter(widget.now, 1);

  DateTime? _instant() {
    switch (_until) {
      case _Until.hour:
        return _hour;
      case _Until.tomorrow:
        return _tomorrow;
      case _Until.day:
        return _pickedDay;
      case null:
        return null;
    }
  }

  Future<void> _pickDay(DateTime latest) async {
    final DateTime local = widget.now.toUtc().add(vietnamOffset);
    final DateTime first = DateTime(local.year, local.month, local.day + 1);
    final DateTime utcLatest = latest.toUtc();
    final DateTime last = DateTime(utcLatest.year, utcLatest.month, utcLatest.day);
    if (last.isBefore(first)) return;
    final DateTime? day = await showDatePicker(context: context, initialDate: first, firstDate: first, lastDate: last);
    if (day != null && mounted) {
      setState(() {
        _pickedDay = DateTime.utc(day.year, day.month, day.day);
        _until = _Until.day;
      });
    }
  }

  Future<void> _submit(SnoozePolicyView policy) async {
    if (_sending) return;
    final String? reason = _reason;
    final DateTime? until = _instant();
    final String note = _note.text.trim();
    final bool noteMissing = reason != null && policy.needsNote(reason) && note.length < snoozeNoteMinLength;
    if (reason == null || until == null || noteMissing) {
      setState(() {
        _tried = true;
        _failure = null;
      });
      return;
    }
    setState(() {
      _sending = true;
      _failure = null;
    });
    final SnoozeChoice choice = SnoozeChoice(until: until.toUtc().toIso8601String(), reasonCode: reason, note: note.isEmpty ? null : note);
    final WorkActionResult result = await widget.send(choice);
    if (!mounted) return;
    if (result.ok) {
      Navigator.of(context).pop(choice);
      return;
    }
    setState(() {
      _sending = false;
      _failure = _failureText(context, result);
    });
  }

  String _failureText(BuildContext context, WorkActionResult result) {
    if (result.outcome == WorkActionOutcome.lost) return context.t('mob.alert.action.error.lost');
    switch (snoozeRefusalOf(result)) {
      case SnoozeRefusal.validation:
        return context.t('mob.alert.snooze.error.validation');
      case SnoozeRefusal.notAllowed:
        return context.t('mob.alert.snooze.error.notAllowed');
      case SnoozeRefusal.tooLong:
        return context.t('mob.alert.snooze.error.tooLong');
      case SnoozeRefusal.limit:
        return context.t('mob.alert.snooze.error.limit');
      case SnoozeRefusal.other:
        return context.t('mob.alert.action.error.refused', <String, Object>{'code': result.code ?? ''});
    }
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final AsyncValue<SnoozePolicyView> policy = ref.watch(snoozePolicyProvider);
    final SnoozePolicyView? view = policy.value;
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(MachvonSpace.space16, 0, MachvonSpace.space16, MediaQuery.viewInsetsOf(context).bottom + MachvonSpace.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Semantics(header: true, child: Text(context.t('mob.alert.snooze.sheet.title'), style: theme.textTheme.titleMedium)),
            const SizedBox(height: MachvonSpace.space4),
            Text(context.t('mob.alert.snooze.sheet.note'), style: theme.textTheme.bodySmall),
            const SizedBox(height: MachvonSpace.space8),
            if (view != null)
              ..._form(context, view)
            else if (policy.isLoading)
              Semantics(
                liveRegion: true,
                label: context.t('mob.alert.snooze.policyLoading.label'),
                child: const Padding(padding: EdgeInsets.all(MachvonSpace.space16), child: Center(child: CircularProgressIndicator())),
              )
            else
              _PolicyError(code: _errorCode(policy.error), onRetry: () => ref.invalidate(snoozePolicyProvider)),
            const SizedBox(height: MachvonSpace.space8),
            Row(
              children: <Widget>[
                Expanded(child: OutlinedButton(onPressed: _sending ? null : () => Navigator.of(context).pop(), child: Text(context.t('mob.alert.snooze.cancel.action')))),
                const SizedBox(width: MachvonSpace.space8),
                Expanded(child: _submitButton(context, view)),
              ],
            ),
          ],
        ),
      ),
    );
  }

  String _errorCode(Object? error) => error is ApiError ? error.code : 'UNKNOWN';

  Widget _submitButton(BuildContext context, SnoozePolicyView? policy) {
    final DateTime? latest = policy == null ? null : latestSnooze(item: widget.item, policy: policy, now: widget.now);
    final bool usable = policy != null && latest != null && latest.isAfter(widget.now) && widget.item.snoozesUsed < policy.maxConsecutive;
    return FilledButton(
      onPressed: usable && !_sending ? () => _submit(policy) : null,
      child: _sending
          ? Semantics(
              label: context.t('mob.alert.snooze.sending.label'),
              child: const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
            )
          : Text(context.t('mob.alert.snooze.submit.action')),
    );
  }

  List<Widget> _form(BuildContext context, SnoozePolicyView policy) {
    final ThemeData theme = Theme.of(context);
    final AlertItem item = widget.item;
    final DateTime? latest = latestSnooze(item: item, policy: policy, now: widget.now);
    final int used = item.snoozesUsed;
    final int ordinal = used + 1;
    final bool exhausted = used >= policy.maxConsecutive;
    final bool pastDue = latest != null && !latest.isAfter(widget.now);
    final bool last = !exhausted && ordinal >= policy.maxConsecutive;
    final bool noteNeeded = _reason != null && policy.needsNote(_reason!);
    final int? capDays = policy.maxDaysOf(item.severity);
    bool fits(DateTime instant) => latest != null && !instant.isAfter(latest);
    final bool canPickDay = latest != null && !pastDue && !DateTime.utc(latest.toUtc().year, latest.toUtc().month, latest.toUtc().day).isBefore(DateTime.utc(_firstDay.year, _firstDay.month, _firstDay.day));
    return <Widget>[
      if (latest == null)
        _PolicyError(code: 'CONTRACT_MISMATCH', onRetry: () => ref.invalidate(snoozePolicyProvider))
      else ...<Widget>[
        Text(
          <String>[
            if (!exhausted) context.t('mob.alert.snooze.count.line', <String, Object>{'n': ordinal, 'of': policy.maxConsecutive}),
            context.t('mob.alert.snooze.cap.note', <String, Object>{'level': severityLabel(context, item.severity), 'days': capDays ?? 0}),
          ].join(' · '),
          style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
        ),
        if (exhausted) _Notice(icon: Icons.block, text: context.t('mob.alert.snooze.exhausted.note', <String, Object>{'of': policy.maxConsecutive}), color: MachvonColors.danger),
        if (pastDue && !exhausted) _Notice(icon: Icons.block, text: context.t('mob.alert.snooze.pastDue.note'), color: MachvonColors.danger),
        if (last) _Notice(icon: Icons.warning_amber_rounded, text: policy.finalNotifies ? context.t('mob.alert.snooze.final.warn') : context.t('mob.alert.snooze.finalQuiet.note'), color: MachvonColors.warning),
        const SizedBox(height: MachvonSpace.space8),
        Semantics(header: true, child: Text(context.t('mob.alert.snooze.reason.title'), style: theme.textTheme.labelLarge)),
        for (final String code in policy.reasons)
          _ChoiceTile(
            key: ValueKey<String>('snooze-reason-$code'),
            icon: _reason == code ? Icons.radio_button_checked : Icons.radio_button_unchecked,
            label: snoozeReasonLabel(context, code),
            selected: _reason == code,
            enabled: !_sending && !exhausted && !pastDue,
            onTap: () => setState(() => _reason = code),
          ),
        if (_tried && _reason == null) _FieldError(text: context.t('mob.alert.snooze.reason.error')),
        if (noteNeeded) ...<Widget>[
          const SizedBox(height: MachvonSpace.space4),
          TextField(
            controller: _note,
            maxLength: 500,
            minLines: 1,
            maxLines: 3,
            enabled: !_sending,
            decoration: InputDecoration(
              labelText: context.t('mob.alert.snooze.note.label'),
              helperText: context.t('mob.alert.snooze.note.help'),
              errorText: _tried && _note.text.trim().length < snoozeNoteMinLength ? context.t('mob.alert.snooze.note.error') : null,
            ),
            onChanged: (String _) => setState(() {}),
          ),
        ],
        const SizedBox(height: MachvonSpace.space8),
        Semantics(header: true, child: Text(context.t('mob.alert.snooze.duration.title'), style: theme.textTheme.labelLarge)),
        _ChoiceTile(
          icon: Icons.schedule,
          label: context.t('mob.alert.snooze.hour.option'),
          selected: _until == _Until.hour,
          enabled: !_sending && !exhausted && fits(_hour),
          hint: fits(_hour) ? null : context.t('mob.alert.snooze.tooLong.hint'),
          onTap: () => setState(() => _until = _Until.hour),
        ),
        _ChoiceTile(
          icon: Icons.wb_sunny_outlined,
          label: context.t('mob.alert.snooze.tomorrow.option'),
          selected: _until == _Until.tomorrow,
          enabled: !_sending && !exhausted && fits(_tomorrow),
          hint: fits(_tomorrow) ? null : context.t('mob.alert.snooze.tooLong.hint'),
          onTap: () => setState(() => _until = _Until.tomorrow),
        ),
        _ChoiceTile(
          icon: Icons.event,
          label: _pickedDay == null ? context.t('mob.alert.snooze.pick.option') : context.t('mob.alert.snooze.picked.option', <String, Object>{'date': formatDay(_dayText(_pickedDay!))}),
          selected: _until == _Until.day,
          enabled: !_sending && !exhausted && canPickDay,
          hint: canPickDay ? null : context.t('mob.alert.snooze.tooLong.hint'),
          onTap: () => _pickDay(latest),
        ),
        if (_tried && _until == null) _FieldError(text: context.t('mob.alert.snooze.duration.error')),
      ],
      if (_failure != null) _FieldError(text: _failure!),
    ];
  }

  DateTime get _firstDay {
    final DateTime local = widget.now.toUtc().add(vietnamOffset);
    return DateTime(local.year, local.month, local.day + 1);
  }

  String _dayText(DateTime day) => '${day.year.toString().padLeft(4, '0')}-${day.month.toString().padLeft(2, '0')}-${day.day.toString().padLeft(2, '0')}';
}

/// A choice of a list (a reason, a time): an icon that shows whether it is picked, the words, and a reason when it cannot be.
class _ChoiceTile extends StatelessWidget {
  const _ChoiceTile({required this.icon, required this.label, required this.selected, required this.enabled, required this.onTap, this.hint, super.key});

  final IconData icon;
  final String label;
  final bool selected;
  final bool enabled;
  final String? hint;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      inMutuallyExclusiveGroup: true,
      child: ListTile(
        minTileHeight: 48,
        contentPadding: EdgeInsets.zero,
        leading: Icon(icon),
        title: Text(label),
        subtitle: hint == null ? null : Text(hint!),
        selected: selected,
        enabled: enabled,
        onTap: enabled ? onTap : null,
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.text, required this.color});

  final IconData icon;
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      container: true,
      child: Padding(
        padding: const EdgeInsets.only(top: MachvonSpace.space4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            ExcludeSemantics(child: Icon(icon, size: 18, color: color)),
            const SizedBox(width: MachvonSpace.space8),
            Expanded(child: Text(text, style: Theme.of(context).textTheme.bodyMedium)),
          ],
        ),
      ),
    );
  }
}

class _FieldError extends StatelessWidget {
  const _FieldError({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => _Notice(icon: Icons.error_outline, text: text, color: MachvonColors.danger);
}

class _PolicyError extends StatelessWidget {
  const _PolicyError({required this.code, required this.onRetry});

  final String code;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _Notice(icon: Icons.error_outline, text: context.t('mob.alert.snooze.policy.error', <String, Object>{'code': code}), color: MachvonColors.danger),
        const SizedBox(height: MachvonSpace.space8),
        OutlinedButton(onPressed: onRetry, child: Text(context.t('mob.alert.snooze.policyRetry.action'))),
      ],
    );
  }
}

/// 07:00 in Vietnam, [days] after the day of [now] there; as an instant in UTC.
DateTime _morningAfter(DateTime now, int days) {
  final DateTime local = now.toUtc().add(vietnamOffset);
  return DateTime.utc(local.year, local.month, local.day + days).subtract(vietnamOffset).add(const Duration(hours: 7));
}

/// What the person chose to give the work: who, by which day, and why.
final class AssignChoice {
  const AssignChoice({required this.assigneeId, required this.dueOn, this.reason});

  final String assigneeId;
  final String dueOn;
  final String? reason;
}

/// "Giao cho": the person (by their code) and the day they must be done by. Returns null when closed.
Future<AssignChoice?> showAssignSheet(BuildContext context, {required DateTime now}) {
  return showModalBottomSheet<AssignChoice>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (BuildContext sheet) => _AssignSheet(now: now),
  );
}

class _AssignSheet extends StatefulWidget {
  const _AssignSheet({required this.now});

  final DateTime now;

  @override
  State<_AssignSheet> createState() => _AssignSheetState();
}

class _AssignSheetState extends State<_AssignSheet> {
  final TextEditingController _assignee = TextEditingController();
  final TextEditingController _reason = TextEditingController();
  int _days = 3;
  bool _missing = false;

  @override
  void dispose() {
    _assignee.dispose();
    _reason.dispose();
    super.dispose();
  }

  String _dayAfter(int days) {
    final DateTime local = widget.now.toUtc().add(vietnamOffset).add(Duration(days: days));
    return '${local.year.toString().padLeft(4, '0')}-${local.month.toString().padLeft(2, '0')}-${local.day.toString().padLeft(2, '0')}';
  }

  void _submit() {
    final String assignee = _assignee.text.trim();
    if (assignee.isEmpty) {
      setState(() => _missing = true);
      return;
    }
    final String reason = _reason.text.trim();
    Navigator.of(context).pop(AssignChoice(assigneeId: assignee, dueOn: _dayAfter(_days), reason: reason.isEmpty ? null : reason));
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(MachvonSpace.space16, 0, MachvonSpace.space16, MediaQuery.viewInsetsOf(context).bottom + MachvonSpace.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Semantics(header: true, child: Text(context.t('mob.alert.assign.sheet.title'), style: Theme.of(context).textTheme.titleMedium)),
            const SizedBox(height: MachvonSpace.space12),
            TextField(
              controller: _assignee,
              textInputAction: TextInputAction.next,
              decoration: InputDecoration(
                labelText: context.t('mob.alert.assign.person.label'),
                helperText: context.t('mob.alert.assign.person.help'),
                errorText: _missing ? context.t('mob.alert.assign.person.error') : null,
              ),
              onChanged: (String _) {
                if (_missing) setState(() => _missing = false);
              },
            ),
            const SizedBox(height: MachvonSpace.space12),
            Text(context.t('mob.alert.assign.due.label'), style: Theme.of(context).textTheme.labelLarge),
            Wrap(
              spacing: MachvonSpace.space8,
              children: <Widget>[
                for (final int days in const <int>[1, 3, 7])
                  ChoiceChip(
                    label: Text(context.t('mob.alert.assign.due.option', <String, Object>{'days': days, 'date': formatDay(_dayAfter(days))})),
                    selected: _days == days,
                    onSelected: (bool _) => setState(() => _days = days),
                  ),
              ],
            ),
            const SizedBox(height: MachvonSpace.space12),
            TextField(
              controller: _reason,
              maxLength: 500,
              decoration: InputDecoration(labelText: context.t('mob.alert.assign.reason.label')),
            ),
            const SizedBox(height: MachvonSpace.space8),
            Row(
              children: <Widget>[
                Expanded(child: OutlinedButton(onPressed: () => Navigator.of(context).pop(), child: Text(context.t('mob.alert.assign.cancel.action')))),
                const SizedBox(width: MachvonSpace.space8),
                Expanded(child: FilledButton(onPressed: _submit, child: Text(context.t('mob.alert.assign.submit.action')))),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
