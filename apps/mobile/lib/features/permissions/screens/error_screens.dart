import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/navigation/router.dart' show homeLocation;
import '../../../core/state/state_card.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../problem_routing.dart';

const String _tenantMismatch = 'TENANT_MISMATCH';
const String _entitlementDenied = 'ENTITLEMENT_DENIED';
const String _licenseExpired = 'LICENSE_EXPIRED';

/// MOB-45: the server refused the action (403 `SCOPE_DENIED`), or the link belongs to another tenant. It says why in words of
/// the application, shows the stable code and the correlation id, and nothing of the record: the text of the server and the
/// protected record never reach the screen.
Widget buildAccessDeniedScreen(BuildContext context, ScreenContext screen) => AccessDeniedScreen(
      code: safeCode(screen.queryParameters[codeParameter]) ?? _tenantMismatch,
      reference: safeReference(screen.queryParameters[referenceParameter]),
      action: kRefusedActions.contains(screen.queryParameters[actionParameter]) ? screen.queryParameters[actionParameter] : null,
    );

/// MOB-46: the licence of the tenant has expired according to the server (422 `LICENSE_EXPIRED`). Reading stays possible; the
/// changes wait for the renewal. The phone's clock is never asked.
Widget buildLicenceExpiredScreen(BuildContext context, ScreenContext screen) => LicenceExpiredScreen(
      code: safeCode(screen.queryParameters[codeParameter]) ?? _licenseExpired,
      reference: safeReference(screen.queryParameters[referenceParameter]),
    );

class AccessDeniedScreen extends ConsumerWidget {
  const AccessDeniedScreen({required this.code, this.reference, this.action, super.key});

  final String code;
  final String? reference;
  final String? action;

  String _reason(BuildContext context) {
    if (code == _tenantMismatch) return context.t('mob.access.reason.tenant');
    if (code == _entitlementDenied) return context.t('mob.access.reason.entitlement');
    return context.t('mob.access.reason.scope');
  }

  String? _action(BuildContext context) {
    switch (action) {
      case 'view':
        return context.t('mob.access.action.view');
      case 'edit':
        return context.t('mob.access.action.edit');
      case 'submit':
        return context.t('mob.access.action.submit');
      case 'approve':
        return context.t('mob.access.action.approve');
    }
    return null;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final String reason = _reason(context);
    final String? refused = _action(context);
    return AppScaffold(
      showTopBar: false,
      body: StateCard(
        icon: Icons.gpp_bad_outlined,
        title: context.t('mob.access.title.text'),
        body: reason,
        announcement: <String>[
          context.t('mob.access.title.text'),
          reason,
          if (refused != null) '${context.t('mob.access.action.label')}: $refused',
          '${context.t('mob.problem.code.label')}: $code',
          if (reference != null) '${context.t('mob.problem.reference.label')}: $reference',
        ].join('. '),
        details: <Widget>[
          if (refused != null) _Fact(label: context.t('mob.access.action.label'), value: refused),
          _Fact(label: context.t('mob.problem.code.label'), value: code),
          if (reference != null) _Fact(label: context.t('mob.problem.reference.label'), value: reference!, copyable: true),
          Text(context.t('mob.access.contact.hint'), textAlign: TextAlign.center, style: context.v2text.caption),
        ],
        actions: <Widget>[
          FilledButton(
            onPressed: () => context.push(Uri(path: ref.read(routeTableProvider).locationOf('MOB-50'), queryParameters: const <String, String>{'category': 'ACCESS'}).toString()),
            child: Text(context.t('mob.access.contact.action')),
          ),
          OutlinedButton(onPressed: () => _back(context), child: Text(context.t('mob.access.back.action'))),
        ],
      ),
    );
  }

  void _back(BuildContext context) => context.canPop() ? context.pop() : context.go(homeLocation);
}

class LicenceExpiredScreen extends ConsumerWidget {
  const LicenceExpiredScreen({required this.code, this.reference, super.key});

  final String code;
  final String? reference;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final String status = context.t('mob.licence.status.value');
    return AppScaffold(
      showTopBar: false,
      body: StateCard(
        icon: Icons.event_busy_outlined,
        title: context.t('mob.licence.title.text'),
        body: context.t('mob.licence.readOnly.body'),
        announcement: <String>[
          context.t('mob.licence.title.text'),
          '${context.t('mob.licence.status.label')}: $status',
          context.t('mob.licence.readOnly.title'),
          context.t('mob.licence.readOnly.body'),
          '${context.t('mob.problem.code.label')}: $code',
          if (reference != null) '${context.t('mob.problem.reference.label')}: $reference',
        ].join('. '),
        details: <Widget>[
          _Fact(label: context.t('mob.licence.status.label'), value: status),
          Text(context.t('mob.licence.readOnly.title'), textAlign: TextAlign.center, style: context.v2text.label),
          _Fact(label: context.t('mob.problem.code.label'), value: code),
          if (reference != null) _Fact(label: context.t('mob.problem.reference.label'), value: reference!, copyable: true),
          Text(context.t('mob.licence.contact.hint'), textAlign: TextAlign.center, style: context.v2text.caption),
        ],
        actions: <Widget>[
          FilledButton(onPressed: () => context.go(homeLocation), child: Text(context.t('mob.licence.read.action'))),
          OutlinedButton(
            onPressed: () => context.push(Uri(path: ref.read(routeTableProvider).locationOf('MOB-50'), queryParameters: const <String, String>{'category': 'BILLING'}).toString()),
            child: Text(context.t('mob.licence.contact.action')),
          ),
        ],
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value, this.copyable = false});

  final String label;
  final String value;
  final bool copyable;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
      child: Wrap(
        alignment: WrapAlignment.center,
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: MachvonV2Space.s8,
        children: <Widget>[
          Text('$label:', style: text.label),
          SelectableText(value, style: text.body.copyWith(fontFamily: 'monospace')),
          if (copyable)
            IconButton(
              tooltip: context.t('mob.problem.copy.action'),
              icon: const Icon(Icons.copy_outlined),
              onPressed: () => Clipboard.setData(ClipboardData(text: value)),
            ),
        ],
      ),
    );
  }
}
