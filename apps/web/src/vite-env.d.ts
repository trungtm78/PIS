/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base64 of at least 32 bytes shared with the development API (development builds only). */
  readonly VITE_DEV_SESSION_KEY?: string;
  /** JSON array of the development API's fixture users, see session/dev-users.ts (development builds only). */
  readonly VITE_DEV_USERS?: string;
  readonly VITE_DEV_TENANT_NAME?: string;
  /** Origin of the API; the same origin when unset. */
  readonly VITE_API_BASE_URL?: string;
  /** Issuer of the OIDC identity provider; unset means no real sign-in is configured (see session/oidc/config.ts). */
  readonly VITE_OIDC_ISSUER?: string;
  /** Client id of this web application at the identity provider; defaults to machvon-web. */
  readonly VITE_OIDC_CLIENT_ID?: string;
  /** Passed as login_hint: a development identity provider uses it to pick the user. */
  readonly VITE_OIDC_LOGIN_HINT?: string;
  /** The public VAPID key of the application server (base64url): the web push button of the installed application is offered only when it is set (docs/pwa.md). */
  readonly VITE_WEBPUSH_VAPID_PUBLIC_KEY?: string;
  /** The product edition of this build: `public` (also when unset) or `enterprise`; any other value stops the start (see editions/load.ts). */
  readonly VITE_EDITION?: string;
}
