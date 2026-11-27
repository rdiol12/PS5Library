# PS5Library Shell indicator experiment

The HomeUI source-profile patch is derived from OnionHEN's
`source/shellui/src/homeui_top_nav_patch.cpp` at commit
`b23ffe674b2de9f62fe634944c9230ff149d593a`:

https://github.com/aydencharles/onionHEN

OnionHEN is licensed under GPL-3.0-or-later. The derived files in this
directory retain that license and copyright notice. PS5Library keeps this
code in a separate source boundary so distributions can include its source
and license together. Enabling this option statically links GPL code into the
agent binary; a distributor must meet the corresponding GPL source and notice
requirements.

The injector uses pinned copies of OnionHEN's `libNineS`,
`libonion_elfldr`, and `libonion_detour` sources. Files under `upstream/`
retain their upstream notices. PS5Library-owned compatibility headers and the
small adapter around `inject_elf` are kept beside, rather than folded into,
those sources.

## Verified boundary

- The runtime gate accepts firmware 4.50 and 4.51. The only accepted source
  bytes remain the exact NPXS40002 legacy RNPS payload profile with size
  `0x152990` and the pinned OnionHEN offsets.
- The stock `ApplicationErrorEventTrigger` component is the host. The older
  FPS body replacement is intentionally excluded.
- Every marker and replacement field is validated before mutation. Unknown,
  partial-corrupt, and differently sized input is left unchanged.
- The agent heartbeat is local and remains present in offline mode. A fresh,
  authenticated Library Server heartbeat only selects the optional pulse
  state. Stale server status falls back to steady.
- `/data/ps5library/disable-shell-indicator` is the external kill switch.
- OnionHEN, etaHEN, Yoncore, kylin-core, wmdw-jwm, and CheatRunner activity
  blocks startup. A conflict appearing after startup stops the local indicator
  heartbeat. The agent fails closed when firmware or process discovery cannot
  be verified.
- The helper is injected only after both ShellUI trophy modules are present.
  It publishes a PID-scoped readiness marker and is not reinjected into a PID
  that already failed.
- The helper reuses the installed PS5Library app icon from app metadata.
- Input diagnostics and the cheat page are optional hooks. A missing optional
  Mono symbol disables that feature without suppressing the core indicator.
- `/system_tmp/ps5library/shell-helper.status` records the exact startup stage
  and whether the verified HomeUI source patch was applied.
- The helper reads the local heartbeat on its own worker thread. ShellUI's UI
  thread only consumes atomics and performs the required NPXS40002 reload.
- A clean agent stop removes its session-owned state. A crash makes the icon
  disappear after the 12-second liveness window and the next HomeUI reload.

## Experimental limitation

The firmware-4.50/4.51 build enables `PS5LIBRARY_EXPERIMENTAL_SHELL_INDICATOR` by default. The
firmware-4.50 test candidate explicitly enables it; a public release still
requires a fresh physical 4.50/4.51 pass. The compiled
helper implements the real steady icon, local liveness removal, PID-scoped
reinjection, and no-network ShellUI path. The state protocol computes a slow,
bounded pulse only for a fresh authenticated server heartbeat, but visual
opacity mutation is deliberately gated until the exact target-firmware component method
is verified on hardware. Pulse state therefore renders steady in this first
build. The helper stays resident until SceShellUI exits; disabling the feature
hides the icon but does not attempt an unsafe live detour removal. Enable the
kill switch and reboot before starting a different ShellUI injector.

## Options input diagnostic

The separately gated `PS5LIBRARY_EXPERIMENTAL_SHELL_INPUT_DIAGNOSTIC` build
reuses this helper and injector. It is based on OnionHEN commit
`b23ffe674b2de9f62fe634944c9230ff149d593a`:

- `source/shellui/src/prx.cpp`, `install_hooks`, resolves
  `Sce.PlayStation.Core.dll` -> `Sce.PlayStation.Core.Input.GamePad.GetData`
  with one parameter.
- `source/shellui/include/hooked_funcs.hpp`, `GamePadData` and
  `GamePadButtons`, verifies the 36-byte returned value layout and the shared
  `Start`/`Option` mask `0x100`.
- `source/shellui/src/hook_boot.cpp`, `GetData_hook`, verifies that this value
  is the live ShellUI controller sample.

