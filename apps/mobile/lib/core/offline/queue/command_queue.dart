import 'dart:async';
import 'dart:convert';

import 'package:machvon_api_client/machvon_api_client.dart';

import '../../api/answer.dart';
import '../../session/session.dart';
import '../drafts/draft_files.dart';
import '../drafts/local_draft.dart';
import '../store/local_store.dart';
import 'backoff.dart';
import 'offline_codes.dart';
import 'queue_results.dart';
import 'queued_command.dart';

/// The most commands one batch carries (`POST /sync/batches` takes 1 to 50).
const int kMaxBatchItems = 50;

/// How long the server keeps its receipts and idempotency records of queued commands (MOB.md 6, CR-04-37). A command
/// that is still not found after this time can no longer be told from one that never arrived.
const Duration kReceiptRetention = Duration(days: 7);

final RegExp _keyShape = RegExp(r'^[A-Za-z0-9._:-]{16,128}$');

/// The offline command queue of one user in one tenant (ST-MOB-005, MOB.md 4).
///
/// What the person does offline is queued as a **command** with the idempotency key of its [CommandAttempt]. When the
/// network is back [flush] sends the commands in batches and the server answers each one on its own: accepted,
/// conflict or rejected. A command whose answer was lost is [CommandState.unknown]: it is looked up by its key and never
/// created again. Retry never makes a new command out of an old one: it sends the same key again, and a new decision
/// of the person (a corrected command after a refusal, a resolved conflict) gets a new key because the old one is
/// settled on the server.
///
/// The public surface is deliberately small:
///
/// * [enqueue], [watch], [commands], [command]: make and read commands;
/// * [flush]: send what is due, after looking up what is unknown;
/// * [retry], [discard], [resolveConflict]: the decisions of the person;
/// * [events]: a stream of every move, for the screens that react (a conflict, a locked period).
class CommandQueue {
  CommandQueue({
    required LocalStore store,
    required MachvonApiClient client,
    required SessionSnapshot Function() session,
    required Future<String?> Function() deviceId,
    DateTime Function()? clock,
    String Function()? newKey,
    Backoff? backoff,
    void Function(Duration roundTrip)? onRoundTrip,
  })  : _onRoundTrip = onRoundTrip,
        _store = store,
        _client = client,
        _session = session,
        _deviceId = deviceId,
        _clock = clock ?? DateTime.now,
        _newKey = newKey ?? newUuidV4,
        _backoff = backoff ?? Backoff();

  final LocalStore _store;
  final MachvonApiClient _client;
  final SessionSnapshot Function() _session;
  final Future<String?> Function() _deviceId;
  final DateTime Function() _clock;
  final String Function() _newKey;
  final Backoff _backoff;
  final void Function(Duration roundTrip)? _onRoundTrip;
  final StreamController<void> _changes = StreamController<void>.broadcast();
  final StreamController<QueueEvent> _events = StreamController<QueueEvent>.broadcast();
  Future<FlushResult>? _flushing;
  Future<void> _tail = Future<void>.value();
  bool _disposed = false;

  String get tenantId => _store.tenantId;
  String get userId => _store.userId;

  int get _now => _clock().millisecondsSinceEpoch;

  // ---------------------------------------------------------------------------------------------------- reading

  /// The commands, oldest first; only those in [states] when it is given.
  List<QueuedCommand> commands({Set<CommandState>? states}) =>
      states == null ? _store.commands.all() : _store.commands.inStates(states);

  QueuedCommand? command(String id) => _store.commands.byId(id);

  /// The commands now and again after every change, so a screen always shows the state of the queue.
  Stream<List<QueuedCommand>> watch() => Stream<List<QueuedCommand>>.multi((MultiStreamController<List<QueuedCommand>> controller) {
        controller.add(commands());
        final StreamSubscription<void> subscription = _changes.stream.listen((void _) => controller.add(commands()));
        controller.onCancel = subscription.cancel;
      });

  /// Every move of a command, with the state it left.
  Stream<QueueEvent> get events => _events.stream;

  QueueStats stats() => QueueStats.of(_store.commands.counts(), _store.commands.inStates(<CommandState>{CommandState.queued, CommandState.sending, CommandState.unknown}), _now);

