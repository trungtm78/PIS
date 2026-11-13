import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart' show apiClientProvider;
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/components.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/state_view.dart';
import '../../account/deadline_thresholds.dart';
import '../../command_support/command_outcome.dart';
import '../../read_support/attempts.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../pwf_models.dart';

/// MOB-82: the reminders of the person for their own tasks. The three thresholds (green, yellow, red, in days) and the days on which to be reminded. A
/// personal setting can only remind earlier than the official rule of the unit, never later (R40): a value that is later is refused here first and by
/// the server, and what the server raised to the official level is said. It changes only the colour on "Việc của tôi" and the reminders sent to this
/// person; the official alerts, the escalation and the KPI keep following the rule of the unit.
Widget buildDeadlinePreferenceScreen(BuildContext context, ScreenContext screen) => const PwfDeadlinePreferenceScreen();

class PwfDeadlinePreferenceScreen extends StatefulWidget {
  const PwfDeadlinePreferenceScreen({super.key});

  @override
  State<PwfDeadlinePreferenceScreen> createState() => _PwfDeadlinePreferenceScreenState();
}

class _PwfDeadlinePreferenceScreenState extends State<PwfDeadlinePreferenceScreen> {
  int _reload = 0;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.pwf.pref.title'),
      body: DataView<PwfPreference>(
        cacheKey: 'pwf.preference',
        read: (MachvonApiClient client) => client.getDeadlinePreference(),
        parse: parsePwfPreference,
        reloadKey: _reload,
        builder: (BuildContext context, Loaded<PwfPreference> loaded) => PwfPreferenceForm(preference: loaded.value, readOnly: loaded.fromCache, onSaved: () => setState(() => _reload += 1)),
      ),
    );
  }
}

/// What a form of thresholds lacks before anything is sent. The server judges the same again.
enum PwfPreferenceProblem { notNumbers, notDescending, notEarlier, reminders }

/// The thresholds as the person typed them; a blank is "no setting of my own" (the official one applies).
({int? green, int? yellow, int? red})? parseThresholds(String green, String yellow, String red) {
  int? one(String value) => value.trim().isEmpty ? null : int.tryParse(value.trim());
  final int? g = one(green);
  final int? y = one(yellow);
  final int? r = one(red);
  if ((green.trim().isNotEmpty && g == null) || (yellow.trim().isNotEmpty && y == null) || (red.trim().isNotEmpty && r == null)) return null;
  return (green: g, yellow: y, red: r);
}

/// The reminder days written as `5, 2, 0, -1`; null when something in the text is not a whole number.
List<int>? parseReminderDays(String text) {
  if (text.trim().isEmpty) return <int>[];
  final List<int> days = <int>[];
  for (final String part in text.split(RegExp(r'[,;\s]+'))) {
    if (part.isEmpty) continue;
    final int? value = int.tryParse(part);
    if (value == null) return null;
    days.add(value);
  }
  return days;
}

/// What is wrong with the thresholds against the official ones, or null: green above yellow above red (the last at least -1), and each one the same as
/// or earlier than the official one (more days left).
PwfPreferenceProblem? checkThresholds(({int? green, int? yellow, int? red}) own, PwfThresholds? official) {
  final int? yellow = own.yellow ?? official?.yellow;
  final int? red = own.red ?? official?.red;
  final int? green = own.green ?? official?.green;
  if (yellow != null && red != null && !(yellow > red && red >= -1)) return PwfPreferenceProblem.notDescending;
  if (green != null && yellow != null && green <= yellow) return PwfPreferenceProblem.notDescending;
  if (official != null) {
    if (own.yellow != null && own.yellow! < official.yellow) return PwfPreferenceProblem.notEarlier;
    if (own.red != null && own.red! < official.red) return PwfPreferenceProblem.notEarlier;
    if (own.green != null && official.green != null && own.green! < official.green!) return PwfPreferenceProblem.notEarlier;
  }
  return null;
}

class PwfPreferenceForm extends ConsumerStatefulWidget {
  const PwfPreferenceForm({required this.preference, required this.onSaved, this.readOnly = false, super.key});

  final PwfPreference preference;
  final VoidCallback onSaved;

  /// A copy kept on the device: the settings are shown but not changed (the version a change needs is the server's).
  final bool readOnly;

  @override
  ConsumerState<PwfPreferenceForm> createState() => _PwfPreferenceFormState();
}

