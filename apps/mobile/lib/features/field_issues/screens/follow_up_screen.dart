import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/attachments/attachment_upload.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/session/session.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../offline/offline_labels.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../../read_support/offline.dart';
import '../../read_support/widgets.dart';
import '../issue_comments.dart';
import '../issue_follow_up.dart';
import '../issue_labels.dart';

/// MOB-31: the follow-up of a report. Opened with the id of the command on this phone, it says where the report stands while it
/// waits for the network or for the answer of the server; once the server holds it, it reads the issue (by the id the server
/// gave back for that command) and shows its status, who handles it, the deadlines the server counted on its working calendar and
/// the exchange so far, and takes comments. Opened with the id of an issue it shows the issue directly.
Widget buildFollowUpScreen(BuildContext context, ScreenContext screen) =>
    FollowUpScreen(reference: screen.pathParameters['ref'] ?? '');

class FollowUpScreen extends ConsumerWidget {
  const FollowUpScreen({required this.reference, super.key});

  final String reference;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<List<QueuedCommand>> commands = ref.watch(
      queuedCommandsProvider,
    );
    return ScreenFrame(
      title: context.t('mob.fld.follow.title'),
      body: commands.when(
        skipLoadingOnReload: true,
        loading: () => const StateBoundary(
          state: ScreenState.loading,
          keepContent: false,
          child: SizedBox.shrink(),
        ),
        // Without the store of this phone (nobody is signed in there, or it cannot be opened) the reference is read as the id of
        // an issue on the server.
        error: (Object _, StackTrace _) => _Issue(issueId: reference),
        data: (List<QueuedCommand> all) {
          QueuedCommand? command;
          for (final QueuedCommand candidate in all) {
            if (candidate.id == reference) command = candidate;
          }
          if (command == null) return _Issue(issueId: reference);
          if (command.state == CommandState.accepted)
            return _Accepted(command: command);
          return _Waiting(command: command);
        },
      ),
    );
  }
}

/// The id of the issue the server made for an accepted command: the one the queue kept, or else the one the server gives when it
/// is asked about the key of the command (a batch answer carries no id).
final _resultOfProvider = FutureProvider.family<String?, String>((
  Ref ref,
  String key,
) async {
  final Object? answer = await ref
      .read(apiClientProvider)
      .getSyncCommandsKey(idempotencyKey: key);
  return answer is Map ? answer['result_ref'] as String? : null;
});

class _Accepted extends ConsumerWidget {
  const _Accepted({required this.command});

  final QueuedCommand command;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final String? known = command.resultRef;
    if (known != null) return _Issue(issueId: known);
    final AsyncValue<String?> result = ref.watch(
      _resultOfProvider(command.idempotencyKey),
    );
    return result.when(
      loading: () => const StateBoundary(
        state: ScreenState.loading,
        keepContent: false,
        child: SizedBox.shrink(),
      ),
      error: (Object error, StackTrace _) => StateBoundary(
        state: ProblemView.from(
          error,
          reachability: ref.watch(reachabilityProvider),
        ).state,
        problem: ProblemView.from(
          error,
          reachability: ref.watch(reachabilityProvider),
        ),
        onRetry: () =>
            ref.invalidate(_resultOfProvider(command.idempotencyKey)),
        keepContent: false,
        child: const SizedBox.shrink(),
      ),
      data: (String? issueId) => issueId == null
          ? StateBoundary(
              state: ScreenState.error,
              problem: const ProblemView(
                state: ScreenState.error,
                code: 'RESULT_NOT_FOUND',
              ),
              onRetry: () =>
                  ref.invalidate(_resultOfProvider(command.idempotencyKey)),
              keepContent: false,
              child: const SizedBox.shrink(),
            )
          : _Issue(issueId: issueId),
    );
  }
}

/// A report that the server does not hold yet: queued, being sent, its answer lost, or refused.
class _Waiting extends ConsumerWidget {
  const _Waiting({required this.command});

  final QueuedCommand command;

