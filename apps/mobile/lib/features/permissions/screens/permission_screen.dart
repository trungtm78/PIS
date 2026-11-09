import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/deep_link_guard.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/navigation/router.dart' show homeLocation;
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../notification_inbox/push_registration.dart' show pushRegistrationProvider;
import '../permission_providers.dart';
import '../permission_service.dart';

/// MOB-05: the rationale for push notifications, and the place the push state is read (granted, declined, or blocked with a
/// link to the settings of the phone).
Widget buildNotificationPermissionScreen(BuildContext context, ScreenContext screen) => PermissionScreen(
      permissions: const <AppPermission>[AppPermission.notifications],
      returnTo: safeReturnLocation(screen.queryParameters[returnParameter]),
    );

/// MOB-06: the rationale for the camera and the position while the app is in use. `need` (a comma separated list) says which
/// of the two the feature that opened it needs; without it both are explained.
Widget buildCameraLocationPermissionScreen(BuildContext context, ScreenContext screen) {
  final List<AppPermission> needed = <AppPermission>[
    for (final String name in (screen.queryParameters['need'] ?? '').split(','))
      if (name == AppPermission.camera.name) AppPermission.camera else if (name == AppPermission.location.name) AppPermission.location,
  ];
  return PermissionScreen(
    permissions: needed.isEmpty ? const <AppPermission>[AppPermission.camera, AppPermission.location] : needed,
    returnTo: safeReturnLocation(screen.queryParameters[returnParameter]),
  );
}

class PermissionScreen extends ConsumerStatefulWidget {
  const PermissionScreen({required this.permissions, required this.returnTo, super.key});

  final List<AppPermission> permissions;
  final String? returnTo;

  @override
  ConsumerState<PermissionScreen> createState() => _PermissionScreenState();
}

class _PermissionScreenState extends ConsumerState<PermissionScreen> {
  late final AppLifecycleListener _lifecycle;
  Map<AppPermission, PermissionState>? _states;
  ProblemView? _problem;
  ManualLocation? _manualLocation;
  PermissionAlternative? _alternative;

