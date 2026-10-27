/**
 * ============================================================================
 * NAV — History-aware router (pages + quiz overlay + drawers), transitions, drafts
 * ============================================================================
 * Single source of truth for "which screen is showing."
 *
 * ROUTES (hash based, so it works from file://, Electron and Capacitor too):
 *     #/home  #/study  #/riddles  ...   every dashboard page
 *     #/quiz                            the full-screen quiz overlay
 * Overlays (the profile drawer) are extra history entries on top of a route, so the
 * browser/Android Back button closes them instead of leaving the page.
 *
 * Every history entry carries   { app:1, route, idx, ov }   where idx is a running
 * counter. Comparing idx on `popstate` tells us whether the user went Back or
 * Forward, which drives the slide direction of the page transition.
 *
 * STATE PRESERVATION: pages are never destroyed, only hidden, so typed text, chat
 * history and scroll-independent UI survive Back/Forward. The quiz is the one thing
 * with a live timer, so leaving #/quiz PAUSES it (QuizSession in app.js) and
 * returning (Forward, or the "Resume" banner) picks up where it stopped. Only an
 * explicit action (Terminate / Home / Discard) resets it.
 */

const DASHBOARD_PAGES = ['home', 'custom', 'study', 'report', 'achievements', 'history', 'feedback', 'help', 'daily', 'flashcards', 'arcade', 'riddles', 'duel'];
const PAGE_TITLES = {
    home: 'Home', custom: 'Custom Quiz', study: 'Study Hub', report: 'Report & Analytics',
    achievements: 'Awards', history: 'History', feedback: 'Feedback', help: 'Help & Support',
    daily: 'Daily', flashcards: 'Flashcards', arcade: 'Arcade', riddles: 'Riddle Rush', duel: 'Quiz Duel'
};

// Game windows live "inside" the Arcade — keep the Arcade nav item lit while one is open.
// Report and Analytics used to be two pages. Old links, bookmarks and history entries still land on the merged one.
const ROUTE_ALIASES = { analytics: 'report' };

const NAV_PARENT = { riddles: 'arcade', duel: 'arcade' };

// Leaving a game window tears the game down. The guard lets a live PvP match ask for
// confirmation first; it is honoured for sidebar clicks AND the browser Back button.
const PAGE_LEAVE_GUARDS = {
    riddles: () => (window.riddlesCanLeave ? riddlesCanLeave() : true),
    duel: () => (window.duelCanLeave ? duelCanLeave() : true),
};
const PAGE_LEAVE_HOOKS = {
    riddles: () => { if (window.riddlesLeave) riddlesLeave(); },
    duel: () => { if (window.duelLeave) duelLeave(); },
};

// Pages with live-computed widgets that can go stale — refresh them on every visit.
const PAGE_REFRESH_HOOKS = {
    home: () => {
        if (window.renderExpChips) renderExpChips();
        if (window.renderDueReviewBadge) renderDueReviewBadge();
    },
    daily: () => {
        if (window.renderDailyPage) renderDailyPage();
        if (window.renderPowerupShop) renderPowerupShop();
        if (window.renderDueReviewBadge) renderDueReviewBadge();
    },
    report: () => { if (window.renderReportPage) renderReportPage(); },
    flashcards: () => { if (window.renderFlashcardStats) renderFlashcardStats(); if (window.renderFlashcardLibrary) renderFlashcardLibrary(); },
    // The hub only REFRESHES its stats — it never touches a running game.
    arcade: () => { if (window.renderArcadeHub) renderArcadeHub(); },
    riddles: () => { if (window.riddlesEnter) riddlesEnter(); },
    duel: () => { if (window.duelEnter) duelEnter(); },
};

let _musicWasPlayingBeforeStudy = false;
const PAGE_LEAVE_MS = 140;     // outgoing page fade (keep in sync with .page-leaving in style.css)
const OVERLAY_LEAVE_MS = 190;  // quiz overlay fade-out (keep in sync with #quiz-focus-overlay.closing)

