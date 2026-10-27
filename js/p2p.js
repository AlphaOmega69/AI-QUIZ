/**
 * ============================================================================
 * P2P CONNECTION LAYER — WebRTC data channel, manual signaling
 * ============================================================================
 * HONEST LIMITATION, READ FIRST: this app has no backend, so there is no
 * automatic matchmaking or server to relay the connection handshake. WebRTC
 * still works peer-to-peer without one, but the very first handshake (the
 * "offer"/"answer" exchange) has to travel through SOME channel — here,
 * that channel is the player himself: Host generates a short connection
 * code, sends it to the Guest via any means (text, Discord, in person), the
 * Guest pastes it in and generates a reply code, which the Host pastes back.
 * After that one-time handshake, the connection is genuinely direct
 * peer-to-peer over a WebRTC data channel — no server in the middle, no
 * per-message relay cost, works over the internet or a local network alike.
 *
 * Uses only free public STUN servers (for NAT traversal) — no TURN server,
 * because a reliable TURN relay costs real money to run and there's no
 * backend budget for one here. That means most home/school/mobile networks
 * will connect fine, but very restrictive corporate firewalls or double-NAT
 * setups occasionally can't — if a connection times out, the most reliable
 * fix is both players joining the same WiFi network.
 */
let p2pConnection = null;
let p2pChannel = null;
let p2pOnMessageCallback = null;
let p2pOnStatusCallback = null;
let p2pOnPeerLostCallback = null;
let p2pIsHostRole = false;

const P2P_STUN_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

function p2pSetStatus(status) {
    if (p2pOnStatusCallback) p2pOnStatusCallback(status);
    // A game registers p2pOnPeerLost() so it can end the match cleanly if the other
    // player drops (closed tab, lost signal) instead of hanging on a dead channel.
    if ((status === 'disconnected' || status === 'error') && p2pOnPeerLostCallback) {
        const cb = p2pOnPeerLostCallback;
        cb(status);
    }
}

// Waits for ICE gathering to finish so the generated code includes every
// candidate up front (simplest correct approach for manual copy/paste signaling).
function p2pWaitForIceGathering(pc) {
    return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') { resolve(); return; }
        function check() {
            if (pc.iceGatheringState === 'complete') {
                pc.removeEventListener('icegatheringstatechange', check);
                resolve();
            }
        }
        pc.addEventListener('icegatheringstatechange', check);
        setTimeout(resolve, 4000); // don't hang forever on a slow/partial ICE gather
    });
}

function p2pWireChannel(channel) {
    p2pChannel = channel;
    // Every handler checks `channel === p2pChannel`, so late events from a channel we
    // already replaced or closed on purpose can never leak into the next game.
    channel.onopen = () => { if (channel === p2pChannel) p2pSetStatus('connected'); };
    channel.onclose = () => { if (channel === p2pChannel) p2pSetStatus('disconnected'); };
    channel.onerror = () => { if (channel === p2pChannel) p2pSetStatus('error'); };
    channel.onmessage = (e) => {
        if (channel !== p2pChannel) return;
        try {
            const data = JSON.parse(e.data);
            if (p2pOnMessageCallback) p2pOnMessageCallback(data);
        } catch (err) { console.warn('P2P: malformed message', err); }
    };
    if (channel.readyState === 'open') p2pSetStatus('connected');
}

function p2pWatchConnection(pc) {
    pc.onconnectionstatechange = () => {
        if (pc !== p2pConnection) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
            if (p2pChannel) p2pSetStatus('disconnected');
            else if (pc.connectionState === 'failed') p2pSetStatus('error');
        }
    };
}

/**
 * HOST side: creates the connection + data channel, generates a connection
 * code (base64 of the SDP offer + ICE candidates) to send to the other player.
 */
window.p2pCreateHostCode = async function() {
    p2pSetStatus('generating');
    p2pConnection = new RTCPeerConnection(P2P_STUN_CONFIG);
    p2pWatchConnection(p2pConnection);
    const channel = p2pConnection.createDataChannel('game');
    p2pWireChannel(channel);

    const offer = await p2pConnection.createOffer();
    await p2pConnection.setLocalDescription(offer);
    await p2pWaitForIceGathering(p2pConnection);

    const code = btoa(JSON.stringify(p2pConnection.localDescription));
    p2pSetStatus('waiting-for-guest');
    return code;
};

/**
 * HOST side: once the Guest sends back their reply code, feed it in here to complete the handshake.
 */
window.p2pAcceptGuestReply = async function(replyCode) {
    try {
        const answer = JSON.parse(atob(replyCode.trim()));
        await p2pConnection.setRemoteDescription(answer);
        p2pSetStatus('connecting');
    } catch (e) {
        p2pSetStatus('error');
        throw new Error('That code looks invalid or incomplete.');
    }
};

/**
 * GUEST side: paste the Host's code in here — returns a reply code to send back to the Host.
 */
window.p2pJoinWithHostCode = async function(hostCode) {
    p2pSetStatus('generating');
    p2pConnection = new RTCPeerConnection(P2P_STUN_CONFIG);
    p2pWatchConnection(p2pConnection);
    p2pConnection.ondatachannel = (e) => p2pWireChannel(e.channel);

    let offer;
    try { offer = JSON.parse(atob(hostCode.trim())); }
    catch (e) { p2pSetStatus('error'); throw new Error('That code looks invalid or incomplete.'); }

    await p2pConnection.setRemoteDescription(offer);
    const answer = await p2pConnection.createAnswer();
    await p2pConnection.setLocalDescription(answer);
    await p2pWaitForIceGathering(p2pConnection);

    const replyCode = btoa(JSON.stringify(p2pConnection.localDescription));
    p2pSetStatus('connecting');
    return replyCode;
};