  /// How many commands have not reached the server for good. Switching tenant or signing out while this is above zero
  /// loses the work, so the switch waits for the person (07, "Cách ly tenant trong đồng bộ").
  int get unsentCount {
    final Map<CommandState, int> counts = _store.commands.counts();
    return _unsentStates.fold<int>(0, (int total, CommandState state) => total + counts[state]!);
  }

  /// The states of a command that has not reached the server for good.
  static const Set<CommandState> _unsentStates = <CommandState>{
    CommandState.queued,
    CommandState.sending,
    CommandState.unknown,
    CommandState.conflict,
    CommandState.rejected,
  };

  /// How many commands are unknown: sent, and the answer did not say what became of them. They are looked up by the next flush.
  int get unknownCount => _store.commands.counts()[CommandState.unknown]!;

  /// The time the earliest queued command may be sent, or null when none waits for a backoff; the runner sleeps until then.
  DateTime? get nextDueAt {
    final List<QueuedCommand> queued = _store.commands.inStates(<CommandState>{CommandState.queued}).where((QueuedCommand c) => c.tenantId == tenantId && c.userId == userId).toList();
    if (queued.isEmpty) return null;
    final int earliest = queued.map((QueuedCommand c) => c.nextAttemptAt).reduce((int a, int b) => a < b ? a : b);
    return DateTime.fromMillisecondsSinceEpoch(earliest);
  }

  // --------------------------------------------------------------------------------------------------- making

  /// Queues a command. [attempt] is the intention of the person: pass the same [CommandAttempt] for the same tap, and a
  /// second call with it returns the command that already exists (never a second one); the same key with a different
  /// command is [IdempotencyKeyReuse]. [draftId] links the draft the command was made from, which is kept intact
  /// whatever the server answers; with [releaseDraft] it is removed once the command is accepted (a submit).
  QueuedCommand enqueue({
    required String commandType,
    required Map<String, Object?> payload,
    int baseServerVersion = 0,
    CommandAttempt? attempt,
    String? draftId,
    bool releaseDraft = false,
  }) {
    if (commandType.isEmpty) throw ArgumentError.value(commandType, 'commandType', 'is empty');
    if (baseServerVersion < 0) throw ArgumentError.value(baseServerVersion, 'baseServerVersion', 'is negative');
    final String key = (attempt ?? CommandAttempt.fresh(_newKey)).key;
    if (!_keyShape.hasMatch(key)) throw ArgumentError.value(key, 'attempt', 'the key must be 16 to 128 characters of letters, digits and . _ : -');
    final String encoded = jsonEncode(payload);
    final QueuedCommand? existing = _store.commands.byKey(key);
    final QueuedCommand? replaced = existing == null ? _store.commands.bySupersededKey(key) : null;
    if (replaced != null) throw IdempotencyKeyReuse(key);
    if (existing != null) {
      final bool same = existing.commandType == commandType && existing.baseServerVersion == baseServerVersion && jsonEncode(existing.payload) == encoded;
      // A settled command keeps no payload, so only its type and version can still be compared.
      final bool sameSettled = existing.payload == null && existing.commandType == commandType && existing.baseServerVersion == baseServerVersion;
      if (same || sameSettled) return existing;
      throw IdempotencyKeyReuse(key);
    }
    if (draftId != null && _store.drafts.byId(draftId) == null) throw ArgumentError.value(draftId, 'draftId', 'is not a draft of this device');
    final int now = _now;
    final QueuedCommand command = QueuedCommand(
      id: _newKey(),
      tenantId: tenantId,
      userId: userId,
      commandType: commandType,
      payload: (jsonDecode(encoded) as Map<String, Object?>),
      payloadBytes: utf8.encode(encoded).length,
      baseServerVersion: baseServerVersion,
      idempotencyKey: key,
      state: CommandState.queued,
      draftId: draftId,
      releaseDraft: releaseDraft,
      createdAt: now,
      updatedAt: now,
    );
    _store.transaction<void>(() {
      _store.commands.insert(command);
      if (draftId != null) _markDraft(draftId, DraftStatus.queued);
    });
    _announce(command, null);
    return command;
  }

