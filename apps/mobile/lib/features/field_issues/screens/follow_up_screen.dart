import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/attachments/attachment_upload.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/offline_codes.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/session/session.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../../core/widgets/progress.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/status_pill.dart';
import '../../../core/widgets/timeline.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/field_widgets.dart';
import '../../field_evidence/place_format.dart';
import '../../offline/offline_labels.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/offline.dart';
import '../issue_comments.dart';
import '../issue_follow_up.dart';
import '../issue_labels.dart';

/// MOB-31: the follow-up of a report. Opened with the id of the command on this phone, it says where the report stands while it
/// waits for the network or for the answer of the server; once the server holds it, it reads the issue (by the id the server
/// gave back for that command) and shows its status, who handles it, the deadlines the server counted on its working calendar and
/// the exchange so far as a timeline, and takes comments from the bar at its foot. Opened with the id of an issue it shows the issue
/// directly. A report that was dropped is an empty state whose action records a new one.
Widget buildFollowUpScreen(BuildContext context, ScreenContext screen) => FollowUpScreen(reference: screen.pathParameters['ref'] ?? '');

class FollowUpScreen extends ConsumerWidget {
  const FollowUpScreen({required this.reference, super.key});

  final String reference;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<List<QueuedCommand>> commands = ref.watch(queuedCommandsProvider);
    return AppScaffold(
      title: context.t('mob.fld.follow.title'),
      body: commands.when(
        skipLoadingOnReload: true,
        loading: () => const StateBoundary(state: ScreenState.loading, keepContent: false, child: SizedBox.shrink()),
        // Without the store of this phone (nobody is signed in there, or it cannot be opened) the reference is read as the id of
        // an issue on the server.
        error: (Object _, StackTrace _) => _Issue(issueId: reference),
        data: (List<QueuedCommand> all) {
          QueuedCommand? command;
          for (final QueuedCommand candidate in all) {
            if (candidate.id == reference) command = candidate;
          }
          if (command == null) return _Issue(issueId: reference);
          if (command.state == CommandState.accepted) return _Accepted(command: command);
          return _Waiting(command: command);
        },
      ),
    );
  }
}

/// The id of the issue the server made for an accepted command: the one the queue kept, or else the one the server gives when it
/// is asked about the key of the command (a batch answer carries no id).
final _resultOfProvider = FutureProvider.family<String?, String>((Ref ref, String key) async {
  final Object? answer = await ref.read(apiClientProvider).getSyncCommandsKey(idempotencyKey: key);
  return answer is Map ? answer['result_ref'] as String? : null;
});

class _Accepted extends ConsumerWidget {
  const _Accepted({required this.command});

  final QueuedCommand command;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final String? known = command.resultRef;
    if (known != null) return _Issue(issueId: known);
    final AsyncValue<String?> result = ref.watch(_resultOfProvider(command.idempotencyKey));
    return result.when(
      loading: () => const StateBoundary(state: ScreenState.loading, keepContent: false, child: SizedBox.shrink()),
      error: (Object error, StackTrace _) => StateBoundary(
        state: ProblemView.from(error, reachability: ref.watch(reachabilityProvider)).state,
        problem: ProblemView.from(error, reachability: ref.watch(reachabilityProvider)),
        onRetry: () => ref.invalidate(_resultOfProvider(command.idempotencyKey)),
        keepContent: false,
        child: const SizedBox.shrink(),
      ),
      data: (String? issueId) => issueId == null
          ? StateBoundary(
              state: ScreenState.error,
              problem: const ProblemView(state: ScreenState.error, code: 'RESULT_NOT_FOUND'),
              onRetry: () => ref.invalidate(_resultOfProvider(command.idempotencyKey)),
              keepContent: false,
              child: const SizedBox.shrink(),
            )
          : _Issue(issueId: issueId),
    );
  }
}

/// A report that the server does not hold yet: queued, being sent, its answer lost, or refused. Each state is one panel with its words,
/// the stable code and the way on; a report kept for the network says so as the receipt of an offline save ("Saved, will be sent when
/// there is a connection") with the way to the queue.
class _Waiting extends ConsumerWidget {
  const _Waiting({required this.command});

  final QueuedCommand command;

  Future<void> _retry(WidgetRef ref) async => (await ref.read(commandQueueProvider.future)).retry(command.id);

  Future<void> _discard(WidgetRef ref, BuildContext context) async {
    (await ref.read(commandQueueProvider.future)).discard(command.id, deleteDraft: true);
    if (context.mounted) openScreen(context, 'MOB-28');
  }

