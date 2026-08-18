/* JavaScript owns pacing and UI; this bridge exposes non-blocking core steps. */
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <emscripten/emscripten.h>

#include "emu.h"

#define KEEP EMSCRIPTEN_KEEPALIVE

/* Emu is too large for the wasm stack. */
static Emu e;
static int booted;

/* Keep live input separate from e.btn_mask, which stores the previous tick. */
static uint8_t held_mask;

/* Preserved across tw_boot's state reset. */
static int keep_awake = 1;

/* lcd_render always writes the full panel; tw_frame converts it for ImageData. */
static uint32_t framebuf[PANEL_W * PANEL_H];

void tw_audio_reset(void);

int KEEP tw_device_count(void)
{
    int n = 0;
    while (device_at((size_t)n)) n++;
    return n;
}

const char *KEEP tw_device_name(int i)
{
    const DeviceProfile *d = device_at((size_t)i);
    return d ? d->name : "";
}

const char *KEEP tw_device_title(int i)
{
    const DeviceProfile *d = device_at((size_t)i);
    return d ? d->title : "";
}

int KEEP tw_device_rom_size(int i)
{
    const DeviceProfile *d = device_at((size_t)i);
    return d ? (int)d->rom_size : 0;
}

/* Returns 0 on success:
 *   -1 no such device   -2 device fails its own ceiling check
 *   -3 ROM too large    -4 out of memory
 */
int KEEP tw_boot(const char *device, const uint8_t *rom, int len)
{
    const DeviceProfile *d = device_find(device);
    if (!d) return -1;
    if (!device_check(d, stderr)) return -2;
    if (len < 0 || (uint32_t)len > d->rom_size) return -3;

    /* Browser reboots reuse the module, so clear all device state. */
    free(e.rom);
    memset(&e, 0, sizeof e);
    held_mask = 0;

    e.dev = *d;
    e.cmu.osc3_hz = d->osc3_hz;
    /* memset cleared the standing preference. */
    e.stay_awake = keep_awake ? true : false;
    /* Required for profile-gated 4U bingo and gashapon touch. */
    e.auto_touch = true;

    e.rom = calloc(1, d->rom_size);
    if (!e.rom) return -4;
    memcpy(e.rom, rom, (size_t)len);
    cpu_reset(&e);
    tw_audio_reset();   /* discard the previous device's tone state */
    fprintf(stderr, "[rom] %s: %d bytes, reset vector -> %08x\n",
            d->title, len, e.pc);
    booted = 1;
    return 0;
}

int KEEP tw_booted(void) { return booted; }

static void hold_awake(void);
static void hold_probe(void);

#define PROBE_MAX 1024
static uint32_t probe_off[PROBE_MAX];   /* A0RAM offsets held at zero */
static int      probe_n;

/* Exported controls for testing A0RAM offsets as sleep gates. */
void KEEP tw_probe_clear(void) { probe_n = 0; }

int KEEP tw_probe_add(int off)
{
    if (probe_n >= PROBE_MAX || off < 0 || (uint32_t)off >= e.dev.a0ram_size) return 0;
    probe_off[probe_n++] = (uint32_t)off;
    return 1;
}

static void hold_probe(void)
{
    for (int i = 0; i < probe_n; i++) e.a0ram[probe_off[i]] = 0;
}

/* Report controller sleep state, not stay_awake's rendered output. */
int KEEP tw_panel_asleep(void) { return e.lcd.sleep_out ? 0 : 1; }

/* Return frames until sleep, or -1 if the candidate offsets keep it awake. */
int KEEP tw_run_until_sleep(int max_frames)
{
    if (!booted) return -1;
    for (int f = 0; f < max_frames; f++) {
        uint64_t hz = (uint64_t)(e.cmu.mclk_hz > 0 ? e.cmu.mclk_hz : 2e7);
        uint64_t fcyc = hz / 60; if (!fcyc) fcyc = 333333;
        uint64_t target = e.cycles + fcyc;
        while (e.cycles < target && !e.stopped) {
            hold_awake(); hold_probe(); link_core_step(&e, held_mask);
        }
        if (tw_panel_asleep()) return f;
    }
    return -1;
}

