/**
 * ============================================================================
 * DB — tiny IndexedDB helper with a graceful localStorage fallback
 * ============================================================================
 * Why: localStorage is capped at ~5 MB for the whole site and throws
 * QuotaExceededError when it fills up. Documents (PDF bytes + extracted text) and the
 * full quiz history live in IndexedDB instead, which holds hundreds of MB.
 *
 *   dbStore(store, key, value)  -> Promise<void>     create / replace one record
 *   dbGet(store, key)           -> Promise<any|null>
 *   dbGetAll(store)             -> Promise<any[]>
 *   dbDelete(store, key)        -> Promise<void>
 *   dbClear(store)              -> Promise<void>
 *   dbMode()                    -> 'indexeddb' | 'localstorage'
 *
 * Stores (all in one database, "ai_quiz_pro_study", v2):
 *   pdfs             Study Hub PDF reader        (inline key: record.id)
 *   neural_library   documents for quizzes       (out-of-line key)
 *   quiz_history     full, unbounded history     (out-of-line key)
 *
 * If IndexedDB is missing or blocked (some private modes, locked-down WebViews) every
 * call transparently reads/writes localStorage under "idbfb:<store>:<key>" instead, and
 * dbMode() reports 'localstorage'. A full localStorage surfaces as an Error whose
 * .code === 'quota' and whose message is safe to show to the player.
 *
 * This file must load BEFORE app.js / study.js.
 */
