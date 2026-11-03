/**
 * ============================================================================
 * P2P CONNECTION LAYER — WebRTC data channel + 4 ways to connect
 * ============================================================================
 * Once two players are connected, everything is genuinely peer-to-peer over a
 * WebRTC data channel (no server relays game traffic). The only question is how
 * the two browsers FIND each other, so this file offers several routes:
 *
 *   0. RANDOM — "find me an opponent": players searching for the same game are paired up
 *              automatically through numbered lobby slots on the same matchmaking socket.
 *   1. ROOM  — room name + password. Both players type the same pair. A tiny
 *              public "matchmaking" WebSocket (the free PeerJS broker by default,
 *              or your own — see js/config.js) only relays the connection
 *              handshake; game data never touches it.
 *   2. LINK  — same as ROOM, but the host just shares a link that contains a
 *              random room + password; opening the link joins automatically.
 *   3. WIFI  — copy/paste code exchange with NO internet and no server at all.
 *              Works on the same Wi-Fi / phone hotspot / LAN.
 *   4. CODE  — the same copy/paste exchange, but with STUN so it also works
 *              across the internet.
 *
 * There is no TURN relay (it costs real money to run). Most home / mobile
 * networks connect fine with STUN; very strict firewalls may not — then use the
 * same Wi-Fi / hotspot. Put your own TURN in window.PVP_ICE_SERVERS to fix that.
 */
let p2pConnection = null;
let p2pChannel = null;
let p2pOnMessageCallback = null;
let p2pOnStatusCallback = null;
let p2pOnPeerLostCallback = null;
let p2pIsHostRole = false;

let p2pSignal = null;          // matchmaking socket (ROOM / LINK only)
let p2pIceMode = 'internet';   // 'internet' (STUN) | 'lan' (no ICE servers, offline)
let p2pAttemptId = 0;          // bumps on every start/teardown so late async work can tell it is stale
let p2pGraceTimer = null;      // "disconnected" is often transient — wait before declaring the peer gone
let p2pPingTimer = null;
let p2pPendingCandidates = [];
let p2pRemoteSet = false;
let p2pRoomPeer = null;        // signaling id of the player on the other end
let p2pConnectionId = null;
let p2pMatchToken = 0;         // bumps when a random-match search is cancelled
let p2pMatchActive = false;
let p2pFailHook = null;        // lets the matchmaking loop swallow per-attempt failures
let p2pConnectedHook = null;

const P2P_GRACE_MS = 10000;
const P2P_PING_MS = 4000;

function p2pIceConfig() {
    if (p2pIceMode === 'lan') return { iceServers: [] };
    const servers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
    ];
    if (Array.isArray(window.PVP_ICE_SERVERS)) window.PVP_ICE_SERVERS.forEach(s => servers.push(s));
    return { iceServers: servers, iceCandidatePoolSize: 2 };
}

function p2pSetStatus(status, detail) {
    if (p2pOnStatusCallback) p2pOnStatusCallback(status, detail);
    // A game registers p2pOnPeerLost() so it can end the match cleanly if the other
    // player drops (closed tab, lost signal) instead of hanging on a dead channel.
    if ((status === 'disconnected' || status === 'error') && p2pOnPeerLostCallback) {
        const cb = p2pOnPeerLostCallback;
        cb(status);
    }
}
function p2pFail(code, message) {
    if (p2pFailHook) { p2pFailHook(code, message); return; }
    p2pSetStatus('error', { code, message });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
// Waits for ICE gathering so a copy/paste code includes every candidate.
function p2pWaitForIceGathering(pc) {
    return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') { resolve(); return; }
        function check() {
            if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); resolve(); }
        }
        pc.addEventListener('icegatheringstatechange', check);
        setTimeout(resolve, 5000); // never hang on a slow/partial gather
    });
}

