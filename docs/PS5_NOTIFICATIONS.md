# PS5 notifications

## VERIFIED

[SDK v0.43 source](https://github.com/ps5-payload-dev/sdk/tree/3b6ea8044e153b0f98f3a6fbc7a19785cd3e62d1/samples) includes `notify_debug/main.c`: zero-initialized request storage with a 45-byte reserved prefix, 3075-byte message area, passed to `sceKernelSendNotificationRequest(0, &request, sizeof(request), 0)`. Our native `notify` helper follows that example and bounds the formatted string.

The richer `notify/main.c` sample uses `sceNotificationSend(0xFE, true, json)`. The existence of that example does not verify custom game-icon delivery across every firmware, so the current app does not claim that feature.

Pairing, transfer-start, permanent-transfer-failure and verified-ready events have real agent call sites. Ready is notified only after file verification, required registration, inventory report and backend acceptance. The server's source-download completion is not presented as “ready to play.” The native host test confirms the checksum-failure state reaches the server; it does not verify a PS5 notification appears.

## EXPERIMENTAL

`nativeNotifications` is an opt-in configuration/capability for transfer events until hardware verification. Pairing currently also calls the SDK helper. Simulator output goes to stderr, not the PS5 shell. Game-specific notification artwork and target-console validation remain unfinished. Check 4.51 first, then other firmware/runtime combinations; record the export, return code and observed notification. Notification failure must not invalidate an otherwise verified file transfer.
