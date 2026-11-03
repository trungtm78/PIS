/// The standard states of every screen, the same as the web (06_UI_UX_Design_System.md, 04_Design_Assets/states):
/// the seven of the design (default, loading, empty, error, denied, expired licence, offline) and `signedOut`, the lapsed
/// session, which has its own wording and leads to sign-in.
enum ScreenState { defaultState, loading, empty, error, denied, expired, signedOut, offline }
