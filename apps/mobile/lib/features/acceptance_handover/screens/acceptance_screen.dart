import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/sheets.dart';
import '../../../core/widgets/stage_strip.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../acceptance_commands.dart';
import '../acceptance_models.dart';
import '../acceptance_support.dart';
import '../widgets/fact_row.dart';

/// MOB-65: quality acceptance minutes on the phone. Without a parameter it lists the minutes that wait for signatures or for a
/// decision, those the person can act on first; with `?acceptance=<id>` it shows one set of minutes: the minutes, the work they
/// accept, the evidence (who signed, how, and what each signature is worth), the opinion and the decision.
///
/// Signing and approving are online only (MOB.md 3, L3): offline, or on a copy kept on the device, the action bar is disabled with
/// the reason above it and nothing is queued. Every signature and decision is confirmed in a sheet that says what it does, then sent.
/// The server checks the right, the scope, the version and the licence again, and refuses with a reason the screen words
/// (`SIGNATURES_INCOMPLETE` names the roles still missing; `VERSION_CONFLICT` offers to read the minutes again, never to overwrite).
Widget buildAcceptanceScreen(BuildContext context, ScreenContext screen) {
  final String? id = screen.queryParameters['acceptance'];
  return id == null || id.isEmpty ? const _MinutesListScreen() : _MinutesScreen(minutesId: id);
}

StatusPill _statusPill(BuildContext context, String status) {
  final MachvonTone tone = switch (status) {
    'APPROVED' => MachvonTone.success,
    'REJECTED' || 'REVOKED' => MachvonTone.danger,
    'SIGNING' => MachvonTone.info,
    _ => MachvonTone.neutral,
  };
  return StatusPill(label: statusLabel(context, status), tone: tone);
}

class _MinutesListScreen extends StatelessWidget {
  const _MinutesListScreen();

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.acceptance.list.title'),
      body: DataView<MinutesList>(
        cacheKey: 'acceptance.minutes',
        read: (MachvonApiClient client) => client.listQualityAcceptances(),
        parse: parseMinutesList,
        asOf: (MinutesList list) => list.asOf,
        isEmpty: (MinutesList list) => list.items.isEmpty,
        builder: (BuildContext context, Loaded<MinutesList> loaded) {
          final List<Minutes> mine = <Minutes>[for (final Minutes m in loaded.value.items) if (_isMine(m)) m];
          final List<Minutes> others = <Minutes>[for (final Minutes m in loaded.value.items) if (!_isMine(m)) m];
          return ListView(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s4, MachvonV2Space.s16, MachvonV2Space.s12),
                child: Text(context.t('mob.acceptance.list.intro'), style: context.v2text.caption.copyWith(color: context.v2.palette.ink2)),
              ),
              if (mine.isNotEmpty) GroupHeader(title: context.t('mob.acceptance.list.row.yours'), count: mine.length),
              for (int index = 0; index < mine.length; index += 1) _MinutesRow(minutes: mine[index], dividerAbove: index > 0),
              if (others.isNotEmpty) GroupHeader(title: context.t('mob.acceptance.list.group.others'), count: others.length),
              for (int index = 0; index < others.length; index += 1) _MinutesRow(minutes: others[index], dividerAbove: index > 0),
            ],
          );
        },
      ),
    );
  }
}

bool _isMine(Minutes minutes) => minutes.canSign || minutes.canApprove || minutes.canReject;

class _MinutesRow extends StatelessWidget {
  const _MinutesRow({required this.minutes, required this.dividerAbove});

  final Minutes minutes;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final String status = statusLabel(context, minutes.status);
    final String? missing = minutes.missingRoles.isEmpty ? null : context.t('mob.acceptance.list.row.missing', <String, Object>{'roles': rolesLabel(context, minutes.missingRoles)});
    return FactRow(
      title: minutes.recordNo,
      lines: <String>[
        context.t('mob.acceptance.list.row.facts', <String, Object>{'contract': minutes.contractCode, 'scope': scopeLabel(context, minutes.scope)}),
        ?missing,
      ],
      trailing: _statusPill(context, minutes.status),
      dividerAbove: dividerAbove,
      semanticLabel: <String>[
        context.t('mob.acceptance.list.row.aria', <String, Object>{'no': minutes.recordNo, 'contract': minutes.contractCode, 'status': status}),
        ?missing,
      ].join('. '),
      onTap: () => openScreen(context, 'MOB-65', query: <String, String>{'acceptance': minutes.id}, stacked: true),
    );
  }
}

