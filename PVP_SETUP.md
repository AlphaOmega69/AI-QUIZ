# PvP — how players connect

After the handshake every match is **direct peer-to-peer (WebRTC)**. The options differ only in how the two devices find each other.

| Option | Needs internet | How |
|---|---|---|
| **Random opponent** | yes | Tap it and you're paired with anyone else searching for the same game right now. |
| **Room name + password** | yes | Both type the same room + password. One taps HOST, the other JOIN. |
| **Invite link** | yes | Host taps *Create invite link* and shares it (WhatsApp, Discord, SMS…). Opening it joins automatically. |
| **Same Wi-Fi / hotspot** | **no** | Swap two short codes. Use a phone hotspot if there is no router. |
| **Code exchange** | yes | Same as above but also works across the internet (uses STUN). |

## How random matching works (no server of ours)
Searchers use numbered lobby slots on the matchmaking broker (`aqm1-<game>-0…5`). Each player tries to claim slot 0; if it's already held, someone is waiting there and you connect to them; if it's free you hold it for a few seconds, then release and rescan. It only works while at least two people search at the same time, and the host's topic/difficulty is used. Searching stops after ~100 s with a clear message.

## The matchmaking server (random, rooms + links)
Rooms/links use a small WebSocket "broker" that relays only the connection handshake (offer/answer/ICE), never game data.
By default the free public **PeerJS** broker is used (`0.peerjs.com`). It is a third-party service with no uptime guarantee.
To run your own: `npx peer --port 9000`, then in `js/config.js`:

```js
window.PVP_SIGNAL = { host: "my-server.example.com", port: 443, secure: true, path: "/", key: "peerjs" };
```

The room id is derived from `SHA-256(room name + password)`, so a stranger can't join without knowing both. This is convenience-level protection, not strong security.

## Strict networks
There is no TURN relay (they cost money). If two players can't connect (school/corporate firewalls, some mobile carriers), use **Same Wi-Fi / hotspot**, or add your own TURN to `window.PVP_ICE_SERVERS` in `js/config.js`.

## Why it used to say "connection failed" when API keys were set
Quiz Duel only started generating questions *after* the friend connected, and the AI calls had no timeout, so a slow Groq→Gemini attempt left the guest staring at a spinner. The host now starts generating the moment it opens a room, each AI call is capped, the whole thing falls back to built-in questions after 15 s, the guest sees "Host is generating questions…", and a keep-alive ping plus a 10 s grace period stop brief network blips from ending the match.