  // -------------------------------------------------------------------------------------------- sending

  /// Brings the queue up to date: looks up what is unknown, then sends what is due. Calls made while a flush is running
  /// join it. Returns what happened; a network that is down is a result ([FlushBlocker.offline]), not an exception.
  Future<FlushResult> flush() => _flushing ??= _serial(_flushOnce).whenComplete(() => _flushing = null);

  /// The requests of the queue run one after the other, so a lookup made by the person and a flush never move the same
  /// command at once.
  Future<T> _serial<T>(Future<T> Function() action) {
    final Future<T> run = _tail.then((void _) => action());
    _tail = run.then((T _) {}, onError: (Object _) {});
    return run;
  }

  /// A command found `sending` after the app was killed has an unknown fate: the request may have reached the server.
  /// Called when the queue is opened.
  int recoverInterrupted() {
    final List<QueuedCommand> interrupted = _store.commands.inStates(<CommandState>{CommandState.sending});
    for (final QueuedCommand command in interrupted) {
      _move(command.id, CommandState.unknown, (QueuedCommand c) => c.copyWith(errorCode: kInterrupted, updatedAt: _now));
    }
    return interrupted.length;
  }

  /// Whether the session is the one this queue belongs to and holds a credential (a locked session has none). Checked again after every wait: a tenant switch or a sign-out in the middle of
  /// a flush ends it before the next request leaves.
  bool get _inScope {
    final SessionSnapshot session = _session();
    return session.canAuthenticate && session.tenantId == tenantId && session.userId == userId;
  }

  Future<FlushResult> _flushOnce() async {
    if (_disposed || !_inScope) return FlushResult.blocked(FlushBlocker.noSession);
    final String? device = await _deviceId();
    if (_disposed || !_inScope) return FlushResult.blocked(FlushBlocker.noSession);
    if (device == null) return FlushResult.blocked(FlushBlocker.noDevice);
    final Tally tally = Tally();
    final FlushBlocker? lookupBlocker = await _lookUpUnknown(tally);
    if (lookupBlocker != null) return tally.result(lookupBlocker);
    if (_disposed || !_inScope) return tally.result(FlushBlocker.noSession);
    final List<QueuedCommand> due = _store.commands.due(_now, kMaxBatchItems).where((QueuedCommand c) => c.tenantId == tenantId && c.userId == userId).toList();
    if (due.isEmpty) return tally.result(null);
    final int sentAt = _now;
    // The state is written before the request leaves: a process that dies in the middle finds `sending` and treats it as unknown.
    _store.transaction<void>(() {
      for (final QueuedCommand command in due) {
        _move(command.id, CommandState.sending, (QueuedCommand c) => c.copyWith(sentAt: sentAt, updatedAt: sentAt));
      }
    });
    final SyncBatchRequest request = SyncBatchRequest(
      deviceId: device,
      items: <SyncBatchRequestItemsItem>[
        for (final QueuedCommand command in due)
          SyncBatchRequestItemsItem(
            idempotencyKey: command.idempotencyKey,
            commandType: command.commandType,
            baseServerVersion: command.baseServerVersion,
            payload: command.payload!,
          ),
      ],
    );
    try {
      // The batch is only an envelope: every command inside has its own key and the server answers each one from its
      // receipt when it has seen it, so the batch gets a fresh key on every send.
      final Stopwatch roundTrip = Stopwatch()..start();
      final Object? answer = await _client.postSyncBatches(request, attempt: CommandAttempt.fresh(_newKey));
      // Disposed while the answer was on its way: the store belongs to nobody now. The commands stay `sending`; the next owner of the
      // store finds them so and looks them up by their keys.
      if (_disposed) return tally.result(FlushBlocker.noSession);
      // The time the person waits for the server to take a batch (PERF-01): from the request to the answer, retries included.
      _onRoundTrip?.call(roundTrip.elapsed);
      final SyncBatchResultResponse results = decodeAnswer('post_sync_batches', answer)! as SyncBatchResultResponse;
      _applyResults(due, results, tally);
      return tally.result(null);
    } on TenantMismatch {
      // The token of this tenant was refused because another is active: the request never left, so nothing was tried.
      if (_disposed) return tally.result(FlushBlocker.noSession);
      for (final QueuedCommand command in due) {
        _move(command.id, CommandState.queued, (QueuedCommand c) => c.copyWith(updatedAt: _now));
        tally.requeued += 1;
      }
      return tally.result(FlushBlocker.noSession);
    } on ApiError catch (error) {
      if (_disposed) return tally.result(FlushBlocker.noSession);
      return tally.result(_afterBatchError(due, error, tally));
    } on ContractMismatch {
      if (_disposed) return tally.result(FlushBlocker.noSession);
      // The server answered with something this client cannot read: the commands may well have been carried out.
      for (final QueuedCommand command in due) {
        _move(command.id, CommandState.unknown, (QueuedCommand c) => c.copyWith(errorCode: kInterrupted, updatedAt: _now));
        tally.unknown += 1;
      }
      return tally.result(null);
    }
  }

