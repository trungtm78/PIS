import 'dart:async';

import 'command_queue.dart';
import 'queue_results.dart';

/// Starts a timer; tests plug in their own so that no real time passes.
typedef TimerFactory = Timer Function(Duration delay, void Function() callback);

/// Keeps a [CommandQueue] moving: it flushes when started, when told that the network is back ([trigger]) and when the
/// wait of a command that came back ends. A flush that finds nothing to do ends the loop; a flush that is blocked by the
/// network waits for [trigger] instead of polling, so a phone without a network does not wake itself.
///
/// The runner never throws into the application: what a flush returned or threw is in [lastResult] and [lastError].
class QueueRunner {
  QueueRunner(this._queue, {TimerFactory? timer, DateTime Function()? clock, this.errorRetry = const Duration(seconds: 30)})
      : _timer = timer ?? Timer.new,
        _clock = clock ?? DateTime.now;

  /// How long to wait before trying again after the server failed or the flush threw.
  final Duration errorRetry;

  final CommandQueue _queue;
  final TimerFactory _timer;
  final DateTime Function() _clock;
  Timer? _wake;
  StreamSubscription<void>? _arrivals;
  bool _running = false;
  bool _again = false;
  bool _disposed = false;

  FlushResult? lastResult;
  Object? lastError;

  void start() {
    // A command made while the application is open is sent without waiting for a connectivity change.
    _arrivals = _queue.events.where((QueueEvent e) => e.from == null).listen((QueueEvent _) => trigger());
    trigger();
  }

  /// Flushes now (or right after the flush that is running).
  void trigger() {
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
  /// the flush (no network, no session, no device, a refused device) nothing is scheduled: the connectivity or session
  /// change triggers the next flush, so a phone that cannot send does not wake itself. After a failure of the server the
  /// lookups are tried again after [errorRetry].
  void _scheduleWake() {
    final FlushBlocker? blocker = lastResult?.blocker;
    if (lastError != null) {
      _wake = _timer(errorRetry, trigger);
      return;
    }
    if (blocker == FlushBlocker.serverError) {
      _wake = _timer(errorRetry, trigger);
      return;
    }
    if (blocker != null && blocker != FlushBlocker.busy) return;
    final DateTime? due = _queue.nextDueAt;
    if (due == null) return;
    final Duration wait = due.difference(_clock());
    _wake = _timer(wait.isNegative ? Duration.zero : wait, trigger);
  }

  void dispose() {
    _disposed = true;
    _wake?.cancel();
    unawaited(_arrivals?.cancel());
  }
}
