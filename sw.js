// AI Quiz Pro — Service Worker
// Caches the app shell so the app opens instantly and works offline for the UI
// (quiz generation itself always needs a live network connection to reach the AI).
const CACHE_NAME = 'ai-quiz-pro-v12';
const APP_SHELL = [
    './AI_QUIZ.html',
    './css/style.css',
    './js/nav.js',
    './js/app.js',
    './js/sound.js',
    './js/charts.js',
    './js/features.js',
    './js/gamification.js',
    './js/config.js',
    './js/auth.js',
    './js/study.js',
    './js/p2p.js',
    './js/riddles.js',
    './js/arcade.js',
    './js/quizduel.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/senpai-avatar.svg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // add each file individually so one missing/optional asset doesn't block install
            return Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => {})));
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // ---- Network-First: dynamic external endpoints (AI APIs, RapidAPI) ----
    // These return different data on every call, so a stale cached response
    // would actively mislead the app. Try the network first; only fall back
    // to whatever's cached (if anything) when the network genuinely fails,
    // so a request doesn't just dead-end with no response at all offline.
    const isDynamicEndpoint = url.hostname.includes('googleapis.com') ||
        url.hostname.includes('groq.com') ||
        url.hostname.includes('rapidapi.com') ||
        url.hostname.includes('whatsapp.com') ||
        url.hostname.includes('wa.me');
    if (isDynamicEndpoint) {
        event.respondWith(
            fetch(req).catch(() => caches.match(req))
        );
        return;
    }

    // ---- Cache-First: local static assets (css/js/icons/html/manifest) ----
    // These only change when we ship a new version (which bumps CACHE_NAME
    // and evicts the old cache in 'activate' below), so it's safe and fast
    // to serve straight from cache without waiting on the network at all.
    const isLocalAsset = url.origin === self.location.origin;
    if (isLocalAsset) {
        event.respondWith(
            caches.match(req).then((cached) => {
                if (cached) return cached;
                return fetch(req).then((res) => {
                    if (res && res.status === 200 && res.type === 'basic') {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
                    }
                    return res;
                });
            })
        );
        return;
    }

    // ---- Everything else (third-party CDN libs — pdf.js, jsPDF, Chart.js, fonts) ----
    // Stale-while-revalidate: serve the cached copy instantly if we have one
    // (these rarely change once loaded), but always refresh it in the
    // background so an update eventually lands without the user waiting on it.
    event.respondWith(
        caches.match(req).then((cached) => {
            const network = fetch(req).then((res) => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
                }
                return res;
            }).catch(() => cached);
            return cached || network;
        })
    );
});