/* iD L sleep gates vary by firmware, so match known reset vectors before
 * falling back to the device profile. */
static uint32_t local_sleep_gate(const DeviceProfile *d)
{
    if (strcmp(d->name, "idl")) return 0xFFFFFFFFu;
    uint32_t rv;
    memcpy(&rv, e.rom + (d->ttbr_reset - d->rom_base), 4);
    if (rv == 0x024C14F6u) return 0x000010F0u;
    if (rv == 0x024CAA72u) return 0x00000FD8u;
    return 0xFFFFFFFFu;
}

/* stay_awake keeps the panel visible; a firmware-specific gate keeps the CPU
 * awake. Unknown firmware builds fall back to the panel-only tier. */
static void hold_awake(void)
{
    /* Forced above 1x when accelerated idle timing can swallow every press. */
    if (!(keep_awake || (e.rtc_mult > 1 && e.dev.wake_press_lost))) return;

    uint32_t off = local_sleep_gate(&e.dev);
    if (off < e.dev.a0ram_size) {
        e.a0ram[off] = 0;
    } else if (e.dev.has_sleep_flag) {
        e.a0ram[e.dev.sleep_flag - e.dev.a0ram_base] = 0;
    }
}

/* Advance MCLK/60 cycles without pacing; link_core_step preserves the core's
 * 256-cycle peripheral cadence. */
void KEEP tw_run_frame(void)
{
    if (!booted || e.stopped) return;
    uint64_t hz  = (uint64_t)(e.cmu.mclk_hz > 0 ? e.cmu.mclk_hz : 2e7);
    uint64_t fcyc = hz / 60;
    if (!fcyc) fcyc = 333333;
    uint64_t target = e.cycles + fcyc;
    while (e.cycles < target && !e.stopped) { hold_awake(); hold_probe(); link_core_step(&e, held_mask); }
}

/* rtc_mult accelerates RTC ageing without speeding MCLK animation or sound.
 * tw_boot resets it so one slot's speed cannot age the next slot. */
int KEEP tw_speed(void) { return e.rtc_mult < 1 ? 1 : e.rtc_mult; }

int KEEP tw_speed_step(int dir)
{
    e.rtc_mult = periph_speed_step(tw_speed(), dir);
    return e.rtc_mult;
}

void KEEP tw_speed_reset(void) { e.rtc_mult = 1; }

/* Lets JS explain why keep-awake is forced above 1x. */
int KEEP tw_wake_press_lost(void) { return e.dev.wake_press_lost ? 1 : 0; }

double KEEP tw_rtc_seconds(void) { return (double)e.rtc_seconds_counted; }

void KEEP tw_set_awake(int on)
{
    keep_awake = on ? 1 : 0;
    e.stay_awake = on ? true : false;
}

/* 0 = not booted, 1 = panel only, 2 = panel and firmware sleep blocked. */
int KEEP tw_awake_tier(void)
{
    if (!booted) return 0;
    if (e.dev.has_sleep_flag) return 2;
    return local_sleep_gate(&e.dev) < e.dev.a0ram_size ? 2 : 1;
}

/* Manual store-point field toggle; bingo and gashapon use auto_touch. */
void KEEP tw_nfc_probe(int on)
{
    if (booted) pn512_probe_set(&e, on ? 1 : 0);
}

int KEEP tw_nfc_probe_on(void) { return booted && e.nfc_probe_at ? 1 : 0; }

int KEEP tw_has_bingo(void) { return booted && e.dev.bingo_open_pc ? 1 : 0; }

