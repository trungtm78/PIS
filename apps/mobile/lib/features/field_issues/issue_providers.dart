import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/problem.dart';
import '../../core/offline/offline_providers.dart';
import '../../core/state/screen_state.dart';
import '../../core/state/state_boundary.dart';
import 'issue_service.dart';

/// One draft of an issue, read from the device. Whoever changes the draft invalidates it.
final issueDraftProvider = FutureProvider.family<StoredIssueDraft?, String>(
  (Ref ref, String draftId) => ref.read(issueServiceProvider).load(draftId),
);

/// The drafts of the signed-in person that can still be worked on.
final FutureProvider<List<StoredIssueDraft>> openIssueDraftsProvider =
    FutureProvider<List<StoredIssueDraft>>(
      (Ref ref) => ref.read(issueServiceProvider).open(),
    );

/// The code shown when the draft a screen was opened for is not on this device (it was sent, discarded, or belongs to another
/// person).
const String kDraftNotFound = 'DRAFT_NOT_FOUND';

/// The state of a screen that works on a draft of the device: while it is read, when it cannot be read (the local store is
/// closed because nobody is signed in, or it failed to open) and when it is not there. The content is built only when the draft
/// is.
class DraftBoundary extends ConsumerWidget {
  const DraftBoundary({
    required this.draftId,
    required this.builder,
    super.key,
  });

  final String draftId;
  final Widget Function(BuildContext context, StoredIssueDraft stored) builder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<StoredIssueDraft?> draft = ref.watch(
      issueDraftProvider(draftId),
    );
    return draft.when(
      skipLoadingOnReload: true,
      loading: () => const StateBoundary(
        state: ScreenState.loading,
        keepContent: false,
        child: SizedBox.shrink(),
      ),
      error: (Object error, StackTrace _) => StateBoundary(
        state: error is OfflineUnavailable
            ? ScreenState.signedOut
            : ScreenState.error,
        problem: error is OfflineUnavailable
            ? const ProblemView(
                state: ScreenState.signedOut,
                code: 'SESSION_EXPIRED',
              )
            : ProblemView.from(error),
        onRetry: () => ref.invalidate(issueDraftProvider(draftId)),
        keepContent: false,
        child: const SizedBox.shrink(),
      ),
      data: (StoredIssueDraft? stored) => stored == null
          ? const StateBoundary(
              state: ScreenState.error,
              problem: ProblemView(
                state: ScreenState.error,
                code: kDraftNotFound,
              ),
              keepContent: false,
              child: SizedBox.shrink(),
            )
          : builder(context, stored),
    );
  }
}
