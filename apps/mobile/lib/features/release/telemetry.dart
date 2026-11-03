import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/foundation.dart' show FlutterError, FlutterErrorDetails;
import 'package:flutter/widgets.dart' show WidgetsBinding;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session/session.dart';

/// The events the application reports: the health of the application and of the offline queue, counted and never described.
/// An event name outside this list is dropped.
const Set<String> kTelemetryEvents = <String>{
  'app.start',
  'app.crash',
  'session.end',
  'queue.length',
  'queue.unknown_rate',
  'queue.conflict_rate',
  'report.submit_started',
  'report.submit_queued',
  'report.submit_unknown',
  'report.submit_accepted',
  'report.submit_rejected',
  'report.submit_conflict',
  'release.blocked',
  'device.integrity',
  'app.cold_start',
  'list.loaded',
  'command.round_trip',
};

/// The attributes an event may carry, each with the only shape its value may have. A key or a value outside these shapes is
/// dropped: names of people, tokens, e-mail addresses and the content of a record cannot be written in a number, a version, an
/// error type, a screen id or a stable code, so they cannot be sent.
final Map<String, bool Function(Object value)> _attributeRules = <String, bool Function(Object value)>{
  'count': (Object v) => v is int && v >= 0,
  'rate': (Object v) => v is num && v >= 0 && v <= 1,
  'crash_free': (Object v) => v is bool,
  'duration_ms': (Object v) => v is int && v >= 0,
  'app_version': (Object v) => v is String && RegExp(r'^\d+(\.\d+){0,2}(\+\d+)?$').hasMatch(v),
  'platform': (Object v) => v == 'ios' || v == 'android',
  'os_version': (Object v) => v is String && RegExp(r'^\d+(\.\d+){0,2}$').hasMatch(v),
  'error_type': (Object v) => v is String && RegExp(r'^[A-Z][A-Za-z0-9_]{0,63}$').hasMatch(v),
  'screen_id': (Object v) => v is String && RegExp(r'^[A-Z]{2,4}-\d{2}$').hasMatch(v),
  'reason_code': (Object v) => v is String && RegExp(r'^[A-Z][A-Z0-9_]{2,63}$').hasMatch(v),
};

/// The tenant an event is about when nobody is signed in to one.
const String kNoTenant = 'none';

/// One event as it leaves the phone: a name, the tenant it belongs to, and the allowed attributes.
final class TelemetryEvent {
  const TelemetryEvent({required this.name, required this.tenantId, required this.attributes});

  final String name;

  /// Always present: the tenant of the session, or [kNoTenant].
  final String tenantId;
  final Map<String, Object> attributes;

  Map<String, Object> toJson() => <String, Object>{'name': name, 'tenant_id': tenantId, ...attributes};
}

/// Where events go (the monitoring vendor is decided outside the application). Tests and the default keep them in memory.
abstract interface class TelemetrySink {
  void send(TelemetryEvent event);
}

/// Keeps the last [capacity] events in memory; the default until the vendor adapter is chosen.
final class BufferedTelemetrySink implements TelemetrySink {
  BufferedTelemetrySink({this.capacity = 200});

  final int capacity;
  final List<TelemetryEvent> events = <TelemetryEvent>[];

  @override
  void send(TelemetryEvent event) {
    events.add(event);
    if (events.length > capacity) events.removeAt(0);
  }
}

/// Builds the events and enforces what they may hold. It knows the tenant (a UUID the server issued) from the session and
/// nothing else about the person.
class TelemetryService {
  TelemetryService({required TelemetrySink sink, required String? Function() tenantId}) : _sink = sink, _tenantId = tenantId;

  final TelemetrySink _sink;
  final String? Function() _tenantId;

  /// Events dropped because of their name, or an attribute because of its key or value.
  int dropped = 0;