  Future<void> _retry(WidgetRef ref) async =>
      (await ref.read(commandQueueProvider.future)).retry(command.id);

  Future<void> _discard(WidgetRef ref, BuildContext context) async {
    (await ref.read(commandQueueProvider.future))
        .discard(command.id, deleteDraft: true);
    if (context.mounted) openScreen(context, 'MOB-28');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ThemeData theme = Theme.of(context);
    final bool offline = isOffline(ref);
    final String? reason = reasonOf(context, command);
    final String operation = '${command.payload?['client_operation_id'] ?? ''}';
    final List<AttachmentUpload> uploads = <AttachmentUpload>[
      for (final AttachmentUpload upload
          in ref.watch(attachmentUploadsProvider).asData?.value ??
              const <AttachmentUpload>[])
        if (operation.isNotEmpty &&
            upload.ownerKind == 'issue' &&
            upload.ownerRef == operation)
          upload,
    ];
    final int clean = uploads
        .where((AttachmentUpload upload) => upload.state == UploadState.clean)
        .length;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: '${command.payload?['title'] ?? ''}',
          children: <Widget>[
            Semantics(
              liveRegion: true,
              child: StatusPill(
                label: stateLabel(context, command.state),
                warn: command.state == CommandState.rejected,
              ),
            ),
            const SizedBox(height: MachvonSpace.space8),
            Text(_waitingText(context, command.state, offline)),
            if (reason != null)
              Padding(
                padding: const EdgeInsets.only(top: MachvonSpace.space8),
                child: Text(reason),
              ),
            if (command.errorCode != null)
              Text(command.errorCode!, style: theme.textTheme.bodySmall),
            if (uploads.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: MachvonSpace.space8),
                child: Text(
                  context.t('mob.fld.follow.waiting.photos', <String, Object>{
                    'done': clean,
                    'total': uploads.length,
                  }),
                ),
              ),
            const SizedBox(height: MachvonSpace.space12),
            if (command.state == CommandState.rejected) ...<Widget>[
              FilledButton(
                onPressed: () => _retry(ref),
                child: Text(context.t('mob.fld.waiting.retry.action')),
              ),
              TextButton(
                onPressed: () => _discard(ref, context),
                child: Text(context.t('mob.fld.waiting.discard.action')),
              ),
            ],
            OutlinedButton(
              onPressed: () => openScreen(context, 'MOB-41', stacked: true),
              child: Text(context.t('mob.fld.waiting.queue.action')),
            ),
          ],
        ),
      ],
    );
  }
}

String _waitingText(BuildContext context, CommandState state, bool offline) {
  switch (state) {
    case CommandState.queued:
      return offline
          ? context.t('mob.fld.follow.waiting.queuedOffline')
          : context.t('mob.fld.follow.waiting.queued');
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
      read: (MachvonApiClient client) => client.getResourcesIssueId(
        id: id,
        query: <String, Object?>{'limit': 200},
      ),
      parse: parseIssueFollowUp,
      builder: (BuildContext context, Loaded<IssueFollowUp> loaded) =>
          _IssueBody(
            issue: loaded.value,
            fromCopy: loaded.fromCache,
            onCommented: () => setState(() => _reload += 1),
          ),
    );
  }
}

class _IssueBody extends ConsumerStatefulWidget {
  const _IssueBody({
    required this.issue,
    required this.fromCopy,
    required this.onCommented,
  });

  final IssueFollowUp issue;
  final bool fromCopy;
  final VoidCallback onCommented;

  @override
  ConsumerState<_IssueBody> createState() => _IssueBodyState();
}