  void _applyResults(List<QueuedCommand> sent, SyncBatchResultResponse results, Tally tally) {
    final Map<String, SyncBatchResultResponseResultsItem> byKey = <String, SyncBatchResultResponseResultsItem>{
      for (final SyncBatchResultResponseResultsItem item in results.results) item.idempotencyKey: item,
    };
    for (final QueuedCommand command in sent) {
      final SyncBatchResultResponseResultsItem? item = byKey[command.idempotencyKey];
      if (item == null) {
        // Every command of the batch must be answered; one that is missing is looked up like a lost answer.
        _move(command.id, CommandState.unknown, (QueuedCommand c) => c.copyWith(errorCode: kInterrupted, updatedAt: _now));
        tally.unknown += 1;
        continue;
      }
      switch (item.status) {
        case 'accepted':
          _accept(command.id, serverVersion: item.serverVersion);
          tally.accepted += 1;
        case 'conflict':
          _conflict(command.id, item.code ?? kVersionConflict, item.serverVersion);
          tally.conflicts += 1;
        default:
          final String code = item.code ?? 'COMMAND_REFUSED';
          if (kTransientItemCodes.contains(code)) {
            _requeue(command.id, code);
            tally.requeued += 1;
          } else {
            _reject(command.id, code);
            tally.rejected += 1;
          }
      }
    }
  }

  FlushBlocker? _afterBatchError(List<QueuedCommand> sent, ApiError error, Tally tally) {
    void all(CommandState to, QueuedCommand Function(QueuedCommand) change) {
      for (final QueuedCommand command in sent) {
        _move(command.id, to, change);
      }
    }

    if (error.status == 0 || (error.status >= 500 && !kBatchNotCarriedOut.contains(error.code))) {
      // No answer, or a failure after the work may have started: the commands may have been carried out.
      all(CommandState.unknown, (QueuedCommand c) => c.copyWith(errorCode: error.code, updatedAt: _now));
      tally.unknown += sent.length;
      return error.status == 0 ? FlushBlocker.offline : FlushBlocker.serverError;
    }
    if (error.status == 401) {
      all(CommandState.queued, (QueuedCommand c) => c.copyWith(errorCode: 'SESSION_EXPIRED', updatedAt: _now));
      tally.requeued += sent.length;
      return FlushBlocker.sessionExpired;
    }
    if (error.status == 403) {
      // The device or the right to sync is the problem, not the commands: they wait, intact.
      all(CommandState.queued, (QueuedCommand c) => c.copyWith(errorCode: error.code, updatedAt: _now));
      tally.requeued += sent.length;
      return FlushBlocker.deviceRejected;
    }
    if (error.status == 429 || kBatchNotCarriedOut.contains(error.code)) {
      for (final QueuedCommand command in sent) {
        _requeue(command.id, error.code);
      }
      tally.requeued += sent.length;
      return FlushBlocker.busy;
    }
    // Any other refusal of the batch as a whole (a licence that has lapsed, a payload the server cannot read): nothing was
    // carried out, and the commands are refused with its code so that the person sees why. Their drafts are intact.
    for (final QueuedCommand command in sent) {
      _reject(command.id, error.code);
    }
    tally.rejected += sent.length;
    return null;
  }

