import 'package:machvon_mobile/features/notification_inbox/push_registration.dart';

/// Ids shaped like the ones the server puts in an opaque link (a uuid: 36 characters of the allowed set).
const String idUnread = '3f2b6c1e-0000-4000-8000-000000000081';
const String idPlain = '3f2b6c1e-0000-4000-8000-000000000082';
const String idRevoked = '3f2b6c1e-0000-4000-8000-000000000083';
const String idRead = '3f2b6c1e-0000-4000-8000-000000000084';

Map<String, Object?> notification(
  String id, {
  String title = 'notification.event.compensation_plan.updated.v1.title',
  String priority = 'NORMAL',
  bool ack = false,
  String? readAt,
  String? acknowledgedAt,
  String? ref,
}) =>
    <String, Object?>{
      'id': id,
      'title': title,
      'priority': priority,
      'status': 'ProviderAccepted',
      'ack_required': ack,
      if (readAt != null) 'read_at': readAt,
      if (acknowledgedAt != null) 'acknowledged_at': acknowledgedAt,
      if (ref != null) 'resource_ref': ref,
    };

Map<String, Object?> notificationsPage(List<Map<String, Object?>> items) => <String, Object?>{'items': items, 'next_cursor': null};

/// N-81 asks for an acknowledgement, N-82 does not (FX-PLAT, UAT-AC181); a third one lost its record.
List<Map<String, Object?>> standardNotifications() => <Map<String, Object?>>[
      notification(idUnread, priority: 'HIGH', ack: true, ref: '/prj/prj-03?id=p-1'),
      notification(idPlain),
      notification(idRevoked, title: 'notification.content.unavailable.title'),
      notification(idRead, priority: 'LOW', readAt: '2026-10-31T09:00:00Z', ref: '/adm/adm-06?id=t-9'),
    ];

Map<String, Object?> preferenceView({int version = 3, bool isDefault = false, String? quietStart, String? quietEnd, List<Map<String, Object?>> items = const <Map<String, Object?>>[], List<Map<String, Object?>> locked = const <Map<String, Object?>>[]}) => <String, Object?>{
      'version': version,
      'is_default': isDefault,
      'quiet_start': quietStart,
      'quiet_end': quietEnd,
      'time_zone': 'Asia/Ho_Chi_Minh',
      'items': items,
      'locked': locked,
    };

Map<String, Object?> prefItem(String category, String channel, bool enabled, {String digest = 'IMMEDIATE'}) => <String, Object?>{'event_category': category, 'channel': channel, 'enabled': enabled, 'digest_mode': digest};

/// A push platform the tests drive: a token, a permission, and refreshes.
final class FakePush implements PushPlatform {
  FakePush({this.currentToken, this.state = PushPermission.granted, this.id = 'dev-abc-installation-0001'});

  String? currentToken;
  PushPermission state;
  final String id;

  @override
  String get platform => 'android';

  @override
  String get appVersion => '1.4.0';

  @override
  Future<String> installId() async => id;

  @override
  Future<PushPermission> permission() async => state;

  @override
  Future<String?> token() async => currentToken;

  @override
  Stream<String> get tokenRefreshes => const Stream<String>.empty();

  bool forgotten = false;

  @override
  Future<void> forgetToken() async => forgotten = true;
}
