/**
 * ============================================================================
 * AUTH — Login screen (Google / Facebook / Email / Guest) + Feedback + Help
 * ============================================================================
 * IMPORTANT HONESTY NOTE: this app has no backend server. "Login" here means
 * a local profile stored in this browser's localStorage — it personalizes the
 * experience (shows your name, ties your local stats to an identity) but it
 * is NOT secure authentication and nothing is verified or synced across
 * devices. Google/Facebook sign-in fetch your name/email/photo from their
 * services client-side, then store that locally the same way Email/Guest do.
 */

/* ============================================================================
   ROUTING: splash -> login (if no saved profile) -> main app
   ============================================================================ */
function routeAfterSplash() {
    const profile = getUserProfile();
    if (profile) {
        enterMainApp();
        return;
    }
    // Backward compatibility: someone who already set a custom identity via the
    // profile editor before this login system existed shouldn't be forced through
    // a login screen — adopt their existing name/avatar as their profile.
    const legacyName = localStorage.getItem('user_name');
    if (legacyName && legacyName !== 'GUEST_01') {
        const legacyProfile = { name: legacyName, email: null, method: 'legacy', avatar: localStorage.getItem('user_pfp') || null };
        localStorage.setItem('user_profile', JSON.stringify(legacyProfile));
        enterMainApp();
        return;
    }
    document.getElementById('login-screen').style.display = 'flex';
    applyAuthSetupBadges();
}
window.routeAfterSplash = routeAfterSplash;

// Shows a small "setup needed" badge directly on the Google/Facebook buttons
// when js/config.js hasn't been filled in yet, so it's obvious before tapping
// rather than only discovered after (see AUTH_SETUP.md for the 5-min setup).
function applyAuthSetupBadges() {
    const googleBadge = document.getElementById('google-setup-badge');
    const fbBadge = document.getElementById('facebook-setup-badge');
    const googleBtn = document.getElementById('google-login-btn');
    const fbBtn = document.getElementById('facebook-login-btn');

    const googleConfigured = !!(window.AUTH_CONFIG && AUTH_CONFIG.googleClientId);
    const fbConfigured = !!(window.AUTH_CONFIG && AUTH_CONFIG.facebookAppId);

    if (googleBadge) googleBadge.style.display = googleConfigured ? 'none' : 'inline-block';
    if (fbBadge) fbBadge.style.display = fbConfigured ? 'none' : 'inline-block';
    if (googleBtn) googleBtn.classList.toggle('needs-setup', !googleConfigured);
    if (fbBtn) fbBtn.classList.toggle('needs-setup', !fbConfigured);
}
window.applyAuthSetupBadges = applyAuthSetupBadges;

function getUserProfile() {
    try { return JSON.parse(localStorage.getItem('user_profile') || 'null'); }
    catch (e) { return null; }
}

// [UNIFIED IDENTITY] One identity, one source of truth. Logging in (any method)
// writes straight into the SAME localStorage keys the profile editor (top-left
// avatar/name button) already uses — so the nav badge, the profile modal, and
// the login profile can never show three different names again.
function saveUserProfile(profile) {
    localStorage.setItem('user_profile', JSON.stringify(profile));
    localStorage.setItem('user_name', profile.name);
    if (profile.avatar) localStorage.setItem('user_pfp', profile.avatar);

    // reflect immediately in the sidebar nav, topbar chip, and profile modal without needing a reload
    const displayName = document.getElementById('display-name');
    const nameInput = document.getElementById('user-name-input');
    const userPfp = document.getElementById('user-pfp');
    if (displayName) displayName.textContent = profile.name;
    if (nameInput) nameInput.value = profile.name;
    if (profile.avatar && userPfp) userPfp.src = profile.avatar;
    if (window.updateHomeNav) updateHomeNav();

    document.getElementById('login-screen').style.display = 'none';
    enterMainApp();
}