PS5Library calls the original method first, observes its `Buttons`,
`ButtonsDown`, and `ButtonsUp` fields, and returns the original value without
clearing any field. Only Options transitions and double-press triggers enter a
32-record ring. A helper thread atomically publishes the dirty ring to
`/system_tmp/ps5library/options-input.trace`; the per-frame hook never writes
to disk. Agent-session changes reset all half-complete gestures. The helper
does not yet open a page or consume the second Options press.

The verified animation path for the cheat page is the firmware's own Legacy
Settings stack. OnionHEN's `source/shellui/src/toolbox_navigation.cpp`
invokes `Sce.Vsh.ShellUI.Settings.CoreUI3.UIManager.Push`/`Pop` with
`TransitionAnimationType.Default` (`0`) and checks
`SettingPageStack.UnderTransition`. The test page uses the stock Boot route and
native toggle component, so firmware open/close and toggle transitions remain
authoritative. No custom renderer or timing layer was added.

## Experimental native cheat page

`PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE` is another firmware-4.50/4.51
mode in this same helper and is enabled by default. It leaves double-Options opening
disabled. For hardware testing, the existing PS5Library Home indicator opens
the stock `pssettings:play?mode=settings&function=debug_settings` route. The
helper substitutes only the pending Debug Settings resource request with
native `toggle_switch` rows; ordinary Debug Settings opens pass through.

The exact hook proof is OnionHEN commit
`b23ffe674b2de9f62fe634944c9230ff149d593a`:

- `source/shellui/src/prx.cpp`, `install_hooks`, resolves
  `System.Reflection.RuntimeAssembly.GetManifestResourceStream(1)` and
  `Sce.Vsh.ShellUI.Settings.CoreUI3.SettingPage.OnPressed(2)`.
- `source/shellui/src/mono_runtime.cpp`, `New_Mono_XML_From_String`, creates a
  Mono `System.IO.MemoryStream` and keeps recent streams in a bounded GC-handle
  ring.
- `source/include/onion/debug_settings_route_policy.hpp` selects the standard
  `debug_settings` URI for firmware 4.51.
- `source/shellui/src/toolbox_navigation.cpp` verifies native
  `UIManager.Push`/`Pop` with `TransitionAnimationType.Default` and
  `SettingPageStack.UnderTransition`. The test entry uses the stock Boot route,
  so its native transition and toggle animation remain authoritative.

Rows remain read-only unless the agent supplies a fresh, exact session and
bounded snapshot under `/system_tmp/ps5library`. Named actions go only to the
loopback agent listener with its random per-session bearer. Stale, malformed,
oversized, overly permissive, unreadable, or cross-session files fail closed.
ShellUI access to the agent-owned `0600` files and the full Settings route still
require current-candidate hardware verification.

## Experimental scalar memory scanner

`PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER` and
`PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES` are separate build flags enabled by
default for firmware 4.50/4.51.
The first enables bounded U8/U16/U32/U64/F32/F64 exact and unknown scans plus
exact/changed/unchanged/increased/decreased refinement and live watch. The
second enables confirmed edit, freeze, unfreeze, and restore controls. The
verified native input path is OnionHEN commit
`b23ffe674b2de9f62fe634944c9230ff149d593a`:

- `source/shellui/include/ps5_settings_ui.hpp`, `GroupT::text_field`, emits the
  native Settings `text_field` with a selected keyboard type.
- `source/shellui/src/hook_onpress.cpp`, `OnPressed_hook`, reads the element's
  `Id` and `Value` through `GetPropertyValue`.
- `source/shellui/src/onpress_system.cpp` consumes the resulting `ctx.value`.
- `source/util/tests/test_ps5_settings_ui.cpp`,
  `test_text_field_and_confirm`, verifies text fields and confirmation XML.

PS5Library uses `basic_latin` rather than the numeric keyboard so signed and
floating-point values retain `-`, `.`, and exponent notation; a strict 32-byte
scalar parser rejects malformed, NaN, and infinite input. Dynamic values are
XML escaped. Scans are bound to the current title/version/process and to
bounded writable sections of the main `eboot.bin` module (`MODULE_WRITABLE`).
The Shell snapshot and loopback API expose only random 128-bit scan/result IDs,
never PIDs, virtual addresses, mappings, or raw memory. Writes additionally
require the native confirmation action and a scan-bound approval header. The
agent caps watched results at 256, modified results at 16, and unknown-scan
state at 32 MiB; frozen values reconcile at the agent service cadence. The
firmware-4.50/4.51 build includes the feature by default; runtime safety checks
still fail closed when the console or selected target does not match.
