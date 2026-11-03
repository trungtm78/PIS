import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/api/problem.dart';
import '../../core/connectivity/reachability.dart';
import '../../core/di/providers.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/session/session.dart';
import '../../core/state/screen_state.dart';
import '../../core/state/state_boundary.dart';
import '../release/telemetry.dart';
import 'amounts.dart';
import 'clock.dart';
import 'loaded.dart';
import 'read_cache.dart';

/// Reads the answer of one operation (or of several: the function decides) as JSON.
typedef ReadAnswer = Future<Object?> Function(MachvonApiClient client);

/// Turns the answer into what the screen shows, or null when the answer lacks what makes a figure citable (the screen then
/// shows a contract mismatch instead of half a page).
typedef ParseAnswer<T> = T? Function(Object? raw);

/// The longest a copy kept on the device is trusted before it is marked out of date. Dashboards and lists change in a day.
const Duration defaultCacheTtl = Duration(hours: 12);

/// A screen's read, with the rules of BR-MOB-01 applied once for every screen:
///
///  * the server is asked first; its answer is kept with its `as_of`;
///  * when the server cannot be reached the kept copy is shown with the moment it describes and a note that it is a copy,
///    marked out of date once it is older than [ttl]; the text never says the data is the newest;
///  * a refusal (the session ended, the right was taken away, the licence ended) never falls back to a copy, and the
///    copy of what was refused is dropped;
///  * the copy belongs to the tenant and the person of the session and to nobody else.
///
/// The states are the eight standard ones of `StateBoundary`; the content is built only when there is data.
class DataView<T> extends ConsumerStatefulWidget {
  const DataView({
    required this.cacheKey,
    required this.read,
    required this.parse,
    required this.builder,
    this.asOf,
    this.isEmpty,
    this.emptyOnCodes = const <String>{},
    this.ttl = defaultCacheTtl,
    this.activeFilters = const <String>[],
    this.onClearFilters,
    this.reloadKey,
    this.keepCopy = true,
    super.key,
  });

  /// Names the read inside the tenant and the person: the screen, its parameters and its filters.
  final String cacheKey;
  final ReadAnswer read;
  final ParseAnswer<T> parse;

  /// The moment the data describes, taken from the parsed value.
  final String? Function(T value)? asOf;
  final bool Function(T value)? isEmpty;

  /// Error codes of the server that mean "there is nothing to show yet" (no snapshot frozen yet) and are drawn as the empty state.
  final Set<String> emptyOnCodes;
  final Duration ttl;
  final List<String> activeFilters;
  final VoidCallback? onClearFilters;

  /// A value that, when it changes, reads again (a decision was made elsewhere and the list must follow).
  final Object? reloadKey;

  /// Whether the answer is kept on the device as a copy for the time the server cannot be reached. A screen of personal data that
  /// is not to be kept (the conversations: MOB.md lets only drafts be offline) passes false: it then has no copy to show, and a lost
  /// connection is the offline state.
  final bool keepCopy;
  final Widget Function(BuildContext context, Loaded<T> data) builder;

  @override
  ConsumerState<DataView<T>> createState() => _DataViewState<T>();
}

