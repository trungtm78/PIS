import 'dart:async';

import 'package:machvon_api_client/machvon_api_client.dart' show networkErrorCode;

import 'attachment_upload.dart';
import 'attachment_uploader.dart';

/// A file that waits for one of these waits for something outside the uploader (the network, a sign-in, a registration), and
/// is resumed when that arrives, not on a timer.
const Set<String> _outsideCauses = <String>{networkErrorCode, 'SESSION_EXPIRED', kNoDevice};

/// Starts a timer; tests plug in their own so that no real time passes.
typedef UploadTimerFactory = Timer Function(Duration delay, void Function() callback);

/// Keeps the uploads of an [AttachmentUploader] moving: it resumes them when started, when told that the network is back
/// ([trigger]) and, for a file that waits for the server (a busy server, a scan that is not finished), after [retryAfter]. A
/// phone without a network does not wake itself: the connectivity change is what resumes.
class UploadRunner {
  UploadRunner(this._uploader, {UploadTimerFactory? timer, this.retryAfter = const Duration(seconds: 30)}) : _timer = timer ?? Timer.new;

  final AttachmentUploader _uploader;
  final UploadTimerFactory _timer;
  final Duration retryAfter;
  Timer? _wake;
  StreamSubscription<void>? _arrivals;
  bool _running = false;
  bool _again = false;
  bool _disposed = false;
  Future<void> _current = Future<void>.value();

  void start() {
    // A file added while the application is open is sent without waiting for a connectivity change.
    _arrivals = _uploader.arrivals.listen((void _) => trigger());
    trigger();
  }

  void trigger() {
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
    if (_uploader.uploads().any(_waitsOnTheServer)) _wake = _timer(retryAfter, trigger);
  }

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