  /// Looks up each unknown command by its key (`GET /sync/commands/{key}`). A command the server never received goes back
  /// to the queue under the same key; one it settled takes that outcome. Stops at the first failure to reach the server.
  Future<FlushBlocker?> _lookUpUnknown(Tally tally) async {
    for (final QueuedCommand command in _store.commands.inStates(<CommandState>{CommandState.unknown})) {
      final FlushBlocker? blocker = await _lookUp(command, tally);
      if (blocker != null) return blocker;
    }
    return null;
  }

  Future<FlushBlocker?> _lookUp(QueuedCommand command, Tally tally) async {
    if (_disposed || !_inScope) return FlushBlocker.noSession;
    final SyncCommandStatusResponse status;
    try {
      final Object? answer = await _client.getSyncCommandsKey(idempotencyKey: command.idempotencyKey);
      status = decodeAnswer('get_sync_commands_key', answer)! as SyncCommandStatusResponse;
    } on TenantMismatch {
      return FlushBlocker.noSession;
    } on ApiError catch (error) {
      if (error.status == 401) return FlushBlocker.sessionExpired;
      return error.status == 0 ? FlushBlocker.offline : FlushBlocker.serverError;
    } on ContractMismatch {
      return FlushBlocker.serverError;
    }
    // Disposed while the answer was on its way: the store belongs to nobody now and the command stays unknown.
    if (_disposed) return FlushBlocker.noSession;
    tally.looked += 1;
    switch (status.status) {
      case 'accepted':
        _accept(command.id, resultRef: status.resultRef);
        tally.accepted += 1;
      case 'conflict':
        _conflict(command.id, status.code ?? kVersionConflict, null);
        tally.conflicts += 1;
      case 'rejected':
        _reject(command.id, status.code ?? 'COMMAND_REFUSED');
        tally.rejected += 1;
      default:
        final int sentAt = command.sentAt ?? command.updatedAt;
        if (_now - sentAt > kReceiptRetention.inMilliseconds) {
          // The server forgot its receipts, so "not received" proves nothing: sending again could do the work twice.
          _move(command.id, CommandState.rejected, (QueuedCommand c) => c.copyWith(errorCode: kResultUnverifiable, updatedAt: _now));
          _blockDraft(command, kResultUnverifiable);
          tally.rejected += 1;
        } else {
          _move(command.id, CommandState.queued, (QueuedCommand c) => c.copyWith(nextAttemptAt: _now, clearError: true, updatedAt: _now));
          tally.requeued += 1;
        }
    }
    return null;
  }

  // ------------------------------------------------------------------------------------ decisions of the person

  /// Looks up one unknown command now, or makes a queued one due, or sends a refused one again as a new decision.
  /// A refused command gets a new key (the old one is settled on the server, which would answer from its receipt),
  /// keeps its data, and goes back to the queue; this is how the person sends again after the period was reopened.
  ///
  /// A command refused as [kResultUnverifiable] is the exception: it may have been carried out, and a new key would carry it out
  /// twice, so it throws [ResultUnverifiable] unless the person, having checked the record, says with [confirmedNotExecuted] that
  /// it was not.
  Future<FlushResult> retry(String id, {bool confirmedNotExecuted = false}) async {
    final QueuedCommand command = _require(id);
    switch (command.state) {
      case CommandState.unknown:
        return _serial(() async {
          // Another request may have settled the command while this one waited.
          final QueuedCommand? current = _store.commands.byId(id);
          final Tally tally = Tally();
          if (current == null || current.state != CommandState.unknown) return tally.result(null);
          return tally.result(await _lookUp(current, tally));
        });
      case CommandState.queued:
        _store.commands.update(id, (QueuedCommand c) => c.copyWith(nextAttemptAt: _now, updatedAt: _now));
        _changes.add(null);
        return flush();
      case CommandState.rejected:
        if (command.errorCode == kResultUnverifiable && !confirmedNotExecuted) throw ResultUnverifiable(id);
        // The payload is not changed, so the draft is not rewritten with it: a command that is only a control (the submit of a report
        // names the report and nothing else) would leave the draft with nothing in it.
        _renew(command, payload: command.payload, baseServerVersion: command.baseServerVersion, rewriteDraft: false);
        return flush();
      case CommandState.sending:
      case CommandState.conflict:
      case CommandState.accepted:
      case CommandState.discarded:
        throw StateError('a ${command.state.name} command cannot be retried');
    }
  }

