import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../acceptance_commands.dart';
import '../acceptance_models.dart';
import '../acceptance_support.dart';

/// MOB-65: quality acceptance minutes on the phone. Without a parameter it lists the minutes that wait for signatures or for a
/// decision, those the person can act on first; with `?acceptance=<id>` it shows one set of minutes: the minutes, the work they
/// accept, the evidence (who signed, how, and what each signature is worth), the opinion and the decision.
///
/// Signing and approving are online only (MOB.md 3, L3): offline, or on a copy kept on the device, the buttons are disabled with
/// the reason beside them and nothing is queued. The server checks the right, the scope, the version and the licence again, and
/// refuses with a reason the screen words (`SIGNATURES_INCOMPLETE` names the roles still missing).
Widget buildAcceptanceScreen(BuildContext context, ScreenContext screen) {
  final String? id = screen.queryParameters['acceptance'];
  return id == null || id.isEmpty ? const _MinutesListScreen() : _MinutesScreen(minutesId: id);
}

class _MinutesListScreen extends StatelessWidget {
  const _MinutesListScreen();

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.acceptance.list.title'),
      body: DataView<MinutesList>(
        cacheKey: 'acceptance.minutes',
        read: (MachvonApiClient client) => client.listQualityAcceptances(),
        parse: parseMinutesList,
        asOf: (MinutesList list) => list.asOf,
        isEmpty: (MinutesList list) => list.items.isEmpty,
        builder: (BuildContext context, Loaded<MinutesList> loaded) => ListView(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.all(MachvonSpace.space16),
              child: Text(context.t('mob.acceptance.list.intro'), style: Theme.of(context).textTheme.bodyMedium),
            ),
            for (final Minutes minutes in loaded.value.items) _MinutesRow(minutes: minutes),
          ],
        ),
      ),
    );
  }
}

class _MinutesRow extends StatelessWidget {
  const _MinutesRow({required this.minutes});