class _MinutesScreen extends StatefulWidget {
  const _MinutesScreen({required this.minutesId});

  final String minutesId;

  @override
  State<_MinutesScreen> createState() => _MinutesScreenState();
}

class _MinutesScreenState extends State<_MinutesScreen> {
  int _changed = 0;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.acceptance.detail.title'),
      body: DataView<Minutes>(
        cacheKey: 'acceptance.minutes.${widget.minutesId}',
        reloadKey: _changed,
        read: (MachvonApiClient client) => client.getQualityAcceptance(id: widget.minutesId),
        parse: parseMinutes,
        asOf: (Minutes minutes) => minutes.asOf,
        builder: (BuildContext context, Loaded<Minutes> loaded) => _MinutesBody(minutes: loaded.value, fromCopy: loaded.fromCache, onChanged: () => setState(() => _changed += 1)),
      ),
    );
  }
}

class _MinutesBody extends ConsumerStatefulWidget {
  const _MinutesBody({required this.minutes, required this.fromCopy, required this.onChanged});

  final Minutes minutes;
  final bool fromCopy;
  final VoidCallback onChanged;

  @override
  ConsumerState<_MinutesBody> createState() => _MinutesBodyState();
}

class _MinutesBodyState extends ConsumerState<_MinutesBody> with CommandFlow<_MinutesBody> {
  late final AcceptanceCommands _commands = AcceptanceCommands(client: ref.read(apiClientProvider), isOnline: () => deviceIsOnline(ref));
  final TextEditingController _reason = TextEditingController();
  final TextEditingController _serial = TextEditingController();
  late String? _role = widget.minutes.signableRoles.length == 1 ? widget.minutes.signableRoles.first : null;
  String _method = signatureMethods.first;
  Map<String, FormProblem> _problems = const <String, FormProblem>{};
  Object? _last;

  @override
  void dispose() {
    _reason.dispose();
    _serial.dispose();
    super.dispose();
  }

  Future<void> _send(Object request, {bool again = false}) {
    _last = request;
    return run(
      () => request is SignRequest ? _commands.sign(request, retryAfterUnknown: again) : _commands.decide(request as DecisionRequest, retryAfterUnknown: again),
      onDone: () {
        _reason.clear();
        _serial.clear();
        widget.onChanged();
      },
    );
  }

  /// The minutes moved under the person: nothing is overwritten, the minutes are read again and the person decides again on what is there.
  void _reload() {
    setState(() => outcome = null);
    widget.onChanged();
  }

  int get _signedCount => widget.minutes.requiredRoles.where((String role) => widget.minutes.signatureOf(role) != null).length;

  Future<void> _confirmSign() async {
    final Map<String, FormProblem> problems = checkSign(role: _role, method: _method, serial: _serial.text);
    setState(() => _problems = problems);
    if (problems.isNotEmpty) return;
    final Minutes minutes = widget.minutes;
    final bool confirmed = await showConfirmSheet(
      context,
      title: context.t('mob.acceptance.confirm.sign.title'),
      facts: <String>[
        context.t('mob.acceptance.confirm.fact.minutes', <String, Object>{'no': minutes.recordNo, 'contract': minutes.contractCode}),
        context.t('mob.acceptance.confirm.fact.signAs', <String, Object>{'role': roleLabel(context, _role!), 'method': methodLabel(context, _method)}),
        effectLabel(context, legalEffectOf(_method)),
        context.t('mob.acceptance.confirm.fact.signatures', <String, Object>{'signed': _signedCount, 'total': minutes.requiredRoles.length}),
      ],
      confirmLabel: context.t('mob.acceptance.confirm.sign.action'),
      cancelLabel: context.t('mob.acceptance.confirm.cancel'),
      auditNote: context.t('mob.acceptance.confirm.audit'),
    );
    if (!confirmed || !mounted) return;
    await _send(SignRequest(minutesId: minutes.id, version: minutes.version, role: _role!, method: _method, certSerial: _serial.text));
  }

