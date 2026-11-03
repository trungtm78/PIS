import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

/// The published theme of one tenant at one version, as the server serves it (`TenantThemeVersion`): the twelve colours the
/// application applies to its `ThemeData`, the version and the hash that pin it, and the names it shows.
///
/// A theme exists on the phone only as a published version: the server serves nothing else to the application, and the
/// application never asks for a draft.
final class PublishedTheme {
  const PublishedTheme({
    required this.tenantId,
    required this.version,
    required this.hash,
    required this.publishedAt,
    required this.name,
    required this.overlay,
  });

  /// Reads a theme from the answer of the server, or null when the answer is not a published theme of the contract.
  static PublishedTheme? tryParse(Object? json) {
    try {
      final TenantThemeVersionResponse response = TenantThemeVersionResponse.fromJson(json);
      final TenantThemeConfigResponse config = response.config;
      final Map<String, String> colours = <String, String>{
        'primary': config.primary,
        'primaryText': config.primaryText,
        'menu': config.menu,
        'menuText': config.menuText,
        'selected': config.selected,
        'selectedText': config.selectedText,
        'headerBg': config.headerBg,
        'headerText': config.headerText,
        'footerBg': config.footerBg,
        'footerText': config.footerText,
        'background': config.background,
        'titleColor': config.titleColor,
      };
      return PublishedTheme(
        tenantId: response.tenantId,
        version: response.version,
        hash: response.hash,
        publishedAt: DateTime.parse(response.publishedAt),
        name: config.name,
        overlay: colours,
      );
    } on ContractMismatch {
      return null;
    } on FormatException {
      return null;
    }
  }

  final String tenantId;
  final int version;
  final String hash;
  final DateTime publishedAt;
  final String name;

  /// The twelve colours by token name, as hex.
  final Map<String, String> overlay;

  /// Whether the whole theme passes the contrast rules of the web (every text pair at least 4.5): a theme that does not is
  /// never applied, not even in part.
  bool get accepted => overlayAccepted(overlay);

  Map<String, Object?> toJson() => <String, Object?>{
        'tenant_id': tenantId,
        'version': version,
        'hash': hash,
        'published_at': publishedAt.toUtc().toIso8601String(),
        'name': name,
        'overlay': overlay,
      };

  static PublishedTheme? fromStored(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final Object? tenant = json['tenant_id'];
    final Object? version = json['version'];
    final Object? hash = json['hash'];
    final Object? at = json['published_at'];
    final Object? name = json['name'];
    final Object? overlay = json['overlay'];
    if (tenant is! String || version is! int || hash is! String || at is! String || name is! String || overlay is! Map<String, Object?>) return null;
    final Map<String, String> colours = <String, String>{for (final MapEntry<String, Object?> e in overlay.entries) if (e.value is String) e.key: e.value! as String};
    final DateTime? publishedAt = DateTime.tryParse(at);
    if (publishedAt == null) return null;
    return PublishedTheme(tenantId: tenant, version: version, hash: hash, publishedAt: publishedAt, name: name, overlay: colours);
  }
}

/// The theme that is applied now: whose it is and which version, so a test, a support call and the tenant switch can say
/// exactly what the application shows.
final class ActiveTheme {
  const ActiveTheme({required this.tenantId, required this.version, required this.hash, this.fromCache = false});

  final String tenantId;
  final int version;
  final String hash;

  /// It was read from the copy kept on the device because the server could not be asked.
  final bool fromCache;

  @override
  bool operator ==(Object other) =>
      other is ActiveTheme && other.tenantId == tenantId && other.version == version && other.hash == hash && other.fromCache == fromCache;

  @override
  int get hashCode => Object.hash(tenantId, version, hash, fromCache);
}
