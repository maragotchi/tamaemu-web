/* Each slot has metadata plus separate flash, A0RAM, and private session
   records under one ID. Autosave can update RAM without replacing flash. */

const DB_NAME = 'tamaemu';
const DB_VERSION = 3;

function newLineage() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return bytes;
}

let dbp = null;

function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
        /* Opening IndexedDB can throw in blocked or private contexts. */
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = ev => {
            const db = req.result;
            if (!db.objectStoreNames.contains('slots'))
                db.createObjectStore('slots', { keyPath: 'id', autoIncrement: true });
            /* Flash and RAM are bare Uint8Arrays keyed by slot ID. */
            if (!db.objectStoreNames.contains('flash')) db.createObjectStore('flash');
            if (!db.objectStoreNames.contains('ram'))   db.createObjectStore('ram');
            if (!db.objectStoreNames.contains('session')) db.createObjectStore('session');
            if (ev.oldVersion < 3) {
                const slots = req.transaction.objectStore('slots');
                if (!slots.indexNames.contains('lineage')) slots.createIndex('lineage', 'lineage');
                slots.openCursor().onsuccess = ev => {
                    const cursor = ev.target.result;
                    if (!cursor) return;
                    const meta = cursor.value;
                    if (!meta.lineage) meta.lineage = newLineage();
                    if (meta.revision == null) meta.revision = 0;
                    if (meta.lastExportedRevision == null) meta.lastExportedRevision = 0;
                    if (meta.savedUtcMs == null) meta.savedUtcMs = meta.updated ?? 0;
                    cursor.update(meta); cursor.continue();
                };
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbp;
}

function tx(db, stores, mode) {
    const t = db.transaction(stores, mode);
    return [t, ...stores.map(s => t.objectStore(s))];
}

const done = t => new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = t.onabort = () => rej(t.error ?? new Error('transaction aborted'));
});

const get = req => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
});

let availability = null;
let unavailableWhy = '';

export async function probe() {
    if (availability !== null) return availability;
    try {
        await open();
        availability = true;
    } catch (err) {
        availability = false;
        unavailableWhy = err?.message || err?.name || String(err);
        dbp = null;
    }
    return availability;
}

/* Keep storage enabled while the first probe is pending. */
export function available() { return availability !== false; }
export function unavailableReason() { return unavailableWhy; }

/* Quota failures stop automatic retries; manual saves can retry after cleanup. */
export function isQuotaError(err) {
    return err?.name === 'QuotaExceededError'
        || /quota/i.test(err?.message ?? '');
}

/* Ask the browser to protect saves from eviction; callers report refusal. */
export async function requestPersistence() {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    try { return await navigator.storage.persist(); } catch { return false; }
}

export async function estimate() {
    if (!navigator.storage?.estimate) return null;
    try { return await navigator.storage.estimate(); } catch { return null; }
}

export async function list() {
    const db = await open();
    const [t, slots] = tx(db, ['slots'], 'readonly');
    const all = await get(slots.getAll());
    await done(t);
    return all.sort((a, b) => b.updated - a.updated);
}

export async function findByLineage(lineage) {
    const db = await open();
    const [t, slots] = tx(db, ['slots'], 'readonly');
    const meta = await get(slots.index('lineage').get(lineage));
    await done(t);
    return meta ? load(meta.id) : null;
}

/* Require copied buffers: cloning a wasm-heap view serializes the whole heap. */
function assertCopy(name, arr, cap = 16 * 1024 * 1024) {
    if (!(arr instanceof Uint8Array)) throw new Error(`${name}: not a Uint8Array`);
    if (arr.buffer.byteLength > cap)
        throw new Error(`${name}: looks like a view into the wasm heap `
                      + `(${arr.buffer.byteLength} bytes behind a ${arr.length}-byte view) `
                      + `- slice() it first`);
    return arr;
}

