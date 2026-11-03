import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';
import 'conversation_models.dart';
import 'conversation_rules.dart';

String statusLabel(BuildContext context, ConversationStatus status) {
  switch (status) {
    case ConversationStatus.newConversation:
      return context.t('mob.conv.status.new');
    case ConversationStatus.assigned:
      return context.t('mob.conv.status.assigned');
    case ConversationStatus.inProgress:
      return context.t('mob.conv.status.inProgress');
    case ConversationStatus.pendingCustomer:
      return context.t('mob.conv.status.pending');
    case ConversationStatus.resolved:
      return context.t('mob.conv.status.resolved');
    case ConversationStatus.closed:
      return context.t('mob.conv.status.closed');
  }
}

/// The name of a channel; one the application does not know is shown by its code.
String channelLabel(BuildContext context, String channel) {
  switch (channel) {
    case 'EMAIL':
      return context.t('mob.conv.channel.email');
    case 'SMS':
      return context.t('mob.conv.channel.sms');
    case 'ZALO_OA':
    case 'ZALO_ZNS':
      return context.t('mob.conv.channel.zalo');
    case 'WHATSAPP':
      return context.t('mob.conv.channel.whatsapp');
    default:
      return channel;
  }
}

/// Whether the conversation is with someone outside or among colleagues, in one phrase that every row and every thread carries.
String kindLabel(BuildContext context, ConversationItem conversation) =>
    conversation.isExternal ? context.t('mob.conv.kind.external', <String, Object>{'channel': channelLabel(context, conversation.channel)}) : context.t('mob.conv.kind.internal');

String directionLabel(BuildContext context, Direction direction) {
  switch (direction) {
    case Direction.inbound:
      return context.t('mob.conv.direction.inbound');
    case Direction.outbound:
      return context.t('mob.conv.direction.outbound');
    case Direction.internalNote:
      return context.t('mob.conv.direction.note');
  }
}

String deliveryLabel(BuildContext context, Delivery delivery) {
  switch (delivery) {
    case Delivery.queued:
      return context.t('mob.conv.delivery.queued');
    case Delivery.providerAccepted:
      return context.t('mob.conv.delivery.accepted');
    case Delivery.delivered:
      return context.t('mob.conv.delivery.delivered');
    case Delivery.read:
      return context.t('mob.conv.delivery.read');
    case Delivery.failed:
      return context.t('mob.conv.delivery.failed');
  }
}

String purposeLabel(BuildContext context, String purpose) {
  switch (purpose) {
    case 'OPERATIONAL':
      return context.t('mob.conv.purpose.operational');
    case 'REMINDER':
      return context.t('mob.conv.purpose.reminder');
    default:
      return context.t('mob.conv.purpose.support');
  }
}

String linkedKindLabel(BuildContext context, LinkedKind kind) {
  switch (kind) {
    case LinkedKind.project:
      return context.t('mob.conv.links.project');
    case LinkedKind.issue:
      return context.t('mob.conv.links.issue');
    case LinkedKind.contract:
      return context.t('mob.conv.links.contract');
  }
}

/// Why the composer does not offer a message to the person outside, beside the composer.
String gateText(BuildContext context, ExternalGate gate) {
  switch (gate) {
    case ExternalGate.open:
      return '';
    case ExternalGate.internalConversation:
      return context.t('mob.conv.gate.internal');
    case ExternalGate.notEnabled:
      return context.t('mob.conv.gate.notEnabled');
    case ExternalGate.notWithAnAgent:
      return context.t('mob.conv.gate.notWithAnAgent');
    case ExternalGate.closed:
      return context.t('mob.conv.gate.closed');
  }
}

String problemText(BuildContext context, ConversationProblem problem) {
  switch (problem) {
    case ConversationProblem.invalid:
      return context.t('mob.conv.problem.invalid');
    case ConversationProblem.consent:
      return context.t('mob.conv.problem.consent');
    case ConversationProblem.optIn:
      return context.t('mob.conv.problem.optIn');
    case ConversationProblem.window:
      return context.t('mob.conv.problem.window');
    case ConversationProblem.account:
      return context.t('mob.conv.problem.account');
    case ConversationProblem.unverified:
      return context.t('mob.conv.problem.unverified');
    case ConversationProblem.content:
      return context.t('mob.conv.problem.content');
    case ConversationProblem.template:
      return context.t('mob.conv.problem.template');
    case ConversationProblem.state:
      return context.t('mob.conv.problem.state');
    case ConversationProblem.contact:
      return context.t('mob.conv.problem.contact');
    case ConversationProblem.conflict:
      return context.t('mob.conv.problem.conflict');
    case ConversationProblem.stepUp:
      return context.t('mob.conv.problem.stepUp');
    case ConversationProblem.licenseExpired:
      return context.t('mob.conv.problem.licenseExpired');
    case ConversationProblem.denied:
      return context.t('mob.conv.problem.denied');
    case ConversationProblem.notFound:
      return context.t('mob.conv.problem.notFound');
    case ConversationProblem.sessionEnded:
      return context.t('mob.conv.problem.session');
    case ConversationProblem.notEligible:
      return context.t('mob.conv.problem.notEligible');
    case ConversationProblem.general:
      return context.t('mob.conv.problem.general');
  }
}