function enterMainApp() {
    document.getElementById('app-shell').style.display = 'flex';
    if (window.Router) Router.start(); else if (window.navigateTo) navigateTo('home', { silent: true });

    // The particle network + background video are now reserved for the
    // splash and login screens only — the main app has its own per-page
    // tinted backgrounds instead (see #page-content[data-active-page] in CSS).
    const particleCanvas = document.getElementById('particle-network');
    const bgVideo = document.getElementById('bg-video');
    const overlay = document.querySelector('.overlay');
    if (particleCanvas) particleCanvas.style.display = 'none';
    if (bgVideo) { bgVideo.pause(); bgVideo.style.display = 'none'; }
    if (overlay) overlay.style.display = 'none';

    // Senpai + achievement toasts are deliberately held back until this point
    // (see features.js onAppReady) so they never appear over the splash/login screens.
    if (window.refreshSenpaiVisibility) refreshSenpaiVisibility();
    if (window.checkAndToastNewAchievements) checkAndToastNewAchievements();
    if (window.renderExpChips) renderExpChips();
    if (window.checkDailyTasks) checkDailyTasks();
    if (window.updateHomeNav) updateHomeNav();

    applyProfileGreeting();
}
window.enterMainApp = enterMainApp;

function applyProfileGreeting() {
    const profile = getUserProfile();
    const line = document.getElementById('settings-profile-line');
    if (line) {
        const name = localStorage.getItem('user_name') || (profile && profile.name) || 'GUEST_01';
        line.textContent = profile
            ? `Signed in as ${name}${profile.email ? ' (' + profile.email + ')' : ''} · via ${profile.method}`
            : 'Not signed in.';
    }
}

/* ============================================================================
   EMAIL LOGIN
   ============================================================================ */
window.showEmailLogin = function() {
    document.getElementById('login-options').style.display = 'none';
    document.getElementById('email-login-form').style.display = 'block';
};
window.hideEmailLogin = function() {
    document.getElementById('email-login-form').style.display = 'none';
    document.getElementById('login-options').style.display = 'flex';
};
window.loginWithEmail = function() {
    const nameEl = document.getElementById('login-name');
    const emailEl = document.getElementById('login-email');
    const name = nameEl.value.trim();
    const email = emailEl.value.trim();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    [nameEl, emailEl].forEach(el => el.style.borderColor = '');
    if (!name) { nameEl.style.borderColor = 'var(--danger)'; nameEl.focus(); return; }
    if (!emailOk) { emailEl.style.borderColor = 'var(--danger)'; emailEl.focus(); return; }

    saveUserProfile({ name, email, method: 'email' });
};

/* ============================================================================
   GUEST LOGIN
   ============================================================================ */
window.loginAsGuest = function() {
    const id = Math.floor(1000 + Math.random() * 9000);
    saveUserProfile({ name: `Guest-${id}`, email: null, method: 'guest' });
};

/* ============================================================================
   GOOGLE LOGIN (Google Identity Services — client-side only)
   ============================================================================ */
window.loginWithGoogle = function() {
    if (!AUTH_CONFIG.googleClientId) { showAuthSetupNotice('Google', 'google-login-btn'); return; }
    if (!window.google || !google.accounts || !google.accounts.id) {
        showAuthSetupNotice('Google (still loading — try again in a second)', 'google-login-btn');
        return;
    }
    google.accounts.id.initialize({
        client_id: AUTH_CONFIG.googleClientId,
        callback: handleGoogleCredential
    });
    google.accounts.id.prompt((notification) => {
        if (notification.isNotDisplayed && notification.isNotDisplayed() ||
            notification.isSkippedMoment && notification.isSkippedMoment()) {
            showAuthSetupNotice('Google (popup blocked or dismissed — try again)', 'google-login-btn');
        }
    });
};

function handleGoogleCredential(response) {
    try {
        const payload = decodeJwtPayload(response.credential);
        saveUserProfile({ name: payload.name, email: payload.email, avatar: payload.picture, method: 'google' });
    } catch (e) {
        console.error('Google credential decode failed:', e);
        showAuthSetupNotice('Google (something went wrong)', 'google-login-btn');
    }
}

function decodeJwtPayload(jwt) {
    const base64Url = jwt.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(atob(base64).split('').map(c =>
        '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
    ).join(''));
    return JSON.parse(json);
}

/* ============================================================================
   FACEBOOK LOGIN
   ============================================================================ */
