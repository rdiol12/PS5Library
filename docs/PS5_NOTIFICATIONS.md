# PS5 notifications

## VERIFIED

[SDK source](https://github.com/ps5-payload-dev/sdk/tree/master/samples) includes both the debug request sample and the richer `sceNotificationSend` sample. PS5Library user-facing events use only the richer notification service; a failed rich delivery is logged and left unacknowledged for retry rather than shown through the debug channel.

The richer `notify/main.c` sample uses `sceNotificationSend(0xFE, true, json)`. The implementation requests PS5Library's installed icon, but source evidence alone does not verify that ShellUI presents it on firmware 4.50/4.51.

ShadowMountPlus 1.7beta2 source at commit `4102fa7aa54961ad4a77df7919fcc3f17d1c05c4`, `src/sm_log.c`, independently verifies a current rich-toast shape using `sceNotificationSend`, a local PNG `Url` icon and `SceNotification`. Its toast research records that omitting `soundEffect` selects the platform's default sound, while the literal value `none` suppresses sound. PS5Library uses the documented data shape and its own installed `/user/appmeta/PPSA99051/icon0.png`; it does not copy ShadowMountPlus artwork or code.

Transfer start, permanent failure and verified-ready transitions are written to the durable `console_notices` queue in the same database statement as their job event. Repeated progress cannot duplicate them, and a server or agent restart cannot lose an unacknowledged event. The agent acknowledges a notice only after the rich native call succeeds. Ready is queued only after file verification, required registration, inventory report and backend acceptance. The server's source-download completion is not presented as “ready to play.”

## EXPERIMENTAL

The 0.2.36 agent sends **PS5Library Agent connected** only after the installed storefront completes an authenticated Unix-socket request and the agent writes its complete successful response. A successful native notification is emitted once per listener lifecycle; failed ShellUI delivery is retried and listener recreation rearms it. Focused host checks cover successful-response gating, failed-request suppression, retry and deduplication. Visual presentation and sound remain UNKNOWN until observed on PS5 hardware.

Version 0.2.7 adds durable, owner-scoped missing-backport, unavailable-runtime and untested-profile warnings. Web clients show unresolved notices; the PS5 shows the plan's explanation and polls its own pending notifications. The agent calls the native helper only when `nativeNotifications` is enabled. A delivery acknowledgement is now sent only after the native call returns success; it still does not prove that a person saw the notification. Console observation remains UNKNOWN.

The owner-scoped `POST /api/v1/consoles/:id/notifications/test` path queues a one-shot test only when that console has advertised `nativeNotifications`. Another account receives 404, the console's agent credential alone can consume and acknowledge it, and successful delivery resolves the test notice. My PS5s exposes the action only for a capable console. The database queue survives server restarts; firmware 4.50 is the current physical target.

Master account connection now uses that same durable console queue. The first paired-storefront observation of a connected account produces **Welcome to the PS5Library Store** with the linked handle. A failed authorization produces a safe reason for known failures, including expiration, denial, consumed code, failed passkey verification, expired session and an unreachable Master. The event is deduplicated by console and account/error transition, and only that owner's paired agent can consume it.

On PS5 the shared helper sends a logged `ToastTemplateB` notification through `sceNotificationSend`, using the `Downloads` channel and PS5Library's installed icon. It omits `soundEffect` so ShellUI selects its normal informational sound. Failed delivery is logged and is not acknowledged to the server. Native presentation and sound remain pending physical observation.

`nativeNotifications` is an opt-in configuration/capability for transfer events until hardware verification. Pairing currently also calls the SDK helper. Simulator output goes to stderr, not the PS5 shell. Game-specific notification artwork and target-console validation remain unfinished. Check 4.50 first, then other firmware/runtime combinations; record the export, return code and observed notification. Notification failure must not invalidate an otherwise verified file transfer.