/* Deterministic test helper. */
void KEEP tw_run_cycles(double n)
{
    if (!booted) return;
    uint64_t target = e.cycles + (uint64_t)n;
    while (e.cycles < target && !e.stopped) { hold_awake(); hold_probe(); link_core_step(&e, held_mask); }
}

/* Bits 0-2 are held A/B/C states; the core derives press edges. */
void KEEP tw_buttons(int mask) { held_mask = (uint8_t)mask & 0x07; }

/* lcd_render returns 0xAARRGGBB words. Swap red and blue so little-endian
 * memory is RGBA byte order for ImageData without a JavaScript copy. */
const uint32_t *KEEP tw_frame(void)
{
    int w, h;
    if (!booted) { memset(framebuf, 0, sizeof framebuf); return framebuf; }
    lcd_render(&e, framebuf, &w, &h);
    for (int i = 0; i < PANEL_W * PANEL_H; i++) {
        uint32_t v = framebuf[i];                    /* 0xAARRGGBB */
        framebuf[i] = (v & 0xFF00FF00u)
                    | ((v & 0x000000FFu) << 16)
                    | ((v >> 16) & 0x000000FFu);     /* RGBA bytes */
    }
    return framebuf;
}

int KEEP tw_frame_w(void) { return PANEL_W; }
int KEEP tw_frame_h(void) { return PANEL_H; }

/* Convert cycle-stamped tone events to float PCM at the caller's sample rate. */
#define AMP 0.13733f    /* 4500/32767, the desktop's piezo level */

/* Diagnostic multiplier; production leaves this at 1.0. */
static double a_pitch = 1.0;

static uint64_t a_cyc;      /* converted up to this cycle */
static unsigned a_ev_r;     /* tone events consumed */
static double   a_phase, a_frac;
static uint8_t  a_cur_on;
static double   a_cur_freq;

void KEEP tw_audio_pitch(double m) { a_pitch = (m > 0.01 && m < 100.0) ? m : 1.0; }

void KEEP tw_audio_reset(void)
{
    a_cyc = 0; a_ev_r = e.tone_ev_w;
    a_phase = a_frac = 0; a_cur_on = 0; a_cur_freq = 0;
}

/* Fill up to max samples through the current emulated cycle; 0 is not an error. */
int KEEP tw_audio_pull(float *out, int max, double rate)
{
    if (!booted || max <= 0 || rate <= 0) return 0;
    double mclk = e.cmu.mclk_hz > 0 ? e.cmu.mclk_hz : e.dev.osc3_hz;
    if (mclk <= 0) return 0;
    if (!a_cyc) a_cyc = e.cycles;

    /* Apply skipped events when resyncing so the tone state remains current. */
    if ((double)(e.cycles - a_cyc) > mclk / 2 || e.tone_ev_w - a_ev_r > TONE_EV_N) {
        a_cyc = e.cycles;
        while (a_ev_r < e.tone_ev_w) {
            struct ToneEv *ev = &e.tone_ev[a_ev_r % TONE_EV_N];
            a_cur_on = ev->on; a_cur_freq = ev->freq; a_ev_r++;
        }
    }

    int n = 0;
    while (a_cyc < e.cycles && n < max) {
        uint64_t next = e.cycles;
        if (a_ev_r < e.tone_ev_w) {
            struct ToneEv *ev = &e.tone_ev[a_ev_r % TONE_EV_N];
            if (ev->cyc <= a_cyc) { a_cur_on = ev->on; a_cur_freq = ev->freq; a_ev_r++; continue; }
            if (ev->cyc < next) next = ev->cyc;   /* preserve event timing */
        }
        double smp = (double)(next - a_cyc) * rate / mclk + a_frac;
        int k = (int)smp; a_frac = smp - k;
        if (k > max - n) { k = max - n; a_frac = 0; }
        for (int i = 0; i < k; i++) {
            float s = 0.0f;
            double f = a_cur_freq * a_pitch;
            if (a_cur_on && f >= 20 && f <= 20000) {
                a_phase += f / rate;
                if (a_phase >= 1.0) a_phase -= 1.0;
                s = a_phase < 0.5 ? AMP : -AMP;
            }
            out[n++] = s;
        }
        a_cyc = next;
    }
    return n;
}