function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
}

/* ============================================================================
   PAGE SWITCHING (visual only — history is handled by Router below)
   Returns false when a leave-guard vetoed the switch.
   ============================================================================ */
function showPage(pageId, o) {
    o = o || {};
    const activeEl = document.querySelector('.app-page.active');
    const previousPageId = activeEl ? activeEl.id.replace('page-', '') : null;

    if (previousPageId && previousPageId !== pageId) {
        const guard = PAGE_LEAVE_GUARDS[previousPageId];
        if (guard && !guard()) return false;
        if (PAGE_LEAVE_HOOKS[previousPageId]) PAGE_LEAVE_HOOKS[previousPageId]();
    }

    // Study Hub has its own music player — pause the ambient loop while it's open,
    // resume on exit, but only if it was actually playing (a manual mute stays respected).
    if (window.isAmbientMusicOn) {
        if (pageId === 'study' && previousPageId !== 'study') {
            _musicWasPlayingBeforeStudy = isAmbientMusicOn();
            if (_musicWasPlayingBeforeStudy) stopAmbientMusic();
        } else if (previousPageId === 'study' && pageId !== 'study' && _musicWasPlayingBeforeStudy) {
            startAmbientMusic();
        }
    }

    // Coming back from the quiz overlay: freeze the quiz first (timer, speech), THEN hide it.
    if (overlayIsVisible()) {
        if (window.QuizSession) QuizSession.pause();
        hideQuizOverlay();
    }

    const contentEl = document.getElementById('page-content');
    const nextEl = document.getElementById('page-' + pageId);
    const dir = o.dir === 'back' ? 'back' : 'forward';
    if (contentEl) contentEl.dataset.navDir = dir;

    // Cross-fade: the page being left is lifted out of the flow at its current on-screen
    // position and fades/slides away while the new page animates in (CSS does the motion).
    const willAnimate = !o.initial && !prefersReducedMotion() && activeEl && nextEl && activeEl !== nextEl && contentEl;
    if (willAnimate) {
        const cr = contentEl.getBoundingClientRect(), ar = activeEl.getBoundingClientRect();
        activeEl.style.top = (ar.top - cr.top) + 'px';
        activeEl.style.left = (ar.left - cr.left) + 'px';
        activeEl.style.width = ar.width + 'px';
        activeEl.style.maxHeight = contentEl.clientHeight + 'px';
        activeEl.classList.add('page-leaving');
        setTimeout(() => {
            if (!activeEl.classList.contains('active')) activeEl.classList.remove('page-leaving');
            ['top', 'left', 'width', 'maxHeight'].forEach(p => { activeEl.style[p] = ''; });
        }, PAGE_LEAVE_MS + 30);
    }

    DASHBOARD_PAGES.forEach(p => {
        const el = document.getElementById('page-' + p);
        if (!el) return;
        const on = p === pageId;
        el.classList.toggle('active', on);
        if (on) { el.classList.remove('page-leaving'); ['top', 'left', 'width', 'maxHeight'].forEach(k => { el.style[k] = ''; }); }
    });
    document.querySelectorAll('.nav-item[data-page]').forEach(b => {
        b.classList.toggle('active', b.dataset.page === (NAV_PARENT[pageId] || pageId));
    });
    const titleEl = document.getElementById('topbar-title');
    if (titleEl) titleEl.textContent = PAGE_TITLES[pageId] || '';
    try { document.title = 'AI Quiz Pro — ' + (PAGE_TITLES[pageId] || ''); } catch (e) {}
    if (contentEl) { contentEl.scrollTop = 0; contentEl.dataset.activePage = pageId; }

    closeMobileSidebar();
    if (!o.silent && typeof playSound === 'function') playSound('snd-click');
    if (PAGE_REFRESH_HOOKS[pageId]) PAGE_REFRESH_HOOKS[pageId]();
    return true;
}

/* ============================================================================
   QUIZ OVERLAY — distraction-free full-screen quiz (fades in/out)
   ============================================================================ */
