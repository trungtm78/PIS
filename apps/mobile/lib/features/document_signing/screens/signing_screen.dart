import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/security/secure_screen.dart';
import '../../../core/session/session.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/sheets.dart';
import '../../../core/widgets/stage_strip.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/status_pill.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/command_flow.dart' show CommandFlow, deviceIsOnline;
import '../../command_support/command_outcome.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../session/session_providers.dart' show biometricGateProvider;
import '../signing_commands.dart';
import '../signing_models.dart';
import '../signing_port.dart';
import '../signing_support.dart';
import 'pdf_pages.dart';
import 'signing_notice.dart';

/// MOB-67: the documents that wait for the leader's signature. Without a parameter it lists them (the ones that name the person as signer
/// first); with `?doc=<id>` it opens one: the final PDF to read, the comparison with the version before it, and the signature.
///
/// The signature is two commands on the server (open a session that fixes the digest, complete it with the proof of the signer) and
/// goes through [SigningPort]. Numbering and the seal of the organisation stay with the clerk, on the web. Signing is online only: offline,
/// or on a copy kept on the device, the buttons are disabled with the reason beside them and nothing is queued. What the screen says
/// about the signature is what the server says (`leader_signed_at`, the verdict of the verification): a refusal or a provider that
/// cannot be reached leaves the document awaiting signature and nothing on the screen says signed.
///
/// The consequential tap, "confirm and sign", opens a sheet that says what the signature does and that it is written to the audit log;
/// the signature is made only when the person confirms there.
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
    return AppScaffold(
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
                padding: const EdgeInsets.all(MachvonV2Space.s16),
                child: Text(context.t('mob.signing.list.intro'), style: context.v2text.caption.copyWith(color: context.v2.palette.ink2)),
              ),
              if (mine.isNotEmpty) GroupHeader(title: context.t('mob.signing.list.group.mine'), count: mine.length),
              for (int index = 0; index < mine.length; index += 1) _DocumentRow(document: mine[index], mine: true, screenId: screenId, dividerAbove: index > 0),
              if (others.isNotEmpty) GroupHeader(title: context.t('mob.signing.list.group.others'), count: others.length),
              for (int index = 0; index < others.length; index += 1) _DocumentRow(document: others[index], mine: false, screenId: screenId, dividerAbove: index > 0),
              if (loaded.value.more) StatusBanner(text: context.t('mob.signing.list.more'), tone: BannerTone.warning),
            ],
          );
        },
      ),
    );
  }
}

class _DocumentRow extends StatelessWidget {
  const _DocumentRow({required this.document, required this.mine, required this.screenId, required this.dividerAbove});

