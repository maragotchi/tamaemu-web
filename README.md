# tamaemu-web

A Tamagotchi emulator that runs in browser. This is a web front end for
[tamaemu](https://github.com/maragotchi/tamaemu), compiled to WebAssembly!

Supported devices: P's, iD L (all models), iD, iD Melody, 4U+, 4U, Plus Color, and
Plus Color (Hexagontchi).

## Firmware

This project does not include or download Tamagotchi firmware and never will. You need a
rom from a device you own. The file is read locally in your browser; nothing is uploaded anywhere.

## Quick start

1. Open the page in your browser.
2. Drag and drop your firmware dump onto the screen (or click the screen to browse).
3. Pick which Tamagotchi the dump is when asked. The best guess is preselected. Picking the wrong one usually boots into a black screen or sounds haunted.

## Controls

|       | A | B | C |
|-------|---|---|---|
| keys  | <kbd>Z</kbd> or <kbd>&larr;</kbd> | <kbd>X</kbd> or <kbd>&darr;</kbd> | <kbd>C</kbd> or <kbd>&rarr;</kbd> |

The on-screen buttons work with mouse and touch.

- <kbd>+</kbd> / <kbd>&minus;</kbd> - speed the game clock up or down
  (1x to 600x). <kbd>0</kbd> resets to 1x. The Tamagotchi ages faster; animations and
  sound stay at normal speed. Speed resets to 1x on every boot.


## Settings

The **Settings** button has volume/mute and the game-clock speed. No-sleep
is on by default: the device skips the firmware's idle sleep so the screen
stays lit and responsive.

## Saves

Every Tamagotchi you start gets a named save slot. Autosave writes every
20 seconds and when the tab is hidden. Slots can be played, renamed, exported,
and deleted from the Save slots card.

- **Saves live in your browser's storage.** Clearing site data
  deletes them. Use **Export .sav** to download a flash-only backup of anything you
  care about.
- **Save** updates the browser slot, including the current session point. It
  does not download a file. Save as often as you want, and please remember to save before navigating away from the page!
- **Reload** returns to that exact session point when its snapshot is
  compatible. Otherwise it falls back to the slot's flash and RAM.
- **Export .sav** is portable flash only and also opens in the desktop
  `tamaemu` build.
- **Export cross save** creates one `.tamasave` that picks up from the exact moment you left off!
  Open it in tamaemu-web or the standalone emulator. This is handy for swapping between mobile browsers, or 
  if you just want to keep your saves protected. Please be aware that if you export a cross save from tamaemu-web that it will
  not pick up the same exact frame on the desktop emulator.
- A cross save is a copy, not shared live storage! Save and export
  before switching applications.  Do not continue playing the desktop and browser
  copies at the same time. Weird things happen, just don't.
- **Import a .sav** restores a backup into a new slot.
- If the browser refuses storage (private browsing, blocked site data), the
  device still runs but nothing is kept; the page warns you and Export becomes
  the only way to keep your Tamagotchi.
- If you ever want to convert a .sav into a .bin, just edit the file to remove the .sav

## Connection play

Open the page in two windows and run a compatible pair. They connect
automatically for connection play!

| pair | can connect? |
|---|---|
| P's + P's | yes |
| iD L + iD L | yes |
| iD + iD | yes |
| iD Melody + iD Melody | yes |
| iD + iD Melody | yes |
| mixed pairings | no |
| 4U or 4U+ pair | no  |
| Plus Color or Hexagontchi pair | no |

Only two devices can connect at a time. Make sure both windows are visible for the best experience! 

## DLC

This emulator supports DLC!

1. **Add payload files** - they are grouped by where they will end up on the device. Files the
   device cannot take are marked unroutable.
2. **Install** - writes to a working copy.
3. **Apply to this Tamagotchi** - reboots the device with the new DLC added.

When downloading a VDP, select all of its files! (Usually there's three) Also, there's no hard-checks on what works for what device, so please be mindful of what device you're installing to! 

## Licence

This project is licensed under GNU GPL-3.0 — see `LICENSE` for the full terms.

In short: you are free to use, fork, modify and share this software, including for your own projects. Anything created and distributed with this software must be shipped with its source code. There is no warrany and it is provided as is.

Per the license: do not create closed-source projects with this software and do not charge others for this software.

The Tamagotchi firmware is not part of this project. It is not covered by the license. You must supply your own dump from hardware you legally own.
