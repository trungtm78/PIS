import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/offline.dart';
import '../../read_support/widgets.dart';
import '../notification_commands.dart';
import '../notification_labels.dart';
import '../preference_models.dart';
import '../push_registration.dart';
import 'device_cards.dart';

/// MOB-34: how the member is reached. For each kind of event the channels (the inbox of a kind that holds an urgent event is
/// locked and says why), how normal messages are sent (at once or in a digest), the quiet hours and the time zone they are in.
/// The whole set is saved under the version the member saw. Saving is online only: the settings are the server's, and a copy
/// of them kept on the device is shown but never saved from. The push state of this device is shown beside them.
Widget buildNotificationPreferencesScreen(BuildContext context, ScreenContext screen) => const NotificationPreferencesScreen();

class NotificationPreferencesScreen extends ConsumerStatefulWidget {
  const NotificationPreferencesScreen({super.key});

  @override
  ConsumerState<NotificationPreferencesScreen> createState() => _PreferencesScreenState();
}

class _PreferencesScreenState extends ConsumerState<NotificationPreferencesScreen> {
  late final NotificationCommands _commands = NotificationCommands(ref.read(apiClientProvider));
  CommandResultView? _result;
  bool _saving = false;

  /// The notice of a save lives here, not in the form: a saved set has a new version, the form is then built again, and the
  /// notice must outlive it.
  Future<void> _save(int version, Map<String, Object?> body) async {
    if (_saving) return;
    setState(() {
      _saving = true;
      _result = null;
    });
    final CommandResultView result = await _commands.savePreferences(version, body);
    if (!mounted) return;
    setState(() {
      _saving = false;
      _result = result;
    });
    if (result.ok) ref.read(notificationsChangedProvider.notifier).bump();
  }

  @override
  Widget build(BuildContext context) {
    final bool offline = isOffline(ref);
    final SessionSnapshot session = ref.watch(sessionProvider);
    return ScreenFrame(
      title: context.t('mob.ntf.pref.title'),
      body: DataView<PreferenceView>(
        cacheKey: 'notifications.preferences',
        reloadKey: ref.watch(notificationsChangedProvider),
        read: (MachvonApiClient client) => client.getMyNotificationPreferences(),
        parse: parsePreferences,
        builder: (BuildContext context, Loaded<PreferenceView> loaded) => _Form(
          key: ValueKey<int>(loaded.value.version),
          view: loaded.value,
          readOnlySession: session.isReadOnly,
          canSave: !offline && !loaded.fromCache && !session.isReadOnly,
          offline: offline || loaded.fromCache,
          saving: _saving,
          result: _result,
          onSave: _save,
        ),
      ),
    );
  }
}

class _Form extends ConsumerStatefulWidget {
  const _Form({required this.view, required this.readOnlySession, required this.canSave, required this.offline, required this.saving, required this.result, required this.onSave, super.key});

  final PreferenceView view;
  final bool readOnlySession;
  final bool canSave;
  final bool offline;
  final bool saving;
  final CommandResultView? result;
  final Future<void> Function(int version, Map<String, Object?> body) onSave;

  @override
  ConsumerState<_Form> createState() => _FormState();
}

class _FormState extends ConsumerState<_Form> {
  late final PreferenceDraft _draft = PreferenceDraft.of(widget.view);
  late final TextEditingController _start = TextEditingController(text: _draft.quietStart);
  late final TextEditingController _end = TextEditingController(text: _draft.quietEnd);
  QuietProblem? _quiet;
  bool _tooMany = false;

  @override
  void dispose() {
    _start.dispose();
    _end.dispose();
    super.dispose();
  }