let fbReady = false;
window.fbAsyncInit = function() {
    if (!AUTH_CONFIG.facebookAppId) return;
    FB.init({ appId: AUTH_CONFIG.facebookAppId, cookie: false, xfbml: false, version: 'v19.0' });
    fbReady = true;
};

window.loginWithFacebook = function() {
    if (!AUTH_CONFIG.facebookAppId) { showAuthSetupNotice('Facebook', 'facebook-login-btn'); return; }
    if (!window.FB || !fbReady) { showAuthSetupNotice('Facebook (still loading — try again in a second)', 'facebook-login-btn'); return; }

    FB.login((response) => {
        if (response.authResponse) {
            FB.api('/me', { fields: 'name,email,picture' }, (me) => {
                saveUserProfile({
                    name: me.name,
                    email: me.email || null,
                    avatar: me.picture && me.picture.data ? me.picture.data.url : null,
                    method: 'facebook'
                });
            });
        }
    }, { scope: 'public_profile,email' });
};

/* ============================================================================
   SETUP NOTICE (shown inline when a provider isn't configured yet)
   ============================================================================ */
function showAuthSetupNotice(providerLabel, nearButtonId) {
    let notice = document.getElementById('login-setup-notice');
    if (!notice) {
        notice = document.createElement('div');
        notice.id = 'login-setup-notice';
        notice.className = 'login-note';
        notice.style.color = 'var(--warning)';
        document.getElementById('login-options').insertAdjacentElement('afterend', notice);
    }
    notice.textContent = `${providerLabel} sign-in isn't set up on this copy of the app yet (see AUTH_SETUP.md). Use Email or Guest for now.`;
}

/* ============================================================================
   LOGOUT
   ============================================================================ */
window.logoutUser = function() {
    if (!confirm('Log out? Your quiz history, notes, and achievements stay on this device — only your profile identity (name/photo) is cleared.')) return;
    localStorage.removeItem('user_profile');
    localStorage.removeItem('user_name');
    localStorage.removeItem('user_pfp');
    // drop the per-tab state too (typed drafts, an unfinished quiz) and the page hash, so the next person starts clean
    try { sessionStorage.removeItem('drafts_v1'); sessionStorage.removeItem('quiz_session_v1'); } catch (e) {}
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    location.reload();
};

/* ============================================================================
   FEEDBACK
   ============================================================================ */
let feedbackRating = 0;
window.setFeedbackRating = function(val) {
    feedbackRating = val;
    document.querySelectorAll('#feedback-rating .star').forEach(s => {
        s.classList.toggle('filled', Number(s.dataset.val) <= val);
    });
    if (typeof playSound === 'function') playSound('snd-click');
};

function buildFeedbackText() {
    const text = document.getElementById('feedback-text').value.trim();
    const profile = getUserProfile();
    const lines = [];
    if (feedbackRating) lines.push(`Rating: ${feedbackRating}/5`);
    if (profile && profile.name) lines.push(`From: ${profile.name}${profile.email ? ' <' + profile.email + '>' : ''}`);
    lines.push('');
    lines.push(text || '(no message written)');
    return lines.join('\n');
}

window.sendFeedback = function() {
    const textEl = document.getElementById('feedback-text');
    const text = textEl.value.trim();
    const confirmEl = document.getElementById('feedback-confirm');

    if (!text) {
        textEl.style.borderColor = 'var(--danger)';
        confirmEl.textContent = "Write a message first — the box above is empty.";
        confirmEl.style.color = 'var(--danger)';
        textEl.focus();
        return;
    }
    textEl.style.borderColor = '';

    // Save locally first — this part always succeeds regardless of environment,
    // so feedback is never silently lost even if the email step below can't run
    // (common in embedded WebViews / app previews with no mail client wired up).
    const log = JSON.parse(localStorage.getItem('feedback_log') || '[]');
    log.unshift({ text, rating: feedbackRating, date: new Date().toISOString() });
    localStorage.setItem('feedback_log', JSON.stringify(log.slice(0, 50)));

    confirmEl.textContent = "✔ Feedback saved. Opening your email app to send it too...";
    confirmEl.style.color = 'var(--success)';

    // Use a real, visible <a href="mailto:"> click rather than location.href —
    // more reliable across mobile browsers and embedded WebViews.
    const subject = encodeURIComponent('AI Quiz Pro — Feedback');
    const body = encodeURIComponent(buildFeedbackText());
    const link = document.getElementById('feedback-mailto-link');
    link.href = `mailto:?subject=${subject}&body=${body}`;
    link.click();

    setTimeout(() => {
        if (confirmEl.textContent.includes('Opening your email app')) {
            confirmEl.textContent = "✔ Feedback saved. If your email app didn't open, tap 'Copy Text Instead' below and paste it into any messaging app.";
            confirmEl.style.color = 'var(--success)';
        }
    }, 2500);
};