class _IssueBodyState extends ConsumerState<_IssueBody> {
  final TextEditingController _note = TextEditingController();
  late final IssueComments _comments = IssueComments(
    client: ref.read(apiClientProvider),
    isOnline: () => ref.read(reachabilityProvider) != Reachability.offline,
  );
  CommentOutcome? _outcome;
  CommentFormProblem? _problem;
  bool _sending = false;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _send({bool retryAfterUnknown = false}) async {
    if (_sending) return;
    final CommentFormProblem? problem = checkComment(_note.text);
    setState(() => _problem = problem);
    if (problem != null) return;
    setState(() {
      _sending = true;
      _outcome = null;
    });
    final CommentOutcome outcome = await _comments.send(
      widget.issue.id,
      _note.text,
      retryAfterUnknown: retryAfterUnknown,
    );
    if (!mounted) return;
    if (outcome is Commented) {
      _note.clear();
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
    final ThemeData theme = Theme.of(context);
    final bool readOnly = ref.watch(sessionProvider).isReadOnly;
    final bool offline = isOffline(ref);
    final List<IssueEvent> events = <IssueEvent>[
      ...issue.events,
    ]..sort((IssueEvent a, IssueEvent b) => b.createdAt.compareTo(a.createdAt));
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: issue.title,
          semanticLabel: context.t(
            'mob.fld.follow.summary.aria',
            <String, Object>{
              'code': issue.code,
              'status': statusText(context, issue.status),
              'due': formatMoment(issue.dueAt),
            },
          ),
          children: <Widget>[
            Wrap(
              spacing: MachvonSpace.space8,
              children: <Widget>[
                StatusPill(label: statusText(context, issue.status)),
                StatusPill(label: severityText(context, issue.severity)),
                if (issue.isOverdue)
                  StatusPill(
                    label: context.t('mob.fld.follow.overdue'),
                    warn: true,
                  ),
              ],
            ),
            const SizedBox(height: MachvonSpace.space8),
            FactLine(
              label: context.t('mob.fld.follow.code'),
              value: issue.code,
            ),
            if (issue.projectName != null)
              FactLine(
                label: context.t('mob.fld.follow.project'),
                value: issue.projectName!,
              ),
            if (issue.categoryLabel != null)
              FactLine(
                label: context.t('mob.fld.follow.category'),
                value: issue.categoryLabel!,
              ),
            if (issue.unitName != null)
              FactLine(
                label: context.t('mob.fld.follow.unit'),
                value: issue.unitName!,
              ),
            FactLine(
              label: context.t('mob.fld.follow.assignee'),
              value:
                  issue.assignee ?? context.t('mob.fld.follow.assignee.none'),
            ),
            if (issue.description != null)
              Padding(
                padding: const EdgeInsets.only(top: MachvonSpace.space8),
                child: Text(issue.description!),
              ),
          ],
        ),
        SectionCard(
          title: context.t('mob.fld.follow.sla.title'),
          children: <Widget>[
            FactLine(
              label: context.t('mob.fld.follow.sla.opened'),
              value: formatMoment(issue.openedAt),
            ),
            FactLine(
              label: context.t('mob.fld.follow.sla.responseDue'),
              value: formatMoment(issue.responseDueAt),
            ),
            if (issue.respondedAt != null)
              FactLine(
                label: context.t('mob.fld.follow.sla.responded'),
                value: formatMoment(issue.respondedAt!),
              ),
            FactLine(
              label: context.t('mob.fld.follow.sla.due'),
              value: formatMoment(issue.dueAt),
            ),
            if (issue.closedAt != null)
              FactLine(
                label: context.t('mob.fld.follow.sla.closed'),
                value: formatMoment(issue.closedAt!),
              ),
            if (issue.policyCode != null &&
                issue.responseHours != null &&
                issue.resolveHours != null)
              Text(
                context.t('mob.fld.follow.sla.policy', <String, Object>{
                  'code': issue.policyCode!,
                  'response': issue.responseHours!,
                  'resolve': issue.resolveHours!,
                }),
                style: theme.textTheme.bodySmall,
              ),
            Text(
              context.t('mob.fld.follow.sla.server'),
              style: theme.textTheme.bodySmall,
            ),
          ],
        ),
        SectionCard(
          title: context.t('mob.fld.follow.position.title'),
          children: <Widget>[
            if (issue.position != null) ...<Widget>[
              Text(
                context.t('mob.fld.follow.position.value', <String, Object>{
                  'lat': issue.position!.latitude,
                  'lng': issue.position!.longitude,
                }),
              ),
              if (issue.position!.lowAccuracy)
                Text(context.t('mob.fld.place.accuracy.low')),
            ] else
              Text(
                issue.geoConsent
                    ? context.t('mob.fld.follow.position.hidden')
                    : context.t('mob.fld.follow.position.none'),
              ),
          ],
        ),
        SectionCard(
          title: context.t('mob.fld.follow.timeline.title'),
          children: <Widget>[
            if (events.isEmpty) Text(context.t('mob.fld.follow.timeline.none')),
            for (final IssueEvent event in events)
              MergeSemantics(
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    vertical: MachvonSpace.space4,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        '${eventText(context, event)}${event.actor == null ? '' : ' · ${event.actor}'}',
                        style: theme.textTheme.titleSmall,
                      ),
                      Text(
                        formatMoment(event.createdAt),
                        style: theme.textTheme.bodySmall,
                      ),
                      if (event.note != null) Text(event.note!),
                    ],
                  ),
                ),
              ),
          ],
        ),
        if (issue.acceptsComments)
          SectionCard(
            title: context.t('mob.fld.comment.title'),
            children: <Widget>[
              if (_outcome != null)
                _CommentOutcomeCard(
                  outcome: _outcome!,
                  onSendAgain: () => _send(retryAfterUnknown: true),
                ),
              TextField(
                controller: _note,
                maxLines: 4,
                maxLength: kCommentMax,
                readOnly: _sending,
                decoration: InputDecoration(
                  labelText: context.t('mob.fld.comment.label'),
                  errorText: _problem == null
                      ? null
                      : commentFormText(context, _problem!),
                ),
              ),
              if (offline || widget.fromCopy)
                Padding(
                  padding: const EdgeInsets.only(bottom: MachvonSpace.space8),
                  child: Text(context.t('mob.fld.comment.needsConnection')),
                ),
              if (readOnly)
                Padding(
                  padding: const EdgeInsets.only(bottom: MachvonSpace.space8),
                  child: Text(context.t('mob.fld.send.readOnly.notice')),
                ),
              FilledButton(
                onPressed: _sending || readOnly ? null : _send,
                child: Text(
                  _sending
                      ? context.t('mob.fld.comment.pending')
                      : context.t('mob.fld.comment.action'),
                ),
              ),
            ],
          )
        else
          Padding(
            padding: const EdgeInsets.all(MachvonSpace.space16),
            child: Text(context.t('mob.fld.comment.closed.notice')),
          ),
      ],
    );
  }
}

class _CommentOutcomeCard extends StatelessWidget {
  const _CommentOutcomeCard({required this.outcome, required this.onSendAgain});

  final CommentOutcome outcome;
  final VoidCallback onSendAgain;

  @override
  Widget build(BuildContext context) {
    final CommentOutcome result = outcome;
    final List<Widget> children;
    switch (result) {
      case Commented():
        children = <Widget>[Text(context.t('mob.fld.comment.done'))];
      case CommentUnknown():
        children = <Widget>[
          Text(
            context.t('mob.fld.comment.unknown.title'),
            style: Theme.of(context).textTheme.titleSmall,
          ),
          Text(context.t('mob.fld.comment.unknown.body')),
          OutlinedButton(
            onPressed: onSendAgain,
            child: Text(context.t('mob.fld.comment.unknown.action')),
          ),
        ];
      case CommentOffline():
        children = <Widget>[Text(context.t('mob.fld.comment.needsConnection'))];
      case CommentRefused():
        children = <Widget>[
          Text(commentProblemText(context, commentProblemOf(result.code))),
          Text(result.code, style: Theme.of(context).textTheme.bodySmall),
        ];
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space8),
      child: Semantics(
        liveRegion: true,
        container: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        ),
      ),
    );
  }
}