  void _openQueue(BuildContext context) => openScreen(context, 'MOB-41', stacked: true);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (command.state == CommandState.discarded) {
      return StateView(
        kind: StateKind.empty,
        icon: Icons.inbox_outlined,
        title: context.t('mob.fld.follow.discarded.title'),
        body: context.t('mob.fld.follow.discarded.body'),
        actionLabel: context.t('mob.fld.capture.title'),
        onAction: () => openScreen(context, 'MOB-28'),
        secondaryLabel: context.t('mob.fld.waiting.queue.action'),
        onSecondary: () => _openQueue(context),
      );
    }
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final bool offline = isOffline(ref);
    final String? reason = reasonOf(context, command);
    final String operation = '${command.payload?['client_operation_id'] ?? ''}';
    final List<AttachmentUpload> uploads = <AttachmentUpload>[
      for (final AttachmentUpload upload in ref.watch(attachmentUploadsProvider).asData?.value ?? const <AttachmentUpload>[])
        if (operation.isNotEmpty && upload.ownerKind == 'issue' && upload.ownerRef == operation) upload,
    ];
    final int clean = uploads.where((AttachmentUpload upload) => upload.state == UploadState.clean).length;
    final bool rejected = command.state == CommandState.rejected;
    // A report refused as unverifiable may have been made already: a new key would make it twice, so it is only dropped here.
    final bool canRetry = rejected && command.errorCode != kResultUnverifiable;
    // Offline, a report that waits (or whose send was cut by the lost network) is kept on the phone: that is said first, with the way to the queue.
    final bool saved = offline && (command.state == CommandState.queued || (command.state == CommandState.unknown && command.errorCode == networkErrorCode));
    final Widget panel = switch (command.state) {
      CommandState.queued when saved => const SizedBox.shrink(),
      CommandState.rejected => NoticePanel(tone: NoticeTone.problem, title: _waitingText(context, command.state)),
      CommandState.conflict || CommandState.unknown => NoticePanel(tone: NoticeTone.warning, title: _waitingText(context, command.state)),
      _ => NoticePanel(title: _waitingText(context, command.state)),
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s12, MachvonV2Space.s16, MachvonV2Space.s4),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Semantics(container: true, header: true, child: Text('${command.payload?['title'] ?? ''}', style: text.title)),
                    const SizedBox(height: MachvonV2Space.s8),
                    Semantics(liveRegion: true, child: StatusPill(label: stateLabel(context, command.state), warn: rejected)),
                  ],
                ),
              ),
              if (saved) SavedForLaterPanel(onOpenQueue: () => _openQueue(context)),
              panel,
              if (reason != null) Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s4), child: Text(reason, style: text.body)),
              InfoRow(label: context.t('mob.fld.follow.waiting.code'), value: command.errorCode, divider: false),
              if (uploads.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s12, MachvonV2Space.s16, MachvonV2Space.s4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      Text(context.t('mob.fld.follow.waiting.photos', <String, Object>{'done': clean, 'total': uploads.length}), style: text.caption.copyWith(color: v2.palette.ink2)),
                      const SizedBox(height: MachvonV2Space.s8),
                      ProgressMeter(value: clean / uploads.length),
                    ],
                  ),
                ),
              if (canRetry) WorkRow(title: context.t('mob.fld.waiting.queue.action'), dividerAbove: true, onTap: () => _openQueue(context)),
            ],
          ),
        ),
        if (!saved)
          ActionBar(
            primary: canRetry
                ? ActionBarButton(label: context.t('mob.fld.waiting.retry.action'), onPressed: () => _retry(ref))
                : ActionBarButton(label: context.t('mob.fld.waiting.queue.action'), onPressed: () => _openQueue(context)),
            secondary: rejected ? ActionBarButton(label: context.t('mob.fld.waiting.discard.action'), onPressed: () => _discard(ref, context)) : null,
          ),
      ],
    );
  }
}

String _waitingText(BuildContext context, CommandState state) {
  switch (state) {
    case CommandState.queued:
      return context.t('mob.fld.follow.waiting.queued');
    case CommandState.sending:
      return context.t('mob.fld.follow.waiting.sending');
    case CommandState.unknown:
      return context.t('mob.fld.follow.waiting.unknown');
    case CommandState.rejected:
      return context.t('mob.fld.follow.waiting.rejected');
    case CommandState.conflict:
      return context.t('mob.fld.follow.waiting.conflict');
    case CommandState.discarded:
      return context.t('mob.fld.follow.waiting.discarded');
    case CommandState.accepted:
      return context.t('mob.fld.follow.waiting.accepted');
  }
}

class _Issue extends StatefulWidget {
  const _Issue({required this.issueId});

  final String issueId;

  @override
  State<_Issue> createState() => _IssueState();
}

class _IssueState extends State<_Issue> {
  int _reload = 0;