/* Flash and A0RAM are separate save buffers. These pointers borrow the fixed
 * wasm heap; JavaScript must copy data it keeps. cpu_reset does not clear
 * A0RAM, so restoring it after tw_boot is safe. */
uint8_t *KEEP tw_flash_ptr(void)  { return e.rom; }
int      KEEP tw_flash_size(void) { return booted ? (int)e.dev.rom_size : 0; }
uint8_t *KEEP tw_ram_ptr(void)    { return e.a0ram; }
int      KEEP tw_ram_size(void)   { return booted ? (int)e.dev.a0ram_size : 0; }

/* A0RAM is always saved; this flag avoids copying unchanged flash. */
int  KEEP tw_flash_dirty(void) { return e.flash_dirty ? 1 : 0; }
void KEEP tw_flash_clean(void) { e.flash_dirty = false; }

double KEEP tw_cycles(void)   { return (double)e.cycles; }
double KEEP tw_emu_secs(void) { return e.emu_secs; }
int    KEEP tw_stopped(void)  { return e.stopped; }
int    KEEP tw_pc(void)       { return (int)e.pc; }

/* Headless smoke-test signal. */
int KEEP tw_frame_nonblack(void)
{
    const uint32_t *px = tw_frame();
    int n = 0;
    for (int i = 0; i < PANEL_W * PANEL_H; i++)
        if ((px[i] & 0x00FFFFFFu) != 0) n++;
    return n;
}

/* EXIT_RUNTIME=0 keeps exports usable after main returns. */
int main(void)
{
    fprintf(stderr, "[tamaemu] core ready, %d devices\n", tw_device_count());
    return 0;
}

/* The path-based DLC API runs unchanged against Emscripten MEMFS. */
#include "dlc.h"

int KEEP tw_dlc_install(const char *device, const char *target,
                        const char *listfile, int wipe, int backup,
                        char *err, int errsz)
{
    const DlcDevice *d = device && *device ? dlc_device_find(device)
                                           : dlc_device_default();
    if (!d) { if (errsz) snprintf(err, (size_t)errsz, "unknown device"); return -1; }

    FILE *lf = fopen(listfile, "rb");
    if (!lf) { if (errsz) snprintf(err, (size_t)errsz, "cannot read %s", listfile); return -1; }

    int cap = 64, n = 0;
    char **paths = malloc((size_t)cap * sizeof *paths);
    char line[1024];
    while (fgets(line, sizeof line, lf)) {
        size_t l = strlen(line);
        while (l && (line[l-1] == '\n' || line[l-1] == '\r')) line[--l] = '\0';
        if (!l) continue;
        if (n == cap) { cap *= 2; paths = realloc(paths, (size_t)cap * sizeof *paths); }
        paths[n] = malloc(l + 1);
        memcpy(paths[n], line, l + 1);
        n++;
    }
    fclose(lf);

    DlcResult *res = calloc((size_t)(n > 0 ? n : 1), sizeof *res);
    int rc = dlc_inject(d, target, (const char *const *)paths, n, wipe, backup,
                        NULL, 0, res, err, (size_t)errsz);

    for (int i = 0; i < n; i++) free(paths[i]);
    free(paths);
    free(res);
    return rc == 0 ? n : -1;
}

/* JSON is written into caller-owned buffers. Escape high payload bytes as
 * \u00XX so arbitrary record names round-trip through JavaScript. */