class _PwfPreferenceFormState extends ConsumerState<PwfPreferenceForm> {
  late final TextEditingController _green = TextEditingController(text: widget.preference.green?.toString() ?? '');
  late final TextEditingController _yellow = TextEditingController(text: widget.preference.yellow?.toString() ?? '');
  late final TextEditingController _red = TextEditingController(text: widget.preference.red?.toString() ?? '');
  late final TextEditingController _reminders = TextEditingController(text: widget.preference.reminderDays.join(', '));
  final AttemptRegistry _attempts = AttemptRegistry();
  bool _sending = false;
  String? _result;
  bool _resultIsProblem = false;

  @override
  void dispose() {
    _green.dispose();
    _yellow.dispose();
    _red.dispose();
    _reminders.dispose();
    super.dispose();
  }

  PwfPreferenceProblem? _problem() {
    final ({int? green, int? yellow, int? red})? own = parseThresholds(_green.text, _yellow.text, _red.text);
    if (own == null) return PwfPreferenceProblem.notNumbers;
    if (parseReminderDays(_reminders.text) == null) return PwfPreferenceProblem.reminders;
    return checkThresholds(own, widget.preference.official);
  }

  Future<void> _save() async {
    final PwfPreferenceProblem? problem = _problem();
    if (problem != null || _sending) {
      setState(() {
        _result = null;
        _resultIsProblem = false;
      });
      return;
    }
    final ({int? green, int? yellow, int? red}) own = parseThresholds(_green.text, _yellow.text, _red.text)!;
    final List<int> reminders = parseReminderDays(_reminders.text)!;
    setState(() => _sending = true);
    final CommandOutcome outcome = await sendCommand(
      isOnline: () => ref.read(reachabilityProvider) != Reachability.offline,
      attempts: _attempts,
      intention: '${widget.preference.version}|${own.green}|${own.yellow}|${own.red}|${reminders.join(',')}',
      call: (CommandAttempt attempt) => ref.read(apiClientProvider).setDeadlinePreference(
            PwfDeadlinePreference(greenDays: own.green, yellowDays: own.yellow, redDays: own.red, reminderDays: reminders),
            ifMatchVersion: widget.preference.version,
            attempt: attempt,
          ),
    );
    if (!mounted) return;
    final (String, bool) said = switch (outcome) {
      CommandDone() => (context.t('mob.pwf.pref.saved'), false),
      CommandOffline() => (context.t('mob.pwf.pref.offline'), true),
      CommandUnknown() => (context.t('mob.pwf.pref.unknown'), true),
      CommandRefused(:final String code) => (_refusal(context, code), true),
    };
    setState(() {
      _sending = false;
      _result = said.$1;
      _resultIsProblem = said.$2;
    });
    if (outcome is CommandDone) ref.invalidate(deadlineThresholdsProvider);
    if (outcome is CommandDone || (outcome is CommandRefused && outcome.code == 'VERSION_CONFLICT')) widget.onSaved();
  }

  String _refusal(BuildContext context, String code) => switch (code) {
        'DEADLINE_PERSONAL_NOT_EARLIER' => context.t('mob.pwf.pref.problem.notEarlier'),
        'DEADLINE_BAND_THRESHOLDS_INVALID' => context.t('mob.pwf.pref.problem.notDescending'),
        'VERSION_CONFLICT' => context.t('mob.pwf.pref.versionConflict'),
        _ => context.t('mob.pwf.pref.failed', <String, Object>{'code': code}),
      };