let _overlayHideTimer = null;
function overlayIsVisible() {
    const o = document.getElementById('quiz-focus-overlay');
    return !!o && o.style.display !== 'none' && o.style.display !== '' && !o.classList.contains('closing');
}
function showQuizOverlay() {
    const overlay = document.getElementById('quiz-focus-overlay');
    if (!overlay) return;
    clearTimeout(_overlayHideTimer);
    overlay.classList.remove('closing');
    overlay.style.display = 'flex';
    // Zen Mode is a standing preference, but its effects only apply while a quiz is
    // actually on screen — it shouldn't hide Senpai/power-ups everywhere else.
    if (localStorage.getItem('zen_mode') === '1') document.body.classList.add('zen-active');
}
function hideQuizOverlay() {
    const overlay = document.getElementById('quiz-focus-overlay');
    document.body.classList.remove('zen-active');
    if (!overlay || overlay.style.display === 'none') return;
    if (prefersReducedMotion()) { overlay.style.display = 'none'; return; }
    overlay.classList.add('closing');
    clearTimeout(_overlayHideTimer);
    _overlayHideTimer = setTimeout(() => {
        overlay.style.display = 'none';
        overlay.classList.remove('closing');
    }, OVERLAY_LEAVE_MS);
}

/* ============================================================================
   ROUTER
   ============================================================================ */
