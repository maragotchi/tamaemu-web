#!/bin/sh

set -e
cd "$(dirname "$0")"

. ./emsdk/emsdk_env.sh >/dev/null 2>&1

mkdir -p build

emcc -std=gnu11 -O3 -flto -Wall -Wextra \
    -include time.h -include stdlib.h \
    -o build/tamaemu.mjs \
    src/*.c dlc/*.c web_main.c \
    -I src -I dlc \
    -sEXPORTED_FUNCTIONS=_main,_tw_boot,_tw_booted,_tw_run_frame,_tw_run_cycles,_tw_buttons,_tw_frame,_tw_frame_w,_tw_frame_h,_tw_cycles,_tw_emu_secs,_tw_stopped,_tw_pc,_tw_frame_nonblack,_tw_flash_ptr,_tw_flash_size,_tw_ram_ptr,_tw_ram_size,_tw_flash_dirty,_tw_flash_clean,_tw_session_size,_tw_session_write,_tw_session_restore,_tw_session_reset_host,_tw_set_awake,_tw_awake_tier,_tw_speed,_tw_speed_step,_tw_speed_reset,_tw_wake_press_lost,_tw_rtc_seconds,_tw_audio_pull,_tw_audio_reset,_tw_audio_pitch,_tw_probe_clear,_tw_probe_add,_tw_panel_asleep,_tw_run_until_sleep,_tw_nfc_probe,_tw_nfc_probe_on,_tw_has_bingo,_tw_device_count,_tw_device_name,_tw_device_title,_tw_device_rom_size,_tw_dlc_install,_tw_dlc_supported,_tw_dlc_usage_json,_tw_dlc_tab_for,_tw_dlc_install_json,_tw_link_enable,_tw_link_drain,_tw_link_tx_dur_us,_tw_link_inject,_tw_link_release,_tw_link_set_now,_tw_link_release_at,_tw_link_stats,_malloc,_free \
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,HEAPU32,UTF8ToString,FS \
    -sFORCE_FILESYSTEM=1 \
    -sMODULARIZE=1 \
    -sEXPORT_NAME=createTamaemu \
    -sEXPORT_ES6=1 \
    -sENVIRONMENT=web,node \
    -sEXIT_RUNTIME=0 \
    -sINITIAL_MEMORY=33554432 \
    -sALLOW_MEMORY_GROWTH=0 \
    -sSTACK_SIZE=1048576

echo
echo "  built:"
ls -l build/tamaemu.mjs build/tamaemu.wasm