window.p2pSend = function(data) {
    if (p2pChannel && p2pChannel.readyState === 'open') {
        try { p2pChannel.send(JSON.stringify(data)); return true; } catch (e) { return false; }
    }
    return false;
};

window.p2pOnMessage = function(callback) { p2pOnMessageCallback = callback; };
window.p2pOnStatus = function(callback) { p2pOnStatusCallback = callback; };
window.p2pOnPeerLost = function(callback) { p2pOnPeerLostCallback = callback; };
window.p2pIsHost = function() { return p2pIsHostRole; };

window.p2pIsConnected = function() {
    return !!(p2pChannel && p2pChannel.readyState === 'open');
};

// Intentional close: detaches the game's listeners FIRST so closing the channel
// ourselves is never reported back to the game as "opponent left".
window.p2pDisconnect = function() {
    p2pOnPeerLostCallback = null;
    p2pOnMessageCallback = null;
    const ch = p2pChannel, pc = p2pConnection;
    p2pChannel = null;
    p2pConnection = null;
    try { if (ch) ch.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    if (p2pOnStatusCallback) p2pOnStatusCallback('disconnected');
};

/**
 * ============================================================================
 * SHARED PvP CONNECT UI — a floating overlay reused by Riddle Rush and Quiz Duel.
 * It sits on top of whichever game window is open, so connecting never navigates
 * away or resets anything (the old full-page connect screen did both).
 * ============================================================================
 * Games register a launcher: window.pvpLaunchers.<gameType> = (isHost, options) => {...}
 */
window.pvpLaunchers = window.pvpLaunchers || {};
let p2pPendingGameType = null;
let p2pPendingGameOptions = null;
let p2pLaunched = false;

const P2P_STATUS_LABELS = {
    generating: 'Generating connection code...',
    'waiting-for-guest': 'Waiting for the other player to paste their reply code...',
    connecting: 'Connecting...',
    connected: '✔ Connected!',
    disconnected: 'Disconnected.',
    error: 'Connection error — check the code and try again.'
};

window.showPvpConnect = function(gameType, options) {
    p2pDisconnect(); // always start from a clean slate
    p2pPendingGameType = gameType;
    p2pPendingGameOptions = options || {};
    p2pLaunched = false;
    p2pIsHostRole = false;

    const overlay = document.getElementById('pvp-connect-overlay');
    if (!overlay) return;
    document.getElementById('pvp-connect-title').textContent = gameType === 'duel' ? 'Connect — Quiz Duel' : 'Connect — Riddle Duel';
    document.getElementById('pvp-connect-choice').style.display = 'flex';
    document.getElementById('pvp-host-panel').style.display = 'none';
    document.getElementById('pvp-join-panel').style.display = 'none';
    document.getElementById('pvp-join-reply-wrap').style.display = 'none';
    ['pvp-host-code', 'pvp-host-reply-input', 'pvp-join-code-input', 'pvp-join-reply-output'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('pvp-connect-status').textContent = '';

    window.p2pOnStatus((status) => {
        const statusEl = document.getElementById('pvp-connect-status');
        if (statusEl) statusEl.textContent = P2P_STATUS_LABELS[status] || status;
        if (status === 'connected') p2pLaunchPendingGame();
    });

    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('show'));
};

function p2pCloseConnectOverlay() {
    const overlay = document.getElementById('pvp-connect-overlay');
    if (!overlay) return;
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

window.pvpChooseHost = async function() {
    p2pIsHostRole = true;
    document.getElementById('pvp-connect-choice').style.display = 'none';
    document.getElementById('pvp-host-panel').style.display = 'block';
    try {
        const code = await p2pCreateHostCode();
        document.getElementById('pvp-host-code').value = code;
    } catch (e) {
        document.getElementById('pvp-connect-status').textContent = 'Could not start hosting: ' + (e.message || e);
    }
};

window.pvpSubmitGuestReply = async function() {
    const reply = document.getElementById('pvp-host-reply-input').value;
    if (!reply.trim()) return;
    try { await p2pAcceptGuestReply(reply); }
    catch (e) { document.getElementById('pvp-connect-status').textContent = '✕ ' + e.message; }
};

window.pvpChooseJoin = function() {
    p2pIsHostRole = false;
    document.getElementById('pvp-connect-choice').style.display = 'none';
    document.getElementById('pvp-join-panel').style.display = 'block';
};

window.pvpSubmitHostCode = async function() {
    const hostCode = document.getElementById('pvp-join-code-input').value;
    if (!hostCode.trim()) return;
    try {
        const replyCode = await p2pJoinWithHostCode(hostCode);
        document.getElementById('pvp-join-reply-output').value = replyCode;
        document.getElementById('pvp-join-reply-wrap').style.display = 'block';
    } catch (e) { document.getElementById('pvp-connect-status').textContent = '✕ ' + e.message; }
};

window.pvpCancelConnect = function() {
    if (!p2pLaunched) p2pDisconnect();
    p2pCloseConnectOverlay();
};

window.pvpCopyCode = function(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.select();
    if (navigator.clipboard) navigator.clipboard.writeText(el.value).catch(() => {});
    if (typeof playSound === 'function') playSound('snd-click');
};