static void json_str(char **p, char *end, const char *s)
{
    if (*p < end) *(*p)++ = '"';
    for (const unsigned char *u = (const unsigned char *)s; *u && *p + 6 < end; u++) {
        if (*u == '"' || *u == '\\') { *(*p)++ = '\\'; *(*p)++ = (char)*u; }
        else if (*u == '\n') { *(*p)++ = '\\'; *(*p)++ = 'n'; }
        else if (*u < 0x20 || *u >= 0x80) *p += snprintf(*p, (size_t)(end - *p), "\\u%04x", *u);
        else *(*p)++ = (char)*u;
    }
    if (*p < end) *(*p)++ = '"';
}

int KEEP tw_dlc_supported(const char *device)
{
    const DlcDevice *d = dlc_device_find(device);
    return (d && d->nkinds > 0) ? 1 : 0;
}

int KEEP tw_dlc_usage_json(const char *device, char *out, int n)
{
    const DlcDevice *d = dlc_device_find(device);
    if (!d || !booted || !e.rom) { snprintf(out, (size_t)n, "[]"); return 0; }
    DlcUsage u[24];
    int un = dlc_store_usage(d, e.rom, u, 24);
    char *p = out, *end = out + n - 2;
    *p++ = '[';
    for (int i = 0; i < un && p < end; i++) {
        if (i) *p++ = ',';
        *p++ = '{'; p += snprintf(p, (size_t)(end - p), "\"label\":");
        json_str(&p, end, u[i].label ? u[i].label : "");
        p += snprintf(p, (size_t)(end - p), ",\"used\":%d,\"max\":%d}", u[i].used, u[i].max);
    }
    *p++ = ']'; *p = 0;
    return un;
}

/* An empty tab means the payload cannot be installed on this device. */
int KEEP tw_dlc_tab_for(const char *device, const char *path, char *out, int n)
{
    const DlcDevice *d = dlc_device_find(device);
    if (!d) { snprintf(out, (size_t)n, "{}"); return 0; }
    char tab[DLC_TAB_MAX] = "", display[256] = "";
    dlc_tab_for(d, path, tab, sizeof tab, display, sizeof display);
    char *p = out, *end = out + n - 2;
    p += snprintf(p, (size_t)(end - p), "{\"tab\":");
    json_str(&p, end, tab);
    p += snprintf(p, (size_t)(end - p), ",\"display\":");
    json_str(&p, end, display);
    if (p < end) *p++ = '}';
    *p = 0;
    return tab[0] ? 1 : 0;
}

int KEEP tw_dlc_install_json(const char *device, const char *target,
                             const char *listfile, int wipe, char *out, int n)
{
    const DlcDevice *d = device && *device ? dlc_device_find(device)
                                           : dlc_device_default();
    char *p = out, *end = out + n - 2;
    if (!d) { snprintf(out, (size_t)n, "{\"error\":\"unknown device\"}"); return -1; }

    FILE *lf = fopen(listfile, "rb");
    if (!lf) { snprintf(out, (size_t)n, "{\"error\":\"no list\"}"); return -1; }
    int cap = 64, np = 0;
    char **paths = malloc((size_t)cap * sizeof *paths);
    char line[1024];
    while (fgets(line, sizeof line, lf)) {
        size_t l = strlen(line);
        while (l && (line[l-1] == '\n' || line[l-1] == '\r')) line[--l] = '\0';
        if (!l) continue;
        if (np == cap) { cap *= 2; paths = realloc(paths, (size_t)cap * sizeof *paths); }
        paths[np] = malloc(l + 1); memcpy(paths[np], line, l + 1); np++;
    }
    fclose(lf);

    DlcResult *res = calloc((size_t)(np > 0 ? np : 1), sizeof *res);
    char err[256] = "";
    int rc = dlc_inject(d, target, (const char *const *)paths, np, wipe, 0,
                        NULL, 0, res, err, sizeof err);

    p += snprintf(p, (size_t)(end - p), "{\"rc\":%d,\"error\":", rc);
    json_str(&p, end, err);
    p += snprintf(p, (size_t)(end - p), ",\"items\":[");
    for (int i = 0; i < np && p < end; i++) {
        if (i) *p++ = ',';
        p += snprintf(p, (size_t)(end - p), "{\"file\":");
        json_str(&p, end, res[i].file);
        p += snprintf(p, (size_t)(end - p), ",\"id\":");
        json_str(&p, end, res[i].id);
        p += snprintf(p, (size_t)(end - p), ",\"name\":");
        json_str(&p, end, res[i].name);
        p += snprintf(p, (size_t)(end - p), ",\"label\":");
        json_str(&p, end, res[i].label ? res[i].label : "");
        p += snprintf(p, (size_t)(end - p), ",\"kind\":%d,\"off\":%ld,\"error\":",
                      res[i].kind, res[i].off);
        json_str(&p, end, res[i].error);
        if (p < end) *p++ = '}';
    }
    p += snprintf(p, (size_t)(end - p), "]}");

    for (int i = 0; i < np; i++) free(paths[i]);
    free(paths); free(res);
    return rc == 0 ? np : -1;
}