class _DataViewState<T> extends ConsumerState<DataView<T>> {
  Loaded<T>? _loaded;
  ProblemView? _problem;
  ScreenState _state = ScreenState.loading;
  bool _refreshing = false;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(DataView<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.cacheKey != widget.cacheKey) {
      _loaded = null;
      _problem = null;
      _load();
    } else if (oldWidget.reloadKey != widget.reloadKey) {
      _load();
    }
  }

  CacheScope? _scope() {
    final SessionSnapshot session = ref.read(sessionProvider);
    final String? tenant = session.tenantId;
    final String? user = session.userId;
    if (!session.isSignedIn || tenant == null || user == null) return null;
    return CacheScope(tenantId: tenant, userId: user);
  }

  Future<void> _load() async {
    final int generation = ++_generation;
    final CacheScope? scope = _scope();
    if (scope == null) {
      _show(generation, state: ScreenState.signedOut, problem: const ProblemView(state: ScreenState.signedOut, code: 'SESSION_EXPIRED'));
      return;
    }
    setState(() {
      _refreshing = _loaded != null;
      if (_loaded == null) _state = ScreenState.loading;
    });
    final ReadCache cache = ref.read(readCacheProvider);
    final DateTime Function() now = ref.read(clockProvider);
    final Stopwatch waited = Stopwatch()..start();
    try {
      final Object? raw = await widget.read(ref.read(apiClientProvider));
      final T? value = widget.parse(raw);
      if (value == null) throw const ContractMismatch('response', 'does not hold what the screen needs');
      ref.read(telemetryProvider).recordListLoaded(waited.elapsed);
      final DateTime fetchedAt = now();
      final String? asOf = widget.asOf?.call(value);
      if (widget.keepCopy) await _remember(cache, scope, CacheEntry(raw: raw, asOf: asOf, fetchedAt: fetchedAt));
      _showData(generation, Loaded<T>(value: value, source: DataSource.network, asOf: asOf, fetchedAt: fetchedAt));
    } on Object catch (error) {
      final ProblemView problem = ProblemView.from(error, reachability: ref.read(reachabilityProvider));
      if (error is ApiError && widget.emptyOnCodes.contains(error.code)) {
        _show(generation, state: ScreenState.empty, problem: problem);
        return;
      }
      if (error is ApiError && error.code == networkErrorCode) {
        final Loaded<T>? copy = widget.keepCopy ? await _copy(cache, scope, now()) : null;
        if (copy != null) {
          _showData(generation, copy);
          return;
        }
      } else if (problem.state == ScreenState.denied || problem.state == ScreenState.signedOut || problem.state == ScreenState.expired) {
        // What the server refused is not kept: a taken-away right leaves nothing on the device.
        await cache.forget(scope, widget.cacheKey);
      }
      _show(generation, state: problem.state, problem: problem);
    }
  }

  /// A copy that cannot be stored costs only the offline copy: the answer on the screen is still true.
  Future<void> _remember(ReadCache cache, CacheScope scope, CacheEntry entry) async {
    try {
      await cache.write(scope, widget.cacheKey, entry);
    } on Object {
      return;
    }
  }

  Future<Loaded<T>?> _copy(ReadCache cache, CacheScope scope, DateTime now) async {
    final CacheEntry? entry = await cache.read(scope, widget.cacheKey);
    if (entry == null) return null;
    final T? value = widget.parse(entry.raw);
    if (value == null) {
      await cache.forget(scope, widget.cacheKey);
      return null;
    }
    return Loaded<T>(
      value: value,
      source: DataSource.cache,
      asOf: entry.asOf,
      fetchedAt: entry.fetchedAt,
      stale: now.difference(entry.fetchedAt) > widget.ttl,
    );
  }

  void _showData(int generation, Loaded<T> data) {
    if (!mounted || generation != _generation) return;
    final bool empty = widget.isEmpty?.call(data.value) ?? false;
    setState(() {
      _loaded = data;
      _problem = null;
      _refreshing = false;
      _state = empty ? ScreenState.empty : ScreenState.defaultState;
    });
  }

  void _show(int generation, {required ScreenState state, required ProblemView problem}) {
    if (!mounted || generation != _generation) return;
    setState(() {
      _problem = problem;
      _state = state;
      _refreshing = false;
    });
  }

  void _sessionChanged(SessionSnapshot? previous, SessionSnapshot next) {
    if (previous?.tenantId == next.tenantId && previous?.userId == next.userId && previous?.status == next.status) return;
    _loaded = null;
    _load();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<SessionSnapshot>(sessionProvider, _sessionChanged);
    final Loaded<T>? data = _loaded;
    final bool showsData = data != null && (_state == ScreenState.defaultState || _state == ScreenState.empty);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (showsData) FreshnessBar(data: data, ttl: widget.ttl, onRefresh: _refreshing ? null : _load),
        if (_refreshing) const _RefreshingBar(),
        Expanded(
          child: StateBoundary(
            state: _state,
            problem: _problem,
            onRetry: _load,
            activeFilters: widget.activeFilters,
            onClearFilters: widget.onClearFilters,
            keepContent: false,
            child: data == null || _state != ScreenState.defaultState ? const SizedBox.shrink() : widget.builder(context, data),
          ),
        ),
      ],
    );
  }
}

class _RefreshingBar extends StatelessWidget {
  const _RefreshingBar();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      label: context.t('mob.read.refreshing.label'),
      child: const LinearProgressIndicator(minHeight: 3),
    );
  }
}

/// Says where the data came from and the moment it describes. A copy kept on the device says so, says the amounts are
/// reference data that cannot be edited, and says when it is out of date. Never says the data is the newest.
class FreshnessBar extends StatelessWidget {
  const FreshnessBar({required this.data, required this.ttl, this.onRefresh, super.key});

  final Loaded<Object?> data;
  final Duration ttl;
  final VoidCallback? onRefresh;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String? asOf = data.asOf;
    final String line;
    if (data.fromCache) {
      line = asOf == null
          ? context.t('mob.read.saved.fetched', <String, Object>{'time': formatFetched(data.fetchedAt)})
          : context.t('mob.read.saved.asOf', <String, Object>{'time': asOfLabel(asOf)});
    } else {
      line = asOf == null
          ? context.t('mob.read.fetched.line', <String, Object>{'time': formatFetched(data.fetchedAt)})
          : context.t('mob.read.asOf.line', <String, Object>{'time': asOfLabel(asOf)});
    }
    final List<String> notes = <String>[
      if (data.fromCache) context.t('mob.read.saved.readOnly'),
      if (data.fromCache && data.stale) context.t('mob.read.stale.line', <String, Object>{'hours': ttl.inHours}),
    ];
    return Semantics(
      container: true,
      liveRegion: data.fromCache,
      child: ColoredBox(
        color: data.fromCache ? MachvonColors.selected : Colors.transparent,
        child: Padding(
          padding: const EdgeInsets.only(left: MachvonSpace.space16, right: MachvonSpace.space4, top: MachvonSpace.space4, bottom: MachvonSpace.space4),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(line, style: theme.textTheme.bodySmall),
                    for (final String note in notes) Text(note, style: theme.textTheme.bodySmall),
                  ],
                ),
              ),
              IconButton(
                onPressed: onRefresh,
                tooltip: context.t('mob.read.refresh.action'),
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The moment the phone got an answer, in Vietnam time.
String formatFetched(DateTime fetchedAt) => asOfLabel(fetchedAt.toUtc().toIso8601String());
