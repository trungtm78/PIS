import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/problem.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/offline/offline_providers.dart';
import '../../core/state/screen_state.dart';
import '../../core/state/state_boundary.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/state_view.dart';
import '../read_support/navigate.dart';
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
/// is. A draft that is not there (it was sent, dropped, or belongs to another person) is an empty state with its code and the way
/// out: record an obstacle.
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
      data: (StoredIssueDraft? stored) => stored == null ? const _DraftMissing() : builder(context, stored),
    );
  }
}

/// The draft a screen was opened for is not on this phone: what that means, its stable code, and the one action that fixes it.
class _DraftMissing extends StatelessWidget {
  const _DraftMissing();

  @override
  Widget build(BuildContext context) {
    return StateView(
      kind: StateKind.empty,
      icon: Icons.edit_off_outlined,
      title: context.t('mob.fld.draft.missing.title'),
      body: context.t('mob.fld.draft.missing.body'),
      details: <Widget>[Text(kDraftNotFound, textAlign: TextAlign.center, style: context.v2text.caption.copyWith(color: context.v2.palette.ink2))],
      actionLabel: context.t('mob.fld.capture.title'),
      onAction: () => openScreen(context, 'MOB-28'),
    );
  }
}