  Future<void> _confirmDecision({required bool approve}) async {
    final Map<String, FormProblem> problems = checkDecision(_reason.text);
    setState(() => _problems = problems);
    if (problems.isNotEmpty) return;
    final Minutes minutes = widget.minutes;
    final bool confirmed = await showConfirmSheet(
      context,
      title: approve ? context.t('mob.acceptance.confirm.approve.title') : context.t('mob.acceptance.confirm.reject.title'),
      facts: <String>[
        context.t('mob.acceptance.confirm.fact.minutes', <String, Object>{'no': minutes.recordNo, 'contract': minutes.contractCode}),
        context.t('mob.acceptance.confirm.fact.signatures', <String, Object>{'signed': _signedCount, 'total': minutes.requiredRoles.length}),
        context.t('mob.acceptance.confirm.fact.opinion', <String, Object>{'reason': _reason.text.trim()}),
        context.t('mob.acceptance.confirm.fact.status', <String, Object>{'status': statusLabel(context, approve ? 'APPROVED' : 'REJECTED')}),
      ],
      confirmLabel: approve ? context.t('mob.acceptance.confirm.approve.action') : context.t('mob.acceptance.confirm.reject.action'),
      cancelLabel: context.t('mob.acceptance.confirm.cancel'),
      auditNote: context.t('mob.acceptance.confirm.audit'),
      destructive: !approve,
    );
    if (!confirmed || !mounted) return;
    await _send(DecisionRequest(minutesId: minutes.id, version: minutes.version, approve: approve, reason: _reason.text));
  }

