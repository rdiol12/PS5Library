# Development environment

Verified locally on 2026-09-15:

| Component | Finding |
| --- | --- |
| OS | Windows 11 Home, 10.0.26200, x86-64 |
| CPU | AMD Ryzen 9 9955HX, 16 cores / 32 logical processors |
| Node / npm | 22.18.0 / 11.6.4; pnpm absent |
| Git | 2.51.2.windows.1 |
| Docker / Compose | 29.1.3 / 5.0.1; engine initially stopped, started successfully |
| PostgreSQL / Redis | No native PATH executables or detected native services; isolated Compose services selected |
| .NET SDK | 10.0.112, 10.0.300, 10.0.303 |
| CMake | 4.3.4 |
| C/C++ | No compiler on Windows PATH; Visual Studio Community installed on a secondary drive; WSL GCC 15.2.0 available |
| Python | 3.13.5 (Anaconda) |
| PowerShell | Windows PowerShell 5.1.26100.9444; pwsh absent |
| WSL | WSL2 Ubuntu 26.04 LTS; kernel 6.6.114.1 |
| macOS / Xcode | Not present in inspected environment; no remote Mac supplied |
| PS5 SDK | No installed SDK found in PATH or inspected /opt locations; open-source ps5-payload-dev SDK cloned for research |
| Disk | Approximately 421 GB free on the system drive at inspection |

Windows owns the Node/.NET workflow. Docker owns PostgreSQL and Redis. WSL or a Linux build container owns PS5 cross compilation. Apple compilation stays a separate, documented gate.
