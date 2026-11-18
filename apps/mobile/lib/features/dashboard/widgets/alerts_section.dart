import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/session/session.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../read_support/clock.dart';
import '../../read_support/wire.dart';
import '../alerts.dart';
import 'alert_list.dart';

/// The alerts of the person as a block of their own, for a screen that is not the home (MOB-32): it reads `getMyWork` by itself,
/// shows the skeleton while it waits (never a 0), names the failing source with a retry in place, and reads again when an alert
/// changed here or a push arrived. It keeps no copy: without a connection it says so instead of showing what may be old.
///
/// With [scope] it is the list the block "Việc trong phạm vi quản lý" of the leader home leads to: the work of the whole scope the reader manages
/// (`view=scope`), under that title, never mixed up with the reader's own. When [onScope] is given a pair of chips says which of the two lists is
/// shown and leads to the other ("Việc của tôi"). A reader the server refuses the scope gets their own work and is told so.
///
/// The list belongs to the session it was read under (the person, the tenant and the membership). The shell keeps this screen while the person
/// switches organisation or another person signs in, so on any change of that identity the rows are dropped at once, an answer still on its way
/// for the session that ended is ignored when it arrives, and the list is read again only while somebody is signed in.
class AlertsSection extends ConsumerStatefulWidget {
  const AlertsSection({this.limit = 20, this.scope = false, this.onScope, super.key});

  final int limit;

  /// The work of the scope the reader manages, not the reader's own.
  final bool scope;

  /// Chooses between the reader's own work (false) and the work of the scope (true); null draws no choice.
  final ValueChanged<bool>? onScope;

  @override
  ConsumerState<AlertsSection> createState() => _AlertsSectionState();
}

class _AlertsSectionState extends ConsumerState<AlertsSection> {
  AlertFeed? _feed;
  String? _error;
  DateTime? _fetchedAt;
  bool _scopeRefused = false;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(AlertsSection oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.scope == widget.scope) return;
    // Another list: the rows of the one that was shown are never left under the title of the other.
    _feed = null;
    _error = null;
    _scopeRefused = false;
    _load();
  }

  /// Who the list is of: null when nobody is signed in.
  ({String? tenantId, String? userId, String? membershipId})? _identityOf(SessionSnapshot session) =>
      session.isSignedIn ? (tenantId: session.tenantId, userId: session.userId, membershipId: session.membershipId) : null;

  void _sessionChanged(SessionSnapshot? previous, SessionSnapshot next) {
    if (previous != null && _identityOf(previous) == _identityOf(next)) return;
    // Nothing of the session that ended stays on the screen, not even while the new list is on its way.
    _generation += 1;
    setState(() {
      _feed = null;
      _error = null;
      _scopeRefused = false;
      _fetchedAt = null;
    });
    _load();
  }

  Future<void> _load() async {
    final int generation = ++_generation;
    final bool scope = widget.scope;
    final ({String? tenantId, String? userId, String? membershipId})? asked = _identityOf(ref.read(sessionProvider));
    // Nobody is signed in: nothing is asked.
    if (asked == null) return;
    // The answer counts only for the read that is the latest and for the session it was asked under.
    bool current() => mounted && generation == _generation && _identityOf(ref.read(sessionProvider)) == asked;
    try {
      final Json raw = await readAlertFeed(ref.read(apiClientProvider), view: scope ? alertViewScope : 'mine', fallbackToMine: scope);
      final AlertFeed? feed = parseAlertFeed(raw);
      if (!current()) return;
      setState(() {
        _feed = feed;
        _error = feed == null ? 'CONTRACT_MISMATCH' : null;
        _scopeRefused = raw['scope_refused'] == true;
        _fetchedAt = ref.read(clockProvider)();
      });
    } on ApiError catch (error) {
      if (!current()) return;
      setState(() {
        _error = error.code;
        if (error.status == 401 || error.status == 403) _feed = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<int>(alertsChangedProvider, (int? previous, int next) => _load());
    ref.listen<SessionSnapshot>(sessionProvider, _sessionChanged);
    // The rows are of the scope only when the scope was asked for and not refused.
    final bool ofScope = widget.scope && !_scopeRefused;
    final Widget panel = AlertsPanel(
      feed: _error != null && _feed == null ? null : _feed,
      errorCode: _feed == null ? _error : null,
      onReload: () {
        setState(() => _error = null);
        _load();
      },
      limit: widget.limit,
      showSeeAll: false,
      fetchedAt: _fetchedAt,
      title: ofScope ? context.t('mob.home.scope.title') : context.t('mob.alert.inbox.title.label'),
      scopeView: ofScope,
      scopeRefused: _scopeRefused,
      // A failed refresh keeps the alerts that were read before and says they may be old.
      stale: _feed != null && _error != null,
    );
    final ValueChanged<bool>? onScope = widget.onScope;
    if (onScope == null) return panel;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Semantics(
          container: true,
          label: context.t('mob.alert.inbox.view.label'),
          child: FilterChips<bool>(
            options: <ChipOption<bool>>[
              ChipOption<bool>(value: false, label: context.t('mob.alert.inbox.view.mine')),
              ChipOption<bool>(value: true, label: context.t('mob.alert.inbox.view.scope')),
            ],
            selected: widget.scope,
            onChanged: onScope,
          ),
        ),
        panel,
      ],
    );
  }
}