  final WaitingDocument document;
  final bool mine;
  final String screenId;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Palette p = context.v2.palette;
    final String facts = context.t('mob.signing.list.row.facts', <String, Object>{'type': document.docTypeCode, 'signer': document.signerTitle ?? ''});
    return WorkRow(
      title: document.title,
      subtitle: facts,
      leading: ExcludeSemantics(
        child: SizedBox(
          width: MachvonV2Size.glyph,
          height: MachvonV2Size.glyph,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(MachvonV2Radius.glyph),
            child: ColoredBox(color: mine ? p.soonBg : p.sunken, child: Icon(Icons.draw_outlined, size: 22, color: mine ? p.soonFg : p.ink2)),
          ),
        ),
      ),
      trailing: mine ? StatusPill(label: context.t('mob.signing.list.row.yours'), warn: true) : null,
      semanticLabel: context.t('mob.signing.list.row.aria', <String, Object>{'title': document.title, 'facts': facts}),
      dividerAbove: dividerAbove,
      onTap: () => openScreen(context, screenId, query: <String, String>{'doc': document.id}, stacked: true),
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
    return AppScaffold(
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

  /// The tap on "confirm and sign": the code of the provider is checked first (a missing code needs no sheet), then the sheet says what the
  /// signature does and that it is written to the audit log; only its confirmation goes on to the signature.
  Future<void> _confirmAndSign(SigningSession session) async {
    if (_interacting || sending) return;
    final SigningPort port = ref.read(signingPortProvider);
    final OtpProblem? problem = port.needsTypedCode ? checkOtp(_otp.text) : null;
    if (problem != null) {
      setState(() {
        _otpProblem = problem;
        _unlockRefused = false;
      });
      return;
    }
    final SigningDocument document = widget.document;
    final FileVersion? file = document.currentFile;
    final SigningCertificate? certificate = document.certificateOf(session);
    final bool confirmed = await showConfirmSheet(
      context,
      title: context.t('mob.signing.confirm.title'),
      facts: <String>[
        context.t('mob.signing.confirm.fact.document', <String, Object>{
          'title': document.title,
          'version': file?.version ?? 0,
          'hash': file == null ? '' : file.checksum.substring(0, file.checksum.length < 12 ? file.checksum.length : 12),
        }),
        if (certificate != null) context.t('mob.signing.confirm.fact.certificate', <String, Object>{'subject': certificate.subject}),
        context.t('mob.signing.confirm.fact.effect'),
      ],
      confirmLabel: context.t('mob.signing.confirm.action'),
      cancelLabel: context.t('mob.signing.confirm.cancel'),
      auditNote: context.t('mob.signing.confirm.audit'),
    );
    if (!confirmed || !mounted) return;
    await _complete(session);
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

  Widget _portNotice(BuildContext context, PortProblem problem) {
    final bool retry = isPortRetryable(problem) && _portRetry != null;
    return SigningNotice(
      title: portProblemText(context, problem),
      lines: <String>[retry ? context.t('mob.signing.port.retryable.body') : context.t('mob.signing.port.final.body')],
      actionLabel: retry ? context.t('mob.signing.result.retry.action') : null,
      onAction: retry && !_interacting ? _portRetry : null,
    );
  }

  Widget _outcome(BuildContext context, CommandOutcome result) {
    switch (result) {
      case CommandDone():
        return SigningNotice(tone: NoticeTone.done, title: context.t('mob.signing.result.done.title'), lines: <String>[context.t('mob.signing.result.done.body')]);
      case CommandUnknown():
        return SigningNotice(
          tone: NoticeTone.warning,
          title: context.t('mob.signing.result.unknown.title'),
          lines: <String>[context.t('mob.signing.result.unknown.body')],
          actionLabel: context.t('mob.signing.result.unknown.action'),
          onAction: _last == null || _interacting ? null : () => _send(_last!, again: true),
        );
      case CommandOffline():
        return SigningNotice(tone: NoticeTone.info, title: gateText(context, SigningGate.offline));
      case CommandRefused():
        final SigningProblem problem = problemOf(result, completing: _last is CompleteRequest);
        return SigningNotice(
          title: problemText(context, problem),
          lines: <String>[if (isRetryable(problem)) context.t('mob.signing.result.retryable.body')],
          code: result.code,
          actionLabel: isRetryable(problem) ? context.t('mob.signing.result.retry.action') : null,
          onAction: isRetryable(problem) && _last != null && !_interacting ? () => _send(_last!, again: true) : null,
        );
    }
  }

  void _openViewer(FileVersion file) => Navigator.of(context).push(secureRoute<void>((_) => PdfViewerPage(file: file, title: widget.document.title)));

  @override
  Widget build(BuildContext context) {
    final SigningDocument document = widget.document;
    final SessionSnapshot session = ref.watch(sessionProvider);
    final SigningGate gate = gateOf(document: document, offline: isOffline(ref), fromCopy: widget.fromCopy, session: session);
    final CommandOutcome? result = outcome;
    final FileVersion? current = document.currentFile;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (_port != null) _portNotice(context, _port!),
                if (result != null) _outcome(context, result),
                _DocumentHeader(document: document),
                if (document.isLeaderSigned) _ResultSection(document: document) else _signSection(context, document),
                _FileSection(document: document),
                if (widget.footer != null) widget.footer!(context, document, fromCopy: widget.fromCopy, onChanged: widget.onChanged),
              ],
            ),
          ),
        ),
        if (!document.isLeaderSigned)
          _signBar(context, document, gate, current)
        else if (current != null)
          ActionBar(primary: ActionBarButton(label: context.t('mob.signing.file.view.action'), icon: Icons.picture_as_pdf_outlined, onPressed: current.isClean ? () => _openViewer(current) : null)),
      ],
    );
  }

  /// The facts of the signature: how, with which certificate, the open session and the code field. The button is in the bar under the list.
  Widget _signSection(BuildContext context, SigningDocument document) {
    final MachvonV2Text text = context.v2text;
    final SigningPort port = ref.watch(signingPortProvider);
    final SigningSession? last = document.lastLeaderSession;
    final SigningSession? stored = document.openLeaderSession;
    final bool refused = stored != null && _ranOut.contains(stored.id);
    final SigningSession? open = refused ? null : stored;
    final SigningCertificate? certificate = document.signingCertificate;
    final bool busy = sending || _interacting;
    final bool lapsed = open == null && last != null && (refused || last.status == 'EXPIRED');
    return SigningSection(
      title: context.t('mob.signing.sign.title'),
      children: <Widget>[
        InfoRow(label: context.t('mob.signing.sign.method'), value: adapterLabel(context, port.adapterCode), divider: false),
        if (certificate != null) InfoRow(label: context.t('mob.signing.sign.certificate'), value: context.t('mob.signing.sign.certificate.value', <String, Object>{'subject': certificate.subject, 'until': formatDay(certificate.validUntil)})),
        if (certificate == null || lapsed || open != null || _unlockRefused)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (certificate == null) Text(context.t('mob.signing.sign.noCertificate'), style: text.body),
                if (lapsed) Text(context.t('mob.signing.sign.lapsed'), style: text.body),
                if (open != null) ...<Widget>[
                  Text(context.t('mob.signing.sign.open.hint', <String, Object>{'until': formatMoment(open.expiresAt)}), style: text.body),
                  if (port.needsTypedCode)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
                      child: TextField(
                        controller: _otp,
                        readOnly: busy,
                        keyboardType: TextInputType.number,
                        autofillHints: const <String>[AutofillHints.oneTimeCode],
                        decoration: InputDecoration(labelText: context.t('mob.signing.otp.label'), helperText: context.t('mob.signing.otp.helper'), errorText: _otpProblem == null ? null : otpProblemText(context, _otpProblem!)),
                      ),
                    ),
                ],
                if (_unlockRefused) Semantics(liveRegion: true, child: Text(context.t('mob.signing.unlock.refused'), style: text.body.copyWith(color: context.v2.palette.lateFg))),
              ],
            ),
          ),
      ],
    );
  }

  /// The bar under the list: the one primary action of the screen, locked with its reason written beside it when the gate is closed; the
  /// second button reads the file.
  Widget _signBar(BuildContext context, SigningDocument document, SigningGate gate, FileVersion? current) {
    final SigningSession? stored = document.openLeaderSession;
    final SigningSession? last = document.lastLeaderSession;
    final bool refused = stored != null && _ranOut.contains(stored.id);
    final SigningSession? open = refused ? null : stored;
    final bool busy = sending || _interacting;
    final bool ready = gate == SigningGate.open && !busy;
    final bool lapsed = open == null && last != null && (refused || last.status == 'EXPIRED');
    final bool canSign = document.signingCertificate != null;
    final String label = busy
        ? context.t('mob.signing.sending.label')
        : open != null
            ? context.t('mob.signing.sign.confirm.action')
            : lapsed
                ? context.t('mob.signing.sign.restart.action')
                : context.t('mob.signing.sign.start.action');
    final VoidCallback? press = open != null ? (ready ? () => _confirmAndSign(open) : null) : (ready && canSign ? _start : null);
    return ActionBar(
      primary: ActionBarButton(label: label, onPressed: press),
      secondary: current == null ? null : ActionBarButton(label: context.t('mob.signing.file.view.action'), icon: Icons.picture_as_pdf_outlined, onPressed: current.isClean ? () => _openViewer(current) : null),
      why: gate == SigningGate.open ? null : gateText(context, gate),
    );
  }
}

