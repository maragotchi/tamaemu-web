let dlg, list, okEl, cancelEl;
let candidates = [];
let verb = 'Start';
let settle = null;

export function init() {
    if (dlg) return;
    dlg      = document.getElementById('deviceDlg');
    list     = document.getElementById('deviceList');
    okEl     = document.getElementById('deviceOk');
    cancelEl = document.getElementById('deviceCancel');

    cancelEl.onclick = () => dlg.close('');
    okEl.onclick     = () => dlg.close(picked() ?? '');
    list.addEventListener('change', paintOk);

    /* Every close path resolves the pending selection; an empty return value means cancellation. */
    dlg.addEventListener('close', () => {
        const done = settle; settle = null;
        if (done) done(dlg.returnValue || null);
    });
}

const picked = () => list.querySelector('input:checked')?.value ?? null;

function paintOk() {
    const d = candidates.find(x => x.name === picked());
    okEl.textContent = d ? `${verb} ${d.title}` : verb;
    okEl.disabled = !d;
}

/* Render the caller's order unchanged; exact ROM-size matches belong first.
   Resolve to the selected device name, or null on cancellation. */
export function choose({ list: choices, preselect, confirm = 'Start as' }) {
    /* A file picker can resolve before the page's async storage startup reaches
       Device.init(), especially in Firefox. The dialog markup already exists. */
    if (!dlg) init();
    /* Keep the active dialog open when a second selection request arrives. */
    if (dlg.open) return Promise.resolve(null);

    candidates = choices;
    verb = confirm;

    list.replaceChildren();
    for (const d of choices) {
        const row = document.createElement('label');
        row.className = 'device-row';
        row.innerHTML = '<input type="radio" name="device">'
                      + '<span class="name"><span class="t"></span>'
                      + '<span class="aka"></span></span><span class="size"></span>';
        const input = row.querySelector('input');
        input.value = d.name;
        input.checked = d.name === preselect;
        /* Render device metadata as text, not HTML. */
        row.querySelector('.t').textContent = d.title;
        row.querySelector('.aka').textContent = d.aka ?? '';
        row.querySelector('.size').textContent = `${d.size / 1048576} MB`;
        list.append(row);
    }

    paintOk();
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise(res => { settle = res; });
}
