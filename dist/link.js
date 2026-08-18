/* Local two-window transport. One BroadcastChannel carries presence, byte
 * records, and slot claims. init() callbacks provide device and page state.
 * Arm only for one compatible, running peer. Channel order per sender is
 * sufficient because each window accepts records from only one remote peer.
 * Record timestamps use the shared browser clock, not the core clock. */
const IRDA = new Set(['ps', 'idl', 'id', 'id-melody']);

/* Only this cross-device pair may link; other cross pairs report 'mixed'. */
const XDEV = [new Set(['id', 'id-melody'])];
const compatible = (a, b) =>
    a === b ? IRDA.has(a) : XDEV.some(s => s.has(a) && s.has(b));

const GPIO_WIRE = new Set(['plus-color', 'plus-color-hexa']);
const usesWireTime = () => GPIO_WIRE.has(cb.device());

let M = null, cb = null, chan = null;
let hbTimer = 0;
let armed = false;
let warnedDrop = false;       /* Warn once per session when the pending queue fills. */
let lastTs = 0;               /* Outgoing record stamps must strictly increase. */
let pendingAsk = null;        /* Only one canBoot request may wait at a time. */
const peers = new Map();      /* winId -> { last, frame, frameAt, device, running, slot } */
const opts = { hbMs: 2000, deadMs: 5000, claimMs: 250 };

/* Must be unique and nonzero: peers ignore self messages, and canBoot returns
   holder IDs as truthy values. */
const myWin = (crypto.getRandomValues(new Uint32Array(1))[0] | 1) >>> 0;

const nowUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);

export function init(m, callbacks, o = {}) {
    M = m; cb = callbacks;
    Object.assign(opts, o);
    if (typeof BroadcastChannel === 'undefined') return false;
    chan = new BroadcastChannel('tamaemu-link');
    chan.onmessage = ev => onMsg(ev.data);
    post({ t: 'hello' });
    hbTimer = setInterval(beat, opts.hbMs);
    /* pagehide reaches mobile Safari; beforeunload does not reliably. */
    if (typeof addEventListener === 'function')
        addEventListener('pagehide', () => post({ t: 'bye' }));
    return true;
}

export function dispose({ silent = false } = {}) {
    if (!silent) post({ t: 'bye' });
    clearInterval(hbTimer);
    /* A disposed module must not leave its core linked. */
    if (armed) { armed = false; M._tw_link_enable(0); }
    if (chan) { chan.close(); chan = null; }
}

function post(m) { if (chan) chan.postMessage({ ...m, win: myWin }); }

function beat() {
    post({ t: 'hb', frame: cb.frame(), device: cb.device(),
           running: cb.running(), slot: cb.slot() });
    const now = Date.now();
    for (const [w, p] of peers)
        if (now - p.last > opts.deadMs) peers.delete(w);
    sync();
}

/* Choose armed state and the page status; '' means no peer. */
function sync() {
    const live = [...peers.values()];
    const dev = cb.device();
    let state = '', want = false;
    if (live.length > 1) state = 'toomany';
    else if (live.length === 1) {
        const p = live[0];
        if (!dev || !p.device) state = 'idle';
        /* Keep same unsupported devices distinct from incompatible pairs. */
        else if (p.device === dev && !IRDA.has(dev)) state = 'nolink';
        else if (!compatible(dev, p.device)) state = 'mixed';
        else if (!cb.running() || !p.running) state = 'idle';
        else {
            want = true;
            /* Hidden windows stop rAF while heartbeats continue; preserve the
               link but report a peer with a stale frame counter as paused. */
            state = Date.now() - p.frameAt > opts.deadMs ? 'paused' : 'linked';
        }
    }
    if (want !== armed) { armed = want; M._tw_link_enable(armed ? 1 : 0); }
    cb.onState(state, live.length);
}

/* tw_boot detaches the link, so re-arm an active pair after every boot. */
export function bootHappened() {
    if (armed) M._tw_link_enable(1);
    sync();
}

