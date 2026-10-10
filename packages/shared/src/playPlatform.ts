// ── Play platform (2026-10-09) ──────────────────────────────────────────
//
// Owner decision 2026-10-09:「現在不用自建伺服器了, 我們都只會用
// https://avalon.signage-cloud.org/Account/Login 這個玩」. Games are no longer
// hosted on this platform — every "create / join a game" entry point (web
// lobby buttons, Discord slash commands, LINE commands) points here instead.
// The LINE ↔ Discord ↔ lobby chat sync is unaffected.
//
// Single source of truth: change the URL here and both web and server follow.
export const PLAY_PLATFORM_URL = 'https://avalon.signage-cloud.org/Account/Login';