  Widget _outcome(BuildContext context, CommandOutcome result) {
    switch (result) {
      case CommandDone():
        return OutcomeCard(title: context.t('mob.acceptance.result.done.title'), lines: <String>[context.t('mob.acceptance.result.done.body')]);
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.acceptance.result.unknown.title'),
          lines: <String>[context.t('mob.acceptance.result.unknown.body')],
          actionLabel: context.t('mob.acceptance.result.unknown.action'),
          onAction: _last == null ? null : () => _send(_last!, again: true),
        );
      case CommandOffline():
        return OutcomeCard(title: gateText(context, AcceptanceGate.offline));
      case CommandRefused():
        final AcceptanceRefusal refusal = refusalOf(result);
        final bool conflict = refusal.problem == AcceptanceProblem.versionConflict;
        return OutcomeCard(
          title: problemText(context, refusal),
          code: result.code,
          actionLabel: conflict ? context.t('mob.acceptance.result.conflict.action') : null,
          onAction: conflict ? _reload : null,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final Minutes minutes = widget.minutes;
    final SessionSnapshot session = ref.watch(sessionProvider);
    final bool offline = isOffline(ref);
    AcceptanceGate gate(bool allowed) => gateOf(minutes: minutes, allowed: allowed, offline: offline, fromCopy: widget.fromCopy, session: session);
    final AcceptanceGate decideGate = gate(minutes.canApprove || minutes.canReject);
    final AcceptanceGate signGate = gate(minutes.canSign && minutes.signableRoles.isNotEmpty);
    final CommandOutcome? result = outcome;
    final bool signOffered = minutes.canSign && minutes.signableRoles.isNotEmpty && minutes.isOpen;
    final bool decideOffered = minutes.isOpen && (minutes.canApprove || minutes.canReject);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
            children: <Widget>[
              if (result != null) _outcome(context, result),
              _MinutesCard(minutes: minutes),
              _WorksCard(minutes: minutes),
              _SignatureProgress(minutes: minutes, signed: _signedCount),
              _EvidenceCard(minutes: minutes),
              if (signOffered) _signCard(context, minutes),
              _opinionCard(context, minutes, decideGate, decideOffered: decideOffered, signOffered: signOffered, decideOpen: decideGate == AcceptanceGate.open && !sending),
            ],
          ),
        ),
        if (signOffered || decideOffered) _bar(context, minutes, signOffered ? signGate : decideGate, signOffered: signOffered),
      ],
    );
  }

  Widget _bar(BuildContext context, Minutes minutes, AcceptanceGate gate, {required bool signOffered}) {
    final bool open = gate == AcceptanceGate.open && !sending;
    final String? why = gate == AcceptanceGate.open ? null : gateText(context, gate);
    final String sendingLabel = context.t('mob.acceptance.sending.label');
    if (signOffered) {
      return ActionBar(primary: ActionBarButton(label: sending ? sendingLabel : context.t('mob.acceptance.sign.action'), onPressed: open ? _confirmSign : null, icon: Icons.draw_outlined), why: why);
    }
    final ActionBarButton approve = ActionBarButton(label: sending ? sendingLabel : context.t('mob.acceptance.decide.approve.action'), onPressed: open ? () => _confirmDecision(approve: true) : null, icon: Icons.check);
    final ActionBarButton reject = ActionBarButton(label: context.t('mob.acceptance.decide.reject.action'), onPressed: open ? () => _confirmDecision(approve: false) : null);
    if (minutes.canApprove) return ActionBar(primary: approve, secondary: minutes.canReject ? reject : null, why: why);
    return ActionBar(primary: reject, why: why);
  }

  Widget _signCard(BuildContext context, Minutes minutes) {
    return SectionCard(
      title: context.t('mob.acceptance.sign.title'),
      children: <Widget>[
        DropdownButtonFormField<String>(
          initialValue: _role,
          isExpanded: true,
          decoration: InputDecoration(labelText: context.t('mob.acceptance.sign.role.label'), errorText: _problem('role')),
          items: <DropdownMenuItem<String>>[for (final String role in minutes.signableRoles) DropdownMenuItem<String>(value: role, child: Text(roleLabel(context, role)))],
          onChanged: sending ? null : (String? role) => setState(() => _role = role),
        ),
        const SizedBox(height: MachvonV2Space.s8),
        DropdownButtonFormField<String>(
          initialValue: _method,
          isExpanded: true,
          decoration: InputDecoration(labelText: context.t('mob.acceptance.sign.method.label'), helperText: effectLabel(context, legalEffectOf(_method)), helperMaxLines: 3),
          items: <DropdownMenuItem<String>>[for (final String method in signatureMethods) DropdownMenuItem<String>(value: method, child: Text(methodLabel(context, method)))],
          onChanged: sending ? null : (String? method) => setState(() => _method = method ?? _method),
        ),
        if (_method == 'DIGITAL_CERT')
          Padding(
            padding: const EdgeInsets.only(top: MachvonV2Space.s8),
            child: TextField(
              controller: _serial,
              readOnly: sending,
              decoration: InputDecoration(labelText: context.t('mob.acceptance.sign.serial.label'), errorText: _problem('serial')),
            ),
          ),
      ],
    );
  }

  Widget _opinionCard(BuildContext context, Minutes minutes, AcceptanceGate gate, {required bool decideOffered, required bool signOffered, required bool decideOpen}) {
    final MachvonV2Text text = context.v2text;
    return SectionCard(
      title: context.t('mob.acceptance.opinion.title'),
      children: <Widget>[
        if (minutes.decisionNote != null) Text(context.t('mob.acceptance.opinion.note', <String, Object>{'note': minutes.decisionNote!}), style: text.body),
        if (minutes.approvedBy != null) InfoRow(label: context.t('mob.acceptance.opinion.approvedBy'), value: minutes.approvedBy!, divider: false),
        if (decideOffered) ...<Widget>[
          TextField(
            controller: _reason,
            readOnly: sending,
            maxLines: 3,
            decoration: InputDecoration(labelText: context.t('mob.acceptance.opinion.reason.label'), errorText: _problem('reason')),
          ),
          if (signOffered) ...<Widget>[
            const SizedBox(height: MachvonV2Space.s12),
            if (gate != AcceptanceGate.open) GateNote(text: gateText(context, gate)),
            if (minutes.canApprove) FilledButton(onPressed: decideOpen ? () => _confirmDecision(approve: true) : null, child: Text(context.t('mob.acceptance.decide.approve.action'))),
            if (minutes.canApprove && minutes.canReject) const SizedBox(height: MachvonV2Space.s8),
            if (minutes.canReject) OutlinedButton(onPressed: decideOpen ? () => _confirmDecision(approve: false) : null, child: Text(context.t('mob.acceptance.decide.reject.action'))),
          ],
        ] else if (!minutes.isOpen || !_isMine(minutes))
          GateNote(text: gateText(context, minutes.isOpen ? AcceptanceGate.notAllowed : AcceptanceGate.notOpen)),
      ],
    );
  }

  String? _problem(String field) {
    final FormProblem? problem = _problems[field];
    return problem == null ? null : formProblemText(context, problem);
  }
}

class _MinutesCard extends StatelessWidget {
  const _MinutesCard({required this.minutes});