  @override
  Widget build(BuildContext context) {
    final String id = widget.issueId;
    return DataView<IssueFollowUp>(
      cacheKey: 'issues.view.$id',
      reloadKey: _reload,
      read: (MachvonApiClient client) => client.getResourcesIssueId(id: id, query: <String, Object?>{'limit': 200}),
      parse: parseIssueFollowUp,
      builder: (BuildContext context, Loaded<IssueFollowUp> loaded) => _IssueBody(issue: loaded.value, onCommented: () => setState(() => _reload += 1)),
    );
  }
}

class _IssueBody extends ConsumerStatefulWidget {
  const _IssueBody({required this.issue, required this.onCommented});

  final IssueFollowUp issue;
  final VoidCallback onCommented;

  @override
  ConsumerState<_IssueBody> createState() => _IssueBodyState();
}

class _IssueBodyState extends ConsumerState<_IssueBody> {
  final TextEditingController _note = TextEditingController();
  late final IssueComments _comments = IssueComments(client: ref.read(apiClientProvider), isOnline: () => ref.read(reachabilityProvider) != Reachability.offline);
  CommentOutcome? _outcome;
  CommentFormProblem? _problem;
  bool _sending = false;

  /// The words that left the screen last, exactly as sent. The field stays editable after a lost answer, but "send again" means
  /// this comment (it may already be recorded): reading the field then would send a different comment under the same key.
  String? _sent;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _send({bool retryAfterUnknown = false}) async {
    if (_sending) return;
    final String? settling = retryAfterUnknown ? _sent : null;
    final String words = settling ?? _note.text;
    final CommentFormProblem? problem = checkComment(words);
    setState(() => _problem = settling == null ? problem : null);
    if (problem != null) return;
    _sent = words;
    setState(() {
      _sending = true;
      _outcome = null;
    });
    final CommentOutcome outcome = await _comments.send(widget.issue.id, words, retryAfterUnknown: retryAfterUnknown);
    if (!mounted) return;
    if (outcome is Commented) {
      // Words typed since the send are another comment: they stay.
      if (_note.text == words) _note.clear();
      widget.onCommented();
    }
    setState(() {
      _sending = false;
      _outcome = outcome;
    });
  }