(function () {
    'use strict';

    const DB_NAME = 'ai_quiz_pro_study';
    const DB_VERSION = 2;
    const STORES = {
        pdfs: { keyPath: 'id' },
        neural_library: {},
        quiz_history: {}
    };
    const FB_PREFIX = 'idbfb:';

    let dbPromise = null;
    let mode = 'indexeddb';

    /* ------------------------------------------------------------------ */
    /* Opening                                                            */
    /* ------------------------------------------------------------------ */
    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            let req;
            try {
                if (!window.indexedDB) throw new Error('IndexedDB is not supported here');
                req = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (e) { reject(e); return; }

            req.onupgradeneeded = () => {
                const db = req.result;
                Object.keys(STORES).forEach(name => {
                    if (!db.objectStoreNames.contains(name)) {
                        const opts = STORES[name];
                        db.createObjectStore(name, opts.keyPath ? { keyPath: opts.keyPath } : undefined);
                    }
                });
            };
            req.onsuccess = () => {
                const db = req.result;
                // another tab wants to upgrade: let go so it isn't blocked forever
                db.onversionchange = () => { try { db.close(); } catch (e) {} dbPromise = null; };
                resolve(db);
            };
            req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
            req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
        }).catch(err => {
            mode = 'localstorage';
            console.warn('IndexedDB unavailable, falling back to localStorage:', err && err.message);
            throw err;
        });
        return dbPromise;
    }
    window.dbOpen = open;

    // Runs `fn(db)` with IndexedDB; on any open failure use `fallback()` (localStorage) instead.
    async function withDb(fn, fallback) {
        if (mode === 'localstorage') return fallback();
        let db;
        try { db = await open(); }
        catch (e) { return fallback(); }
        return fn(db);
    }

    function idbRequest(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    function txDone(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
    }
    function friendly(err) {
        const name = err && err.name;
        if (name === 'QuotaExceededError' || (err && /quota/i.test(err.message || ''))) {
            const e = new Error('Device storage is full — delete some documents and try again.');
            e.code = 'quota'; return e;
        }
        return err instanceof Error ? err : new Error(String(err));
    }

    /* ------------------------------------------------------------------ */
    /* localStorage fallback (JSON; ArrayBuffers are base64'd)            */
    /* ------------------------------------------------------------------ */
    function b64FromBuf(buf) {
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        return btoa(bin);
    }
    function bufFromB64(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out.buffer;
    }
    function fbEncode(value) {
        return JSON.stringify(value, (k, v) => {
            if (v instanceof ArrayBuffer) return { __ab: b64FromBuf(v) };
            if (ArrayBuffer.isView(v)) return { __ab: b64FromBuf(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
            return v;
        });
    }
    function fbDecode(str) {
        return JSON.parse(str, (k, v) => (v && typeof v === 'object' && typeof v.__ab === 'string') ? bufFromB64(v.__ab) : v);
    }
    const fbKey = (store, key) => FB_PREFIX + store + ':' + key;

    const fb = {
        store(store, key, value) {
            try { localStorage.setItem(fbKey(store, key), fbEncode(value)); }
            catch (e) { throw friendly(e); }
        },
        get(store, key) {
            const raw = localStorage.getItem(fbKey(store, key));
            if (raw == null) return null;
            try { return fbDecode(raw); } catch (e) { return null; }
        },
        getAll(store) {
            const prefix = FB_PREFIX + store + ':';
            const out = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf(prefix) === 0) { try { out.push(fbDecode(localStorage.getItem(k))); } catch (e) {} }
            }
            return out;
        },
        del(store, key) { localStorage.removeItem(fbKey(store, key)); },
        clear(store) {
            const prefix = FB_PREFIX + store + ':';
            const kill = [];
            for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf(prefix) === 0) kill.push(k); }
            kill.forEach(k => localStorage.removeItem(k));
        }
    };

    function assertStore(store) {
        if (!STORES[store]) throw new Error('Unknown store: ' + store);
    }

    /* ------------------------------------------------------------------ */
    /* Public API                                                         */
    /* ------------------------------------------------------------------ */
    window.dbStore = async function (store, key, value) {
        assertStore(store);
        return withDb(async (db) => {
            try {
                const tx = db.transaction(store, 'readwrite');
                const os = tx.objectStore(store);
                if (os.keyPath) os.put(value); else os.put(value, key);
                await txDone(tx);
            } catch (e) { throw friendly(e); }
        }, () => fb.store(store, key, value));
    };

    window.dbGet = async function (store, key) {
        assertStore(store);
        return withDb(async (db) => {
            const v = await idbRequest(db.transaction(store, 'readonly').objectStore(store).get(key));
            return v === undefined ? null : v;
        }, () => fb.get(store, key));
    };

    window.dbGetAll = async function (store) {
        assertStore(store);
        return withDb(async (db) => (await idbRequest(db.transaction(store, 'readonly').objectStore(store).getAll())) || [],
            () => fb.getAll(store));
    };

    window.dbDelete = async function (store, key) {
        assertStore(store);
        return withDb(async (db) => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).delete(key);
            await txDone(tx);
        }, () => fb.del(store, key));
    };

    window.dbClear = async function (store) {
        assertStore(store);
        return withDb(async (db) => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).clear();
            await txDone(tx);
        }, () => fb.clear(store));
    };

    window.dbMode = function () { return mode; };
    // Resolves 'indexeddb' | 'localstorage' once the first open attempt has settled.
    window.dbReady = function () { return open().then(() => mode, () => mode); };

    /* ------------------------------------------------------------------ */
    /* One-time migration of data an older version kept in localStorage   */
    /* ------------------------------------------------------------------ */
    // neural_library (an array of {name, content}) moves into the neural_library store.
    // quiz_history is mirrored: the app still keeps its newest 200 entries in localStorage as a
    // fast synchronous cache (13 screens read it synchronously), while the complete history
    // lives in IndexedDB.
    window.dbMigrateLegacy = async function () {
        try {
            if (localStorage.getItem('idb_migrated_v1') === '1') return;
            await window.dbReady();

            const lib = JSON.parse(localStorage.getItem('neural_library') || '[]');
            if (Array.isArray(lib) && lib.length) {
                for (let i = 0; i < lib.length; i++) {
                    const it = lib[i]; if (!it || !it.name) continue;
                    const id = 'lib_legacy_' + i;
                    await window.dbStore('neural_library', id, {
                        id, name: it.name, text: String(it.content || ''), type: 'text',
                        size: String(it.content || '').length, addedAt: new Date(Date.now() - (lib.length - i) * 1000).toISOString(), legacy: true
                    });
                }
            }
            const hist = JSON.parse(localStorage.getItem('quiz_history') || '[]');
            // (in the localStorage fallback a mirror would only double the space used — skip it)
            if (Array.isArray(hist) && mode === 'indexeddb') {
                for (const rec of hist) { if (rec && rec.isoDate) await window.dbStore('quiz_history', rec.isoDate, rec); }
            }
            // only drop the old array once everything above was written without throwing
            localStorage.removeItem('neural_library');
            localStorage.setItem('idb_migrated_v1', '1');
        } catch (e) {
            console.warn('Legacy data migration skipped (will retry next launch):', e && e.message);
        }
    };

    // Kick off at load: opens the DB (creating v2 stores) and migrates once.
    window.dbMigrateLegacy();
})();