const Router = (function () {
    const R = { enabled: false, current: null, idx: 0, trail: [], ov: null };
    const OVERLAYS = {};          // name -> { open(), close() }  (UI only, no history side effects)
    let pendingBack = false, pendingTimer = null, queue = [], ignorePop = 0;

    const hashFor = route => '#/' + route;
    function parseHash() {
        const m = /^#\/?([a-z0-9-]+)/i.exec(location.hash || '');
        const r = m ? m[1].toLowerCase() : null;
        return (r && ROUTE_ALIASES[r]) || r;
    }
    function mkState(route, idx, ov) { return { app: 1, route: route, idx: idx, ov: ov || null }; }
    function push(st, route) { try { history.pushState(st, '', hashFor(route)); } catch (e) { /* sandboxed: history just won't track */ } }
    function replace(st, route) { try { history.replaceState(st, '', hashFor(route)); } catch (e) {} }
    function quizAvailable() { return !!(window.QuizSession && QuizSession.canEnter()); }

    // Applies a route to the UI. Returns false if vetoed.
    // R.current is updated HERE (before the banner refresh) so everything that asks
    // "are we in the quiz right now?" sees the new route.
    function apply(route, o) {
        if (route === 'quiz') {
            showQuizOverlay();
            R.current = 'quiz';
            if (window.QuizSession) { QuizSession.resume(); QuizSession.refreshBanner(); }
            return true;
        }
        if (!showPage(route, o)) return false;
        R.current = route;
        if (window.QuizSession) QuizSession.refreshBanner();
        return true;
    }

    // history.back() is asynchronous; anything that wants to push/replace afterwards has
    // to wait for the matching popstate or it would pop the wrong entry. Queue it.
    function popOne() {
        pendingBack = true;
        clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => { adopt(history.state); settle(); }, 450);
        try { history.back(); } catch (e) { settle(); }
    }
    function settle() {
        pendingBack = false;
        clearTimeout(pendingTimer);
        const q = queue.splice(0);
        q.forEach(fn => fn());
    }
    function adopt(st) {
        if (st && st.app) { R.idx = st.idx; R.ov = st.ov || null; R.trail[R.idx] = st.route; }
    }

    function go(route, opts) {
        opts = opts || {};
        if (!R.enabled) { return apply(route, opts); }
        if (pendingBack) { queue.push(() => go(route, opts)); return true; }

        const fromRoute = R.current;
        const same = route === fromRoute;
        const st = history.state;
        const hadOverlay = !!(st && st.ov);
        if (!apply(route, { dir: opts.dir || 'forward', silent: opts.silent })) return false;

        if (hadOverlay && R.ov && OVERLAYS[R.ov]) { OVERLAYS[R.ov].close(); }
        R.current = route;
        if (same && !hadOverlay) return true;

        // A dead quiz entry (the session was explicitly ended) is collapsed instead of
        // stacking "home, quiz, home" in the history.
        const collapseQuiz = fromRoute === 'quiz' && route !== 'quiz' && !quizAvailable() && !opts.push;
        if (collapseQuiz && R.idx > 0 && R.trail[R.idx - 1] === route && !hadOverlay) {
            popOne();
            return true;
        }
        if (opts.replace || hadOverlay || collapseQuiz) {
            R.ov = null;
            R.trail[R.idx] = route;
            replace(mkState(route, R.idx), route);
        } else {
            R.idx++; R.trail.length = R.idx; R.trail[R.idx] = route; R.ov = null;
            push(mkState(route, R.idx), route);
        }
        return true;
    }

    function openOverlay(name) {
        if (!R.enabled) return;
        if (pendingBack) { queue.push(() => openOverlay(name)); return; }
        if (R.ov === name) return;
        R.idx++; R.trail.length = R.idx; R.trail[R.idx] = R.current; R.ov = name;
        push(mkState(R.current, R.idx, name), R.current);
    }
    function closeOverlay(name) {
        if (!R.enabled || R.ov !== name) return;
        const st = history.state;
        if (st && st.ov === name) popOne(); else R.ov = null;
    }

    window.addEventListener('popstate', function (e) {
        if (!R.enabled) return;
        let st = e.state;
        if (pendingBack) { adopt(st); settle(); return; }
        if (ignorePop > 0) { ignorePop--; adopt(st); return; }

        // A fragment navigation (typed hash, <a href="#/study">) arrives with no state:
        // adopt it as a forward step.
        if (!st || !st.app) {
            const route = parseHash();
            if (!route || DASHBOARD_PAGES.indexOf(route) === -1) { replace(mkState(R.current, R.idx), R.current); return; }
            if (R.ov && OVERLAYS[R.ov]) OVERLAYS[R.ov].close();
            R.idx++; R.trail.length = R.idx; R.trail[R.idx] = route; R.ov = null;
            st = mkState(route, R.idx);
            replace(st, route);
            if (route !== R.current) {
                if (!apply(route, { dir: 'forward' })) { ignorePop++; history.back(); return; }
                R.current = route;
            }
            return;
        }

        const dir = st.idx < R.idx ? 'back' : 'forward';
        let route = st.route;

        // Landing on a quiz entry whose session no longer exists: swap in the page before it.
        if (route === 'quiz' && !quizAvailable()) {
            route = (R.trail[st.idx - 1] && R.trail[st.idx - 1] !== 'quiz') ? R.trail[st.idx - 1] : 'home';
            replace(mkState(route, st.idx, st.ov), route);
            st = history.state;
        }

        if (R.ov && R.ov !== st.ov && OVERLAYS[R.ov]) OVERLAYS[R.ov].close();

        if (route !== R.current) {
            if (!apply(route, { dir: dir })) {
                // Vetoed (e.g. "leave the duel?" -> No): undo the browser's move.
                ignorePop++;
                try { history.go(R.idx - st.idx); } catch (err) { ignorePop = 0; }
                return;
            }
            R.current = route;
        }
        R.idx = st.idx; R.trail[R.idx] = route;
        if (st.ov && R.ov !== st.ov && OVERLAYS[st.ov]) OVERLAYS[st.ov].open();
        R.ov = st.ov || null;
    });

    // Called once the user is inside the app (after splash/login).
    function start() {
        if (R.enabled) return;
        let route = parseHash();
        if (!route || (DASHBOARD_PAGES.indexOf(route) === -1 && route !== 'quiz')) route = 'home';
        const st = history.state;
        // Reload: keep the running idx so Back/Forward direction stays right.
        R.idx = (st && st.app && typeof st.idx === 'number') ? st.idx : 0;
        R.trail = [];
        R.enabled = true;
        if (window.QuizSession) QuizSession.restore();
        if (route === 'quiz' && !quizAvailable()) route = 'home';

        showPage(route === 'quiz' ? 'home' : route, { silent: true, initial: true, dir: 'forward' });
        if (route === 'quiz') { showQuizOverlay(); if (window.QuizSession) QuizSession.resume(); }
        R.current = route;
        R.trail[R.idx] = route;
        R.ov = null;
        replace(mkState(route, R.idx), route);
        if (window.QuizSession) QuizSession.refreshBanner();
        if (window.Drafts) Drafts.restore();
    }
    function stop() { R.enabled = false; }

    return {
        get enabled() { return R.enabled; },
        get current() { return R.current; },
        get overlay() { return R.ov; },
        go: go, start: start, stop: stop,
        openOverlay: openOverlay, closeOverlay: closeOverlay,
        registerOverlay: function (name, api) { OVERLAYS[name] = api; },
        // After the quiz session is explicitly ended: leave #/quiz and show `route`.
        leaveQuiz: function (route) { return go(route || 'home', { silent: true }); }
    };
})();
window.Router = Router;

