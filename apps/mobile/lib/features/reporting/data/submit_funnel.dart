import '../../release/telemetry.dart';
import 'submit_flow.dart';

/// The funnel of the submit, counted and never described (TK-MOB-012-4, MOB.md 9): the person tapped Submit, the command waits, its
/// result is unknown, the server accepted it, refused it (with the stable code of the platform) or found the report moved on. An event
/// carries the screen, a stable reason code and a duration measured with a monotonic stopwatch, nothing else: the telemetry service
/// drops any other attribute, so no project, no amount and no name can leave the phone through it.
class SubmitFunnel {
  SubmitFunnel(this._telemetry);

  static const Map<String, Object> _screen = <String, Object>{'screen_id': 'MOB-20'};

  final TelemetryService _telemetry;
  final Stopwatch _since = Stopwatch();
  SubmitStage? _last;

  /// The person tapped Submit.
  void started() {
    _since
      ..reset()
      ..start();
    _telemetry.record('report.submit_started', _screen);
  }

  /// Reports the stage of the sending when it changes; the same stage twice is one event.
  void observe(SubmitStatus status) {
    if (status.stage == _last) return;
    _last = status.stage;
    final String? code = status.code;
    switch (status.stage) {
      case SubmitStage.queued:
        _telemetry.record('report.submit_queued', _screen);
      case SubmitStage.unknown:
        _telemetry.record('report.submit_unknown', _screen);
      case SubmitStage.submitted:
        _telemetry.record('report.submit_accepted', <String, Object>{..._screen, if (_since.isRunning) 'duration_ms': _since.elapsedMilliseconds});
        _since.stop();
      case SubmitStage.rejected:
        _telemetry.record('report.submit_rejected', <String, Object>{..._screen, if (code != null) 'reason_code': code});
      case SubmitStage.conflict:
        _telemetry.record('report.submit_conflict', <String, Object>{..._screen, if (code != null) 'reason_code': code});
      case SubmitStage.idle:
      case SubmitStage.sending:
        break;
    }
  }

}