// wa.me with no phone number opens WhatsApp's own contact/chat picker rather
// than messaging a fixed number — the right behavior for a generic "share
// feedback" button. Falls back to https://api.whatsapp.com/send if wa.me
// itself is blocked in a given WebView, since some environments allow one
// domain but not the other.
window.sendFeedbackWhatsApp = function() {
    const textEl = document.getElementById('feedback-text');
    const text = textEl.value.trim();
    const confirmEl = document.getElementById('feedback-confirm');

    if (!text) {
        textEl.style.borderColor = 'var(--danger)';
        confirmEl.textContent = "Write a message first — the box above is empty.";
        confirmEl.style.color = 'var(--danger)';
        textEl.focus();
        return;
    }
    textEl.style.borderColor = '';

    const log = JSON.parse(localStorage.getItem('feedback_log') || '[]');
    log.unshift({ text, rating: feedbackRating, date: new Date().toISOString() });
    localStorage.setItem('feedback_log', JSON.stringify(log.slice(0, 50)));

    const message = encodeURIComponent('AI Quiz Pro — Feedback\n\n' + buildFeedbackText());
    const link = document.getElementById('feedback-whatsapp-link');
    link.href = `https://wa.me/?text=${message}`;
    link.click();

    confirmEl.textContent = "✔ Feedback saved. Opening WhatsApp — pick who to send it to.";
    confirmEl.style.color = 'var(--success)';

    setTimeout(() => {
        if (confirmEl.textContent.includes('Opening WhatsApp')) {
            confirmEl.textContent = "✔ Feedback saved. If WhatsApp didn't open, tap 'Copy Text Instead' below.";
            confirmEl.style.color = 'var(--success)';
        }
    }, 2500);
};

window.copyFeedback = function() {
    const textEl = document.getElementById('feedback-text');
    const text = textEl.value.trim();
    const confirmEl = document.getElementById('feedback-confirm');
    if (!text) {
        textEl.style.borderColor = 'var(--danger)';
        confirmEl.textContent = "Write a message first — the box above is empty.";
        confirmEl.style.color = 'var(--danger)';
        textEl.focus();
        return;
    }
    textEl.style.borderColor = '';
    copyToClipboardRobust(buildFeedbackText(), confirmEl);
};

// Three-tier fallback: modern clipboard API -> legacy execCommand -> manual prompt.
// Some embedded WebViews block the Clipboard API entirely, so this always leaves
// the user with a way to actually get the text, rather than a silent failure.
function copyToClipboardRobust(text, confirmEl) {
    const succeed = () => {
        confirmEl.textContent = "✔ Copied — paste it anywhere you'd like to send it.";
        confirmEl.style.color = 'var(--success)';
    };
    const legacyFallback = () => {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed'; ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            if (ok) { succeed(); return; }
        } catch (e) {}
        // last resort — a native prompt() can be copied manually almost anywhere
        window.prompt('Copy this text (Ctrl+C / long-press → Copy):', text);
        confirmEl.textContent = "Couldn't auto-copy in this browser — use the box that just popped up to copy manually.";
        confirmEl.style.color = 'var(--warning)';
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(succeed).catch(legacyFallback);
    } else {
        legacyFallback();
    }
}

window.openFeedback = function() {
    if (typeof playSound === 'function') playSound('snd-click');
    navigateTo('feedback');
};

/* ============================================================================
   AI SUPPORT — Gemini-powered help chat (reuses the shared geminiChatCall
   helper defined in features.js, same one Senpai uses)
   ============================================================================ */