// Pure-JS SHA-256 so BOTH players derive the same room id even when one of them is on a
// non-secure origin (crypto.subtle only exists on https / localhost).
function p2pSha256Hex(str) {
    const ascii = unescape(encodeURIComponent(str));
    const rrot = (v, a) => (v >>> a) | (v << (32 - a));
    const mp = Math.pow, mw = mp(2, 32);
    const words = [], bitLen = ascii.length * 8;
    let hash = [], k = [], primeCounter = 0, result = '';
    const composite = {};
    for (let c = 2; primeCounter < 64; c++) {
        if (!composite[c]) {
            for (let i = 0; i < 313; i += c) composite[i] = c;
            hash[primeCounter] = (mp(c, 0.5) * mw) | 0;
            k[primeCounter++] = (mp(c, 1 / 3) * mw) | 0;
        }
    }
    let s = ascii + '\x80';
    while (s.length % 64 - 56) s += '\x00';
    for (let i = 0; i < s.length; i++) words[i >> 2] |= s.charCodeAt(i) << ((3 - i) % 4) * 8;
    words[words.length] = (bitLen / mw) | 0;
    words[words.length] = bitLen;
    for (let j = 0; j < words.length;) {
        const w = words.slice(j, j += 16), old = hash;
        hash = hash.slice(0, 8);
        for (let i = 0; i < 64; i++) {
            const w15 = w[i - 15], w2 = w[i - 2], a = hash[0], e = hash[4];
            const t1 = hash[7] + (rrot(e, 6) ^ rrot(e, 11) ^ rrot(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + k[i] +
                (w[i] = i < 16 ? w[i] : (w[i - 16] + (rrot(w15, 7) ^ rrot(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rrot(w2, 17) ^ rrot(w2, 19) ^ (w2 >>> 10))) | 0);
            const t2 = (rrot(a, 2) ^ rrot(a, 13) ^ rrot(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
            hash = [(t1 + t2) | 0].concat(hash);
            hash[4] = (hash[4] + t1) | 0;
        }
        for (let i = 0; i < 8; i++) hash[i] = (hash[i] + old[i]) | 0;
    }
    for (let i = 0; i < 8; i++) for (let j = 3; j + 1; j--) { const b = (hash[i] >> (j * 8)) & 255; result += (b < 16 ? 0 : '') + b.toString(16); }
    return result;
}
window.p2pSha256Hex = p2pSha256Hex;

function p2pNormRoom(room) { return String(room || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function p2pRoomId(room, pw) { return 'aqp' + p2pSha256Hex(p2pNormRoom(room) + '\u0001' + String(pw || '')).slice(0, 28); }
window.p2pRoomId = p2pRoomId;
function p2pRandom(len) {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; let out = '';
    const buf = (window.crypto && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(len)) : null;
    for (let i = 0; i < len; i++) out += chars[(buf ? buf[i] : Math.floor(Math.random() * 256)) % chars.length];
    return out;
}
window.p2pRandom = p2pRandom;

/* ------------------------------------------------------------------ */
/* Data channel + connection health                                   */
/* ------------------------------------------------------------------ */
function p2pStopPing() { clearInterval(p2pPingTimer); p2pPingTimer = null; }

function p2pWireChannel(channel) {
    p2pChannel = channel;
    // Every handler checks `channel === p2pChannel`, so late events from a channel we
    // already replaced or closed on purpose can never leak into the next game.
    channel.onopen = () => { if (channel === p2pChannel) p2pOnChannelOpen(); };
    channel.onclose = () => { if (channel === p2pChannel) { p2pStopPing(); p2pSetStatus('disconnected'); } };
    channel.onerror = () => { if (channel === p2pChannel) p2pSetStatus('error', { code: 'channel', message: 'The data channel reported an error.' }); };
    channel.onmessage = (e) => {
        if (channel !== p2pChannel) return;
        try {
            const data = JSON.parse(e.data);
            if (data && data.type === '__ping') return; // keepalive only — never shown to the game
            if (p2pOnMessageCallback) p2pOnMessageCallback(data);
        } catch (err) { console.warn('P2P: malformed message', err); }
    };
    if (channel.readyState === 'open') p2pOnChannelOpen();
}

function p2pOnChannelOpen() {
    clearTimeout(p2pGraceTimer);
    p2pSignalClose(); // handshake done — free the matchmaking slot, game traffic is direct
    // Tiny keepalive so NATs don't expire the mapping while one side is busy (e.g. the host
    // waiting on the AI). Pings are swallowed in onmessage above.
    p2pStopPing();
    const ch = p2pChannel;
    p2pPingTimer = setInterval(() => {
        if (ch !== p2pChannel || ch.readyState !== 'open') { p2pStopPing(); return; }
        try { ch.send('{"type":"__ping"}'); } catch (e) {}
    }, P2P_PING_MS);
    p2pSetStatus('connected');
    if (p2pConnectedHook) p2pConnectedHook();
}

function p2pWatchConnection(pc) {
    pc.onconnectionstatechange = () => {
        if (pc !== p2pConnection) return;
        const s = pc.connectionState;
        if (s === 'connected') { clearTimeout(p2pGraceTimer); return; }
        if (s === 'disconnected') {
            // Usually a blip (app switch, Wi-Fi roam, CPU busy). Give ICE a chance to recover
            // before ending a match; the old code gave up instantly.
            clearTimeout(p2pGraceTimer);
            p2pGraceTimer = setTimeout(() => {
                if (pc === p2pConnection && pc.connectionState !== 'connected') p2pConnectionLost(pc);
            }, P2P_GRACE_MS);
            return;
        }
        if (s === 'failed' || s === 'closed') p2pConnectionLost(pc);
    };
}

function p2pConnectionLost(pc) {
    if (pc !== p2pConnection) return;
    clearTimeout(p2pGraceTimer);
    if (p2pChannel && p2pChannel.readyState === 'open') { p2pSetStatus('disconnected'); return; }
    if (p2pChannel && p2pChannel.readyState !== 'connecting') { p2pSetStatus('disconnected'); return; }
    // Never got a channel. A host that is still waiting in a room just frees the slot for the next guest.
    if (p2pIsHostRole && p2pSignal) {
        p2pResetHostPeer();
        p2pSetStatus(p2pMatchActive ? 'match-searching' : 'room-open', { retry: true });
        return;
    }
    p2pFail('ice-failed', "A direct connection couldn't be made — a firewall or mobile network blocked it.");
}

function p2pResetHostPeer() {
    const pc = p2pConnection, ch = p2pChannel;
    p2pChannel = null; p2pConnection = null;
    try { if (ch) ch.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    p2pPendingCandidates = []; p2pRemoteSet = false; p2pRoomPeer = null; p2pConnectionId = null;
}

/* ------------------------------------------------------------------ */
/* Matchmaking (signaling) client — speaks the PeerServer protocol    */
/* ------------------------------------------------------------------ */
function p2pSignalConfig() {
    const cfg = { host: '0.peerjs.com', port: 443, secure: true, path: '/', key: 'peerjs' };
    try { Object.assign(cfg, window.PVP_SIGNAL || {}); } catch (e) {}
    try { Object.assign(cfg, JSON.parse(localStorage.getItem('pvp_signal') || 'null') || {}); } catch (e) {}
    return cfg;
}

function p2pSignalClose() {
    const s = p2pSignal; p2pSignal = null;
    if (!s) return;
    s.closing = true;
    clearInterval(s.hb);
    try { s.ws.close(); } catch (e) {}
}

// Resolves with a signal object once the broker says OPEN. Rejects with {code, message}.
function p2pSignalOpen(id, onmessage, onclose) {
    return new Promise((resolve, reject) => {
        const cfg = p2pSignalConfig();
        const proto = cfg.secure ? 'wss' : 'ws';
        let path = cfg.path || '/'; if (path[0] !== '/') path = '/' + path; if (path[path.length - 1] !== '/') path += '/';
        const url = `${proto}://${cfg.host}:${cfg.port}${path}peerjs?key=${encodeURIComponent(cfg.key)}&id=${encodeURIComponent(id)}&token=${p2pRandom(12)}`;
        let ws, settled = false, opened = false;
        const sig = { id, closing: false, hb: null, ws: null, send: null };
        const fail = (code, message) => { if (settled) return; settled = true; clearTimeout(timer); try { ws && ws.close(); } catch (e) {} reject({ code, message }); };
        const timer = setTimeout(() => fail('server-unreachable', "Couldn't reach the matchmaking server (timed out)."), 10000);
        try { ws = new WebSocket(url); } catch (e) { fail('server-unreachable', "Couldn't reach the matchmaking server."); return; }
        sig.ws = ws;
        sig.send = (type, dst, payload) => { try { ws.send(JSON.stringify({ type, dst, payload })); return true; } catch (e) { return false; } };
        ws.onmessage = (ev) => {
            let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
            if (!settled) {
                if (msg.type === 'OPEN') {
                    settled = true; opened = true; clearTimeout(timer);
                    sig.hb = setInterval(() => { try { ws.send('{"type":"HEARTBEAT"}'); } catch (e) {} }, 5000);
                    resolve(sig);
                } else if (msg.type === 'ID-TAKEN') fail('id-taken', 'That room name is already in use.');
                else if (msg.type === 'INVALID-KEY') fail('server-unreachable', 'The matchmaking server rejected the app key.');
                else if (msg.type === 'ERROR') fail('server-unreachable', (msg.payload && msg.payload.msg) || 'Matchmaking server error.');
                return;
            }
            if (!sig.closing && onmessage) onmessage(msg);
        };
        ws.onerror = () => fail('server-unreachable', "Couldn't reach the matchmaking server. Check your internet connection.");
        ws.onclose = () => {
            if (!opened) { fail('server-unreachable', "Couldn't reach the matchmaking server."); return; } // never opened (e.g. ID-TAKEN): nothing to report
            if (!sig.closing && onclose) onclose();
        };
    });
}

function p2pMakePeer(isHost) {
    const pc = new RTCPeerConnection(p2pIceConfig());
    p2pConnection = pc;
    p2pWatchConnection(pc);
    pc.onicecandidate = (e) => {
        if (!e.candidate || pc !== p2pConnection || !p2pSignal || !p2pRoomPeer) return;
        p2pSignal.send('CANDIDATE', p2pRoomPeer, { candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate, type: 'data', connectionId: p2pConnectionId });
    };
    if (isHost) pc.ondatachannel = (e) => { if (pc === p2pConnection) p2pWireChannel(e.channel); };
    return pc;
}

async function p2pFlushCandidates(pc) {
    p2pRemoteSet = true;
    const list = p2pPendingCandidates; p2pPendingCandidates = [];
    for (const c of list) { try { await pc.addIceCandidate(c); } catch (e) { console.warn('P2P: bad candidate', e); } }
}
function p2pAddRemoteCandidate(candidate) {
    const pc = p2pConnection; if (!pc || !candidate) return;
    if (!p2pRemoteSet) { p2pPendingCandidates.push(candidate); return; }
    pc.addIceCandidate(candidate).catch(e => console.warn('P2P: bad candidate', e));
}

/**
 * HOST: open a room. Waits (indefinitely) for a guest to knock; the first one is answered.
 * Status flow: signal-connecting -> room-open -> negotiating -> connecting -> connected
 */
window.p2pHostRoom = async function (room, pw) {
    p2pDisconnectQuiet();
    const attempt = ++p2pAttemptId;
    p2pIsHostRole = true; p2pIceMode = 'internet';
    p2pSetStatus('signal-connecting');
    try {
        const sig = await p2pSignalOpen(p2pRoomId(room, pw),
            (msg) => { if (attempt === p2pAttemptId) p2pHostOnSignal(msg); },
            () => { if (attempt === p2pAttemptId && !p2pChannel) p2pFail('server-lost', 'Lost contact with the matchmaking server.'); });
        if (attempt !== p2pAttemptId) { try { sig.closing = true; clearInterval(sig.hb); sig.ws.close(); } catch (e) {} return; }
        p2pSignal = sig;
        p2pSetStatus('room-open');
    } catch (err) {
        if (attempt === p2pAttemptId) p2pFail(err.code || 'error', err.message || String(err));
    }
};

async function p2pHostOnSignal(msg) {
    if (!p2pSignal) return;
    const attempt = p2pAttemptId;
    if (msg.type === 'OFFER') {
        if (p2pConnection) { p2pSignal.send('LEAVE', msg.src, { msg: 'busy' }); return; } // room already has a guest
        p2pRoomPeer = msg.src; p2pConnectionId = (msg.payload && msg.payload.connectionId) || null;
        p2pRemoteSet = false; p2pPendingCandidates = [];
        try {
            const pc = p2pMakePeer(true);
            p2pSetStatus('negotiating', { who: 'guest' });
            await pc.setRemoteDescription({ type: 'offer', sdp: msg.payload.sdp });
            await p2pFlushCandidates(pc);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            if (attempt !== p2pAttemptId || !p2pSignal) return;
            p2pSignal.send('ANSWER', msg.src, { sdp: answer.sdp, type: 'data', connectionId: p2pConnectionId, browser: 'chrome' });
            p2pSetStatus('connecting');
        } catch (e) {
            console.warn('P2P host negotiation failed', e);
            if (attempt !== p2pAttemptId) return;
            p2pResetHostPeer();
            p2pSetStatus(p2pMatchActive ? 'match-searching' : 'room-open', { retry: true });
        }
    } else if (msg.type === 'CANDIDATE') {
        if (msg.src === p2pRoomPeer && msg.payload) p2pAddRemoteCandidate(msg.payload.candidate);
    }
}

/**
 * GUEST: knock on a room. Status flow: signal-connecting -> room-looking -> negotiating -> connecting -> connected
 */
window.p2pJoinRoom = async function (room, pw) {
    p2pDisconnectQuiet();
    const attempt = ++p2pAttemptId;
    p2pIsHostRole = false; p2pIceMode = 'internet';
    p2pSetStatus('signal-connecting');
    await p2pJoinId(p2pRoomId(room, pw), attempt, false);
};

// Knocks on `hostId`. quiet = part of a random-match search: don't flash UI statuses for attempts that may just move on.
async function p2pJoinId(hostId, attempt, quiet) {
    let answered = false;
    try {
        const sig = await p2pSignalOpen('aqg' + p2pRandom(20),
            async (msg) => {
                if (attempt !== p2pAttemptId) return;
                if (msg.type === 'ANSWER' && msg.src === hostId && p2pConnection) {
                    answered = true;
                    try {
                        p2pSetStatus('connecting');
                        await p2pConnection.setRemoteDescription({ type: 'answer', sdp: msg.payload.sdp });
                        await p2pFlushCandidates(p2pConnection);
                    } catch (e) { p2pFail('negotiation', 'The handshake with the host failed. Try again.'); }
                } else if (msg.type === 'CANDIDATE' && msg.src === hostId && msg.payload) {
                    p2pAddRemoteCandidate(msg.payload.candidate);
                } else if (msg.type === 'EXPIRE' && !answered) {
                    p2pFail('room-not-found', 'No room found with that name & password.');
                } else if (msg.type === 'LEAVE' && !answered) {
                    p2pFail('room-busy', 'That room already has two players.');
                }
            },
            () => { if (attempt === p2pAttemptId && !p2pChannel && !answered) p2pFail('server-lost', 'Lost contact with the matchmaking server.'); });
        if (attempt !== p2pAttemptId) { try { sig.closing = true; clearInterval(sig.hb); sig.ws.close(); } catch (e) {} return; }
        p2pSignal = sig;
        if (!quiet) p2pSetStatus('room-looking');
        p2pRoomPeer = hostId; p2pConnectionId = 'dc_' + p2pRandom(10);
        p2pRemoteSet = false; p2pPendingCandidates = [];
        const pc = p2pMakePeer(false);
        p2pWireChannel(pc.createDataChannel('game', { ordered: true }));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (attempt !== p2pAttemptId || !p2pSignal) return;
        p2pSignal.send('OFFER', hostId, { sdp: offer.sdp, type: 'data', connectionId: p2pConnectionId, label: 'game', reliable: true, serialization: 'json', browser: 'chrome' });
        if (!quiet) p2pSetStatus('negotiating', { who: 'host' });
    } catch (err) {
        if (attempt === p2pAttemptId) p2pFail(err.code || 'error', err.message || String(err));
    }
}

/* ------------------------------------------------------------------ */
/* RANDOM MATCHMAKING                                                  */
/* ------------------------------------------------------------------ */
// Everyone searching for the same game uses the same numbered "lobby slots" (aqm1-<game>-0..N).
// A searcher tries to CLAIM slot 0 (register that id on the broker). If it is already taken, somebody
// is waiting there, so we knock on it and play them. If it is free we now hold it and wait a few
// seconds; then release and rescan, so two waiting players always cross paths.
const P2P_MATCH_SLOTS = 6;
const P2P_MATCH_LIMIT_MS = 100000;

function p2pWaitOutcome(ms) {
    return new Promise((resolve) => {
        const done = (o) => { clearTimeout(t); p2pFailHook = null; p2pConnectedHook = null; resolve(o); };
        const t = setTimeout(() => done({ ok: false, code: 'timeout' }), ms);
        p2pFailHook = (code, message) => done({ ok: false, code, message });
        p2pConnectedHook = () => done({ ok: true });
    });
}
function p2pTeardownPeer() {
    ++p2pAttemptId;
    p2pFailHook = null; p2pConnectedHook = null;
    clearTimeout(p2pGraceTimer); p2pStopPing(); p2pSignalClose();
    const ch = p2pChannel, pc = p2pConnection;
    p2pChannel = null; p2pConnection = null;
    p2pPendingCandidates = []; p2pRemoteSet = false; p2pRoomPeer = null; p2pConnectionId = null;
    try { if (ch) ch.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
}
const p2pSleep = (ms) => new Promise(r => setTimeout(r, ms));

window.p2pFindMatch = async function (game) {
    p2pDisconnectQuiet();
    const token = p2pMatchToken;
    const alive = () => token === p2pMatchToken;
    p2pMatchActive = true; p2pIceMode = 'internet';
    p2pSetStatus('signal-connecting');
    const start = Date.now();
    const giveUp = (code, message) => { p2pMatchActive = false; p2pTeardownPeer(); p2pFail(code, message); };
    let announcedHosting = false;

    while (alive() && Date.now() - start < P2P_MATCH_LIMIT_MS) {
        for (let slot = 0; slot < P2P_MATCH_SLOTS && alive(); slot++) {
            const id = `aqm1-${game}-${slot}`;
            p2pTeardownPeer();
            const holdAttempt = p2pAttemptId;
            let sig = null;
            try {
                sig = await p2pSignalOpen(id,
                    (msg) => { if (holdAttempt === p2pAttemptId) p2pHostOnSignal(msg); },
                    () => { if (holdAttempt === p2pAttemptId && !p2pChannel && p2pFailHook) p2pFailHook('server-lost', 'Lost contact with the matchmaking server.'); });
            } catch (err) {
                if (!alive()) return;
                if (err.code !== 'id-taken') { giveUp(err.code || 'error', err.message); return; }
            }
            if (!alive()) { if (sig) { sig.closing = true; clearInterval(sig.hb); try { sig.ws.close(); } catch (e) {} } return; }

            if (sig) {
                // ---- slot was free: we hold it and wait for somebody to knock
                p2pSignal = sig; p2pIsHostRole = true;
                p2pSetStatus('match-searching', { hosting: !announcedHosting, elapsed: Date.now() - start });
                announcedHosting = true;
                const w = p2pWaitOutcome(6000 + Math.random() * 5000);
                let o = await w;
                if (!alive()) return;
                if (o.ok) { p2pMatchActive = false; return; }
                if (p2pConnection) { // a guest knocked: give the handshake time to finish
                    o = await p2pWaitOutcome(25000);
                    if (!alive()) return;
                    if (o.ok) { p2pMatchActive = false; return; }
                }
                p2pTeardownPeer(); // release the slot, rescan from slot 0
                p2pSetStatus('match-searching', { elapsed: Date.now() - start });
                await p2pSleep(150 + Math.random() * 600);
                break;
            }

            // ---- slot is taken: somebody is waiting there, knock
            p2pIsHostRole = false;
            const w = p2pWaitOutcome(14000);
            const knockAttempt = ++p2pAttemptId;
            p2pJoinId(id, knockAttempt, true);
            const o = await w;
            if (!alive()) return;
            if (o.ok) { p2pMatchActive = false; return; }
            if (o.code === 'server-unreachable') { giveUp(o.code, o.message); return; }
            p2pTeardownPeer(); // stale / busy / blocked — try the next slot
            p2pSetStatus('match-searching', { elapsed: Date.now() - start });
        }
    }
    if (alive()) giveUp('no-match', 'Nobody else is searching right now.');
};

/* ------------------------------------------------------------------ */
/* Copy/paste code flows (no server). mode: 'lan' (offline) | 'internet' */
/* ------------------------------------------------------------------ */
window.p2pCreateHostCode = async function (mode) {
    p2pDisconnectQuiet();
    ++p2pAttemptId;
    p2pIceMode = mode === 'lan' ? 'lan' : 'internet';
    p2pIsHostRole = true;
    p2pSetStatus('generating');
    const pc = new RTCPeerConnection(p2pIceConfig());
    p2pConnection = pc;
    p2pWatchConnection(pc);
    p2pWireChannel(pc.createDataChannel('game'));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await p2pWaitForIceGathering(pc);

    const code = btoa(JSON.stringify(pc.localDescription));
    p2pSetStatus('waiting-for-guest');
    return code;
};

window.p2pAcceptGuestReply = async function (replyCode) {
    try {
        const answer = JSON.parse(atob(replyCode.trim()));
        await p2pConnection.setRemoteDescription(answer);
        p2pSetStatus('connecting');
    } catch (e) {
        p2pFail('bad-code', 'That code looks invalid or incomplete.');
        throw new Error('That code looks invalid or incomplete.');
    }
};

window.p2pJoinWithHostCode = async function (hostCode, mode) {
    p2pDisconnectQuiet();
    ++p2pAttemptId;
    p2pIceMode = mode === 'lan' ? 'lan' : 'internet';
    p2pIsHostRole = false;
    p2pSetStatus('generating');
    const pc = new RTCPeerConnection(p2pIceConfig());
    p2pConnection = pc;
    p2pWatchConnection(pc);
    pc.ondatachannel = (e) => { if (pc === p2pConnection) p2pWireChannel(e.channel); };

    let offer;
    try { offer = JSON.parse(atob(hostCode.trim())); }
    catch (e) { p2pFail('bad-code', 'That code looks invalid or incomplete.'); throw new Error('That code looks invalid or incomplete.'); }

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await p2pWaitForIceGathering(pc);

    const replyCode = btoa(JSON.stringify(pc.localDescription));
    p2pSetStatus('connecting');
    return replyCode;
};

/* ------------------------------------------------------------------ */
/* Public API used by the games                                       */
/* ------------------------------------------------------------------ */
window.p2pSend = function (data) {
    if (p2pChannel && p2pChannel.readyState === 'open') {
        try { p2pChannel.send(JSON.stringify(data)); return true; } catch (e) { return false; }
    }
    return false;
};

window.p2pOnMessage = function (callback) { p2pOnMessageCallback = callback; };
window.p2pOnStatus = function (callback) { p2pOnStatusCallback = callback; };
window.p2pOnPeerLost = function (callback) { p2pOnPeerLostCallback = callback; };
window.p2pIsHost = function () { return p2pIsHostRole; };
window.p2pIsConnected = function () { return !!(p2pChannel && p2pChannel.readyState === 'open'); };

// Closes everything WITHOUT telling the game (used when starting a new attempt).
function p2pDisconnectQuiet() {
    ++p2pMatchToken; p2pMatchActive = false;
    ++p2pAttemptId;
    p2pFailHook = null; p2pConnectedHook = null;
    clearTimeout(p2pGraceTimer); p2pStopPing(); p2pSignalClose();
    const ch = p2pChannel, pc = p2pConnection;
    p2pChannel = null; p2pConnection = null;
    p2pPendingCandidates = []; p2pRemoteSet = false; p2pRoomPeer = null; p2pConnectionId = null;
    try { if (ch) ch.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
}

// Intentional close: detaches the game's listeners FIRST so closing the channel
// ourselves is never reported back to the game as "opponent left".
window.p2pDisconnect = function () {
    p2pOnPeerLostCallback = null;
    p2pOnMessageCallback = null;
    p2pDisconnectQuiet();
    if (p2pOnStatusCallback) p2pOnStatusCallback('disconnected');
};

/**
 * ============================================================================
 * INVITE LINKS   https://…/?pvp=<room>&pw=<password>&g=duel|riddles
 * ============================================================================
 * Captured here at load time (before the router touches the URL), then acted on by
 * pvpHandleInvite() once the player is signed in and the app shell is showing.
 */
const PVP_GAMES = { duel: 'Quiz Duel', riddles: 'Riddle Duel' };

function pvpParseInvite(text) {
    try {
        const u = new URL(String(text).trim(), location.href);
        const room = u.searchParams.get('pvp'), pw = u.searchParams.get('pw'), g = u.searchParams.get('g');
        if (room && pw && PVP_GAMES[g]) return { room, pw, g };
    } catch (e) {}
    return null;
}
window.pvpParseInvite = pvpParseInvite;

window.pvpBuildInviteLink = function (game, room, pw) {
    let base = location.href.split('#')[0].split('?')[0];
    // file:// / capacitor:// / electron origins can't be opened by a friend — fall back to the public site
    if (!/^https?:$/.test(location.protocol)) base = window.PVP_PUBLIC_URL || 'https://alpha-omega69.github.io/AI-QUIZ-PRO/';
    const u = new URL(base);
    u.searchParams.set('pvp', room); u.searchParams.set('pw', pw); u.searchParams.set('g', game);
    return u.toString();
};

window.__pvpInvite = pvpParseInvite(location.search ? location.href : '');
if (window.__pvpInvite) {
    try { history.replaceState(history.state, '', location.pathname + location.hash); } catch (e) {}
}

window.pvpHandleInvite = function (invite) {
    const inv = invite || window.__pvpInvite;
    if (!inv) return false;
    if (!invite) window.__pvpInvite = null;
    if (window.navigateTo) navigateTo(inv.g === 'duel' ? 'duel' : 'riddles');
    // let the page transition + game enter() hooks run before the overlay opens on top
    setTimeout(() => showPvpConnect(inv.g, {}, { autoJoin: { room: inv.room, pw: inv.pw } }), 350);
    return true;
};

/**
 * ============================================================================
 * SHARED PvP CONNECT UI — a floating overlay reused by Riddle Rush and Quiz Duel.
 * It sits on top of whichever game window is open, so connecting never navigates
 * away or resets anything.
 * ============================================================================
 * Games register a launcher: window.pvpLaunchers.<gameType> = (isHost, options) => {...}
 */
window.pvpLaunchers = window.pvpLaunchers || {};
let p2pPendingGameType = null;
let p2pPendingGameOptions = null;
let p2pLaunched = false;

let pvpView = 'methods';
let pvpBackView = 'methods';
let pvpMethod = null;        // 'room' | 'link' | 'wifi' | 'code'
let pvpRun = null;           // closure that (re)starts the current attempt — used by RETRY
let pvpRole = null;          // 'host' | 'guest'
let pvpStep = -1;
let pvpStartedAt = 0;
let pvpTickTimer = null;
let pvpTimeoutTimer = null;
let pvpFailed = false;
let pvpHostNotified = false;
let pvpShare = null;         // { room, pw, link } while hosting a room / link

const PVP_STEPS = {
    'room-host':  ['Contacting matchmaking server', 'Room open — waiting for a player', 'Negotiating connection', 'Connection open'],
    'room-guest': ['Contacting matchmaking server', 'Looking for the room', 'Negotiating connection', 'Connection open'],
    'match':      ['Contacting matchmaking server', 'Searching for an opponent', 'Opponent found — connecting', 'Connection open'],
    'code':       ['Preparing connection', 'Exchanging codes', 'Opening direct link', 'Connection open']
};
const PVP_STEP_OF = { 'signal-connecting': 0, 'generating': 0, 'room-open': 1, 'room-looking': 1, 'match-searching': 1, 'waiting-for-guest': 1, 'negotiating': 2, 'connecting': 2, connected: 3 };
const PVP_ERRORS = {
    'server-unreachable': "Couldn't reach the matchmaking server. Check your internet connection — or use Same Wi-Fi / hotspot mode, which needs no internet.",
    'server-lost': 'Lost contact with the matchmaking server. Check your connection and try again.',
    'id-taken': 'That room name + password is already in use. Pick a different room name or password.',
    'room-not-found': 'No room found with that name & password. Check the spelling and make sure the host has already started the room.',
    'room-busy': 'That room already has two players.',
    'ice-failed': "A direct connection couldn't be made — a firewall or mobile network blocked it. Try again, or put both phones on the same Wi-Fi / hotspot and use Same Wi-Fi mode.",
    'no-match': "Nobody else is searching for this game right now. Try again in a minute, or invite a friend with a link — you can also play the bot / solo while you wait.",
    'timeout': 'Still not connected after 40 seconds. Check that both players are online and try again — or use Same Wi-Fi / hotspot mode.',
    'negotiation': 'The handshake with the other player failed. Try again.',
    'bad-code': 'That code looks invalid or incomplete.'
};

function pvpEl(id) { return document.getElementById(id); }
function pvpEsc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function pvpShowView(name) {
    pvpView = name;
    ['methods', 'room', 'link', 'code', 'wait'].forEach(v => {
        const el = pvpEl('pvp-view-' + v); if (el) el.style.display = v === name ? 'block' : 'none';
    });
    const card = pvpEl('pvp-connect-card'); if (card) card.scrollTop = 0;
}

function pvpClearTimers() { clearInterval(pvpTickTimer); clearTimeout(pvpTimeoutTimer); pvpTickTimer = null; pvpTimeoutTimer = null; }

window.showPvpConnect = function (gameType, options, extra) {
    p2pDisconnect(); // always start from a clean slate
    pvpClearTimers();
    p2pPendingGameType = gameType;
    p2pPendingGameOptions = options || {};
    p2pLaunched = false;
    p2pIsHostRole = false;
    pvpMethod = null; pvpRun = null; pvpShare = null; pvpFailed = false; pvpHostNotified = false;

    const overlay = pvpEl('pvp-connect-overlay');
    if (!overlay) return;
    pvpEl('pvp-connect-title').textContent = 'Connect — ' + (PVP_GAMES[gameType] || 'PvP');
    ['pvp-room-name', 'pvp-room-pass', 'pvp-link-paste', 'pvp-host-code', 'pvp-host-reply-input', 'pvp-join-code-input', 'pvp-join-reply-output'].forEach(id => {
        const el = pvpEl(id); if (el) el.value = '';
    });
    pvpEl('pvp-join-reply-wrap').style.display = 'none';
    pvpEl('pvp-host-panel').style.display = 'none';
    pvpEl('pvp-join-panel').style.display = 'none';
    pvpEl('pvp-code-choice').style.display = 'flex';
    pvpEl('pvp-connect-status').innerHTML = '';
    pvpShowView('methods');

    window.p2pOnStatus(pvpOnStatus);

    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('show'));

    if (extra && extra.autoJoin) pvpStartRoom('guest', extra.autoJoin.room, extra.autoJoin.pw, 'methods');
};

function p2pCloseConnectOverlay() {
    const overlay = pvpEl('pvp-connect-overlay');
    if (!overlay) return;
    pvpClearTimers();
    overlay.classList.remove('show');
    setTimeout(() => { if (!overlay.classList.contains('show')) overlay.style.display = 'none'; }, 200);
}

function p2pLaunchPendingGame() {
    if (p2pLaunched) return; // 'connected' can fire twice (onopen + readyState check) — launch once
    p2pLaunched = true;
    const launcher = window.pvpLaunchers[p2pPendingGameType];
    const opts = p2pPendingGameOptions || {};
    p2pOnStatusCallback = null; // overlay is done listening
    p2pCloseConnectOverlay();
    // Launch synchronously: the game must register its message handler in the same tick the
    // channel opens, otherwise the first message from the other side could arrive unheard.
    if (launcher) launcher(p2pIsHostRole, opts);
}

/* ---------- status -> UI ---------- */
function pvpOnStatus(status, detail) {
    if (status === 'connected') { pvpClearTimers(); p2pLaunchPendingGame(); return; }
    if (status === 'disconnected') return;
    if (pvpView === 'wait') {
        if (status === 'error') { pvpShowFailure(detail); return; }
        if (status in PVP_STEP_OF) {
            pvpStep = Math.max(pvpStep, PVP_STEP_OF[status]);
            if (status === 'room-open' || status === 'match-searching') pvpStep = 1;
            if (status === 'match-searching' && detail && detail.hosting && !pvpHostNotified) { pvpHostNotified = true; pvpNotifyHosting(); }
            pvpFailed = false;
            // a host can sit in an open room for ages; the clock only matters once someone knocks
            if (status === 'negotiating' && pvpRole === 'host') { clearTimeout(pvpTimeoutTimer); pvpStartedAt = Date.now(); pvpTimeoutTimer = setTimeout(() => pvpShowFailure({ code: 'timeout' }), 40000); }
            pvpRenderWait(status, detail);
        }
        return;
    }
    // code-exchange views: a simple status line
    const el = pvpEl('pvp-connect-status'); if (!el) return;
    const spin = '<span class="pvp-spin" aria-hidden="true"></span>';
    const msg = {
        generating: spin + 'Generating connection code…',
        'waiting-for-guest': 'Waiting for the other player to paste their reply code…',
        connecting: spin + 'Connecting… (up to 40s)',
        error: '✕ ' + ((detail && detail.message) || 'Connection error — check the code and try again.')
    }[status];
    el.innerHTML = msg || pvpEsc(status);
    if (status === 'connecting') {
        clearTimeout(pvpTimeoutTimer);
        pvpTimeoutTimer = setTimeout(() => {
            el.innerHTML = '✕ ' + pvpEsc(PVP_ERRORS.timeout);
        }, 40000);
    } else if (status === 'error') clearTimeout(pvpTimeoutTimer);
}

function pvpRenderWait(status, detail) {
    const key = pvpMethod === 'random' ? 'match' : (pvpMethod === 'code' || pvpMethod === 'wifi' ? 'code' : (pvpRole === 'host' ? 'room-host' : 'room-guest'));
    const steps = PVP_STEPS[key];
    pvpEl('pvp-steps').innerHTML = steps.map((label, i) => {
        const cls = pvpFailed && i === pvpStep ? 'fail' : (i < pvpStep ? 'done' : (i === pvpStep ? 'active' : ''));
        const icon = cls === 'done' ? '✓' : (cls === 'fail' ? '✕' : (cls === 'active' ? '<span class="pvp-spin"></span>' : '○'));
        return `<li class="${cls}"><span class="pvp-step-ic">${icon}</span>${pvpEsc(label)}</li>`;
    }).join('');
    const title = pvpEl('pvp-wait-title'), sub = pvpEl('pvp-wait-sub');
    const titles = {
        'signal-connecting': 'Connecting…', 'match-searching': 'Searching for an opponent…', 'room-open': 'Room is open', 'room-looking': 'Finding the room…',
        negotiating: 'Setting up the link…', connecting: 'Almost there…'
    };
    title.textContent = titles[status] || 'Connecting…';
    if (status === 'room-open') sub.textContent = (detail && detail.retry) ? 'The last attempt dropped — still waiting for a player to join.' : 'Share the room details below. The match starts automatically when they join.';
    else if (status === 'match-searching') sub.textContent = 'Looking for another player who is searching right now. You\'ll be paired automatically — this can take a minute if few people are online.';
    else if (status === 'negotiating') sub.textContent = pvpRole === 'host' ? 'A player is joining…' : 'Knocking on the room — waiting for the host to answer…';
    else sub.textContent = 'This usually takes a few seconds.';
    pvpEl('pvp-wait-spinner').style.display = pvpFailed ? 'none' : 'block';
    pvpEl('pvp-wait-share').style.display = (pvpShare && pvpRole === 'host') ? 'block' : 'none';
    pvpEl('pvp-retry-btn').style.display = pvpFailed ? 'block' : 'none';
    pvpEl('pvp-wait-error').style.display = pvpFailed ? 'block' : 'none';
}

function pvpShowFailure(detail) {
    pvpClearTimers();
    pvpFailed = true;
    const code = detail && detail.code;
    const text = PVP_ERRORS[code] || (detail && detail.message) || 'Connection failed.';
    pvpEl('pvp-wait-error').textContent = text;
    pvpEl('pvp-wait-title').textContent = 'Connection failed';
    pvpEl('pvp-wait-sub').textContent = '';
    pvpRenderWait('error');
    pvpEl('pvp-wait-title').textContent = 'Connection failed';
    pvpEl('pvp-wait-sub').textContent = '';
    // a taken room name can't be fixed by retrying — only by changing it
    pvpEl('pvp-retry-btn').style.display = code === 'id-taken' ? 'none' : 'block';
    p2pDisconnect();
    window.p2pOnStatus(pvpOnStatus);
}

function pvpStartTicker(timeoutMs) {
    pvpClearTimers();
    pvpStartedAt = Date.now();
    const tick = () => {
        const s = Math.floor((Date.now() - pvpStartedAt) / 1000);
        const el = pvpEl('pvp-elapsed'); if (!el) return;
        const waitingForPlayer = (pvpRole === 'host' || pvpRole === 'match') && pvpStep === 1;
        el.textContent = waitingForPlayer ? (pvpRole === 'match' ? `Searching ${s}s` : `Waiting ${s}s`) : (s >= 15 ? `${s}s — slow networks can take up to 40s…` : `${s}s`);
    };
    tick();
    pvpTickTimer = setInterval(tick, 1000);
    if (timeoutMs) {
        pvpTimeoutTimer = setTimeout(() => {
            // a host sitting in an open room is not a failure — only a stuck negotiation is
            if (pvpRole === 'host' && pvpStep <= 1) return;
            pvpShowFailure({ code: 'timeout' });
        }, timeoutMs);
    }
}

// Lets a game warm things up (e.g. Quiz Duel starts generating questions) as soon as we are the host.
function pvpNotifyHosting() {
    try { const h = window.pvpOnHosting && window.pvpOnHosting[p2pPendingGameType]; if (h) h(p2pPendingGameOptions || {}); } catch (e) { console.warn(e); }
}

/* ---------- starting attempts ---------- */
function pvpEnterWait(role, backView, run) {
    pvpRole = role; pvpBackView = backView; pvpRun = run; pvpStep = 0; pvpFailed = false;
    pvpShowView('wait');
    pvpRenderWait('signal-connecting');
    pvpStartTicker(40000);
}

function pvpStartRoom(role, room, pw, backView) {
    pvpMethod = pvpMethod === 'link' ? 'link' : 'room';
    const run = () => {
        pvpEnterWait(role, backView, run);
        window.p2pOnStatus(pvpOnStatus);
        p2pIsHostRole = role === 'host';
        (role === 'host' ? p2pHostRoom : p2pJoinRoom)(room, pw);
    };
    pvpShare = role === 'host' ? { room, pw, link: pvpBuildInviteLink(p2pPendingGameType, room, pw) } : null;
    if (pvpShare) {
        pvpNotifyHosting();
        pvpEl('pvp-share-room').textContent = room;
        pvpEl('pvp-share-pass').textContent = pw;
        pvpEl('pvp-share-link').value = pvpShare.link;
    }
    run();
}

window.pvpStartRandom = function () {
    pvpMethod = 'random'; pvpShare = null; pvpHostNotified = false;
    const run = () => {
        pvpHostNotified = false;
        pvpEnterWait('match', 'methods', run);
        pvpClearTimers(); pvpStartTicker(0); // the matchmaking layer enforces its own limits
        window.p2pOnStatus(pvpOnStatus);
        p2pFindMatch(p2pPendingGameType);
    };
    run();
};

window.pvpPickMethod = function (m) {
    if (typeof playSound === 'function') playSound('snd-click');
    pvpMethod = m;
    if (m === 'room') pvpShowView('room');
    else if (m === 'link') pvpShowView('link');
    else if (m === 'random') pvpStartRandom();
    else { // 'wifi' | 'code'
        pvpEl('pvp-code-choice').style.display = 'flex';
        pvpEl('pvp-host-panel').style.display = 'none';
        pvpEl('pvp-join-panel').style.display = 'none';
        pvpEl('pvp-code-hint').innerHTML = m === 'wifi'
            ? '<b>No internet needed.</b> Both phones/PCs must be on the same Wi-Fi, or one phone\'s hotspot. Copy a code across (message, AirDrop, QR…) in each direction.'
            : 'No account or server needed. The host sends a short code; the other player pastes it and sends back a reply code.';
        pvpEl('pvp-connect-status').innerHTML = '';
        pvpShowView('code');
    }
};
window.pvpBackToMethods = function () {
    p2pDisconnect(); window.p2pOnStatus(pvpOnStatus);
    pvpClearTimers(); pvpFailed = false;
    pvpEl('pvp-connect-status').innerHTML = '';
    pvpShowView('methods');
};
window.pvpBackFromWait = function () {
    p2pDisconnect(); window.p2pOnStatus(pvpOnStatus);
    pvpClearTimers();
    pvpShowView(pvpBackView && pvpBackView !== 'wait' ? pvpBackView : 'methods');
};
window.pvpRetry = function () { if (pvpRun) pvpRun(); };

function pvpRoomInputs() {
    const room = pvpEl('pvp-room-name').value.trim(), pw = pvpEl('pvp-room-pass').value;
    const err = pvpEl('pvp-room-error');
    if (room.length < 3) { err.textContent = 'Room name needs at least 3 characters.'; pvpEl('pvp-room-name').focus(); return null; }
    if (pw.length < 3) { err.textContent = 'Password needs at least 3 characters.'; pvpEl('pvp-room-pass').focus(); return null; }
    err.textContent = '';
    return { room, pw };
}
window.pvpRoomHost = function () { const v = pvpRoomInputs(); if (v) { pvpMethod = 'room'; pvpStartRoom('host', v.room, v.pw, 'room'); } };
window.pvpRoomJoin = function () { const v = pvpRoomInputs(); if (v) { pvpMethod = 'room'; pvpStartRoom('guest', v.room, v.pw, 'room'); } };

window.pvpLinkCreate = function () {
    pvpMethod = 'link';
    pvpStartRoom('host', 'r-' + p2pRandom(6), p2pRandom(6), 'link');
};
window.pvpLinkJoinPasted = function () {
    const err = pvpEl('pvp-link-error');
    const inv = pvpParseInvite(pvpEl('pvp-link-paste').value);
    if (!inv) { err.textContent = "That doesn't look like an invite link."; return; }
    err.textContent = '';
    if (inv.g !== p2pPendingGameType) { // link is for the other game — open that game first
        p2pCloseConnectOverlay(); p2pDisconnect();
        pvpHandleInvite(inv);
        return;
    }
    pvpMethod = 'link';
    pvpStartRoom('guest', inv.room, inv.pw, 'link');
};

window.pvpCopyText = function (text, btn) {
    const done = () => { if (btn) { const o = btn.textContent; btn.textContent = '✔ COPIED'; setTimeout(() => { btn.textContent = o; }, 1400); } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => window.prompt('Copy this:', text));
    else window.prompt('Copy this:', text);
    if (typeof playSound === 'function') playSound('snd-click');
};
window.pvpCopyInvite = function (btn) { if (pvpShare) pvpCopyText(pvpShare.link, btn); };
window.pvpCopyRoom = function (btn) { if (pvpShare) pvpCopyText(`Room: ${pvpShare.room}\nPassword: ${pvpShare.pw}`, btn); };
window.pvpShareInvite = function () {
    if (!pvpShare) return;
    const text = `Join my ${PVP_GAMES[p2pPendingGameType] || 'game'} on AI Quiz Pro!`;
    if (navigator.share) navigator.share({ title: 'AI Quiz Pro — PvP invite', text, url: pvpShare.link }).catch(() => {});
    else pvpCopyText(pvpShare.link, pvpEl('pvp-share-copy-btn'));
};

/* ---------- copy/paste code flows ---------- */
window.pvpChooseHost = async function () {
    p2pIsHostRole = true;
    pvpNotifyHosting();
    pvpEl('pvp-code-choice').style.display = 'none';
    pvpEl('pvp-host-panel').style.display = 'block';
    try {
        window.p2pOnStatus(pvpOnStatus);
        const code = await p2pCreateHostCode(pvpMethod === 'wifi' ? 'lan' : 'internet');
        pvpEl('pvp-host-code').value = code;
    } catch (e) {
        pvpEl('pvp-connect-status').textContent = 'Could not start hosting: ' + (e.message || e);
    }
};

window.pvpSubmitGuestReply = async function () {
    const reply = pvpEl('pvp-host-reply-input').value;
    if (!reply.trim()) return;
    try { await p2pAcceptGuestReply(reply); }
    catch (e) { pvpEl('pvp-connect-status').textContent = '✕ ' + e.message; }
};

window.pvpChooseJoin = function () {
    p2pIsHostRole = false;
    pvpEl('pvp-code-choice').style.display = 'none';
    pvpEl('pvp-join-panel').style.display = 'block';
};

window.pvpSubmitHostCode = async function () {
    const hostCode = pvpEl('pvp-join-code-input').value;
    if (!hostCode.trim()) return;
    try {
        window.p2pOnStatus(pvpOnStatus);
        const replyCode = await p2pJoinWithHostCode(hostCode, pvpMethod === 'wifi' ? 'lan' : 'internet');
        pvpEl('pvp-join-reply-output').value = replyCode;
        pvpEl('pvp-join-reply-wrap').style.display = 'block';
    } catch (e) { pvpEl('pvp-connect-status').textContent = '✕ ' + e.message; }
};

window.pvpCancelConnect = function () {
    if (!p2pLaunched) p2pDisconnect();
    p2pCloseConnectOverlay();
};

window.pvpCopyCode = function (elementId) {
    const el = pvpEl(elementId);
    if (!el) return;
    el.select();
    if (navigator.clipboard) navigator.clipboard.writeText(el.value).catch(() => {});
    if (typeof playSound === 'function') playSound('snd-click');
};
