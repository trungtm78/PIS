import 'package:flutter_riverpod/flutter_riverpod.dart';

/// What is waiting on the device: commands that are queued, sending or unknown, and the ones in conflict. The offline
/// queue (ST-MOB-005) and the conflict screen (ST-MOB-006) write it; the shell only reads it to show the banner.
final class SyncStatus {
  const SyncStatus({this.pendingCommands = 0, this.conflicts = 0});

  /// Commands that have not reached the server (queued, sending, unknown).
  final int pendingCommands;

  /// Commands that need the user to choose between the device and the server version.
  final int conflicts;

  bool get isIdle => pendingCommands == 0 && conflicts == 0;

  @override
  bool operator ==(Object other) =>
      other is SyncStatus && other.pendingCommands == pendingCommands && other.conflicts == conflicts;

  @override
  int get hashCode => Object.hash(pendingCommands, conflicts);
}

class SyncStatusNotifier extends Notifier<SyncStatus> {
  @override
  SyncStatus build() => const SyncStatus();

  void update(SyncStatus value) => state = value;
}

final NotifierProvider<SyncStatusNotifier, SyncStatus> syncStatusProvider =
    NotifierProvider<SyncStatusNotifier, SyncStatus>(SyncStatusNotifier.new);
