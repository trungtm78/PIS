import 'dart:async';

import 'package:machvon_api_client/machvon_api_client.dart' show networkErrorCode;

import 'attachment_upload.dart';
import 'attachment_uploader.dart';

/// A file that waits for one of these waits for something outside the uploader (the network, a sign-in, a registration), and
/// is resumed when that arrives, not on a timer. The network is the one cause that is also probed, because the only
/// connectivity signal the application has is the outcome of its own requests.
const Set<String> _outsideCauses = <String>{networkErrorCode, 'SESSION_EXPIRED', kNoDevice};

/// Starts a timer; tests plug in their own so that no real time passes.
typedef UploadTimerFactory = Timer Function(Duration delay, void Function() callback);

/// Keeps the uploads of an [AttachmentUploader] moving: it resumes them when started, when told that the network is back
/// ([trigger]) and, for a file that waits for the server (a busy server, a scan that is not finished), after [retryAfter]. A
/// file that waits for the network is resumed by the connectivity change and, because that signal only comes from a request that
/// succeeds, also by a bounded probe: the upload itself is the request that shows the connection is back, so recovery never
/// depends on an unrelated request made by the person.
class UploadRunner {
  UploadRunner(
    this._uploader, {
    UploadTimerFactory? timer,
    this.retryAfter = const Duration(seconds: 30),
    this.offlineProbes = const <Duration>[],
    this.maxOfflineProbes = 0,
  }) : _timer = timer ?? Timer.new;

  final AttachmentUploader _uploader;
  final UploadTimerFactory _timer;
  final Duration retryAfter;

  /// The waits between the probes of a lost connection: each probe that finds it still lost moves to the next wait, the last one
  /// repeats. Empty (the default of the class) means no probe: the application passes [OfflineProbePolicy.standard].
  final List<Duration> offlineProbes;

  /// How many times in a row the runner probes a lost connection on its own; [trigger] from outside starts the count over.
  final int maxOfflineProbes;
  Timer? _wake;
  StreamSubscription<void>? _arrivals;
  bool _running = false;
  bool _again = false;
  bool _disposed = false;
  int _offlineProbed = 0;
  Future<void> _current = Future<void>.value();

  void start() {
    // A file added while the application is open is sent without waiting for a connectivity change.
    _arrivals = _uploader.arrivals.listen((void _) => trigger());
    trigger();
  }

  void trigger() {
    _offlineProbed = 0;
    _resume();
  }

  void _resume() {
    if (_disposed) return;
    if (_running) {
      _again = true;
      return;
    }
    _current = _run();
    unawaited(_current);
  }

  /// Completes when no run is in progress (a run that was asked for while another ran is part of it). A file's real I/O takes real time,
  /// so whoever needs to see the outcome of a trigger waits for this, not for a number of event-loop turns.
  Future<void> get idle async {
    while (_running) {
      await _current;
    }
  }

  Future<void> _run() async {
    _running = true;
    try {
      do {
        _again = false;
        _wake?.cancel();
        _wake = null;
        await _uploader.resumeAll();
      } while (_again && !_disposed);
    } finally {
      _running = false;
    }
    if (_disposed) return;
    final List<AttachmentUpload> uploads = _uploader.uploads();
    Duration? wait = uploads.any(_waitsOnTheServer) ? retryAfter : null;
    if (uploads.any(_waitsOnTheNetwork)) {
      final Duration? probe = _nextProbe();
      if (probe != null && (wait == null || probe < wait)) {
        wait = probe;
        _offlineProbed += 1;
      }
    } else {
      _offlineProbed = 0;
    }
    if (wait != null) _wake = _timer(wait, _resume);
  }

  Duration? _nextProbe() {
    if (_offlineProbed >= maxOfflineProbes || offlineProbes.isEmpty) return null;
    return offlineProbes[_offlineProbed < offlineProbes.length ? _offlineProbed : offlineProbes.length - 1];
  }

  static bool _waitsOnTheNetwork(AttachmentUpload u) => u.state == UploadState.pending && u.errorCode == networkErrorCode;

  /// A file waits on the server, not on the phone, when the server was busy or when the scanner has not given its verdict yet:
  /// nothing outside the uploader announces either, so the runner asks again after [retryAfter].
  static bool _waitsOnTheServer(AttachmentUpload u) =>
      u.state == UploadState.scanning || (u.state == UploadState.pending && u.errorCode != null && !_outsideCauses.contains(u.errorCode));

  void dispose() {
    _disposed = true;
    _wake?.cancel();
    unawaited(_arrivals?.cancel());
  }
}