/* Local mode uses FIFO 1 as the JavaScript outbox and FIFO 0 for inbound data.
 * JavaScript supplies cross-window timestamps and sender IDs. Times use two
 * u32 arguments because this build does not enable WASM_BIGINT. Injection is
 * available while detached for self-tests; tw_boot detaches every connection. */

int KEEP tw_link_enable(int on)
{
    Link *l = &e.auto_link_storage;
    link_reset(l);
    if (on) { e.core_id = 0; e.link = l; }
    else    { e.link = NULL; }
    return 0;
}

int KEEP tw_link_drain(void)
{
    Link *l = &e.auto_link_storage;
    return link_rx_pending(l, 1) ? link_rx(l, 1) : -1;
}

unsigned KEEP tw_link_tx_dur_us(void)
{
    return e.auto_link_storage.tx_byte_us;
}

int KEEP tw_link_inject(unsigned id, int byte,
                        unsigned t_lo, unsigned t_hi, unsigned dur_us)
{
    Link *l = &e.auto_link_storage;
    uint64_t t = ((uint64_t)t_hi << 32) | t_lo;
    if (dur_us > 0xFFFF) dur_us = 0xFFFF;  /* downstream stores uint16_t */
    /* A full pending queue drops silently, so report whether it grew. */
    int before = l->pend_n;
    link_test_inject(l, (uint32_t)id, (uint8_t)byte, t, dur_us);
    return l->pend_n > before;
}

void KEEP tw_link_release(void)
{
    link_test_release(&e.auto_link_storage);
}

/* JavaScript supplies explicit timestamps for cross-window link scheduling. */

void KEEP tw_link_set_now(unsigned now_lo, unsigned now_hi)
{
    /* Override link_clock until the next link_reset. */
    link_test_now(&e.auto_link_storage,
                  ((uint64_t)now_hi << 32) | now_lo);
}

void KEEP tw_link_release_at(unsigned now_lo, unsigned now_hi)
{
    Link *l = &e.auto_link_storage;
    uint64_t now = ((uint64_t)now_hi << 32) | now_lo;
    int was = l->net;
    l->net = 1;
    (void)link_rx_pending_at(l, 0, now);
    l->net = was;
}

int KEEP tw_link_stats(char *out, int n)
{
    if (!out || n <= 0) return -1;
    Link *l = &e.auto_link_storage;
    /* pend_max is net-only; reorder_late detects late wire-time arrivals. */
    return snprintf(out, (size_t)n,
        "{\"enabled\":%d,\"bytes_out\":%llu,\"bytes_in\":%llu,"
        "\"collisions\":%llu,\"backlog_max\":%u,\"overflows\":%llu,"
        "\"pend_max\":%d,\"reorder_late\":%llu}",
        e.link == l,
        (unsigned long long)l->bytes_ab, (unsigned long long)l->bytes_ba,
        (unsigned long long)l->collisions, l->backlog_max,
        (unsigned long long)l->overflows, l->pend_max,
        (unsigned long long)l->reorder_late);
}