  /// Drops a command that was not sent. An unknown command is not discarded (it may have been carried out), and a sent
  /// one cannot be taken back. The draft it came from stays on the device and becomes editable again unless
  /// [deleteDraft] says the person drops it too.
  void discard(String id, {bool deleteDraft = false}) {
    final QueuedCommand command = _require(id);
    _store.transaction<void>(() {
      _move(id, CommandState.discarded, (QueuedCommand c) => c.copyWith(clearPayload: true, settledAt: _now, updatedAt: _now));
      final String? draftId = command.draftId;
      if (draftId != null) {
        if (deleteDraft) {
          _store.drafts.delete(draftId);
        } else {
          _markDraft(draftId, DraftStatus.editing);
        }
      }
    });
  }

  /// The person chose to discard everything that waits on the device (leaving the tenant, signing out): every command that has not
  /// reached the server for good ([unsentCount]) is dropped, whatever its state, so nothing of it is ever sent, looked up and sent
  /// again, or offered for a retry, even when the rest of the local data of the tenant is kept. A command that was sent and whose
  /// fate is unknown is dropped too: that is what the person was told they would lose. The drafts stay on the device and become
  /// editable again. Returns how many commands were dropped.
  int discardUnsent() {
    final List<QueuedCommand> unsent = _store.commands.inStates(_unsentStates);
    if (unsent.isEmpty) return 0;
    final List<QueuedCommand> dropped = _store.transaction<List<QueuedCommand>>(() {
      final List<QueuedCommand> result = <QueuedCommand>[];
      for (final QueuedCommand command in unsent) {
        result.add(_store.commands.abandon(command.id, (QueuedCommand c) => c.copyWith(clearPayload: true, settledAt: _now, updatedAt: _now)));
        final String? draftId = command.draftId;
        if (draftId != null) _markDraft(draftId, DraftStatus.editing);
      }
      return result;
    });
    for (int index = 0; index < dropped.length; index += 1) {
      _announce(dropped[index], unsent[index].state);
    }
    return dropped.length;
  }

  /// The person chose what to keep after a conflict (MOB-42): the command goes back to the queue with the version the
  /// server holds as its base, the payload they decided, and a new key, and is accepted once. The old key is settled as a
  /// conflict on the server and would answer from that receipt, which is why the decision is a new command.
  QueuedCommand resolveConflict(String id, {required Map<String, Object?> payload, required int baseServerVersion}) {
    final QueuedCommand command = _require(id);
    if (command.state != CommandState.conflict) throw StateError('a ${command.state.name} command has no conflict to resolve');
    if (baseServerVersion <= command.baseServerVersion) {
      // The version the person looked at must be newer than the one the command was based on, or the same conflict returns.
      throw ArgumentError.value(baseServerVersion, 'baseServerVersion', 'must be newer than ${command.baseServerVersion}');
    }
    return _renew(command, payload: payload, baseServerVersion: baseServerVersion);
  }

  // --------------------------------------------------------------------------------------------- transitions

  QueuedCommand _require(String id) => _store.commands.byId(id) ?? (throw StateError('no queued command $id'));

  QueuedCommand _renew(QueuedCommand command, {required Map<String, Object?>? payload, required int baseServerVersion, bool rewriteDraft = true}) {
    if (payload == null) throw StateError('the command has no data left to send');
    final String encoded = jsonEncode(payload);
    final String key = CommandAttempt.fresh(_newKey).key;
    return _store.transaction<QueuedCommand>(() {
      final QueuedCommand next = _move(
        command.id,
        CommandState.queued,
        (QueuedCommand c) => c.copyWith(
          payload: jsonDecode(encoded) as Map<String, Object?>,
          payloadBytes: utf8.encode(encoded).length,
          baseServerVersion: baseServerVersion,
          idempotencyKey: key,
          supersededKeys: <String>[...c.supersededKeys, c.idempotencyKey],
          attempts: 0,
          nextAttemptAt: 0,
          clearError: true,
          updatedAt: _now,
        ),
      );
      final String? draftId = command.draftId;
      if (draftId != null) _markDraft(draftId, DraftStatus.queued, fields: rewriteDraft ? jsonDecode(encoded) as Map<String, Object?> : null, baseServerVersion: baseServerVersion);
      return next;
    });
  }

