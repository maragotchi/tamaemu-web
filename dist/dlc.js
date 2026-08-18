let M = null, ctx = null;
const files = [];

const $ = id => document.getElementById(id);

/* #status is refreshed by the frame loop; install results need their own line. */
function dlcSay(msg, cls) {
    const el = $('dlcStatus');
    el.hidden = !msg;
    el.textContent = msg || '';
    el.style.color = cls === 'bad' ? 'var(--bad)' : cls === 'ok' ? 'var(--ok)' : '';
}

/* C JSON escapes raw filename bytes as U+0080..U+00FF; recover valid UTF-8,
 * otherwise retain the stable Latin-1 view. */
function fixText(s) {
    if (!s || !/[\u0080-\u00ff]/.test(s)) return s;
    const bytes = Uint8Array.from([...s].map(c => c.charCodeAt(0) & 0xff));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return s; }
}

/* tw_dlc_install_json's numeric wipe precedes its output buffer; string-only
 * arguments would pass a nonzero wipe. */
const callJson = (fn, argTypes, args, size = 1 << 16) => {
    const buf = M._malloc(size);
    M.ccall(fn, 'number', [...argTypes, 'number', 'number'], [...args, buf, size]);
    const s = M.UTF8ToString(buf);
    M._free(buf);
    try { return JSON.parse(s); } catch { return null; }
};

export function init(c) {
    ctx = c; M = c.M;
    $('dlcAddBtn').onclick = () => $('dlcFiles').click();
    $('dlcFiles').onchange = onAdd;
    $('dlcInstall').onclick = install;
    $('dlcClear').onclick = () => { files.length = 0; clearOutcome(); render(); };
    refresh();
}

function clearOutcome() {
    $('dlcResults').hidden = true;
    $('dlcResults').replaceChildren();
    $('dlcApply').hidden = true;
    $('dlcDownload').hidden = true;
    dlcSay('');
    pending = null;
}

export function refresh() {
    /* Results describe the previous device after a switch or reset. */
    clearOutcome();
    const dev = ctx.deviceName();
    /* The raw export needs a char*; use ccall to marshal the JS device name. */
    const supported = !!dev && M.ccall('tw_dlc_supported', 'number', ['string'], [dev]) === 1;
    $('dlcUnsupported').hidden = supported;
    $('dlcBody').hidden = !supported;
    if (!supported) {
        $('dlcUnsupported').textContent = dev
            ? `No content stores are mapped for ${ctx.deviceTitle()}, so nothing can be installed onto it.`
            : 'Start a ROM first.';
        return;
    }
    renderUsage();
    render();
}

function renderUsage() {
    const usage = callJson('tw_dlc_usage_json', ['string'], [ctx.deviceName()], 8192) ?? [];
    const el = $('dlcUsage');
    el.replaceChildren();
    if (!usage.length) { el.innerHTML = '<div class="muted">Start the Tamagotchi to read its stores.</div>'; return; }
    for (const u of usage) {
        const full = u.used >= u.max;
        const row = document.createElement('div');
        row.className = 'dlcrow';
        row.innerHTML = `<span>${fixText(u.label)}</span>`
                      + `<span class="${full ? 'dlcfull' : 'muted'}">${u.used}/${u.max}</span>`;
        el.append(row);
    }
}

async function onAdd(ev) {
    const picked = [...ev.target.files];
    ev.target.value = '';
    if (!picked.length) return;

    const dev = ctx.deviceName();
    for (const f of picked) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        /* dlc_tab_for accepts a path, so classify a temporary MEMFS file.
           The installer writes separate copies. */
        const probe = '/probe/' + f.name;
        mkdirp('/probe');
        M.FS.writeFile(probe, bytes);
        const info = callJson('tw_dlc_tab_for', ['string', 'string'], [dev, probe], 2048) ?? {};
        try { M.FS.unlink(probe); } catch {}
        files.push({
            name: f.name, bytes,
            tab: fixText(info.tab || ''),
            display: fixText(info.display || f.name),
            routable: !!(info.tab && info.tab.length),
        });
    }
    render();
}

function render() {
    const el = $('dlcList');
    el.replaceChildren();
    $('dlcInstall').disabled = !files.some(f => f.routable);
    $('dlcClear').hidden = !files.length;

    if (!files.length) {
        el.innerHTML = '<div class="muted">No payloads added yet.</div>';
        return;
    }

    const tabs = new Map();
    for (const f of files) {
        const key = f.routable ? f.tab : ' unroutable';
        if (!tabs.has(key)) tabs.set(key, []);
        tabs.get(key).push(f);
    }
    for (const [tab, group] of tabs) {
        const head = document.createElement('div');
        head.className = 'dlctab';
        head.textContent = tab === ' unroutable'
            ? `Cannot be installed on this Tamagotchi (${group.length})` : `${tab} (${group.length})`;
        el.append(head);
        for (const f of group) {
            const row = document.createElement('div');
            row.className = 'dlcrow' + (f.routable ? '' : ' dlcbad');
            row.innerHTML = `<span>${escapeHtml(f.display)}</span>`;
            if (!f.routable) row.innerHTML += '<span class="muted">unroutable</span>';
            el.append(row);
        }
    }
}