  /// Reports [name] with the attributes that pass the rules. Returns whether the event was sent.
  bool record(String name, [Map<String, Object> attributes = const <String, Object>{}]) {
    if (!kTelemetryEvents.contains(name)) {
      dropped += 1;
      return false;
    }
    final Map<String, Object> allowed = <String, Object>{};
    for (final MapEntry<String, Object> entry in attributes.entries) {
      final bool Function(Object value)? rule = _attributeRules[entry.key];
      if (rule != null && rule(entry.value)) {
        allowed[entry.key] = entry.value;
      } else {
        dropped += 1;
      }
    }
    _sink.send(TelemetryEvent(name: name, tenantId: _tenantId() ?? kNoTenant, attributes: allowed));
    return true;
  }

  /// The health of the offline queue: its length, and the share of its commands whose result is unknown or in conflict.
  void recordQueueHealth({required int length, required int unknown, required int conflicts}) {
    record('queue.length', <String, Object>{'count': length});
    final int divisor = length == 0 ? 1 : length;
    record('queue.unknown_rate', <String, Object>{'rate': (unknown / divisor).clamp(0.0, 1.0)});
    record('queue.conflict_rate', <String, Object>{'rate': (conflicts / divisor).clamp(0.0, 1.0)});
  }

  /// How long the start took, from the first line of `main` to the first frame of the application (PERF-01).
  void recordColdStart(Duration elapsed) => record('app.cold_start', <String, Object>{'duration_ms': elapsed.inMilliseconds});

  /// How long a screen waited for the server's answer to its read before it could show it (PERF-01). Only an answer of the server
  /// counts: a copy kept on the device says nothing about the network.
  void recordListLoaded(Duration elapsed) => record('list.loaded', <String, Object>{'duration_ms': elapsed.inMilliseconds});

  /// How long the server took to answer a batch of queued commands (PERF-01).
  void recordCommandRoundTrip(Duration elapsed) => record('command.round_trip', <String, Object>{'duration_ms': elapsed.inMilliseconds});

  /// A crash: the type of the error and nothing it said (its message can hold a name, a token or a record).
  void recordCrash(Object error) => record('app.crash', <String, Object>{'error_type': error.runtimeType.toString()});

  /// The end of a session of use, counted as crash-free or not (the crash-free session rate).
  void recordSessionEnd({required bool crashFree, required int durationMs}) =>
      record('session.end', <String, Object>{'crash_free': crashFree, 'duration_ms': durationMs});
}

/// Where the application's events go. The composition root overrides it with the vendor adapter.
final Provider<TelemetrySink> telemetrySinkProvider = Provider<TelemetrySink>((Ref ref) => BufferedTelemetrySink());

final Provider<TelemetryService> telemetryProvider = Provider<TelemetryService>(
  (Ref ref) => TelemetryService(sink: ref.watch(telemetrySinkProvider), tenantId: () => ref.read(sessionProvider).tenantId),
);

/// Reports the cold start once the first frame of the application has been drawn. [started] is the stopwatch that was started on the
/// first line of `main`.
void reportColdStartAfterFirstFrame(WidgetsBinding binding, TelemetryService service, Stopwatch started) {
  binding.addPostFrameCallback((Duration _) => service.recordColdStart(started.elapsed));
  binding.ensureVisualUpdate();
}

/// Sends every uncaught error of the framework and of the platform to [service] as a crash event (the type only), then lets the
/// previous handlers run as before. Returns the function that puts the previous handlers back.
void Function() installCrashReporting(TelemetryService service) {
  final void Function(FlutterErrorDetails details)? previous = FlutterError.onError;
  FlutterError.onError = (FlutterErrorDetails details) {
    service.recordCrash(details.exception);
    if (previous != null) previous(details);
  };
  final bool Function(Object error, StackTrace stack)? previousPlatform = PlatformDispatcher.instance.onError;
  PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
    service.recordCrash(error);
    return previousPlatform != null && previousPlatform(error, stack);
  };
  return () {
    FlutterError.onError = previous;
    PlatformDispatcher.instance.onError = previousPlatform;
  };
}
