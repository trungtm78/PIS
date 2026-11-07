import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../read_support/clock.dart';
import '../alerts.dart';
import 'alert_list.dart';

/// The alerts of the person as a block of their own, for a screen that is not the home (MOB-32): it reads `getMyWork` by itself,
/// shows the skeleton while it waits (never a 0), names the failing source with a retry in place, and reads again when an alert
/// changed here or a push arrived. It keeps no copy: without a connection it says so instead of showing what may be old.
class AlertsSection extends ConsumerStatefulWidget {
  const AlertsSection({this.limit = 20, super.key});

  final int limit;

  @override
  ConsumerState<AlertsSection> createState() => _AlertsSectionState();
}

class _AlertsSectionState extends ConsumerState<AlertsSection> {
  AlertFeed? _feed;
  String? _error;
  DateTime? _fetchedAt;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final int generation = ++_generation;
    try {
      final AlertFeed? feed = parseAlertFeed(await readAlertFeed(ref.read(apiClientProvider)));
      if (!mounted || generation != _generation) return;
      setState(() {
        _feed = feed;
        _error = feed == null ? 'CONTRACT_MISMATCH' : null;
        _fetchedAt = ref.read(clockProvider)();
      });
    } on ApiError catch (error) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _error = error.code;
        if (error.status == 401 || error.status == 403) _feed = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<int>(alertsChangedProvider, (int? previous, int next) => _load());
    return AlertsPanel(
      feed: _error != null && _feed == null ? null : _feed,
      errorCode: _feed == null ? _error : null,
      onReload: () {
        setState(() => _error = null);
        _load();
      },
      limit: widget.limit,
      showSeeAll: false,
      fetchedAt: _fetchedAt,
      title: context.t('mob.alert.inbox.title.label'),
      // A failed refresh keeps the alerts that were read before and says they may be old.
      stale: _feed != null && _error != null,
    );
  }
}