  String? _problemText(BuildContext context, PwfPreferenceProblem? problem) => switch (problem) {
        null => null,
        PwfPreferenceProblem.notNumbers => context.t('mob.pwf.pref.problem.notNumbers'),
        PwfPreferenceProblem.notDescending => context.t('mob.pwf.pref.problem.notDescending'),
        PwfPreferenceProblem.notEarlier => context.t('mob.pwf.pref.problem.notEarlier'),
        PwfPreferenceProblem.reminders => context.t('mob.pwf.pref.problem.reminders'),
      };

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final PwfThresholds? official = widget.preference.official;
    final PwfPreferenceProblem? problem = _problem();
    final bool locked = widget.readOnly || _sending;
    final ({int? green, int? yellow, int? red})? own = parseThresholds(_green.text, _yellow.text, _red.text);
    final int? red = own?.red ?? official?.red;
    final int? yellow = own?.yellow ?? official?.yellow;
    final int? green = own?.green ?? official?.green;
    return ListView(
      padding: const EdgeInsets.all(MachvonV2Space.s16),
      children: <Widget>[
        StatusBanner(text: context.t('mob.pwf.pref.note'), icon: Icons.info_outline),
        const SizedBox(height: MachvonV2Space.s12),
        if (widget.preference.clamped.isNotEmpty) ...<Widget>[
          StatusBanner(text: context.t('mob.pwf.pref.clamped'), tone: BannerTone.warning, icon: Icons.warning_amber_outlined),
          const SizedBox(height: MachvonV2Space.s12),
        ],
        if (official != null && official.green != null)
          Text(context.t('mob.pwf.pref.official', <String, Object>{'green': official.green!, 'yellow': official.yellow, 'red': official.red}), style: text.caption)
        else if (official != null)
          Text(context.t('mob.pwf.pref.officialOpen', <String, Object>{'yellow': official.yellow, 'red': official.red}), style: text.caption),
        const SizedBox(height: MachvonV2Space.s8),
        TextField(controller: _green, keyboardType: TextInputType.number, readOnly: locked, onChanged: (String _) => setState(() {}), decoration: InputDecoration(labelText: context.t('mob.pwf.pref.green'))),
        const SizedBox(height: MachvonV2Space.s8),
        TextField(controller: _yellow, keyboardType: TextInputType.number, readOnly: locked, onChanged: (String _) => setState(() {}), decoration: InputDecoration(labelText: context.t('mob.pwf.pref.yellow'))),
        const SizedBox(height: MachvonV2Space.s8),
        TextField(controller: _red, keyboardType: const TextInputType.numberWithOptions(signed: true), readOnly: locked, onChanged: (String _) => setState(() {}), decoration: InputDecoration(labelText: context.t('mob.pwf.pref.red'))),
        const SizedBox(height: MachvonV2Space.s8),
        TextField(controller: _reminders, readOnly: locked, onChanged: (String _) => setState(() {}), decoration: InputDecoration(labelText: context.t('mob.pwf.pref.reminders'), helperText: context.t('mob.pwf.pref.reminders.help'))),
        const SizedBox(height: MachvonV2Space.s16),
        Semantics(header: true, child: Text(context.t('mob.pwf.pref.preview'), style: text.heading)),
        const SizedBox(height: MachvonV2Space.s8),
        if (problem != null || red == null || yellow == null)
          Text(_problemText(context, problem) ?? context.t('mob.pwf.pref.preview.none'), style: text.body.copyWith(color: v2.palette.lateFg))
        else ...<Widget>[
          Text(context.t('mob.pwf.pref.preview.red', <String, Object>{'days': red}), style: text.body),
          Text(context.t('mob.pwf.pref.preview.yellow', <String, Object>{'from': red + 1, 'to': yellow}), style: text.body),
          if (green != null) Text(context.t('mob.pwf.pref.preview.green', <String, Object>{'from': yellow + 1, 'to': green}), style: text.body) else Text(context.t('mob.pwf.pref.preview.greenOpen', <String, Object>{'days': yellow}), style: text.body),
        ],
        const SizedBox(height: MachvonV2Space.s16),
        if (_result != null) StatusBanner(text: _result!, tone: _resultIsProblem ? BannerTone.warning : BannerTone.info, icon: _resultIsProblem ? Icons.error_outline : Icons.check_circle_outline),
        if (widget.readOnly) Padding(padding: const EdgeInsets.only(bottom: MachvonV2Space.s8), child: Text(context.t('mob.pwf.pref.readOnly'), style: text.caption)),
        FilledButton(onPressed: locked || problem != null ? null : _save, style: v2PrimaryButtonStyle(v2), child: Text(_sending ? context.t('mob.pwf.pref.saving') : context.t('mob.pwf.pref.save'), textAlign: TextAlign.center)),
        const SizedBox(height: MachvonV2Space.s8),
        OutlinedButton(
          onPressed: locked
              ? null
              : () {
                  _green.clear();
                  _yellow.clear();
                  _red.clear();
                  _reminders.clear();
                  setState(() {});
                },
          style: v2QuietButtonStyle(v2),
          child: Text(context.t('mob.pwf.pref.reset'), textAlign: TextAlign.center),
        ),
      ],
    );
  }
}
