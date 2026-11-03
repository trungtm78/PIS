import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/attempts.dart';

/// The longest comment the server takes.
const int kCommentMax = 2000;

/// How a comment ended.
sealed class CommentOutcome {
  const CommentOutcome();
}

final class Commented extends CommentOutcome {
  const Commented();
}

/// The server refused: nothing was recorded. [code] is its stable error code.
final class CommentRefused extends CommentOutcome {
  const CommentRefused(this.code);

  final String code;
}

/// The answer was lost: the comment may or may not be recorded. Sending it again reuses the key, so it is recorded once.
final class CommentUnknown extends CommentOutcome {
  const CommentUnknown();
}

/// The device is offline: nothing was sent. A comment is not queued (the queue carries no comment command), so the words stay
/// on the screen for the person to send when the network is back.
final class CommentOffline extends CommentOutcome {
  const CommentOffline();
}

/// What a refusal means to the person.
enum CommentProblem {
  closed,
  validation,
  denied,
  notFound,
  sessionEnded,
  general,
}

CommentProblem commentProblemOf(String code) {
  switch (code) {
    case 'ISSUE_STATE_INVALID':
      return CommentProblem.closed;
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return CommentProblem.validation;
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
      return CommentProblem.denied;
    case 'RESOURCE_NOT_FOUND':
      return CommentProblem.notFound;
    case 'SESSION_EXPIRED':
      return CommentProblem.sessionEnded;
    default:
      return CommentProblem.general;
  }
}

/// Sends the comments of one screen. It owns the attempt of the comment the person is on, so a send repeated after a lost answer
/// keeps the key of the first one and the issue holds the comment once.
class IssueComments {
  IssueComments({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _attempts = AttemptRegistry();

  Future<CommentOutcome> send(
    String issueId,
    String note, {
    bool retryAfterUnknown = false,
  }) async {
    if (!retryAfterUnknown && !isOnline()) return const CommentOffline();
    final String words = note.trim();
    final CommandAttempt attempt = _attempts.forPayload('$issueId|$words');
    try {
      await client.commentIssue(
        IssCommentIssue(note: words),
        id: issueId,
        attempt: attempt,
      );
      _attempts.done();
      return const Commented();
    } on ApiError catch (error) {
      _attempts.ended(error);
      return error.code == networkErrorCode
          ? const CommentUnknown()
          : CommentRefused(error.code);
    }
  }
}

/// What is wrong with the words of a comment before they are sent.
enum CommentFormProblem { required, tooLong }

CommentFormProblem? checkComment(String note) {
  final String words = note.trim();
  if (words.isEmpty) return CommentFormProblem.required;
  return words.runes.length > kCommentMax ? CommentFormProblem.tooLong : null;
}
