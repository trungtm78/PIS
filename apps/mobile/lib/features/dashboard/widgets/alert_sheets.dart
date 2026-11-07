import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../read_support/moment.dart';

/// "Nhắc lại sau": an hour, tomorrow morning, or a day the person picks. Returns the instant (ISO 8601, UTC), or null when the
/// sheet was closed. Reminding later does not change the due day of the business and does not stop the escalation.
Future<String?> showSnoozeSheet(BuildContext context, {required DateTime now}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (BuildContext sheet) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Semantics(header: true, child: Text(sheet.t('mob.alert.snooze.sheet.title'), style: Theme.of(sheet).textTheme.titleMedium)),
            const SizedBox(height: MachvonSpace.space4),
            Text(sheet.t('mob.alert.snooze.sheet.note'), style: Theme.of(sheet).textTheme.bodySmall),
            const SizedBox(height: MachvonSpace.space8),
            ListTile(
              minTileHeight: 48,
              leading: const Icon(Icons.schedule),
              title: Text(sheet.t('mob.alert.snooze.hour.option')),
              onTap: () => Navigator.of(sheet).pop(now.toUtc().add(const Duration(hours: 1)).toIso8601String()),
            ),
            ListTile(
              minTileHeight: 48,
              leading: const Icon(Icons.wb_sunny_outlined),
              title: Text(sheet.t('mob.alert.snooze.tomorrow.option')),
              onTap: () => Navigator.of(sheet).pop(_morningAfter(now, 1).toIso8601String()),
            ),
            ListTile(
              minTileHeight: 48,
              leading: const Icon(Icons.event),
              title: Text(sheet.t('mob.alert.snooze.pick.option')),
              onTap: () async {
                final DateTime? day = await showDatePicker(
                  context: sheet,
                  initialDate: now.toUtc().add(vietnamOffset).add(const Duration(days: 2)),
                  firstDate: now.toUtc().add(vietnamOffset).add(const Duration(days: 1)),
                  lastDate: now.toUtc().add(vietnamOffset).add(const Duration(days: 365)),
                );
                if (day != null && sheet.mounted) Navigator.of(sheet).pop(DateTime.utc(day.year, day.month, day.day).toIso8601String());
              },
            ),
            const SizedBox(height: MachvonSpace.space8),
          ],
        ),
      ),
    ),
  );
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