  @override
  void initState() {
    super.initState();
    // The person may come back from the settings of the phone: the state is read again.
    _lifecycle = AppLifecycleListener(onResume: _read);
    _read();
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  Future<void> _read() async {
    try {
      final PermissionService service = ref.read(permissionServiceProvider);
      final Map<AppPermission, PermissionState> read = <AppPermission, PermissionState>{
        for (final AppPermission permission in widget.permissions) permission: await service.status(permission),
      };
      if (mounted) {
        setState(() {
          _states = read;
          _problem = null;
        });
      }
    } on Object catch (error) {
      if (mounted) setState(() => _problem = ProblemView.from(error));
    }
  }

  Future<void> _allow(AppPermission permission) async {
    try {
      final PermissionState answer = await ref.read(permissionServiceProvider).request(permission);
      // Once notifications are allowed the device is registered for push at once, not at the next start.
      if (permission == AppPermission.notifications && answer == PermissionState.granted) unawaited(ref.read(pushRegistrationProvider).sync());
      if (mounted) setState(() => _states = <AppPermission, PermissionState>{...?_states, permission: answer});
    } on Object catch (error) {
      if (mounted) setState(() => _problem = ProblemView.from(error));
    }
  }

  Future<void> _manual() async {
    final ManualLocation? entered = await showDialog<ManualLocation>(context: context, builder: (BuildContext context) => const _ManualLocationDialog());
    if (entered == null || !mounted) return;
    setState(() {
      _manualLocation = entered;
      _alternative = PermissionAlternative.manualLocation;
    });
    _finish();
  }

  void _attach() {
    setState(() => _alternative = PermissionAlternative.attachFile);
    _finish();
  }

  void _finish({bool deferred = false}) {
    final PermissionOutcome outcome = PermissionOutcome(
      states: _states ?? const <AppPermission, PermissionState>{},
      deferred: deferred,
      alternative: _alternative,
      manualLocation: _manualLocation,
    );
    if (context.canPop()) {
      context.pop(outcome);
    } else {
      context.go(widget.returnTo ?? homeLocation);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bool notifications = widget.permissions.length == 1 && widget.permissions.single == AppPermission.notifications;
    final Map<AppPermission, PermissionState>? states = _states;
    final ScreenState state = _problem != null ? ScreenState.error : (states == null ? ScreenState.loading : ScreenState.defaultState);
    final bool allGranted = states != null && states.values.every((PermissionState s) => s == PermissionState.granted);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: StateBoundary(
              state: state,
              problem: _problem,
              onRetry: _read,
              child: ListView(
                padding: const EdgeInsets.all(MachvonSpace.space16),
                children: <Widget>[
                  Semantics(
                    header: true,
                    child: Text(
                      notifications ? context.t('mob.permission.notifications.title') : context.t('mob.permission.screen.title'),
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                  ),
                  const SizedBox(height: MachvonSpace.space12),
                  Text(notifications ? context.t('mob.permission.notifications.body') : context.t('mob.permission.screen.body')),
                  const SizedBox(height: MachvonSpace.space16),
                  for (final AppPermission permission in widget.permissions)
                    _PermissionCard(
                      permission: permission,
                      state: states?[permission] ?? PermissionState.notAsked,
                      onAllow: () => _allow(permission),
                      onSettings: () => ref.read(permissionServiceProvider).openSettings(),
                      onAttach: _attach,
                      onManual: _manual,
                    ),
                  const SizedBox(height: MachvonSpace.space8),
                  if (allGranted)
                    FilledButton(onPressed: _finish, child: Text(context.t('mob.permission.done.action')))
                  else
                    OutlinedButton(onPressed: () => _finish(deferred: true), child: Text(context.t('mob.permission.later.action'))),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PermissionCard extends StatelessWidget {
  const _PermissionCard({
    required this.permission,
    required this.state,
    required this.onAllow,
    required this.onSettings,
    required this.onAttach,
    required this.onManual,
  });

  final AppPermission permission;
  final PermissionState state;
  final VoidCallback onAllow;
  final VoidCallback onSettings;
  final VoidCallback onAttach;
  final VoidCallback onManual;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool granted = state == PermissionState.granted;
    final bool blocked = state == PermissionState.blocked;
    final String status = _statusText(context);
    return Card(
      margin: const EdgeInsets.only(bottom: MachvonSpace.space12),
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Semantics(header: true, child: Text(_title(context), style: theme.textTheme.titleMedium)),
            const SizedBox(height: MachvonSpace.space8),
            Text(_why(context)),
            const SizedBox(height: MachvonSpace.space8),
            Semantics(liveRegion: true, child: Text(status, style: theme.textTheme.labelLarge)),
            if (blocked) ...<Widget>[
              const SizedBox(height: MachvonSpace.space8),
              Text(context.t('mob.permission.settings.hint'), style: theme.textTheme.bodySmall),
            ],
            if (permission == AppPermission.notifications && !granted) ...<Widget>[
              const SizedBox(height: MachvonSpace.space8),
              Text(context.t('mob.permission.notifications.inApp'), style: theme.textTheme.bodySmall),
            ],
            const SizedBox(height: MachvonSpace.space12),
            if (blocked)
              FilledButton(onPressed: onSettings, child: Text(context.t('mob.permission.settings.action')))
            else if (!granted)
              FilledButton(
                onPressed: onAllow,
                child: Text(state == PermissionState.denied ? context.t('mob.permission.again.action') : context.t('mob.permission.allow.action')),
              ),
            if (!granted && permission == AppPermission.camera) ...<Widget>[
              const SizedBox(height: MachvonSpace.space8),
              OutlinedButton(onPressed: onAttach, child: Text(context.t('mob.permission.camera.alternative'))),
            ],
            if (!granted && permission == AppPermission.location) ...<Widget>[
              const SizedBox(height: MachvonSpace.space8),
              OutlinedButton(onPressed: onManual, child: Text(context.t('mob.permission.location.alternative'))),
            ],
          ],
        ),
      ),
    );
  }

  // Each key is written out so the string check can see it is in use.
  String _title(BuildContext context) {
    switch (permission) {
      case AppPermission.notifications:
        return context.t('mob.permission.notifications.title');
      case AppPermission.camera:
        return context.t('mob.permission.camera.title');
      case AppPermission.location:
        return context.t('mob.permission.location.title');
    }
  }

  String _why(BuildContext context) {
    switch (permission) {
      case AppPermission.notifications:
        return context.t('mob.permission.notifications.benefit');
      case AppPermission.camera:
        return context.t('mob.permission.camera.why');
      case AppPermission.location:
        return context.t('mob.permission.location.why');
    }
  }

  String _statusText(BuildContext context) {
    switch (state) {
      case PermissionState.notAsked:
        return context.t('mob.permission.state.notAsked');
      case PermissionState.granted:
        return context.t('mob.permission.state.granted');
      case PermissionState.denied:
        return context.t('mob.permission.state.denied');
      case PermissionState.blocked:
        return context.t('mob.permission.state.blocked');
    }
  }
}

class _ManualLocationDialog extends StatefulWidget {
  const _ManualLocationDialog();

  @override
  State<_ManualLocationDialog> createState() => _ManualLocationDialogState();
}

class _ManualLocationDialogState extends State<_ManualLocationDialog> {
  final TextEditingController _controller = TextEditingController();
  bool _invalid = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _save() {
    final ManualLocation? parsed = ManualLocation.tryParse(_controller.text);
    if (parsed == null) {
      setState(() => _invalid = true);
      return;
    }
    Navigator.of(context).pop(parsed);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(context.t('mob.permission.manual.title')),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(context.t('mob.permission.manual.source')),
            const SizedBox(height: MachvonSpace.space12),
            TextField(
              controller: _controller,
              autofocus: true,
              maxLength: ManualLocation.maxLength,
              decoration: InputDecoration(
                labelText: context.t('mob.permission.manual.label'),
                hintText: context.t('mob.permission.manual.hint'),
                errorText: _invalid ? context.t('mob.permission.manual.invalid') : null,
              ),
              onChanged: (String _) {
                if (_invalid) setState(() => _invalid = false);
              },
            ),
          ],
        ),
      ),
      actions: <Widget>[
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(context.t('mob.permission.manual.cancel.action'))),
        FilledButton(onPressed: _save, child: Text(context.t('mob.permission.manual.save.action'))),
      ],
    );
  }
}