export async function create({ name, device, flash, ram, session, emuSecs = 0,
                              lineage = newLineage(), revision = 0,
                              savedUtcMs = Date.now(), lastExportedRevision = 0, handoffHandle = null }) {
    assertCopy('flash', flash);
    assertCopy('ram', ram);
    if (session != null) assertCopy('session', session);
    const db = await open();
    const now = Date.now();
    const [t, slots, fs, rs, ss] = tx(db, ['slots', 'flash', 'ram', 'session'], 'readwrite');
    const id = await get(slots.add({
        name, device, created: now, updated: now,
        flashSize: flash.length, ramSize: ram.length,
        sessionSize: session?.length ?? 0, emuSecs,
        lineage, revision, savedUtcMs, lastExportedRevision, handoffHandle,
    }));
    fs.put(flash, id);
    rs.put(ram, id);
    if (session != null) ss.put(session, id);
    await done(t);
    return id;
}

/* Omitting flash preserves it during A0RAM-only autosaves. */
export async function update(id, changes) {
    const { flash, ram, emuSecs, session, revision, savedUtcMs, lastExportedRevision, handoffHandle } = changes;
    const hasSession = Object.prototype.hasOwnProperty.call(changes, 'session');
    if (flash) assertCopy('flash', flash);
    if (ram) assertCopy('ram', ram);
    if (hasSession && session != null) assertCopy('session', session);
    const db = await open();
    const stores = ['slots', 'ram'];
    if (flash) stores.push('flash');
    if (hasSession) stores.push('session');
    const t = db.transaction(stores, 'readwrite');
    const slots = t.objectStore('slots');
    const meta = await get(slots.get(id));
    if (!meta) { t.abort(); throw new Error(`no slot ${id}`); }
    meta.updated = Date.now();
    if (emuSecs != null) meta.emuSecs = emuSecs;
    if (revision != null) meta.revision = revision;
    if (savedUtcMs != null) meta.savedUtcMs = savedUtcMs;
    if (lastExportedRevision != null) meta.lastExportedRevision = lastExportedRevision;
    if (handoffHandle !== undefined) meta.handoffHandle = handoffHandle;
    if (ram) { meta.ramSize = ram.length; t.objectStore('ram').put(ram, id); }
    if (flash) { meta.flashSize = flash.length; t.objectStore('flash').put(flash, id); }
    if (hasSession) {
        meta.sessionSize = session?.length ?? 0;
        if (session == null) t.objectStore('session').delete(id);
        else t.objectStore('session').put(session, id);
    }
    slots.put(meta);
    await done(t);
    return meta;
}

export async function load(id) {
    const db = await open();
    const [t, slots, fs, rs, ss] = tx(db, ['slots', 'flash', 'ram', 'session'], 'readonly');
    const [meta, flash, ram, session] = await Promise.all([
        get(slots.get(id)), get(fs.get(id)), get(rs.get(id)), get(ss.get(id)),
    ]);
    await done(t);
    if (!meta) throw new Error(`no slot ${id}`);
    return { meta, flash, ram, session: session == null ? undefined : new Uint8Array(session) };
}

/* Change the device label without modifying the flash image. */
export async function setDevice(id, device) {
    const db = await open();
    const [t, slots] = tx(db, ['slots'], 'readwrite');
    const meta = await get(slots.get(id));
    if (!meta) { t.abort(); throw new Error(`no slot ${id}`); }
    meta.device = device;
    slots.put(meta);
    await done(t);
}

export async function rename(id, name) {
    const db = await open();
    const [t, slots] = tx(db, ['slots'], 'readwrite');
    const meta = await get(slots.get(id));
    if (!meta) { t.abort(); throw new Error(`no slot ${id}`); }
    meta.name = name;
    slots.put(meta);
    await done(t);
}

export async function remove(id) {
    const db = await open();
    const [t, slots, fs, rs, ss] = tx(db, ['slots', 'flash', 'ram', 'session'], 'readwrite');
    slots.delete(id); fs.delete(id); rs.delete(id); ss.delete(id);
    await done(t);
}