function navigateTo(pageId, opts) {
    opts = opts || {};
    pageId = ROUTE_ALIASES[pageId] || pageId;
    if (DASHBOARD_PAGES.indexOf(pageId) === -1) return;
    Router.go(pageId, opts);
}
window.navigateTo = navigateTo;

/* ============================================================================
   QUIZ FOCUS — public entry/exit points used by the quiz code
   ============================================================================ */
// Entering the quiz IS a navigation: it gets its own history entry (#/quiz) so Back
// leaves it (pausing, not destroying, the session) and Forward returns to it.
function enterQuizFocus() { Router.go('quiz', { silent: true }); }
window.enterQuizFocus = enterQuizFocus;

// Visual-only hide (does not touch the quiz state or history).
function exitQuizFocus() { hideQuizOverlay(); }
window.exitQuizFocus = exitQuizFocus;

/* ============================================================================
   DRAFTS — typed-but-unsent text survives a page reload (sessionStorage).
   Within a session nothing is lost anyway, because pages are only hidden.
   ============================================================================ */
const Drafts = (function () {
    const KEY = 'drafts_v1';
    const FIELDS = ['custom-topic', 'yt-url', 'manual-transcript', 'feedback-text', 'support-chat-input',
        'flashcard-front-input', 'flashcard-back-input', 'duel-topic-input'];
    function read() { try { return JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
    function write(o) { try { sessionStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }
    let timer = null;
    function save(id) {
        const el = document.getElementById(id);
        if (!el) return;
        const d = read();
        if (el.value && el.value.length < 20000) d[id] = el.value; else delete d[id];
        write(d);
    }
    function restore() {
        const d = read();
        FIELDS.forEach(id => {
            const el = document.getElementById(id);
            if (el && !el.value && d[id]) el.value = d[id];
        });
    }
    document.addEventListener('input', function (e) {
        const id = e.target && e.target.id;
        if (FIELDS.indexOf(id) === -1) return;
        clearTimeout(timer);
        timer = setTimeout(() => save(id), 250);
    });
    return { save: save, restore: restore, clearAll: function () { try { sessionStorage.removeItem(KEY); } catch (e) {} } };
})();
window.Drafts = Drafts;

/* ============================================================================
   MOBILE SIDEBAR (off-canvas drawer under ~900px)
   ============================================================================ */
function toggleMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    const willOpen = !sidebar.classList.contains('mobile-open');
    sidebar.classList.toggle('mobile-open', willOpen);
    if (backdrop) backdrop.classList.toggle('show', willOpen);
    if (typeof playSound === 'function') playSound('snd-click');
}
window.toggleMobileSidebar = toggleMobileSidebar;

function closeMobileSidebar() {
    document.getElementById('sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebar-backdrop')?.classList.remove('show');
}
window.closeMobileSidebar = closeMobileSidebar;
