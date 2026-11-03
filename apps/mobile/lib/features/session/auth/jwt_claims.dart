import 'dart:convert';

/// The claims of a JWT, read without checking the signature, or null when the token is not a JWT.
///
/// The application reads an identity token it received directly from the token endpoint of the identity provider over TLS
/// (OpenID Connect Core 3.1.3.7: the signature check may be skipped then) to bind it to the request (issuer, audience,
/// nonce, expiry). The API verifies the whole token, signature included, on every use.
Map<String, Object?>? jwtClaims(String token) {
  final List<String> parts = token.split('.');
  if (parts.length != 3) return null;
  try {
    final Object? decoded = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))));
    return decoded is Map<String, Object?> ? decoded : null;
  } on FormatException {
    return null;
  }
}