  final Minutes minutes;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String status = statusLabel(context, minutes.status);
    final bool mine = minutes.canSign || minutes.canApprove || minutes.canReject;
    return TappableRow(
      semanticLabel: context.t('mob.acceptance.list.row.aria', <String, Object>{'no': minutes.recordNo, 'contract': minutes.contractCode, 'status': status}),
      onTap: () => openScreen(context, 'MOB-65', query: <String, String>{'acceptance': minutes.id}, stacked: true),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(minutes.recordNo, style: theme.textTheme.bodyLarge),
                Text(context.t('mob.acceptance.list.row.facts', <String, Object>{'contract': minutes.contractCode, 'scope': scopeLabel(context, minutes.scope)}), style: theme.textTheme.bodyMedium),
                Wrap(
                  spacing: MachvonSpace.space8,
                  children: <Widget>[
                    StatusPill(label: status),
                    if (mine) StatusPill(label: context.t('mob.acceptance.list.row.yours'), warn: true),
                  ],
                ),
                if (minutes.missingRoles.isNotEmpty)
                  Text(context.t('mob.acceptance.list.row.missing', <String, Object>{'roles': rolesLabel(context, minutes.missingRoles)}), style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
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
    return ScreenFrame(
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

  void _sign() {
    final Map<String, FormProblem> problems = checkSign(role: _role, method: _method, serial: _serial.text);
    setState(() => _problems = problems);
    if (problems.isNotEmpty) return;
    _send(SignRequest(minutesId: widget.minutes.id, version: widget.minutes.version, role: _role!, method: _method, certSerial: _serial.text));
  }

  void _decide({required bool approve}) {
    final Map<String, FormProblem> problems = checkDecision(_reason.text);
    setState(() => _problems = problems);
    if (problems.isNotEmpty) return;
    _send(DecisionRequest(minutesId: widget.minutes.id, version: widget.minutes.version, approve: approve, reason: _reason.text));
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
        return OutcomeCard(title: problemText(context, refusal), code: result.code);
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
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        if (result != null) _outcome(context, result),
        _MinutesCard(minutes: minutes),
        _WorksCard(minutes: minutes),
        _EvidenceCard(minutes: minutes),
        if (minutes.canSign && minutes.signableRoles.isNotEmpty && minutes.isOpen) _signCard(context, minutes, signGate),
        _opinionCard(context, minutes, decideGate),
      ],
    );
  }

  Widget _signCard(BuildContext context, Minutes minutes, AcceptanceGate gate) {
    final bool open = gate == AcceptanceGate.open && !sending;
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
        const SizedBox(height: MachvonSpace.space8),
        DropdownButtonFormField<String>(
          initialValue: _method,
          isExpanded: true,
          decoration: InputDecoration(labelText: context.t('mob.acceptance.sign.method.label'), helperText: effectLabel(context, legalEffectOf(_method)), helperMaxLines: 3),
          items: <DropdownMenuItem<String>>[for (final String method in signatureMethods) DropdownMenuItem<String>(value: method, child: Text(methodLabel(context, method)))],
          onChanged: sending ? null : (String? method) => setState(() => _method = method ?? _method),
        ),
        if (_method == 'DIGITAL_CERT')
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space8),
            child: TextField(
              controller: _serial,
              readOnly: sending,
              decoration: InputDecoration(labelText: context.t('mob.acceptance.sign.serial.label'), errorText: _problem('serial')),
            ),
          ),
        const SizedBox(height: MachvonSpace.space12),
        if (gate != AcceptanceGate.open) GateNote(text: gateText(context, gate)),
        FilledButton(
          onPressed: open ? _sign : null,
          child: Text(sending ? context.t('mob.acceptance.sending.label') : context.t('mob.acceptance.sign.action')),
        ),
      ],
    );
  }

  Widget _opinionCard(BuildContext context, Minutes minutes, AcceptanceGate gate) {
    final ThemeData theme = Theme.of(context);
    final bool open = gate == AcceptanceGate.open && !sending;
    final bool offered = minutes.isOpen && (minutes.canApprove || minutes.canReject);
    return SectionCard(
      title: context.t('mob.acceptance.opinion.title'),
      children: <Widget>[
        if (minutes.decisionNote != null) Text(context.t('mob.acceptance.opinion.note', <String, Object>{'note': minutes.decisionNote!}), style: theme.textTheme.bodyMedium),
        if (minutes.approvedBy != null) FactLine(label: context.t('mob.acceptance.opinion.approvedBy'), value: minutes.approvedBy!),
        if (offered) ...<Widget>[
          TextField(
            controller: _reason,
            readOnly: sending,
            maxLines: 3,
            decoration: InputDecoration(labelText: context.t('mob.acceptance.opinion.reason.label'), errorText: _problem('reason')),
          ),
          const SizedBox(height: MachvonSpace.space12),
          if (gate != AcceptanceGate.open) GateNote(text: gateText(context, gate)),
          if (minutes.canApprove)
            FilledButton(onPressed: open ? () => _decide(approve: true) : null, child: Text(context.t('mob.acceptance.decide.approve.action'))),
          if (minutes.canApprove && minutes.canReject) const SizedBox(height: MachvonSpace.space8),
          if (minutes.canReject)
            OutlinedButton(onPressed: open ? () => _decide(approve: false) : null, child: Text(context.t('mob.acceptance.decide.reject.action'))),
        ] else
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
        FactLine(label: context.t('mob.acceptance.minutes.no'), value: minutes.recordNo),
        FactLine(label: context.t('mob.acceptance.minutes.status'), value: statusLabel(context, minutes.status)),
        FactLine(label: context.t('mob.acceptance.minutes.contract'), value: minutes.contractCode),
        FactLine(label: context.t('mob.acceptance.minutes.inspection'), value: minutes.inspectionNo),
        if (minutes.createdBy != null) FactLine(label: context.t('mob.acceptance.minutes.drafter'), value: minutes.createdBy!),
        if (minutes.awaitingConfirmation)
          Text(context.t('mob.acceptance.minutes.regime', <String, Object>{'cxn': minutes.regimeCxn ?? ''}), style: Theme.of(context).textTheme.bodySmall),
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
        FactLine(label: context.t('mob.acceptance.works.scope'), value: scopeLabel(context, minutes.scope)),
        if (minutes.boqItemKey != null)
          FactLine(label: context.t('mob.acceptance.works.item'), value: minutes.boqItemKey!)
        else
          Text(context.t('mob.acceptance.works.noItem'), style: Theme.of(context).textTheme.bodyMedium),
      ],
    );
  }
}

class _EvidenceCard extends StatelessWidget {
  const _EvidenceCard({required this.minutes});

  final Minutes minutes;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return SectionCard(
      title: context.t('mob.acceptance.evidence.title'),
      children: <Widget>[
        if (minutes.documentVersionId != null)
          FactLine(label: context.t('mob.acceptance.evidence.paper'), value: minutes.documentVersionId!.split('-').first),
        for (final String role in minutes.requiredRoles) _RoleLine(minutes: minutes, role: role),
        if (minutes.missingRoles.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space8),
            child: Text(context.t('mob.acceptance.evidence.missing', <String, Object>{'roles': rolesLabel(context, minutes.missingRoles)}), style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w700)),
          ),
        if (minutes.openCriticalNcr > 0)
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space8),
            child: Text(context.t('mob.acceptance.evidence.ncr', <String, Object>{'count': minutes.openCriticalNcr}), style: theme.textTheme.bodyMedium),
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
    final MinutesSignature? signature = minutes.signatureOf(role);
    final bool voided = signature == null && minutes.signatures.any((MinutesSignature s) => s.role == role);
    final String line;
    if (signature != null) {
      line = context.t('mob.acceptance.evidence.signed', <String, Object>{
        'role': roleLabel(context, role),
        'name': signature.signerName,
        'time': formatMoment(signature.signedAt),
        'method': methodLabel(context, signature.method),
        'effect': effectLabel(context, signature.legalEffect),
      });
    } else if (voided) {
      line = context.t('mob.acceptance.evidence.void', <String, Object>{'role': roleLabel(context, role)});
    } else {
      line = context.t('mob.acceptance.evidence.waiting', <String, Object>{'role': roleLabel(context, role)});
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
      child: MergeSemantics(child: Text(line, style: Theme.of(context).textTheme.bodyMedium)),
    );
  }
}
