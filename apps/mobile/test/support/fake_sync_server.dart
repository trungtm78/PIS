import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

/// What the fake server does with one queued command that it has not seen before.
final class ServerOutcome {
  const ServerOutcome.accepted({this.version = 2, this.resultRef}) : kind = 'accepted', code = null;
  const ServerOutcome.conflict({this.code = 'VERSION_CONFLICT', this.version = 5}) : kind = 'conflict', resultRef = null;
  const ServerOutcome.rejected(this.code) : kind = 'rejected', version = null, resultRef = null;

  /// A failure that may go away: no receipt is written, the phone sends the command again.
  const ServerOutcome.transient([this.code = 'UNAVAILABLE']) : kind = 'transient', version = null, resultRef = null;

  final String kind;
  final String? code;
  final int? version;
  final String? resultRef;
}

class _Receipt {
  _Receipt(this.hash, this.outcome);

  final String hash;
  final ServerOutcome outcome;
}

/// The sync endpoints of the server as the phone sees them (docs/mob-sync.md): `POST /sync/batches` answers each command
/// on its own from its own receipt, `GET /sync/commands/{key}` looks a command up, and a key sent again with another
/// command is refused. The real rules are proven on PostgreSQL by apps/api/test/sync; this fake only lets the phone's
/// side be tested against the same behaviour, and counts the effects so a test can say "carried out once".
class FakeSyncServer implements HttpTransport {
  FakeSyncServer({this.decide = _acceptAll});

  /// The outcome of a command seen for the first time.
  ServerOutcome Function(Map<String, Object?> item) decide;

  final Map<String, _Receipt> _receipts = <String, _Receipt>{};
  final Map<String, int> effects = <String, int>{};
  final List<HttpCall> calls = <HttpCall>[];

  /// The network is down: every request throws before it leaves.
  bool offline = false;

  /// The next batch is carried out and then its answer is lost (the connection is cut after the server did the work).
  bool dropNextBatchAnswer = false;

  /// Answers the next request with this status and code instead of handling it.
  ({int status, String code})? failNext;

  /// The reports the server holds, by id, as `GET /reports/{id}` shows them.
  final Map<String, Map<String, Object?>> reports = <String, Map<String, Object?>>{};

  int get batchPosts => calls.where((HttpCall c) => c.method == 'POST' && c.url.path.endsWith('/sync/batches')).length;
  int get lookups => calls.where((HttpCall c) => c.method == 'GET' && c.url.path.contains('/sync/commands/')).length;
  List<HttpCall> get batches => calls.where((HttpCall c) => c.method == 'POST' && c.url.path.endsWith('/sync/batches')).toList();

  int effectsOf(String key) => effects[key] ?? 0;
  bool hasReceipt(String key) => _receipts.containsKey(key);

  static ServerOutcome _acceptAll(Map<String, Object?> item) => const ServerOutcome.accepted();

  @override
  Future<HttpResult> send(HttpCall call) async {
    calls.add(call);
    if (offline) throw const SocketException('network is down');
    final ({int status, String code})? failure = failNext;
    if (failure != null) {
      failNext = null;
      return _problem(failure.status, failure.code);
    }
    if (call.method == 'POST' && call.url.path.endsWith('/sync/batches')) return _batch(call);
    if (call.method == 'GET' && call.url.path.contains('/sync/commands/')) return _lookup(call);
    if (call.method == 'GET' && call.url.pathSegments.contains('reports')) {
      final Map<String, Object?>? report = reports[call.url.pathSegments.last];
      return report == null ? _problem(404, 'RESOURCE_NOT_FOUND') : _json(200, report);
    }
    return _problem(404, 'RESOURCE_NOT_FOUND');
  }

  HttpResult _batch(HttpCall call) {
    final Map<String, Object?> body = jsonDecode(call.body!) as Map<String, Object?>;
    final List<Object?> items = body['items']! as List<Object?>;
    final List<Map<String, Object?>> results = <Map<String, Object?>>[];
    for (final Object? raw in items) {
      final Map<String, Object?> item = raw! as Map<String, Object?>;
      final String key = item['idempotency_key']! as String;
      final String hash = sha256.convert(utf8.encode(jsonEncode(<Object?>[item['command_type'], item['base_server_version'], item['payload']]))).toString();
      final _Receipt? earlier = _receipts[key];
      if (earlier != null) {
        results.add(earlier.hash == hash ? _result(key, earlier.outcome) : <String, Object?>{'idempotency_key': key, 'status': 'rejected', 'code': 'IDEMPOTENCY_CONFLICT'});
        continue;
      }
      final ServerOutcome outcome = decide(item);
      if (outcome.kind == 'transient') {
        results.add(<String, Object?>{'idempotency_key': key, 'status': 'rejected', 'code': outcome.code});
        continue;
      }
      if (outcome.kind == 'accepted') effects[key] = effectsOf(key) + 1;
      _receipts[key] = _Receipt(hash, outcome);
      results.add(_result(key, outcome));
    }
    if (dropNextBatchAnswer) {
      dropNextBatchAnswer = false;
      throw const SocketException('connection reset after the server did the work');
    }
    return _json(200, <String, Object?>{'results': results});
  }

  HttpResult _lookup(HttpCall call) {
    final String key = Uri.decodeComponent(call.url.pathSegments.last);
    final _Receipt? receipt = _receipts[key];
    if (receipt == null) return _json(200, <String, Object?>{'status': 'not_received'});
    final ServerOutcome outcome = receipt.outcome;
    return _json(200, <String, Object?>{
      'status': outcome.kind,
      if (outcome.resultRef != null) 'result_ref': outcome.resultRef,
      if (outcome.code != null) 'code': outcome.code,
    });
  }

  Map<String, Object?> _result(String key, ServerOutcome outcome) => <String, Object?>{
        'idempotency_key': key,
        'status': outcome.kind,
        if (outcome.code != null) 'code': outcome.code,
        if (outcome.version != null) 'server_version': outcome.version,
      };

  HttpResult _json(int status, Object body) =>
      HttpResult(status: status, headers: const <String, String>{'content-type': 'application/json'}, body: jsonEncode(body));

  HttpResult _problem(int status, String code) => HttpResult(
        status: status,
        headers: const <String, String>{'content-type': 'application/problem+json'},
        body: jsonEncode(<String, Object?>{'type': 'about:blank', 'title': code, 'status': status, 'code': code}),
      );
}