/// The head of the document: its title, where it stands in the three steps (submitted, the leader's signature, numbering and the seal of the
/// clerk) and its facts. A fact that is not known is not drawn.
class _DocumentHeader extends StatelessWidget {
  const _DocumentHeader({required this.document});

  final SigningDocument document;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final String status = document.isLeaderSigned
        ? context.t('mob.signing.document.status.signed')
        : document.isSubmitted
            ? context.t('mob.signing.document.status.waiting')
            : context.t('mob.signing.document.status.other');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s8),
          child: Semantics(container: true, header: true, child: Text(document.title, style: text.heading)),
        ),
        if (document.isLeaderSigned || document.isSubmitted)
          StageStrip(
            total: 3,
            current: document.isLeaderSigned ? 3 : 2,
            currentFraction: document.isLeaderSigned ? 0 : 0.5,
            label: document.isLeaderSigned ? context.t('mob.signing.stage.strip.signed') : context.t('mob.signing.stage.strip.waiting'),
          ),
        const SizedBox(height: MachvonV2Space.s8),
        InfoRow(label: context.t('mob.signing.document.type'), value: document.docTypeCode),
        InfoRow(label: context.t('mob.signing.document.signer'), value: document.signerTitle),
        InfoRow(label: context.t('mob.signing.document.status'), value: status),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
          child: Text(context.t('mob.signing.document.clerk'), style: text.caption.copyWith(color: context.v2.palette.ink2)),
        ),
      ],
    );
  }
}

