import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Whether the release or the service stops the application from being used (MOB-54).
enum ReleaseBlock {
  /// Nothing stops the user.
  none,

  /// The service is in a maintenance window: the screens that work from the device (the drafts and the queue) stay open.
  maintenance,

  /// The server declared this version of the application unsafe: nothing opens until the user updates.
  upgradeRequired,
}

/// What MOB-54 shows. Every value comes from the server (the version policy or an answer 426 or 503); the clock of the
/// phone decides nothing.
final class ReleaseNotice {
  const ReleaseNotice({
    this.block = ReleaseBlock.none,
    this.reasonCode,
    this.windowStartsAt,
    this.windowEndsAt,
    this.minimumVersion,
    this.storeUrl,
  });

  final ReleaseBlock block;

  /// The stable code that says why (for example `APP_VERSION_UNSAFE`); shown as code, never as server text.
  final String? reasonCode;
  final DateTime? windowStartsAt;
  final DateTime? windowEndsAt;

  /// The lowest version the server accepts, shown with the upgrade request.
  final String? minimumVersion;

  /// Where the new version is (a store listing or the address of the managed distribution); https only.
  final Uri? storeUrl;

  bool get blocks => block != ReleaseBlock.none;

  @override
  bool operator ==(Object other) =>
      other is ReleaseNotice &&
      other.block == block &&
      other.reasonCode == reasonCode &&
      other.windowStartsAt == windowStartsAt &&
      other.windowEndsAt == windowEndsAt &&
      other.minimumVersion == minimumVersion &&
      other.storeUrl == storeUrl;

  @override
  int get hashCode => Object.hash(block, reasonCode, windowStartsAt, windowEndsAt, minimumVersion, storeUrl);
}

/// The release state of the application. The foundation ships the one that never blocks; ST-MOB-016 replaces it with the
/// version-policy one by overriding [releaseNoticeProvider] in `main.dart`. The router guard reads it, so a block opens MOB-54
/// from wherever the user is.
abstract class ReleaseNoticeController extends Notifier<ReleaseNotice> {}

class NoReleaseNotice extends ReleaseNoticeController {
  @override
  ReleaseNotice build() => const ReleaseNotice();
}

final NotifierProvider<ReleaseNoticeController, ReleaseNotice> releaseNoticeProvider =
    NotifierProvider<ReleaseNoticeController, ReleaseNotice>(NoReleaseNotice.new);
