import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../command_support/command_outcome.dart';
import 'conversation_models.dart';

/// Whether the application offers to send a message to a person outside the system. External channels (Zalo, WhatsApp, SMS, e-mail)
/// are enabled in the release that follows the channel contracts (D06, CR-SMP-06, R2 at the earliest): the build that ships then
/// sets `--dart-define=MACHVON_EXTERNAL_REPLY=true`. Until then a conversation can be read and answered with a note for the
/// colleagues only. The server judges consent, window and account whatever this says; the flag decides only whether the phone offers it.
final Provider<bool> externalReplyEnabledProvider = Provider<bool>((Ref ref) => const bool.fromEnvironment('MACHVON_EXTERNAL_REPLY'));

/// What the person may write in a conversation now, and why not the rest. The reason is written beside the composer, never left to
/// be guessed.
enum ExternalGate {
  /// A message to the person outside can be sent.
  open,

  /// The conversation is on no external channel: there is nobody outside to answer.
  internalConversation,

  /// The application does not offer external replies yet (the channels wait for D06).
  notEnabled,

  /// Nobody has taken the conversation up, or it is resolved: it takes notes only until it is with an agent.
  notWithAnAgent,

  /// The conversation is closed.
  closed,
}

/// The state in which a message to the person can go: while the conversation is with an agent or waits for the customer.
bool statusAllowsReply(ConversationStatus status) => status == ConversationStatus.assigned || status == ConversationStatus.inProgress || status == ConversationStatus.pendingCustomer;

bool mayResolve(ConversationStatus status) => status == ConversationStatus.inProgress || status == ConversationStatus.pendingCustomer;

bool mayReopen(ConversationStatus status) => status == ConversationStatus.resolved;

/// A conversation can be given to someone while it is open: not once it is resolved (it comes back with a message) or closed.
bool mayAssign(ConversationStatus status) => status != ConversationStatus.resolved && status != ConversationStatus.closed;

/// Whether an external message is offered for [conversation], with the reason when it is not. A closed conversation says closed
/// before anything else; an internal one says so whatever its state.
ExternalGate externalGateOf(ConversationItem conversation, {required bool enabled}) {
  if (conversation.status == ConversationStatus.closed) return ExternalGate.closed;
  if (!conversation.isExternal) return ExternalGate.internalConversation;
  if (!enabled) return ExternalGate.notEnabled;
  if (!statusAllowsReply(conversation.status)) return ExternalGate.notWithAnAgent;
  return ExternalGate.open;
}

/// The longest text the server takes (`ConversationMessageSend.text`), counted in characters and not in code units.
const int messageTextMax = 4000;
const int moveReasonMin = 10;
const int moveReasonMax = 2000;
const int assignReasonMax = 500;

/// The purposes of a message to a person, as the server names them.
const List<String> purposes = <String>['SUPPORT_CONVERSATION', 'OPERATIONAL', 'REMINDER'];
const String defaultPurpose = 'SUPPORT_CONVERSATION';

int _length(String value) => value.runes.length;

/// Whether the text cannot be sent: nothing but blanks, or more than the server takes.
bool textProblem(String text) {
  final int length = _length(text.trim());
  return length == 0 || length > messageTextMax;
}

/// Whether the reason of a resolve or a reopen cannot be sent.
bool moveReasonProblem(String reason) {
  final int length = _length(reason.trim());
  return length < moveReasonMin || length > moveReasonMax;
}

bool assignReasonProblem(String reason) => _length(reason.trim()) > assignReasonMax;

/// What the person writes: a message to the person outside, or a note that never leaves the system.
final class MessageDraft {
  const MessageDraft.external({required this.text, required this.purpose}) : note = false;

  const MessageDraft.note({required this.text})
      : note = true,
        purpose = null;

  final bool note;
  final String text;
  final String? purpose;
}

/// The body of a send. A note carries no purpose (the server refuses one); a message to the person names the channel account of
/// the conversation, the one the server checks it against.
ConversationMessageSend sendBodyOf(MessageDraft draft, String channelAccountId) => draft.note
    ? ConversationMessageSend(kind: 'INTERNAL_NOTE', channelAccountId: channelAccountId, text: draft.text.trim())
    : ConversationMessageSend(kind: 'EXTERNAL', channelAccountId: channelAccountId, purpose: draft.purpose ?? defaultPurpose, text: draft.text.trim());

/// What a refusal means to the person, for the words of the screen. The sentences are those of the web OMNI-02.
enum ConversationProblem {
  invalid,
  consent,
  optIn,
  window,
  account,
  unverified,
  content,
  template,
  state,
  contact,
  conflict,
  stepUp,
  licenseExpired,
  denied,
  notFound,
  sessionEnded,
  notEligible,
  general,
}

ConversationProblem problemOf(CommandRefused refused) {
  switch (refused.code) {
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return ConversationProblem.invalid;
    case 'CONSENT_DENIED':
      return ConversationProblem.consent;
    case 'OPT_IN_REQUIRED':
      return ConversationProblem.optIn;
    case 'CHANNEL_WINDOW_CLOSED':
      return ConversationProblem.window;
    case 'CHANNEL_ACCOUNT_MISMATCH':
      return ConversationProblem.account;
    case 'CHANNEL_UNVERIFIED':
      return ConversationProblem.unverified;
    case 'CONTENT_CLASSIFICATION_BLOCKED':
      return ConversationProblem.content;
    case 'TEMPLATE_INVALID':
      return ConversationProblem.template;
    case 'CONVERSATION_STATE_INVALID':
      return ConversationProblem.state;
    case 'CONTACT_STATE_INVALID':
      return ConversationProblem.contact;
    case 'VERSION_CONFLICT':
      return ConversationProblem.conflict;
    case 'MFA_REQUIRED':
      return ConversationProblem.stepUp;
    case 'LICENSE_EXPIRED':
      return ConversationProblem.licenseExpired;
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
    case 'ENTITLEMENT_DENIED':
      return ConversationProblem.denied;
    case 'RESOURCE_NOT_FOUND':
      return ConversationProblem.notFound;
    case 'SESSION_EXPIRED':
      return ConversationProblem.sessionEnded;
    case 'ASSIGNEE_NOT_ELIGIBLE':
      return ConversationProblem.notEligible;
    default:
      return ConversationProblem.general;
  }
}

/// Whether the refusal means the thread on the screen is not what the server holds (someone else moved the conversation, or it left
/// the scope of the person): it is read again.
bool refusalChangesThread(CommandRefused refused) => const <ConversationProblem>{ConversationProblem.conflict, ConversationProblem.state, ConversationProblem.notFound, ConversationProblem.denied}.contains(problemOf(refused));
