import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/di/providers.dart';
import '../../core/navigation/route_catalogue.dart';
import '../../core/navigation/tab_badges.dart';
import '../../core/session/session.dart';
import '../read_support/clock.dart';
import '../read_support/data_view.dart' show FetchedEarlier;
import '../read_support/paged.dart';
import '../read_support/wire.dart';
import 'approval_models.dart';
import 'approval_support.dart';

/// How old an answer the badge already holds may be for the inbox to take it instead of asking again. An answer still on its way is always taken
/// (it is the newest there can be); one that arrived longer ago than this is left, and the inbox reads for itself when it opens.
const Duration approvalEarlyAnswerMaxAge = Duration(seconds: 30);

/// Who a read is asked for: the person, the tenant and the membership of the session. An answer belongs to the identity it was asked under and to
/// no other.
typedef ApprovalReader = ({String? tenantId, String? userId, String? membershipId});

ApprovalReader? _readerOf(SessionSnapshot session) =>
    session.isSignedIn ? (tenantId: session.tenantId, userId: session.userId, membershipId: session.membershipId) : null;

/// What the inbox of approvals (MOB-23) reads: the tasks given to the person that still wait, then the names of the units (best effort: a unit the
/// reader may not read is left without a name, and a lost connection fails the read so that the copy is shown), then the records of the modules that
/// wait for the person outside the engine (PWF 20.9). A source that cannot be read is named, never shown as "nothing waits".
///
/// It is several requests. [proceed] is asked before each of them, every page and every best-effort follow-up included: once it says no (the person
/// signed out, or the session is of another person or tenant) nothing more is asked and the read ends with [ReadAbandoned].
Future<Object?> readApprovalInbox(MachvonApiClient client, {bool Function()? proceed}) async {
  void check() {
    if (proceed != null && !proceed()) throw const ReadAbandoned();
  }

  final Json tasks = await readMerged(client, 'get_resources_approval_task', query: <String, Object?>{'mine': 'true', 'status': 'Pending', 'limit': 200}, proceed: proceed);
  Json? units;
  try {
    units = await readMerged(client, 'get_resources_organization_unit', query: <String, Object?>{'limit': 200}, proceed: proceed);
  } on ApiError catch (error) {
    if (error.code == networkErrorCode) rethrow;
  }
  Object? pending;
  bool pendingUnavailable = false;
  check();
  try {
    pending = await client.listMyPendingDecisions();
  } on ApiError catch (error) {
    if (error.code == networkErrorCode) rethrow;
    pendingUnavailable = true;
  }
  check();
  final Json? pendingBody = asRecord(pending);
  return <String, Object?>{
    'items': tasks['items'],
    'as_of': tasks['as_of'],
    'units': units,
    'pending': pendingBody?['items'] ?? const <Object?>[],
    'pending_unavailable': pendingUnavailable || (listOf(pendingBody?['unavailable_sources']).isNotEmpty),
  };
}

/// The number on the Approvals tab from the moment the five tabs are up (L9): it used to appear only once the tab had been opened, because the inbox
/// was the only reader. The shell starts this reader (`MobileFeature.onShell`); it reads what the inbox reads, puts the count on the tab, and keeps
/// the answer for a short while ([approvalEarlyAnswerMaxAge]) for the inbox, so opening the tab right after asks the server nothing more. It reads
/// again when the person, the tenant or the membership changes and after a decision made on this device, the moments the inbox itself reads again;
/// the inbox takes that answer too when it is on the screen.
///
/// Every read is tied to the session it was asked under: after a sign-out or a change of identity it asks nothing more, its answer counts for
/// nothing and is handed to nobody.
///
/// The state is the count that waits; null until the server has answered (the tab then shows no number, never a 0 that was not read). A failed read
/// keeps the last number; a sign-out clears it.
class ApprovalBadge extends Notifier<int?> {
  int _generation = 0;
  bool _disposed = false;

  /// The answer kept for the inbox: its future, who it was asked for, and when it arrived (null while it is on its way).
  Future<FetchedEarlier>? _early;
  ApprovalReader? _earlyFor;
  DateTime? _earlyAt;