class _FileSection extends StatelessWidget {
  const _FileSection({required this.document});

  final SigningDocument document;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final FileVersion? current = document.currentFile;
    final FileVersion? previous = document.previousFile;
    return SigningSection(
      title: context.t('mob.signing.file.title'),
      padded: true,
      children: <Widget>[
        if (current == null)
          Text(context.t('mob.signing.file.none'), style: text.body)
        else ...<Widget>[
          MergeSemantics(
            child: Text(
              context.t('mob.signing.file.current', <String, Object>{'version': current.version, 'stage': stageLabel(context, current.stage), 'pages': current.pageCount, 'hash': current.checksum.substring(0, current.checksum.length < 12 ? current.checksum.length : 12)}),
              style: text.body,
            ),
          ),
          if (!current.isClean) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(context.t('mob.signing.file.notClean'), style: text.body.copyWith(color: context.v2.palette.soonFg))),
          const SizedBox(height: MachvonV2Space.s12),
          if (previous != null)
            OutlinedButton(
              onPressed: current.isClean && previous.isClean ? () => Navigator.of(context).push(secureRoute<void>((_) => PdfComparePage(previous: previous, current: current))) : null,
              child: Text(context.t('mob.signing.file.compare.action', <String, Object>{'previous': previous.version}), textAlign: TextAlign.center),
            )
          else
            Text(context.t('mob.signing.file.noPrevious'), style: text.caption.copyWith(color: context.v2.palette.ink2)),
        ],
      ],
    );
  }
}

class _ResultSection extends StatelessWidget {
  const _ResultSection({required this.document});

  final SigningDocument document;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final MachvonV2Palette p = context.v2.palette;
    final SignatureVerdict? verdict = document.leaderVerdict;
    final bool? unchanged = document.signedContentUnchanged;
    final bool? sameSigner = document.signerMatchesCertificate;
    final FileVersion? current = document.currentFile;
    return SigningSection(
      title: context.t('mob.signing.result.title'),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
          child: Text(context.t('mob.signing.result.signed', <String, Object>{'time': formatMoment(document.leaderSignedAt!)}), style: text.bodyStrong),
        ),
        if (verdict != null)
          InfoRow(label: context.t('mob.signing.result.verdict'), value: verdictLabel(context, verdict.status))
        else
          Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8), child: Text(context.t('mob.signing.result.noVerdict'), style: text.body)),
        if (current != null && current.stage == leaderSignedStage) InfoRow(label: context.t('mob.signing.result.file'), value: context.t('mob.signing.result.file.value', <String, Object>{'version': current.version, 'stage': stageLabel(context, current.stage)})),
        InfoRow(label: context.t('mob.signing.result.signer'), value: verdict?.subject),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              if (sameSigner == true) Text(context.t('mob.signing.result.identity.match'), style: text.body),
              if (sameSigner == false) Text(context.t('mob.signing.result.identity.mismatch'), style: text.bodyStrong.copyWith(color: p.lateFg)),
              if (unchanged == true) Text(context.t('mob.signing.result.unchanged'), style: text.body),
              if (unchanged == false) Text(context.t('mob.signing.result.changed'), style: text.bodyStrong.copyWith(color: p.lateFg)),
              Text(context.t('mob.signing.result.next'), style: text.caption.copyWith(color: p.ink2)),
            ],
          ),
        ),
      ],
    );
  }
}