const SUPPORT_SYSTEM_PROMPT = `You are the support assistant for "AI Quiz Pro — Hybrid", a browser-based app. Answer the user's question about the app clearly and concisely (under ~120 words unless they ask for more). Be friendly and to the point, like good technical support — not overly casual.

Facts about the app you should know:
- It generates quizzes from: a typed topic, a custom topic, a PDF, an image, an audio recording, or a YouTube video.
- It needs the user's OWN free Gemini API key (from aistudio.google.com/apikey) entered in ⚙️ Settings (profile icon, top-left → SET tab) to generate anything or to use the Senpai/Support chat. A Groq key there is optional and just makes plain-text quizzes faster. A RapidAPI key there is optional and used only for YouTube transcript fetching.
- YouTube import can fail because YouTube blocks direct browser access to transcripts — if that happens (or no RapidAPI key is set), the app shows a manual box where the user pastes the transcript themselves (copied from YouTube's "⋯ → Show transcript" menu).
- Login (Google/Facebook/Email/Guest) is a LOCAL profile only — there is no backend server, nothing is verified or synced across devices, it just personalizes the local experience. Google/Facebook need the site owner to configure their own OAuth IDs (see AUTH_SETUP.md) before those buttons work.
- Features: 📈 Report (accuracy by topic + trend), 🏆 Awards (achievements, some hidden), 📜 Neural Logs (quiz history), 📚 Study Hub (Notes, a local PDF library with an in-app reader, and a local-folder music player for studying), 🧑‍🏫 Senpai (a friendly AI tutor chat, bottom-right floating button), 💬 Feedback (sends a note via email or clipboard).
- Everything (notes, PDFs, quiz history, API keys, login profile) is stored only in the user's own browser — nothing is uploaded to a server the developer controls.
- It can be installed as an app (PWA) via the browser's install option, or built into a real .apk/.exe — see BUILD_INSTRUCTIONS.md.

If asked something you can't answer from this, say so honestly and suggest they use the 💬 Feedback button to reach the developer directly. Never claim to be human.`;

let supportChatHistory = [];

function addSupportMessage(role, text) {
    const box = document.getElementById('support-chat-messages');
    const div = document.createElement('div');
    div.className = `senpai-msg support-msg ${role}`;
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}
function addSupportTyping() {
    const box = document.getElementById('support-chat-messages');
    const div = document.createElement('div');
    div.className = 'senpai-msg support-msg bot typing';
    div.id = 'support-typing';
    div.innerHTML = '<span></span><span></span><span></span>';
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}
function removeSupportTyping() { document.getElementById('support-typing')?.remove(); }

window.sendSupportMessage = async function() {
    const input = document.getElementById('support-chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    addSupportMessage('user', text);
    supportChatHistory.push({ role: 'user', text });

    const sendBtn = document.getElementById('support-chat-send');
    sendBtn.disabled = true;
    addSupportTyping();

    try {
        const contents = supportChatHistory.slice(-10).map(m => ({
            role: m.role === 'user' ? 'user' : 'model',
            parts: [{ text: m.text }]
        }));
        const reply = await geminiChatCall(SUPPORT_SYSTEM_PROMPT, contents);
        removeSupportTyping();
        addSupportMessage('bot', reply);
        supportChatHistory.push({ role: 'model', text: reply });
    } catch (e) {
        removeSupportTyping();
        if (e.isNoKey) {
            addSupportMessage('bot', "I need a Gemini API key to answer live — add a free one in ⚙️ Settings (aistudio.google.com/apikey). In the meantime, check the FAQ above or use 💬 Feedback to reach us directly.");
        } else {
            addSupportMessage('bot', `Couldn't connect (${e.message}). Check your Gemini key in Settings, or use 💬 Feedback to reach us directly.`);
        }
        console.error('Support chat error:', e);
    } finally {
        sendBtn.disabled = false;
    }
};

/* ============================================================================
   HELP
   ============================================================================ */
window.openHelp = function() {
    if (typeof playSound === 'function') playSound('snd-click');
    navigateTo('help');
    if (supportChatHistory.length === 0) {
        document.getElementById('support-chat-messages').innerHTML = '';
        addSupportMessage('bot', "Hi! I'm AI Support — ask me anything about how the app works.");
    }
};
