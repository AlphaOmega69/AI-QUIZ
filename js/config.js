/**
 * OAuth configuration for "Continue with Google" / "Continue with Facebook".
 *
 * These are OPTIONAL. Email and Guest login always work with zero setup.
 * Google/Facebook login require YOU (the site owner) to register a free app
 * with each provider and paste the ID below — see AUTH_SETUP.md for the
 * exact steps (takes about 5 minutes each). Until you do, those two buttons
 * will show a friendly "not set up yet" message and suggest Email/Guest instead.
 */
const AUTH_CONFIG = {
    googleClientId: "",   // e.g. "1234567890-abcdefg.apps.googleusercontent.com"
    facebookAppId: ""     // e.g. "1234567890123456"
};

/**
 * ----------------------------------------------------------------------------
 * PvP matchmaking (Room name + password, and Invite links) — OPTIONAL overrides
 * ----------------------------------------------------------------------------
 * Rooms/links need a tiny "matchmaking" WebSocket that only relays the connection
 * handshake (never game data). By default the free public PeerJS broker is used, so
 * nothing needs configuring. If it is ever down/blocked on your network you can run
 * your own in one line (`npx peer --port 9000`) and point the app at it:
 *
 *   window.PVP_SIGNAL = { host: "my-server.example.com", port: 443, secure: true, path: "/", key: "peerjs" };
 *
 * Optional TURN relay for very strict networks (costs money to run, so none is bundled):
 *   window.PVP_ICE_SERVERS = [{ urls: "turn:turn.example.com:3478", username: "user", credential: "pass" }];
 *
 * Public address used inside invite links when the app runs from file:// or an installed app:
 *   window.PVP_PUBLIC_URL = "https://alpha-omega69.github.io/AI-QUIZ-PRO/";
 */
window.PVP_SIGNAL = window.PVP_SIGNAL || null;      // null = default public broker
window.PVP_ICE_SERVERS = window.PVP_ICE_SERVERS || [];
window.PVP_PUBLIC_URL = window.PVP_PUBLIC_URL || "https://alpha-omega69.github.io/AI-QUIZ-PRO/";
