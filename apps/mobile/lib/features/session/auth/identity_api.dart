import 'package:machvon_api_client/machvon_api_client.dart';

import '../../../core/api/answer.dart';
import '../../../core/session/session.dart';

/// One membership the person can sign in with: a unit and role in a tenant (the line MOB-04 lists).
final class MembershipChoice {
  const MembershipChoice({
    required this.tenantId,
    required this.tenantName,
    required this.tenantStatus,
    required this.membershipId,
    required this.membershipType,
    required this.status,
    required this.validFrom,
    this.validUntil,
    this.preselected = false,
  });

  final String tenantId;
  final String tenantName;
  final String tenantStatus;
  final String membershipId;
  final String membershipType;
  final String status;
  final DateTime validFrom;
  final DateTime? validUntil;

  /// The tenant of the domain the sign-in was opened on; it gives no right, the membership does.
  final bool preselected;

  /// Whether the server will let the person enter with it (an active membership of an active, or read-only, tenant).
  bool get selectable => status == 'Active' && (tenantStatus == 'Active' || tenantStatus == 'Suspended');

  @override
  bool operator ==(Object other) => other is MembershipChoice && other.tenantId == tenantId && other.membershipId == membershipId;

  @override
  int get hashCode => Object.hash(tenantId, membershipId);
}

/// The answer of the tenant selection: the tenant token (five minutes) bound to the membership, never stored.
final class TenantContext {
  const TenantContext({
    required this.tenantId,
    required this.membershipId,
    required this.accessToken,
    required this.expiresIn,
    required this.mode,
    required this.assurance,
  });

  final String tenantId;
  final String membershipId;
  final String accessToken;
  final int expiresIn;
  final SessionMode mode;
  final AssuranceLevel assurance;

  @override
  String toString() => 'TenantContext(tenant: $tenantId, membership: $membershipId)';
}

const int _defaultTenantTokenSeconds = 300;

/// The two operations that run before a tenant is chosen, with the identity token as the bearer (not the tenant token):
/// `listTenantSelectionCandidates` and `selectTenantContext`. A client is built per call because its token is the identity
/// token the caller holds at that moment.
class IdentityApi {
  IdentityApi({
    required this.baseUrl,
    required this.transport,
    this.locale,
    String Function()? newKey,
    String Function()? newCorrelationId,
  })  : _newKey = newKey,
        _newCorrelationId = newCorrelationId;

  final Uri baseUrl;
  final HttpTransport transport;
  final String Function()? locale;
  final String Function()? _newKey;
  final String Function()? _newCorrelationId;

  MachvonApiClient _client(String idToken) => MachvonApiClient(
        baseUrl: baseUrl,
        transport: transport,
        token: () async => idToken,
        locale: locale,
        newKey: _newKey,
        newCorrelationId: _newCorrelationId,
      );

  /// Every membership of the person, ordered as the server gives them.
  Future<List<MembershipChoice>> candidates(String idToken, {String? host}) async {
    final Object? json = await _client(idToken).execute(
      'listTenantSelectionCandidates',
      query: <String, Object?>{if (host != null) 'host': host},
    );
    final TenantSelectionCandidatesResponse answer = decodeAnswer('listTenantSelectionCandidates', json)! as TenantSelectionCandidatesResponse;
    return <MembershipChoice>[
      for (final TenantSelectionCandidateResponse item in answer.items)
        MembershipChoice(
          tenantId: item.tenantId,
          tenantName: item.tenantName,
          tenantStatus: item.tenantStatus,
          membershipId: item.membershipId,
          membershipType: item.membershipType,
          status: item.status,
          validFrom: DateTime.parse(item.validFrom),
          validUntil: item.validUntil == null ? null : DateTime.parse(item.validUntil!),
          preselected: item.preselected ?? false,
        ),
    ];
  }

  /// Chooses the membership. Every call is a new command (a replay of a stored answer carries no token, so a key is never
  /// reused here): a failed call is simply made again.
  Future<TenantContext> select(String idToken, {required String tenantId, required String membershipId}) async {
    final Object? json = await _client(idToken).execute(
      'selectTenantContext',
      body: TenantSelection(tenantId: tenantId, membershipId: membershipId),
    );
    final SessionContextResponse answer = decodeAnswer('selectTenantContext', json)! as SessionContextResponse;
    final String? token = answer.accessToken;
    if (token == null || token.isEmpty) throw const ContractMismatch('SessionContextResponse.access_token', 'is missing');
    return TenantContext(
      tenantId: answer.tenantId,
      membershipId: answer.membershipId,
      accessToken: token,
      expiresIn: answer.expiresIn ?? _defaultTenantTokenSeconds,
      mode: answer.mode == 'READ_ONLY' ? SessionMode.readOnly : SessionMode.full,
      assurance: answer.assuranceLevel == 'aal2' ? AssuranceLevel.aal2 : AssuranceLevel.aal1,
    );
  }
}