const escapeHtml = s => s.replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* MEMFS payload buffers live in browser memory; clear them between installs
 * and after reading the image. */
function clearDir(path) {
    let ents;
    try { ents = M.FS.readdir(path); } catch { return; }
    for (const e of ents) {
        if (e === '.' || e === '..') continue;
        try { M.FS.unlink(path + '/' + e); } catch {}
    }
}

function mkdirp(path) {
    let cur = '';
    for (const part of path.split('/')) {
        if (!part) continue;
        cur += '/' + part;
        try { M.FS.mkdir(cur); } catch {}
    }
}

async function install() {
    const dev = ctx.deviceName();
    const routable = files.filter(f => f.routable);
    if (!routable.length) return;

    dlcSay(`Installing ${routable.length} payload${routable.length === 1 ? '' : 's'}…`);

    /* Work on a MEMFS copy; Apply is the only write to the live device or slot. */
    mkdirp('/work/payloads');
    clearDir('/work/payloads');
    const flash = ctx.liveFlash();
    M.FS.writeFile('/work/target.sav', flash);

    const paths = [];
    routable.forEach((f, i) => {
        /* Prefix indexes prevent duplicate-name collisions and preserve order. */
        const p = `/work/payloads/${String(i).padStart(4, '0')}_${f.name.replace(/[/\\]/g, '_')}`;
        M.FS.writeFile(p, f.bytes);
        paths.push(p);
    });
    M.FS.writeFile('/work/list.txt', paths.join('\n') + '\n');

    /* Never wipe game or DLC slots by implication. */
    let out, image;
    try {
        out = callJson('tw_dlc_install_json',
                       ['string', 'string', 'string', 'number'],
                       [dev, '/work/target.sav', '/work/list.txt', 0], 1 << 18);

        if (!out || out.rc !== 0) {
            dlcSay(`Install failed: ${out?.error || 'unknown error'}`, 'bad');
            return;
        }

        image = M.FS.readFile('/work/target.sav');
    } finally {
        clearDir('/work/payloads');
    }

    pending = { image, routable, items: out.items || [] };
    renderResults(out.items || []);

    const ok = (out.items || []).filter(i => !i.error).length;
    const bad = (out.items || []).length - ok;
    /* Usage reflects live flash until Apply, not the staged image. */
    dlcSay(`Placed ${ok} of ${out.items.length}.`
          + (bad ? ` ${bad} could not be placed - see below.` : '')
          + ` Nothing has changed yet: the counts above are still the Tamagotchi's.`
          + ` Choose Apply to keep this, or Download for a file.`, ok ? 'ok' : 'bad');

    $('dlcApply').hidden = false;
    $('dlcDownload').hidden = false;
    /* Applying without storage loses the image when the tab closes; Download does not write storage. */
    const canKeep = ctx.storageAvailable ? ctx.storageAvailable() : true;
    $('dlcApply').disabled = !canKeep;
    $('dlcApply').title = canKeep ? ''
        : 'Storage is unavailable, so an applied image could not be kept past '
        + 'this tab. Use Download instead.';
    $('dlcApply').onclick = () => applyImage(image, ok);
    $('dlcDownload').onclick = () => ctx.download(image);
    if (!canKeep)
        dlcSay(`Placed ${ok} of ${out.items.length}, but storage is unavailable, `
             + `so this cannot be kept on the Tamagotchi. Choose Download for a `
             + `file you own.`, 'bad');
}

let pending = null;

function renderResults(items) {
    const el = $('dlcResults');
    el.replaceChildren();
    if (!items.length) { el.hidden = true; return; }
    el.hidden = false;
    for (const it of items) {
        const row = document.createElement('div');
        row.className = 'dlcrow' + (it.error ? ' dlcbad' : '');
        const name = fixText(it.name) || fixText(it.id) || it.file.replace(/^.*\//, '');
        row.innerHTML = `<span>${escapeHtml(name)}</span>`
          + `<span class="muted">${it.error ? escapeHtml(it.error)
                                             : escapeHtml(fixText(it.label || ''))}</span>`;
        el.append(row);
    }
}

async function applyImage(image, ok) {
    if (!confirm(`Apply ${ok} installed item${ok === 1 ? '' : 's'} to this Tamagotchi?\n\n`
               + `The device will reboot!`)) return;
    const p = pending;
    await ctx.applyImage(image);

    /* Keep only refused payloads for a retry after freeing space. */
    let kept = 0;
    if (p) {
        const refused = new Set();
        p.items.forEach((it, i) => { if (it.error && p.routable[i]) refused.add(p.routable[i]); });
        for (let i = files.length - 1; i >= 0; i--)
            if (!refused.has(files[i])) files.splice(i, 1);
        kept = files.length;
    } else {
        files.length = 0;
    }

    refresh();
    dlcSay(kept
        ? `Applied. ${kept} payload${kept === 1 ? '' : 's'} did not fit and are still `
          + `listed - free some space and install again.`
        : 'Applied. The counts above now show the new content.', 'ok');
}
