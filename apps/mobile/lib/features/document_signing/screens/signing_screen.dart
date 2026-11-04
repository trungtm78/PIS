import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/security/secure_screen.dart';
import '../../../core/session/session.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../../session/session_providers.dart' show biometricGateProvider;
import '../signing_commands.dart';
import '../signing_models.dart';
import '../signing_port.dart';
import '../signing_support.dart';
import 'pdf_pages.dart';

/// MOB-67: the documents that wait for the leader's signature. Without a parameter it lists them (the ones that name the person as
/// signer first); with `?doc=<id>` it opens one: the final PDF to read, the comparison with the version before it, and the signature.
///
/// The signature is two commands on the server (open a session that fixes the digest, complete it with the proof of the signer) and
/// goes through [SigningPort]. Numbering and the seal of the organisation stay with the clerk, on the web. Signing is online only: offline,
/// or on a copy kept on the device, the buttons are disabled with the reason beside them and nothing is queued. What the screen says
/// about the signature is what the server says (`leader_signed_at`, the verdict of the verification): a refusal or a provider that
/// cannot be reached leaves the document awaiting signature and nothing on the screen says signed.
Widget buildSigningScreen(BuildContext context, ScreenContext screen) {
  final String? id = screen.queryParameters['doc'];
  return id == null || id.isEmpty ? SigningWaitingList(screenId: 'MOB-67', title: context.t('mob.signing.list.title')) : SigningDocumentView(documentId: id, title: context.t('mob.signing.detail.title'));
}

/// Builds what a screen adds under the document of the signing view (DOC-22 adds the return of the document with a reason).
typedef SigningFooter = Widget Function(BuildContext context, SigningDocument document, {required bool fromCopy, required VoidCallback onChanged});

/// The documents that wait for the leader, those that name the person as signer first. A row opens the document on [screenId] (MOB-67, or
/// DOC-22 which is the same list with the return of a document added), so one list serves both screens.
class SigningWaitingList extends ConsumerWidget {
  const SigningWaitingList({required this.screenId, required this.title, super.key});

  final String screenId;