  @override
  int? build() {
    _disposed = false;
    ref.onDispose(() => _disposed = true);
    ref.listen<SessionSnapshot>(sessionProvider, (SessionSnapshot? previous, SessionSnapshot next) {
      final ApprovalReader? before = previous == null ? null : _readerOf(previous);
      final ApprovalReader? now = _readerOf(next);
      if (before == now) return;
      // Another person, tenant or membership, or nobody: what was read or is being read is of the session that ended.
      _generation += 1;
      _forget();
      state = null;
      if (now == null) {
        ref.read(tabBadgeProvider.notifier).set(AppTab.approval, 0);
      } else {
        unawaited(refresh());
      }
    });
    ref.listen<int>(approvalsChangedProvider, (int? previous, int next) => unawaited(refresh()));
    Future<void>.microtask(refresh);
    return null;
  }

  void _forget() {
    _early = null;
    _earlyFor = null;
    _earlyAt = null;
  }

  ApprovalReader? _reader() => _disposed ? null : _readerOf(ref.read(sessionProvider));

  /// Reads the inbox, counts it for the tab and keeps the answer for the inbox to take.
  Future<void> refresh() async {
    final ApprovalReader? reader = _reader();
    if (reader == null) return;
    final int generation = ++_generation;
    bool wanted() => !_disposed && generation == _generation && _reader() == reader;
    final Future<FetchedEarlier> read = _stamped(readApprovalInbox(ref.read(apiClientProvider), proceed: wanted), ref.read(clockProvider));
    _early = read;
    _earlyFor = reader;
    _earlyAt = null;
    try {
      final FetchedEarlier answer = await read;
      if (!wanted()) return;
      if (identical(_early, read)) _earlyAt = answer.fetchedAt;
      final ApprovalInbox? inbox = parseApprovalInbox(answer.raw);
      if (inbox == null) return;
      state = inbox.waitingCount;
      ref.read(tabBadgeProvider.notifier).set(AppTab.approval, inbox.waitingCount);
    } on Object {
      // The tab keeps the number it had. The inbox does not take an answer that failed: it reads for itself and shows its own state.
      if (identical(_early, read)) _forget();
    }
  }

  /// The answer with the moment it arrived, so a screen that takes it later says when it was fetched and not "just now".
  Future<FetchedEarlier> _stamped(Future<Object?> read, DateTime Function() clock) async {
    final Object? raw = await read;
    return FetchedEarlier(raw, clock());
  }

  /// The answer this reader holds or is waiting for, handed over once, when it is of [reader] and is still on its way or arrived no longer ago
  /// than [approvalEarlyAnswerMaxAge]. Null otherwise: the inbox then reads for itself.
  Future<FetchedEarlier>? _take(ApprovalReader reader) {
    final Future<FetchedEarlier>? early = _early;
    final ApprovalReader? asked = _earlyFor;
    final DateTime? at = _earlyAt;
    if (early == null) return null;
    _forget();
    if (asked != reader) return null;
    if (at != null && ref.read(clockProvider)().difference(at) > approvalEarlyAnswerMaxAge) return null;
    return early;
  }

  /// The read of the inbox screen: the answer the badge already has (in flight or fresh) the first time, the server otherwise. An answer taken
  /// from the badge comes with the moment it was fetched ([FetchedEarlier]). Like the read of the badge it is tied to the session it started
  /// under: after a sign-out or a change of identity it asks nothing more, and no read for the screen itself starts when nobody is signed in.
  Future<Object?> readForInbox(MachvonApiClient client) async {
    final ApprovalReader? reader = _reader();
    if (reader == null) throw const ReadAbandoned();
    bool wanted() => _reader() == reader;
    final Future<FetchedEarlier>? early = _take(reader);
    if (early != null) {
      try {
        return await early;
      } on Object {
        // The early read failed: the screen asks for itself below, so the failure it shows is its own.
      }
      if (!wanted()) throw const ReadAbandoned();
    }
    return readApprovalInbox(client, proceed: wanted);
  }
}

final NotifierProvider<ApprovalBadge, int?> approvalBadgeProvider = NotifierProvider<ApprovalBadge, int?>(ApprovalBadge.new);

/// Starts the count of the Approvals tab with the shell and keeps it while the shell is up (see [ApprovalBadge]).
void startApprovalBadge(WidgetRef ref) => ref.listen<int?>(approvalBadgeProvider, (int? previous, int? next) {});
