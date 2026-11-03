import 'dart:async';

import 'command_queue.dart';
import 'queue_results.dart';

/// Starts a timer; tests plug in their own so that no real time passes.
typedef TimerFactory = Timer Function(Duration delay, void Function() callback);

/// Keeps a [CommandQueue] moving: it flushes when started, when told that the network is back ([trigger]) and when the
/// wait of a command that came back ends. A flush that finds nothing to do ends the loop. A flush that is blocked by the
/// network is tried again by [trigger] (the connectivity or the session changed) and, because the only connectivity signal the
/// application has is the outcome of its own requests, also by a bounded probe: the flush itself is the request that shows the
/// connection is back, so recovery never depends on an unrelated request made by the person.
///
/// The runner never throws into the application: what a flush returned or threw is in [lastResult] and [lastError].
class QueueRunner {
  QueueRunner(
    this._queue, {
    TimerFactory? timer,
    DateTime Function()? clock,
    this.errorRetry = const Duration(seconds: 30),
    this.maxReconciliations = 5,
    this.offlineProbes = const <Duration>[],
    this.maxOfflineProbes = 0,
  })  : _timer = timer ?? Timer.new,
        _clock = clock ?? DateTime.now;

  /// How long to wait before trying again after the server failed or the flush threw.
  final Duration errorRetry;

  /// How many times in a row the runner looks again, on its own, for commands that stayed unknown after a flush that reached the
  /// server (an answer that missed them). A trigger from outside starts the count over.
  final int maxReconciliations;

  /// The waits between the probes of a connection that was lost: each probe that finds it still lost moves to the next wait, and the
  /// last one repeats. A phone without a network wakes itself at most [maxOfflineProbes] times in a row; after that only [trigger]
  /// sends again. Empty (the default of the class) means no probe: the application passes [OfflineProbePolicy.standard].
  final List<Duration> offlineProbes;

  /// How many times in a row the runner probes a lost connection on its own. A trigger from outside starts the count over.
  final int maxOfflineProbes;

  final CommandQueue _queue;
  final TimerFactory _timer;
  final DateTime Function() _clock;
  Timer? _wake;
  StreamSubscription<void>? _arrivals;
  bool _running = false;
  bool _again = false;
  bool _disposed = false;
  int _reconciliations = 0;
  int _offlineProbed = 0;

  FlushResult? lastResult;
  Object? lastError;

  void start() {
    // A command made while the application is open is sent without waiting for a connectivity change.
    _arrivals = _queue.events.where((QueueEvent e) => e.from == null).listen((QueueEvent _) => trigger());
    trigger();
  }

  /// Flushes now (or right after the flush that is running). Called from outside (the network is back, a command was made), it
  /// also starts the count of the reconciliations over.
  void trigger() {
    _reconciliations = 0;
    _offlineProbed = 0;
    _flushNow();
  }

  void _flushNow() {
    if (_disposed) return;
    if (_running) {
      _again = true;
      return;
    }
    unawaited(_run());
  }

  Future<void> _run() async {
    _running = true;
    try {
      do {
        _again = false;
        _wake?.cancel();
        _wake = null;
        try {
          lastResult = await _queue.flush();
          lastError = null;
        } on Object catch (error) {
          lastError = error;
        }
      } while (_again && !_disposed);
    } finally {
      _running = false;
    }
    if (!_disposed) _scheduleWake();
  }

  /// Sleeps until the earliest command that waits for its backoff becomes due. When something outside the queue stopped
  /// the flush (no session, no device, a refused device) nothing is scheduled: the session change triggers the next flush.
  /// When no answer arrived (no network) the connection is probed again after a growing wait, at most [maxOfflineProbes]
  /// times in a row. After a failure of the server the
  /// lookups are tried again after [errorRetry]; so are the commands that are still unknown after a flush that reached the
  /// server and got no blocker (the batch answer missed them), at most [maxReconciliations] times in a row.
  void _scheduleWake() {
    final FlushBlocker? blocker = lastResult?.blocker;
    if (lastError != null) {
      _wake = _timer(errorRetry, _flushNow);
      return;
    }
    if (blocker == FlushBlocker.serverError) {
      _wake = _timer(errorRetry, _flushNow);
      return;
    }
    if (blocker == FlushBlocker.offline) {
      if (_offlineProbed < maxOfflineProbes && offlineProbes.isNotEmpty) {
        final Duration wait = offlineProbes[_offlineProbed < offlineProbes.length ? _offlineProbed : offlineProbes.length - 1];
        _offlineProbed += 1;
        _wake = _timer(wait, _flushNow);
      }
      return;
    }
    _offlineProbed = 0;
    if (blocker != null && blocker != FlushBlocker.busy) return;
    final DateTime? due = _queue.nextDueAt;
    Duration? wait = due == null ? null : _positive(due.difference(_clock()));
    if (_queue.unknownCount == 0) {
      _reconciliations = 0;
    } else if (_reconciliations < maxReconciliations) {
      _reconciliations += 1;
      if (wait == null || errorRetry < wait) wait = errorRetry;
    }
    if (wait != null) _wake = _timer(wait, _flushNow);
  }

  static Duration _positive(Duration wait) => wait.isNegative ? Duration.zero : wait;

  void dispose() {
    _disposed = true;
    _wake?.cancel();
    unawaited(_arrivals?.cancel());
  }
}