  void _accept(String id, {int? serverVersion, String? resultRef}) {
    final QueuedCommand before = _require(id);
    final String? accepted = before.draftId;
    final LocalDraft? sent = accepted == null ? null : _store.drafts.byId(accepted);
    _store.transaction<void>(() {
      _move(
        id,
        CommandState.accepted,
        (QueuedCommand c) => c.copyWith(clearPayload: true, clearError: true, serverVersion: serverVersion, resultRef: resultRef, settledAt: _now, updatedAt: _now),
      );
      final String? draftId = before.draftId;
      if (draftId != null) {
        if (before.releaseDraft) {
          _store.drafts.delete(draftId);
        } else {
          _markDraft(draftId, DraftStatus.synced, baseServerVersion: serverVersion);
        }
      }
    });
    // The server has the command and, because a command links only clean attachments, the photographs it names: the plain copies
    // the draft kept for the person to look at before sending are of no further use (SEC-03). After the commit, so a deletion that
    // fails cannot undo the acceptance.
    if (sent != null) retireDraftFiles(_store.evidenceDirectory, sent.fields);
  }

  void _reject(String id, String code) {
    final QueuedCommand before = _require(id);
    _store.transaction<void>(() {
      _move(id, CommandState.rejected, (QueuedCommand c) => c.copyWith(errorCode: code, updatedAt: _now));
      _blockDraft(before, code);
    });
  }

  void _conflict(String id, String code, int? serverVersion) {
    final QueuedCommand before = _require(id);
    _store.transaction<void>(() {
      _move(id, CommandState.conflict, (QueuedCommand c) => c.copyWith(errorCode: code, serverVersion: serverVersion, updatedAt: _now));
      _blockDraft(before, code);
    });
  }

  void _requeue(String id, String code) {
    final QueuedCommand before = _require(id);
    final int attempts = before.attempts + 1;
    _move(
      id,
      CommandState.queued,
      (QueuedCommand c) => c.copyWith(errorCode: code, attempts: attempts, nextAttemptAt: _now + _backoff.delayAfter(attempts).inMilliseconds, updatedAt: _now),
    );
  }

  /// Moves a command and tells the listeners. The events are delivered after the synchronous work that made them, so a
  /// listener always reads the finished state.
  QueuedCommand _move(String id, CommandState to, QueuedCommand Function(QueuedCommand) change) {
    final CommandState from = _require(id).state;
    final QueuedCommand next = _store.commands.move(id, to, change);
    _announce(next, from);
    return next;
  }

  void _blockDraft(QueuedCommand command, String code) {
    final String? draftId = command.draftId;
    if (draftId != null) _markDraft(draftId, DraftStatus.blocked, blockedCode: code);
  }

  void _markDraft(String id, DraftStatus status, {String? blockedCode, Map<String, Object?>? fields, int? baseServerVersion}) {
    final LocalDraft? draft = _store.drafts.byId(id);
    if (draft == null) return;
    _store.drafts.upsert(
      LocalDraft(
        id: draft.id,
        tenantId: draft.tenantId,
        userId: draft.userId,
        kind: draft.kind,
        recordId: draft.recordId,
        fields: fields ?? draft.fields,
        baseServerVersion: baseServerVersion ?? draft.baseServerVersion,
        status: status,
        blockedCode: status == DraftStatus.blocked ? blockedCode : null,
        createdAt: draft.createdAt,
        updatedAt: _now,
      ),
    );
  }

  void _announce(QueuedCommand command, CommandState? from) {
    _changes.add(null);
    _events.add(QueueEvent(command, from));
  }

  /// Stops the streams; the store is closed by whoever opened it.
  Future<void> dispose() async {
    _disposed = true;
    await _changes.close();
    await _events.close();
  }
}