  final Minutes minutes;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: context.t('mob.acceptance.minutes.title'),
      children: <Widget>[
        InfoRow(label: context.t('mob.acceptance.minutes.no'), value: minutes.recordNo, divider: false),
        InfoRow(label: context.t('mob.acceptance.minutes.status'), value: statusLabel(context, minutes.status), valueWidget: _statusPill(context, minutes.status)),
        InfoRow(label: context.t('mob.acceptance.minutes.contract'), value: minutes.contractCode),
        InfoRow(label: context.t('mob.acceptance.minutes.inspection'), value: minutes.inspectionNo),
        InfoRow(label: context.t('mob.acceptance.minutes.drafter'), value: minutes.createdBy),
        if (minutes.awaitingConfirmation)
          Padding(
            padding: const EdgeInsets.only(top: MachvonV2Space.s8),
            child: Text(context.t('mob.acceptance.minutes.regime', <String, Object>{'cxn': minutes.regimeCxn ?? ''}), style: context.v2text.caption),
          ),
      ],
    );
  }
}

class _WorksCard extends StatelessWidget {
  const _WorksCard({required this.minutes});

  final Minutes minutes;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: context.t('mob.acceptance.works.title'),
      children: <Widget>[
        InfoRow(label: context.t('mob.acceptance.works.scope'), value: scopeLabel(context, minutes.scope), divider: false),
        if (minutes.boqItemKey != null) InfoRow(label: context.t('mob.acceptance.works.item'), value: minutes.boqItemKey!) else Text(context.t('mob.acceptance.works.noItem'), style: context.v2text.body),
      ],
    );
  }
}

/// How many of the signatures the minutes require are on them: one segment per required role, filled when it signed.
class _SignatureProgress extends StatelessWidget {
  const _SignatureProgress({required this.minutes, required this.signed});

  final Minutes minutes;
  final int signed;

  @override
  Widget build(BuildContext context) {
    final int total = minutes.requiredRoles.length;
    if (total == 0) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
      child: StageStrip(total: total, current: signed, currentFraction: 1, label: context.t('mob.acceptance.evidence.progress', <String, Object>{'signed': signed, 'total': total})),
    );
  }
}

class _EvidenceCard extends StatelessWidget {
  const _EvidenceCard({required this.minutes});

  final Minutes minutes;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return SectionCard(
      title: context.t('mob.acceptance.evidence.title'),
      children: <Widget>[
        if (minutes.documentVersionId != null) InfoRow(label: context.t('mob.acceptance.evidence.paper'), value: minutes.documentVersionId!.split('-').first, divider: false),
        for (final String role in minutes.requiredRoles) _RoleLine(minutes: minutes, role: role),
        if (minutes.missingRoles.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: MachvonV2Space.s8),
            child: Text(context.t('mob.acceptance.evidence.missing', <String, Object>{'roles': rolesLabel(context, minutes.missingRoles)}), style: text.bodyStrong),
          ),
        if (minutes.openCriticalNcr > 0)
          Padding(
            padding: const EdgeInsets.only(top: MachvonV2Space.s8),
            child: Text(context.t('mob.acceptance.evidence.ncr', <String, Object>{'count': minutes.openCriticalNcr}), style: text.body),
          ),
      ],
    );
  }
}

class _RoleLine extends StatelessWidget {
  const _RoleLine({required this.minutes, required this.role});

  final Minutes minutes;
  final String role;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MinutesSignature? signature = minutes.signatureOf(role);
    final bool voided = signature == null && minutes.signatures.any((MinutesSignature s) => s.role == role);
    final String line;
    final IconData glyph;
    final Color mark;
    if (signature != null) {
      line = context.t('mob.acceptance.evidence.signed', <String, Object>{
        'role': roleLabel(context, role),
        'name': signature.signerName,
        'time': formatMoment(signature.signedAt),
        'method': methodLabel(context, signature.method),
        'effect': effectLabel(context, signature.legalEffect),
      });
      glyph = Icons.check_circle;
      mark = v2.palette.okMark;
    } else if (voided) {
      line = context.t('mob.acceptance.evidence.void', <String, Object>{'role': roleLabel(context, role)});
      glyph = Icons.error_outline;
      mark = v2.palette.lateMark;
    } else {
      line = context.t('mob.acceptance.evidence.waiting', <String, Object>{'role': roleLabel(context, role)});
      glyph = Icons.schedule;
      mark = v2.palette.soonMark;
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
      child: MergeSemantics(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            ExcludeSemantics(child: Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Icon(glyph, size: 20, color: mark))),
            const SizedBox(width: MachvonV2Space.s8),
            Expanded(child: Text(line, style: context.v2text.body)),
          ],
        ),
      ),
    );
  }
}