  void _submit() {
    _draft
      ..quietStart = _start.text.trim()
      ..quietEnd = _end.text.trim();
    final QuietProblem? quiet = quietProblem(_draft);
    final bool tooMany = tooManyItems(_draft);
    setState(() {
      _quiet = quiet;
      _tooMany = tooMany;
    });
    if (quiet == null && !tooMany) widget.onSave(widget.view.version, preferenceBody(_draft));
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final PreferenceView view = widget.view;
    final List<String> rows = <String>[allCategories, ..._draft.categories];
    final List<String> zones = <String>{_draft.timeZone, ...timeZones}.toList();
    final CommandResultView? result = widget.result;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        if (result != null) _Notice(result: result),
        if (view.isDefault)
          Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8), child: Text(context.t('mob.ntf.pref.default'), style: theme.textTheme.bodySmall)),
        const _PushStatus(),
        for (final String category in rows)
          SectionCard(
            title: categoryName(context, category),
            children: <Widget>[
              for (final String channel in preferenceChannels) _ChannelSwitch(draft: _draft, view: view, category: category, channel: channel, enabled: widget.canSave && !widget.saving, onChanged: () => setState(() {})),
              const SizedBox(height: MachvonSpace.space8),
              DropdownButtonFormField<String>(
                initialValue: _draft.digest[category] ?? 'IMMEDIATE',
                isExpanded: true,
                decoration: InputDecoration(labelText: context.t('mob.ntf.pref.digest.label')),
                items: <DropdownMenuItem<String>>[for (final String mode in digestModes) DropdownMenuItem<String>(value: mode, child: Text(digestName(context, mode)))],
                onChanged: widget.canSave && !widget.saving ? (String? mode) => setState(() => _draft.digest[category] = mode ?? 'IMMEDIATE') : null,
              ),
            ],
          ),
        Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16), child: Text(context.t('mob.ntf.pref.digest.hint'), style: theme.textTheme.bodySmall)),
        SectionCard(
          title: context.t('mob.ntf.pref.quiet.title'),
          children: <Widget>[
            Text(context.t('mob.ntf.pref.quiet.hint'), style: theme.textTheme.bodySmall),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(context.t('mob.ntf.pref.quiet.on')),
              value: _draft.quietOn,
              onChanged: widget.canSave && !widget.saving ? (bool on) => setState(() => _draft.quietOn = on) : null,
            ),
            TextField(controller: _start, enabled: widget.canSave && _draft.quietOn && !widget.saving, keyboardType: TextInputType.datetime, decoration: InputDecoration(labelText: context.t('mob.ntf.pref.quiet.start'))),
            const SizedBox(height: MachvonSpace.space8),
            TextField(
              controller: _end,
              enabled: widget.canSave && _draft.quietOn && !widget.saving,
              keyboardType: TextInputType.datetime,
              decoration: InputDecoration(labelText: context.t('mob.ntf.pref.quiet.end'), errorText: _quiet == null ? null : quietProblemText(context, _quiet!)),
            ),
            const SizedBox(height: MachvonSpace.space8),
            DropdownButtonFormField<String>(
              initialValue: _draft.timeZone,
              isExpanded: true,
              decoration: InputDecoration(labelText: context.t('mob.ntf.pref.zone.label')),
              items: <DropdownMenuItem<String>>[for (final String zone in zones) DropdownMenuItem<String>(value: zone, child: Text(zone))],
              onChanged: widget.canSave && !widget.saving ? (String? zone) => setState(() => _draft.timeZone = zone ?? _draft.timeZone) : null,
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              if (_tooMany) Text(context.t('mob.ntf.pref.save.tooMany'), style: theme.textTheme.bodyMedium),
              if (widget.readOnlySession)
                Text(context.t('mob.ntf.pref.readOnly'), style: theme.textTheme.bodyMedium)
              else if (widget.offline)
                Semantics(liveRegion: true, child: Text(context.t('mob.ntf.pref.offline'), style: theme.textTheme.bodyMedium)),
              const SizedBox(height: MachvonSpace.space8),
              FilledButton(onPressed: widget.canSave && !widget.saving ? _submit : null, child: Text(context.t('mob.ntf.pref.save.action'))),
            ],
          ),
        ),
        const PushDevicesCard(),
        const ExternalChannelsCard(),
      ],
    );
  }
}

class _ChannelSwitch extends StatelessWidget {
  const _ChannelSwitch({required this.draft, required this.view, required this.category, required this.channel, required this.enabled, required this.onChanged});

  final PreferenceDraft draft;
  final PreferenceView view;
  final String category;
  final String channel;
  final bool enabled;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final bool locked = view.isLocked(category, channel);
    final bool on = locked || !draft.off.contains(cellKey(category, channel));
    return SwitchListTile(
      contentPadding: EdgeInsets.zero,
      title: Text(channelName(context, channel)),
      subtitle: locked ? Text(context.t('mob.ntf.pref.locked.hint')) : null,
      value: on,
      onChanged: enabled && !locked
          ? (bool value) {
              draft.toggle(category, channel);
              onChanged();
            }
          : null,
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.result});

  final CommandResultView result;

  @override
  Widget build(BuildContext context) {
    final String message = result.ok
        ? context.t('mob.ntf.pref.save.done')
        : preferenceProblemText(context, result.lost ? PreferenceProblem.general : preferenceProblemOf(result.code ?? ''));
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
      child: Padding(padding: const EdgeInsets.all(MachvonSpace.space12), child: Semantics(liveRegion: true, container: true, child: Text(message))),
    );
  }
}

class _PushStatus extends ConsumerWidget {
  const _PushStatus();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FutureBuilder<PushPermission>(
      future: ref.read(pushPlatformProvider).permission(),
      builder: (BuildContext context, AsyncSnapshot<PushPermission> snapshot) {
        final PushPermission permission = snapshot.data ?? PushPermission.unknown;
        final String text;
        switch (permission) {
          case PushPermission.granted:
          case PushPermission.provisional:
            text = context.t('mob.ntf.pref.push.granted');
          case PushPermission.denied:
            text = context.t('mob.ntf.pref.push.denied');
          case PushPermission.unknown:
            text = context.t('mob.ntf.pref.push.unknown');
        }
        return SectionCard(title: context.t('mob.ntf.pref.push.title'), children: <Widget>[Text(text)]);
      },
    );
  }
}