  /// The title of the screen, in the words the screen that owns the list passes.
  final String title;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final String? membership = ref.watch(sessionProvider).membershipId;
    return ScreenFrame(
      title: title,
      body: DataView<WaitingList>(
        cacheKey: 'signing.waiting',
        reloadKey: ref.watch(signingChangedProvider),
        read: (MachvonApiClient client) => readMerged(client, 'listOutgoingDocuments', query: <String, Object?>{'status': 'SUBMITTED', 'limit': 50}, maxPages: 4),
        parse: parseWaitingList,
        asOf: (WaitingList list) => list.asOf,
        isEmpty: (WaitingList list) => list.documents.isEmpty,
        builder: (BuildContext context, Loaded<WaitingList> loaded) {
          final List<WaitingDocument> mine = <WaitingDocument>[for (final WaitingDocument d in loaded.value.documents) if (d.signerUserId == membership) d];
          final List<WaitingDocument> others = <WaitingDocument>[for (final WaitingDocument d in loaded.value.documents) if (d.signerUserId != membership) d];
          return ListView(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.all(MachvonSpace.space16),
                child: Text(context.t('mob.signing.list.intro'), style: Theme.of(context).textTheme.bodyMedium),
              ),
              for (final WaitingDocument document in mine) _DocumentRow(document: document, mine: true, screenId: screenId),
              for (final WaitingDocument document in others) _DocumentRow(document: document, mine: false, screenId: screenId),
              if (loaded.value.more)
                Padding(
                  padding: const EdgeInsets.all(MachvonSpace.space16),
                  child: Text(context.t('mob.signing.list.more'), style: Theme.of(context).textTheme.bodySmall),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _DocumentRow extends StatelessWidget {
  const _DocumentRow({required this.document, required this.mine, required this.screenId});

  final WaitingDocument document;
  final bool mine;
  final String screenId;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String facts = context.t('mob.signing.list.row.facts', <String, Object>{'type': document.docTypeCode, 'signer': document.signerTitle ?? ''});
    return TappableRow(
      semanticLabel: context.t('mob.signing.list.row.aria', <String, Object>{'title': document.title, 'facts': facts}),
      onTap: () => openScreen(context, screenId, query: <String, String>{'doc': document.id}, stacked: true),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(document.title, style: theme.textTheme.bodyLarge),
                Text(facts, style: theme.textTheme.bodyMedium),
                if (mine) StatusPill(label: context.t('mob.signing.list.row.yours'), warn: true),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}

/// One document that waits for the leader: the document, its file, the signature, and what the screen that shows it adds under them
/// ([footer]). MOB-67 adds nothing; DOC-22 adds the return of the document with a reason.
class SigningDocumentView extends ConsumerStatefulWidget {
  const SigningDocumentView({required this.documentId, required this.title, this.footer, super.key});

  final String documentId;
  final String title;
  final SigningFooter? footer;

  @override
  ConsumerState<SigningDocumentView> createState() => _SigningDocumentViewState();
}

class _SigningDocumentViewState extends ConsumerState<SigningDocumentView> {
  int _changed = 0;

  @override
  Widget build(BuildContext context) {
    final SigningChanged changes = ref.read(signingChangedProvider.notifier);
    return ScreenFrame(
      title: widget.title,
      body: DataView<SigningDocument>(
        cacheKey: 'signing.document.${widget.documentId}',
        reloadKey: _changed,
        read: (MachvonApiClient client) => client.getOutgoingDocument(id: widget.documentId),
        parse: parseSigningDocument,
        asOf: (SigningDocument document) => document.asOf,
        builder: (BuildContext context, Loaded<SigningDocument> loaded) => _DocumentBody(document: loaded.value, fromCopy: loaded.fromCache, footer: widget.footer, onChanged: () {
          changes.bump();
          setState(() => _changed += 1);
        }),
      ),
    );
  }
}

class _DocumentBody extends ConsumerStatefulWidget {
  const _DocumentBody({required this.document, required this.fromCopy, required this.onChanged, this.footer});

  final SigningDocument document;
  final bool fromCopy;
  final VoidCallback onChanged;
  final SigningFooter? footer;

  @override
  ConsumerState<_DocumentBody> createState() => _DocumentBodyState();
}

class _DocumentBodyState extends ConsumerState<_DocumentBody> with CommandFlow<_DocumentBody> {
  late final SigningCommands _commands = SigningCommands(client: ref.read(apiClientProvider), isOnline: () => deviceIsOnline(ref));
  final TextEditingController _otp = TextEditingController();
  OtpProblem? _otpProblem;
  bool _unlockRefused = false;
  Object? _last;

  /// The sessions that the server refused to complete because their time ran out. The server does not change the stored status of such a
  /// session (it expires it when the next one is opened), so reading the document again still shows it open: the refusal is what says that
  /// a new session has to be started.
  final Set<String> _ranOut = <String>{};

  /// A signing interaction is on: the check of the SDK, the prompt of the phone, the SDK signing, up to the send. It is taken at the first
  /// tap and not at the send, because each step is a native operation that must not run twice at once (the guard of the command only covers
  /// the request).
  bool _interacting = false;

  /// Why the provider's SDK did not make the signature, and what the person can do about it. Nothing was sent to the server for it.
  PortProblem? _port;
  VoidCallback? _portRetry;

  @override
  void dispose() {
    _otp.dispose();
    super.dispose();
  }

  Future<void> _send(Object request, {bool again = false}) async {
    _last = request;
    await run(
      () => request is StartRequest ? _commands.start(request, retryAfterUnknown: again) : _commands.complete(request as CompleteRequest, retryAfterUnknown: again),
      onDone: () {
        _otp.clear();
        widget.onChanged();
      },
    );
    // A refusal leaves the document as it was on the server: read it again so that the screen shows that, and nothing the phone assumed.
    if (!mounted) return;
    final CommandOutcome? result = outcome;
    if (result is CommandRefused) {
      if (request is CompleteRequest && result.code == 'SIGNING_SESSION_EXPIRED') setState(() => _ranOut.add(request.sessionId));
      widget.onChanged();
    }
  }

  /// Opens the session only when the signing method can sign: an SDK that cannot be used, or that holds another certificate than the
  /// registered one, creates nothing on the server (AC-ST-MOB-032-3).
  Future<void> _start() => _interaction(_startSession);

  /// Runs one signing interaction from the first tap to its end, once at a time; the guard is let go on every way out.
  Future<void> _interaction(Future<void> Function() step) async {
    if (_interacting || sending) return;
    setState(() => _interacting = true);
    try {
      await step();
    } finally {
      if (mounted) setState(() => _interacting = false);
    }
  }

  Future<void> _startSession() async {
    final SigningDocument document = widget.document;
    final SigningPort port = ref.read(signingPortProvider);
    final PortProblem? problem = portProblemOfReadiness(await port.readiness(certificate: document.signingCertificate));
    if (!mounted) return;
    setState(() {
      _port = problem;
      _portRetry = problem != null && isPortRetryable(problem) ? _start : null;
    });
    if (problem != null) return;
    await _send(StartRequest(documentId: document.id, version: document.version, certificateId: document.signingCertificate?.id, adapterCode: ref.read(signingPortProvider).adapterCode));
  }

  Future<void> _complete(SigningSession session) => _interaction(() => _completeSession(session));

  Future<void> _completeSession(SigningSession session) async {
    final SigningPort port = ref.read(signingPortProvider);
    final OtpProblem? problem = port.needsTypedCode ? checkOtp(_otp.text) : null;
    setState(() {
      _otpProblem = problem;
      _unlockRefused = false;
      _port = null;
    });
    if (problem != null) return;
    if (port.unlocksCredential) {
      // The prompt of the phone only lets the key be used; its answer is not part of what is sent.
      final bool unlocked = await ref.read(biometricGateProvider).authenticate(reason: context.t('mob.signing.unlock.reason'));
      if (!mounted) return;
      if (!unlocked) {
        setState(() => _unlockRefused = true);
        return;
      }
    }
    final SigningProof? proof;
    final SigningCertificate? bound = widget.document.certificateOf(session);
    try {
      proof = await port.prove(
        SigningChallenge(sessionId: session.id, digestHex: session.digestHex ?? '', expectedSubject: bound?.subject, expectedFingerprint: bound?.fingerprintSha256, label: widget.document.title),
        typedCode: _otp.text,
      );
    } on SigningPortException catch (error) {
      if (!mounted) return;
      final PortProblem problem = portProblemOf(error.kind);
      setState(() {
        _port = problem;
        _portRetry = isPortRetryable(problem) ? () => _complete(session) : null;
      });
      return;
    }
    if (!mounted) return;
    if (proof == null) {
      // The signer closed the SDK's own confirmation (or typed no code): nothing was signed and nothing is sent.
      setState(() {
        if (port.needsTypedCode) {
          _otpProblem = OtpProblem.required;
        } else {
          _unlockRefused = true;
        }
      });
      return;
    }
    setState(() => _port = null);
    await _send(CompleteRequest(sessionId: session.id, version: session.version, proof: proof));
  }

  Widget _portCard(BuildContext context, PortProblem problem) {
    final bool retry = isPortRetryable(problem) && _portRetry != null;
    return OutcomeCard(
      title: portProblemText(context, problem),
      lines: <String>[retry ? context.t('mob.signing.port.retryable.body') : context.t('mob.signing.port.final.body')],
      actionLabel: retry ? context.t('mob.signing.result.retry.action') : null,
      onAction: retry && !_interacting ? _portRetry : null,
    );
  }

  Widget _outcome(BuildContext context, CommandOutcome result) {
    switch (result) {
      case CommandDone():
        return OutcomeCard(title: context.t('mob.signing.result.done.title'), lines: <String>[context.t('mob.signing.result.done.body')]);
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.signing.result.unknown.title'),
          lines: <String>[context.t('mob.signing.result.unknown.body')],
          actionLabel: context.t('mob.signing.result.unknown.action'),
          onAction: _last == null || _interacting ? null : () => _send(_last!, again: true),
        );
      case CommandOffline():
        return OutcomeCard(title: gateText(context, SigningGate.offline));
      case CommandRefused():
        final SigningProblem problem = problemOf(result, completing: _last is CompleteRequest);
        return OutcomeCard(
          title: problemText(context, problem),
          lines: <String>[if (isRetryable(problem)) context.t('mob.signing.result.retryable.body')],
          code: result.code,
          actionLabel: isRetryable(problem) ? context.t('mob.signing.result.retry.action') : null,
          onAction: isRetryable(problem) && _last != null && !_interacting ? () => _send(_last!, again: true) : null,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final SigningDocument document = widget.document;
    final SessionSnapshot session = ref.watch(sessionProvider);
    final SigningGate gate = gateOf(document: document, offline: isOffline(ref), fromCopy: widget.fromCopy, session: session);
    final CommandOutcome? result = outcome;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        if (_port != null) _portCard(context, _port!),
        if (result != null) _outcome(context, result),
        _DocumentCard(document: document),
        _FileCard(document: document),
        if (document.isLeaderSigned) _ResultCard(document: document) else _signCard(context, document, gate),
        if (widget.footer != null) widget.footer!(context, document, fromCopy: widget.fromCopy, onChanged: widget.onChanged),
      ],
    );
  }

  Widget _signCard(BuildContext context, SigningDocument document, SigningGate gate) {
    final ThemeData theme = Theme.of(context);
    final SigningPort port = ref.watch(signingPortProvider);
    final SigningSession? last = document.lastLeaderSession;
    final SigningSession? stored = document.openLeaderSession;
    final bool refused = stored != null && _ranOut.contains(stored.id);
    final SigningSession? open = refused ? null : stored;
    final SigningCertificate? certificate = document.signingCertificate;
    final bool busy = sending || _interacting;
    final bool ready = gate == SigningGate.open && !busy;
    final bool lapsed = open == null && last != null && (refused || last.status == 'EXPIRED');
    return SectionCard(
      title: context.t('mob.signing.sign.title'),
      children: <Widget>[
        FactLine(label: context.t('mob.signing.sign.method'), value: adapterLabel(context, port.adapterCode)),
        if (certificate != null) FactLine(label: context.t('mob.signing.sign.certificate'), value: context.t('mob.signing.sign.certificate.value', <String, Object>{'subject': certificate.subject, 'until': formatDay(certificate.validUntil)})),
        if (certificate == null) Text(context.t('mob.signing.sign.noCertificate'), style: theme.textTheme.bodyMedium),
        if (lapsed) Text(context.t('mob.signing.sign.lapsed'), style: theme.textTheme.bodyMedium),
        const SizedBox(height: MachvonSpace.space8),
        if (gate != SigningGate.open) GateNote(text: gateText(context, gate)),
        if (open == null)
          FilledButton(
            onPressed: ready && certificate != null ? _start : null,
            child: Text(busy ? context.t('mob.signing.sending.label') : lapsed ? context.t('mob.signing.sign.restart.action') : context.t('mob.signing.sign.start.action')),
          )
        else ...<Widget>[
          Text(context.t('mob.signing.sign.open.hint', <String, Object>{'until': formatMoment(open.expiresAt)}), style: theme.textTheme.bodyMedium),
          if (port.needsTypedCode)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
              child: TextField(
                controller: _otp,
                readOnly: busy,
                keyboardType: TextInputType.number,
                autofillHints: const <String>[AutofillHints.oneTimeCode],
                decoration: InputDecoration(labelText: context.t('mob.signing.otp.label'), helperText: context.t('mob.signing.otp.helper'), errorText: _otpProblem == null ? null : otpProblemText(context, _otpProblem!)),
              ),
            ),
          if (_unlockRefused) GateNote(text: context.t('mob.signing.unlock.refused')),
          FilledButton(
            onPressed: ready ? () => _complete(open) : null,
            child: Text(busy ? context.t('mob.signing.sending.label') : context.t('mob.signing.sign.confirm.action')),
          ),
        ],
      ],
    );
  }
}

class _DocumentCard extends StatelessWidget {
  const _DocumentCard({required this.document});

  final SigningDocument document;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: context.t('mob.signing.document.title'),
      children: <Widget>[
        Text(document.title, style: Theme.of(context).textTheme.bodyLarge),
        FactLine(label: context.t('mob.signing.document.type'), value: document.docTypeCode),
        if (document.signerTitle != null) FactLine(label: context.t('mob.signing.document.signer'), value: document.signerTitle!),
        FactLine(label: context.t('mob.signing.document.status'), value: document.isLeaderSigned ? context.t('mob.signing.document.status.signed') : document.isSubmitted ? context.t('mob.signing.document.status.waiting') : context.t('mob.signing.document.status.other')),
        Text(context.t('mob.signing.document.clerk'), style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

class _FileCard extends StatelessWidget {
  const _FileCard({required this.document});

  final SigningDocument document;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final FileVersion? current = document.currentFile;
    final FileVersion? previous = document.previousFile;
    return SectionCard(
      title: context.t('mob.signing.file.title'),
      children: <Widget>[
        if (current == null)
          Text(context.t('mob.signing.file.none'), style: theme.textTheme.bodyMedium)
        else ...<Widget>[
          MergeSemantics(
            child: Text(
              context.t('mob.signing.file.current', <String, Object>{'version': current.version, 'stage': stageLabel(context, current.stage), 'pages': current.pageCount, 'hash': current.checksum.substring(0, current.checksum.length < 12 ? current.checksum.length : 12)}),
              style: theme.textTheme.bodyMedium,
            ),
          ),
          if (!current.isClean) Text(context.t('mob.signing.file.notClean'), style: theme.textTheme.bodyMedium),
          const SizedBox(height: MachvonSpace.space8),
          FilledButton(
            onPressed: current.isClean ? () => Navigator.of(context).push(secureRoute<void>((_) => PdfViewerPage(file: current, title: document.title))) : null,
            child: Text(context.t('mob.signing.file.view.action')),
          ),
          const SizedBox(height: MachvonSpace.space8),
          if (previous != null)
            OutlinedButton(
              onPressed: current.isClean && previous.isClean ? () => Navigator.of(context).push(secureRoute<void>((_) => PdfComparePage(previous: previous, current: current))) : null,
              child: Text(context.t('mob.signing.file.compare.action', <String, Object>{'previous': previous.version})),
            )
          else
            Text(context.t('mob.signing.file.noPrevious'), style: theme.textTheme.bodySmall),
        ],
      ],
    );
  }
}

class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.document});

  final SigningDocument document;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final SignatureVerdict? verdict = document.leaderVerdict;
    final bool? unchanged = document.signedContentUnchanged;
    final bool? sameSigner = document.signerMatchesCertificate;
    final FileVersion? current = document.currentFile;
    return SectionCard(
      title: context.t('mob.signing.result.title'),
      children: <Widget>[
        Text(context.t('mob.signing.result.signed', <String, Object>{'time': formatMoment(document.leaderSignedAt!)}), style: theme.textTheme.bodyLarge),
        if (verdict != null) FactLine(label: context.t('mob.signing.result.verdict'), value: verdictLabel(context, verdict.status)) else Text(context.t('mob.signing.result.noVerdict'), style: theme.textTheme.bodyMedium),
        if (current != null && current.stage == leaderSignedStage) FactLine(label: context.t('mob.signing.result.file'), value: context.t('mob.signing.result.file.value', <String, Object>{'version': current.version, 'stage': stageLabel(context, current.stage)})),
        if (verdict?.subject != null) FactLine(label: context.t('mob.signing.result.signer'), value: verdict!.subject!),
        if (sameSigner == true) Text(context.t('mob.signing.result.identity.match'), style: theme.textTheme.bodyMedium),
        if (sameSigner == false) Text(context.t('mob.signing.result.identity.mismatch'), style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w700)),
        if (unchanged == true) Text(context.t('mob.signing.result.unchanged'), style: theme.textTheme.bodyMedium),
        if (unchanged == false) Text(context.t('mob.signing.result.changed'), style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w700)),
        Text(context.t('mob.signing.result.next'), style: theme.textTheme.bodySmall),
      ],
    );
  }
}