/* Each frame, release due wire records and send drained byte records. */
export function pump() {
    if (!armed) return;
    if (usesWireTime()) {
        const now = nowUs();
        M._tw_link_release_at(now >>> 0, Math.floor(now / 2 ** 32));
    }
    const dur = M._tw_link_tx_dur_us() || 100;
    for (let b; (b = M._tw_link_drain()) >= 0; ) {
        const t = nowUs();
        lastTs = t > lastTs ? t : lastTs + 1;
        post({ t: 'rec', byte: b, dur, ts: lastTs });
    }
}

/* Ask before booting a slot; resolve true when free or the holder's winId. */
export function canBoot(slotId) {
    return new Promise(resolve => {
        if (!chan || !peers.size) return resolve(true);
        if (pendingAsk) {
            /* Supersede the earlier request with a refusal, never a false
               "free" result. */
            clearTimeout(pendingAsk.timer);
            pendingAsk.resolve(0);
        }
        pendingAsk = { slot: slotId, resolve,
                       timer: setTimeout(() => { pendingAsk = null; resolve(true); },
                                         opts.claimMs) };
        post({ t: 'claim?', slot: slotId });
    });
}

/* Heartbeats re-assert claims, so a dead peer's claim expires with its lease. */
export function claim(slotId) { post({ t: 'claim', slot: slotId }); }

function touch(m) {
    const p = peers.get(m.win) ?? { frame: -1, frameAt: Date.now() };
    p.last = Date.now();
    if (m.t === 'hb') {
        if (m.frame !== p.frame) { p.frame = m.frame; p.frameAt = Date.now(); }
        p.device = m.device; p.running = m.running; p.slot = m.slot;
    }
    peers.set(m.win, p);
}

/* The lower window id keeps a contested slot. */
function slotConflict(m) {
    if (m.slot != null && m.slot === cb.slot() && m.win < myWin)
        cb.onSlotLost(m.slot);
}

function onMsg(m) {
    if (!m || m.win === myWin) return;
    switch (m.t) {
    case 'hello': touch(m); post({ t: 'here' }); sync(); break;
    case 'here':  touch(m); sync(); break;
    case 'bye':   peers.delete(m.win); sync(); break;
    case 'hb':    touch(m); slotConflict(m); sync(); break;
    case 'rec': {
        if (!armed || !peers.has(m.win)) return;
        /* Set the receiving core clock before injecting the peer's record. */
        const now = nowUs();
        M._tw_link_set_now(now >>> 0, Math.floor(now / 2 ** 32));
        if (!M._tw_link_inject(m.win, m.byte, m.ts >>> 0,
                               Math.floor(m.ts / 2 ** 32), m.dur)
            && !warnedDrop) {
            console.warn('link: record dropped, pend queue full');
            warnedDrop = true;
        }
        if (!usesWireTime()) M._tw_link_release();
        break;
    }
    case 'claim':
        touch(m); slotConflict(m); sync(); break;
    case 'claim?':
        if (m.slot != null && m.slot === cb.slot()) post({ t: 'held', slot: m.slot });
        break;
    case 'held':
        if (pendingAsk && m.slot === pendingAsk.slot) {
            clearTimeout(pendingAsk.timer);
            const { resolve } = pendingAsk; pendingAsk = null;
            resolve(m.win);
        }
        break;
    }
}

export function stats() {
    const buf = M._malloc(256);
    M.ccall('tw_link_stats', 'number', ['number', 'number'], [buf, 256]);
    const s = JSON.parse(M.UTF8ToString(buf));
    M._free(buf);
    return s;
}

/* Test injection runs detached. Resetting the link loses in-flight records,
   so selftest is destructive to a live session; restore the prior armed state. */
export function selftest() {
    const was = armed;
    M._tw_link_enable(0);
    const before = stats().bytes_in;
    M._tw_link_inject(0xC0FFEE, 0x42, 1000, 0, 87);
    M._tw_link_release();
    const after = stats().bytes_in;
    M._tw_link_enable(0);
    if (was) M._tw_link_enable(1);
    return { ok: after === before + 1, before, after };
}
