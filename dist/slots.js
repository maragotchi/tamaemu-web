/* Each slot has metadata plus separate flash and A0RAM records under one ID.
   Autosave can update RAM without replacing flash; both buffers resume a device. */

const DB_NAME = 'tamaemu';
const DB_VERSION = 1;

let dbp = null;

function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
        /* Opening IndexedDB can throw in blocked or private contexts. */
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('slots'))
                db.createObjectStore('slots', { keyPath: 'id', autoIncrement: true });
            /* Flash and RAM are bare Uint8Arrays keyed by slot ID. */
            if (!db.objectStoreNames.contains('flash')) db.createObjectStore('flash');
            if (!db.objectStoreNames.contains('ram'))   db.createObjectStore('ram');
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

/* Require copied buffers: cloning a wasm-heap view serializes the whole heap. */
function assertCopy(name, arr, cap = 16 * 1024 * 1024) {
    if (!(arr instanceof Uint8Array)) throw new Error(`${name}: not a Uint8Array`);
    if (arr.buffer.byteLength > cap)
        throw new Error(`${name}: looks like a view into the wasm heap `
                      + `(${arr.buffer.byteLength} bytes behind a ${arr.length}-byte view) `
                      + `- slice() it first`);
    return arr;
}

export async function create({ name, device, flash, ram, emuSecs = 0 }) {
    assertCopy('flash', flash);
    assertCopy('ram', ram);
    const db = await open();
    const now = Date.now();
    const [t, slots, fs, rs] = tx(db, ['slots', 'flash', 'ram'], 'readwrite');
    const id = await get(slots.add({
        name, device, created: now, updated: now,
        flashSize: flash.length, ramSize: ram.length, emuSecs,
    }));
    fs.put(flash, id);
    rs.put(ram, id);
    await done(t);
    return id;
}

/* Omitting flash preserves it during A0RAM-only autosaves. */
export async function update(id, { flash, ram, emuSecs }) {
    if (flash) assertCopy('flash', flash);
    if (ram) assertCopy('ram', ram);
    const db = await open();
    const stores = ['slots', 'ram'];
    if (flash) stores.push('flash');
    const t = db.transaction(stores, 'readwrite');
    const slots = t.objectStore('slots');
    const meta = await get(slots.get(id));
    if (!meta) { t.abort(); throw new Error(`no slot ${id}`); }
    meta.updated = Date.now();
    if (emuSecs != null) meta.emuSecs = emuSecs;
    if (ram) { meta.ramSize = ram.length; t.objectStore('ram').put(ram, id); }
    if (flash) { meta.flashSize = flash.length; t.objectStore('flash').put(flash, id); }
    slots.put(meta);
    await done(t);
    return meta;
}

export async function load(id) {
    const db = await open();
    const [t, slots, fs, rs] = tx(db, ['slots', 'flash', 'ram'], 'readonly');
    const [meta, flash, ram] = await Promise.all([
        get(slots.get(id)), get(fs.get(id)), get(rs.get(id)),
    ]);
    await done(t);
    if (!meta) throw new Error(`no slot ${id}`);
    return { meta, flash, ram };
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
    const [t, slots, fs, rs] = tx(db, ['slots', 'flash', 'ram'], 'readwrite');
    slots.delete(id); fs.delete(id); rs.delete(id);
    await done(t);
}