  @override
  Widget build(BuildContext context) {
    final IssueFollowUp issue = widget.issue;
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String language = AppStrings.of(context).language;
    final bool readOnly = ref.watch(sessionProvider).isReadOnly;
    final bool offline = isOffline(ref);
    final List<IssueEvent> events = <IssueEvent>[...issue.events]..sort((IssueEvent a, IssueEvent b) => b.createdAt.compareTo(a.createdAt));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
            children: <Widget>[
              Semantics(
                container: true,
                label: context.t('mob.fld.follow.summary.aria', <String, Object>{'code': issue.code, 'status': statusText(context, issue.status), 'due': formatMoment(issue.dueAt, language: language)}),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s12, MachvonV2Space.s16, MachvonV2Space.s8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Semantics(container: true, header: true, child: Text(issue.title, style: text.title)),
                      const SizedBox(height: MachvonV2Space.s8),
                      Wrap(
                        spacing: MachvonV2Space.s8,
                        runSpacing: MachvonV2Space.s8,
                        children: <Widget>[
                          StatusPill(label: statusText(context, issue.status)),
                          StatusPill(label: severityText(context, issue.severity)),
                          if (issue.isOverdue) StatusPill(label: context.t('mob.fld.follow.overdue'), warn: true),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              InfoRow(label: context.t('mob.fld.follow.code'), value: issue.code),
              InfoRow(label: context.t('mob.fld.follow.project'), value: issue.projectName),
              InfoRow(label: context.t('mob.fld.follow.category'), value: issue.categoryLabel),
              InfoRow(label: context.t('mob.fld.follow.unit'), value: issue.unitName),
              InfoRow(label: context.t('mob.fld.follow.assignee'), value: issue.assignee ?? context.t('mob.fld.follow.assignee.none')),
              if (issue.description != null) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(issue.description!, style: text.body)),
              FormSection(title: context.t('mob.fld.follow.sla.title'), children: const <Widget>[]),
              InfoRow(label: context.t('mob.fld.follow.sla.opened'), value: formatMoment(issue.openedAt, language: language), divider: false),
              InfoRow(label: context.t('mob.fld.follow.sla.responseDue'), value: formatMoment(issue.responseDueAt, language: language)),
              InfoRow(label: context.t('mob.fld.follow.sla.responded'), value: issue.respondedAt == null ? null : formatMoment(issue.respondedAt!, language: language)),
              InfoRow(label: context.t('mob.fld.follow.sla.due'), value: formatMoment(issue.dueAt, language: language)),
              InfoRow(label: context.t('mob.fld.follow.sla.closed'), value: issue.closedAt == null ? null : formatMoment(issue.closedAt!, language: language)),
              Padding(
                padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s8, MachvonV2Space.s16, MachvonV2Space.s8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    if (issue.policyCode != null && issue.responseHours != null && issue.resolveHours != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: MachvonV2Space.s4),
                        child: Text(
                          context.t('mob.fld.follow.sla.policy', <String, Object>{'code': issue.policyCode!, 'response': issue.responseHours!, 'resolve': issue.resolveHours!}),
                          style: text.caption.copyWith(color: v2.palette.ink2),
                        ),
                      ),
                    Text(context.t('mob.fld.follow.sla.server'), style: text.caption.copyWith(color: v2.palette.ink2)),
                  ],
                ),
              ),
              FormSection(
                title: context.t('mob.fld.follow.position.title'),
                children: <Widget>[
                  if (issue.position != null) ...<Widget>[
                    Text(
                      context.t('mob.fld.follow.position.value', <String, Object>{'lat': coordinateLabel(context, issue.position!.latitude), 'lng': coordinateLabel(context, issue.position!.longitude)}),
                      style: text.body,
                    ),
                    if (issue.position!.lowAccuracy) NoticePanel(tone: NoticeTone.warning, title: context.t('mob.fld.place.accuracy.low'), margin: const EdgeInsets.only(top: MachvonV2Space.s8)),
                  ] else
                    Text(issue.geoConsent ? context.t('mob.fld.follow.position.hidden') : context.t('mob.fld.follow.position.none'), style: text.body.copyWith(color: v2.palette.ink2)),
                ],
              ),
              FormSection(
                title: context.t('mob.fld.follow.timeline.title'),
                children: <Widget>[
                  if (events.isEmpty)
                    Text(context.t('mob.fld.follow.timeline.none'), style: text.body.copyWith(color: v2.palette.ink2))
                  else
                    TimelineList(
                      entries: <TimelineEntry>[
                        for (final IssueEvent event in events)
                          TimelineEntry(
                            title: '${eventText(context, event)}${event.actor == null ? '' : ' · ${event.actor}'}',
                            when: formatMoment(event.createdAt, language: language),
                            detail: event.note,
                            icon: event.kind == 'COMMENTED' ? Icons.chat_bubble_outline : null,
                          ),
                      ],
                    ),
                ],
              ),
              if (issue.acceptsComments)
                FormSection(
                  title: context.t('mob.fld.comment.title'),
                  children: <Widget>[
                    if (_outcome != null) _CommentOutcomePanel(outcome: _outcome!, onSendAgain: () => _send(retryAfterUnknown: true)),
                    TextField(
                      controller: _note,
                      maxLines: 4,
                      maxLength: kCommentMax,
                      readOnly: _sending,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: InputDecoration(labelText: context.t('mob.fld.comment.label'), errorText: _problem == null ? null : commentFormText(context, _problem!)),
                    ),
                  ],
                )
              else
                NoticePanel(live: false, title: context.t('mob.fld.comment.closed.notice')),
            ],
          ),
        ),
        if (issue.acceptsComments)
          FieldSendBar(
            label: context.t('mob.fld.comment.action'),
            onSend: readOnly || offline ? null : _send,
            sending: _sending,
            why: readOnly ? context.t('mob.fld.send.readOnly.notice') : (offline ? context.t('mob.fld.comment.needsConnection') : null),
          ),
      ],
    );
  }
}

/// What came of a comment, as one panel: recorded, answer lost (with the way to send the same comment again under the same key), no
/// network, or refused (with the stable code). What the person wrote stays in the field beside it.
class _CommentOutcomePanel extends StatelessWidget {
  const _CommentOutcomePanel({required this.outcome, required this.onSendAgain});

  final CommentOutcome outcome;
  final VoidCallback onSendAgain;

  @override
  Widget build(BuildContext context) {
    const EdgeInsets margin = EdgeInsets.only(bottom: MachvonV2Space.s8);
    final CommentOutcome result = outcome;
    switch (result) {
      case Commented():
        return NoticePanel(tone: NoticeTone.ok, title: context.t('mob.fld.comment.done'), margin: margin);
      case CommentUnknown():
        return NoticePanel(
          tone: NoticeTone.warning,
          title: context.t('mob.fld.comment.unknown.title'),
          lines: <String>[context.t('mob.fld.comment.unknown.body')],
          actionLabel: context.t('mob.fld.comment.unknown.action'),
          onAction: onSendAgain,
          margin: margin,
        );
      case CommentOffline():
        return NoticePanel(title: context.t('mob.fld.comment.needsConnection'), margin: margin);
      case CommentRefused():
        return NoticePanel(tone: NoticeTone.problem, title: commentProblemText(context, commentProblemOf(result.code)), code: result.code, margin: margin);
    }
  }
}
