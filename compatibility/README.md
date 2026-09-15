# Runtime validation matrix

PS5Library targets all jailbreakable firmware through runtime capability negotiation. A firmware number alone does not enable a feature. Individual transports/builders/registration methods can be unavailable while catalog browsing remains independent.

| Target | Native storefront | Home entry | Notifications | ShadowMount transfer/registration | FPKG install | In-shell Downloads / ShellUI hooks |
| --- | --- | --- | --- | --- | --- | --- |
| User's 4.51 console; user unsure of runtime/launcher | UNTESTED; first hardware target | EXPERIMENTAL source-backed websrv bridge | EXPERIMENTAL SDK call | EXPERIMENTAL; exact runtime/config required | DISABLED until status/completion adapter verified | DISABLED / UNKNOWN |
| Other jailbreakable firmware/runtime combinations | UNTESTED per combination | Probe exact-title API; 12+ path currently disabled | Verify available export/behavior | Use negotiated capabilities and current upstream requirements | Capability false until verified | No blanket support claim |
| Linux host simulator | BUILD/RENDER/CONTROLLER CHECKS PASS | File rollback checks only | stderr only | File transfer/inventory only; no PS5 registration | Not available | Not available |

Do not mark a profile TESTED without title/content ID, exact version, input hashes, firmware, runtime version, builder configuration and a recorded launch result. `shared/schemas/index.ts` is the profile contract. Profiles/backport binaries belong to the owner's private repository/database; no copyrighted compatibility libraries are included here.

First console test order: boot the ELF → input/video/network → pair/relaunch with stored credential → source/transfer verification → home-entry install/launch/exit/uninstall → mounted game registration and launch → interrupted download/reboot/removable-drive recovery → optional notification/agent persistence. Deeper ShellUI experiments require the recovery mechanism in `docs/PS5_SYSTEM_INTEGRATION.md`.
