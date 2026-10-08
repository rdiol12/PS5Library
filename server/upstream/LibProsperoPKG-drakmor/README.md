# LibProsperoPkg

A .NET class library for building **PS5** packages. It turns a prepared
application folder into a complete, signed PS5 package in-process, with no external
command-line tool to install.

The library is written in **C# 13** and targets **.NET 9**. It is self-contained and
exposes a small, documented public API so any .NET developer can consume it from their own
application.

---

## Highlights

- **In-process pipeline.** Folder -> inner PFS layout -> AES-XTS encryption -> outer PFS ->
  `\x7FCNT` metadata container -> finalized `\x7FFIH` debug image, end to end.
- **Self-contained.** The GP5 project model, the PFS image builder, AES-XTS encryption,
  RSA-3072 metadata signing and the finalized debug image are produced by the library itself.
- **Reader and writer.** Parse, inspect, and file-back extract existing PS5 packages
  (`\x7FCNT` / `\x7FFIH`) without loading complete multi-gigabyte outer/inner images, and build
  new ones.
- **Texture generation.** The `sce_sys` icon/picture DDS (BC7) re-encoder uses the Publishing
  Tools `p2d --high --st` profile when available for byte-exact output, with a portable
  deterministic BCnEncoder.NET fallback.
- **Reproducible builds.** `ProsperoBuildOptions.DeterministicBuild` makes repeated PSAL and
  APP/PPR-NAPS builds byte-identical, including outer-PFS seeds and RSA-wrapped metadata.

---

## Requirements

| | |
|---|---|
| Toolchain | .NET 9 SDK or newer |
| Language | C# 13 |
| Dependencies | `Magick.NET-Q8-AnyCPU`, `BCnEncoder.Net` |
| Optional exact DDS backend | Publishing Tools `ext/p2d.exe`, or `LIBPROSPERO_P2D_PATH` |

---

## Building

```bash
cd LibProsperoPKG/src/LibProsperoPkg
dotnet build -c Release
```

This produces `LibProsperoPkg.dll`.

### Building standalone PFS images

The bundled tool can select the filesystem layout independently from per-file compression:

```powershell
# Publisher direct-root PPR-PFS with PFSC v2 Kraken files (reference-style default)
.\scripts\build-kraken-pfs.ps1 C:\app C:\out\app.pfs -Compression kraken -Level 8

# Classic LibProsperoPKG super-root/FPT structure with classic PFSC/zlib files
.\scripts\build-kraken-pfs.ps1 C:\app C:\out\app-classic.pfs -Classic -Compression zlib -Level 9

# Classic structure with PPR-PFS Kraken files (must be read through ppr_pfs)
.\scripts\build-kraken-pfs.ps1 C:\app C:\out\app-classic-kraken.pfs -Classic -Compression kraken -Level 8

# ShadowMount PHUC: publisher direct-root outer PFS plus one Kraken-compressed pfs_image.dat
.\scripts\build-phuc.ps1 C:\app C:\out\app.phuc

# The same outer PHUC, using an already built inner PFS without rebuilding the game folder
.\scripts\build-phuc.ps1 C:\images\pfs_image.dat C:\out\app.phuc

# Smallest image (the former all-Kraken policy), or lowest decode latency
.\scripts\build-phuc.ps1 C:\app C:\out\compact.phuc -ReadProfile compact
.\scripts\build-phuc.ps1 C:\app C:\out\raw.phuc -ReadProfile raw
```

Compression can be `none`, `zlib`, or `kraken`. Kraken levels are `-4..9`; zlib levels are
`0..9`. `-Exclude 'sce_sys/**','movies/*.mp4'` keeps matching files in the image but stores
them raw. Direct-root `ppr + zlib` is rejected because the runtime PFSv2/v3 container uses
Kraken and is distinct from classic PFSC/zlib; use the classic layout for zlib.

The dedicated PHUC command accepts either a prepared game folder or an existing `pfs_image.dat`.
For an existing image it validates PFS v2, block geometry, encryption state, and the inner
`sce_sys/param.json`/`param.sfo`, then reuses it without rebuilding the game tree. It emits the
reference direct-root geometry (inode bitmap in block 1, inode table in block 2, no super-root/FPT),
places only the PFSC v2/Kraken `pfs_image.dat` in the direct-root outer PFS, and validates the finished image.
Large files receive the same single- and double-indirect 32-bit block maps as publisher images;
these maps are emitted after the contiguous data extent and checked entry by entry.
The publisher artifact command and the normal publisher `build-pkg` path write the NAPS/outer
layers through bounded-memory streams. `selftest-large-outer` exercises the first `ib[1]`
double-indirect leaf with a 120,127,488-byte file.
The specialized publisher inner assembler also writes its final physical `pfs_image.dat` directly
to a temporary file; NAPS CMAC/`obdg`, outer PFS, and SI metadata read that file through
`ProsperoPs5InnerImageResult.OpenImage`.
PFSC keeps 128 KiB table entries, but full Kraken groups are encoded as one 256 KiB seeded/seedless
pair (`C000 -> 4000 -> C000`), matching the requests issued by `ppr_pfs` to the I/O controller.
The default `fast` read profile physically groups startup and small files in the inner image, leaves
its metadata, `eboot.bin`, `sce_module/**`, `sce_sys/**`, and files up to 1 MiB in raw 256 KiB PFSC
groups, and Kraken-compresses a remaining group only when it saves at least 12%. Use `compact` for
the previous all-eligible-Kraken policy or `raw` to retain the PFSC v2 wrapper while storing every
group without Kraken decoding. `-RawSmall`, `-RawInner`, `-RawMetadata`, and
`-MinimumSavingsPercent` override the profile. A ready `pfs_image.dat` can be analyzed for raw ranges,
but its existing physical file order cannot be changed without rebuilding it from a folder.

---

## Quick start

Add a reference to the project (or the built `LibProsperoPkg.dll`) and build a
package from a prepared application folder:

```csharp
using LibProsperoPkg;

var options = new ProsperoBuildOptions
{
    Mode         = ProsperoPackageMode.Application,
    OutputFormat = ProsperoOutputFormat.DebugImage,   // installable on a debug-mode console
    SourceFolder = @"/path/to/prepared/app",          // must contain sce_sys/
    OutputFolder = @"/path/to/output",
    ContentId    = "UP9000-PPSA00000_00-PROSPERO00000000",
    TitleId      = "PPSA00000",
    Title        = "My PS5 Application",
    Version      = "01.00",
    // Optional reproducible debug/regression build:
    // DeterministicBuild = true,
    // Default: publisher data-first outer PFS + NAPS + direct-offset PPR-PFS.
    UsePublisherPprNaps = true,
    // Optional only for a profile that explicitly enables keyed NAPS outer-block CMAC.
    // Publishing Tools 2.79 debug/AC leaves these tags zero by default:
    // NapsOuterBlockCmacKey = Convert.FromHexString("00112233445566778899AABBCCDDEEFF"),
    // Optional fixed publisher seed. pfs-image-key is derived locally from
    // PrimaryId (or ContentId), Passcode and this seed:
    // NapsPfsImageSeed = File.ReadAllBytes("pfs_image_seed.bin"), // exactly 16 bytes
    // Optional sc2 known-answer vector; a mismatch aborts the build:
    // NapsPfsImageKey  = File.ReadAllBytes("pfs_image_key.bin"),  // exactly 32 bytes
    // Optional protected CNT entries produced by the publisher/sc2 profile:
    // PublisherEntryKeys = File.ReadAllBytes("pkg_entry_keys.bin"), // exactly 0xB80 bytes
    // PublisherImageKey = File.ReadAllBytes("pkg_image_key.bin"), // exactly 0x800 bytes
};

ProsperoBuildResult result = ProsperoPackageBuilder.Build(options, Console.WriteLine);

Console.WriteLine($"Package written to: {result.OutputPath}");
foreach (var warning in result.Warnings)
    Console.WriteLine($"Warning: {warning}");
```

### Publisher image creation modes

The publisher pipeline exposes the layers independently:

| Command/profile | NAPS outer-block tags | Outer PFS | Final package |
|---|---|---|---|
| `build-pkg ... <passcode> -` | zero | AES-XTS encrypted | debug FIH/PKG |
| `build-pkg ... <passcode> <32-hex-key>` | keyed AES-CMAC | AES-XTS encrypted | profile-specific debug FIH/PKG |
| `build-publisher-artifacts ... - encrypted` | zero | AES-XTS encrypted | no |
| `build-publisher-artifacts ... - plaintext` | zero | plaintext | no; analysis/custom runtime only |
| `build ... --layout ppr --compression none` | not applicable | not built | inner PPR-PFS only |

For the verified Publishing Tools 2.79 debug APP/AC profile, zero
`OuterBlockDigest` entries are normal and do **not** mean that outer-PFS encryption is disabled.
The high-level package builder can automatically load `naps_cmac_key.bin` from the executable
directory, so remove that sidecar when a guaranteed zero-tag build is required.

Create a fully plaintext standalone publisher artifact set:

```powershell
dotnet run --project .\src\PprPfsKrakenTool\PprPfsKrakenTool.csproj -c Release -- `
  build-publisher-artifacts C:\project\app C:\project\out `
  UP9000-PPSA00000_00-PROSPERO00000000 `
  00000000000000000000000000000000 - plaintext
```

This writes `inner.ppr-pfs`, `logical.ppr-pfs`, `pfs_image.dat`,
`naps_pkg_layout.dat`, and plaintext `outer.pfs`. Kraken remains compression rather than
encryption; SHA3 inode/block hashes and the superblock ICV are still generated. The normal
`build-pkg` path deliberately has no plaintext-outer option because the standard FIH profile
expects an encrypted outer PFS.

### Inspecting an existing package

```csharp
using LibProsperoPkg.PKG;

ProsperoPkg pkg = ProsperoPkgReader.Read(@"/path/to/some.pkg");
Console.WriteLine($"Type:       {pkg.Type}");
Console.WriteLine($"Content ID: {pkg.Header.ContentId}");
Console.WriteLine($"Entries:    {pkg.Entries.Count}");
```

### Finalizing Flexible Content without publisher executables

The complete FGC transformation lives in the class library; the command-line tool is only a
thin wrapper:

```csharp
using LibProsperoPkg.PKG;

ProsperoFlexibleContentFinalizationResult result =
    ProsperoFlexibleContentFinalizer.Finalize(
        new ProsperoFlexibleContentFinalizationOptions
        {
            FixedInfoHeaderPath = "fih.dat",
            PfsMetadataPath = "pfsmeta.dat",
            SubcontainerPath = "cnt.dat",
            ManifestPath = "manifest.json",
            TokenPath = "fgc-token.json",
            PartnerPrivateKeyPath = "partner-private-key.pem",
            Passcode = "0123456789abcdefghijklmnopqrstuv",
        });
```

No `fa.exe` or `sc2.exe` process is started. The publisher-issued token and its matching partner
private key are protocol inputs, not executable dependencies.

---

## Public surface, at a glance

| Namespace | Key types |
|---|---|
| `LibProsperoPkg` | `ProsperoPackageBuilder`, `ProsperoBuildOptions`, `ProsperoBuildResult`, `ProsperoPackageMode`, `ProsperoOutputFormat`, `InnerImageForm` |
| `LibProsperoPkg.PKG` | `ProsperoPkgBuilder`, `ProsperoPkgReader`, `ProsperoPkgWriter`, `ProsperoFihBuilder`, `ProsperoFlexibleContentFinalizer`, `ProsperoPkgSigner`, `ProsperoDdsEncoder`, `ProsperoPkg`, `ProsperoPkgHeader` |
| `LibProsperoPkg.PFS` | `ProsperoPfsLayout`, `ProsperoPfsImage`, `ProsperoPfsc` |
| `LibProsperoPkg.GP5` | `Gp5Creator`, `Gp5Project` and its element model |
| `LibProsperoPkg.Keys` | `ProsperoKeys` |
| `LibProsperoPkg.PlayGo` | `ProsperoPlayGo` |

See **[docs/](docs/)** for the full feature status and the PS5 package technical write-up.

---

## Documentation

- **[docs/README.md](docs/README.md)** - documentation index.
- **[docs/getting-started.md](docs/getting-started.md)** - install, build and first package.
- **[docs/api-overview.md](docs/api-overview.md)** - public API reference by namespace.
- **[docs/implementation-status.md](docs/implementation-status.md)** - what is implemented and
  what is still missing.
- **[docs/ps5-pkg-format.md](docs/ps5-pkg-format.md)** - technical write-up of the PS5 package
  format and the creation process.

---

## Limitations

LibProsperoPkg produces a complete, self-consistent package whose CNT/FIH digests, outer PFS,
NAPS mapping, inner PPR-PFS, and debug install metadata round-trip through the reader. The built-in
public RSA-3072 profile is sufficient for the verified Publishing Tools 2.79 debug FIH/CNT path:
fresh APP and AC packages pass its format and integrity checks. Backend-issued licenses remain
external inputs when the selected APP/AC/AL profile requires them; trusted finalization material is
still required for standard Retail output.
The `obcc` transform itself is implemented exactly as the recovered HMAC-SHA256 +
AES-128-XTS-encrypt + CRC32C pipeline. The builder derives the `sc2 estimate`
`pfs-image-key` locally as
`HMAC-SHA256(EKPFS(PrimaryId, Passcode), NapsPfsImageSeed)`. `PrimaryId` defaults to
`ContentId`; callers should set it explicitly for base/update profiles where they differ.
`NapsPfsImageSeed` may be supplied directly or through `pfs_image_seed.bin`; otherwise it
uses the effective outer seed. `NapsPfsImageKey`/`pfs_image_key.bin` is now an optional
known-answer vector rather than a required secret input. The image seed is also written to
the outer-PFS superblock at `+0x370`; a separately supplied `OuterPfsSeed` must match it.
The protected CNT `ENTRY_KEYS` and `IMAGE_KEY` records are generated locally. The latter is
`RSA3072(mount modulus, pfs-image-key)[0x180] ||
SHAKE128(SHA3-256(pfs-image-key), 0x680)`, matching captured `sc2` 2.79 output byte-for-byte.
`PublisherImageKey`/`pkg_image_key.bin` and
`PublisherEntryKeys`/`pkg_entry_keys.bin` remain optional verbatim overrides.
`naps_meta_18.dat` is likewise loaded automatically when placed next to the executable.
Backend-issued AC/AL `license.dat` and `license.info` can either remain beside the GP5 or be
returned by `ProsperoBuildOptions.LicenseProvider`. The built-in
`ProsperoDirectoryLicenseProvider` loads an arbitrary sidecar directory; custom providers can
bridge an authorized publishing service or console. The records are validated and encrypted into
CNT entries by the library; the provider does not ask the writer to fabricate a retail RIF.
For an exact rebuild of the same protected publisher context, run
`export-publisher-inputs <reference.pkg> <sidecar-dir>` to preserve `ENTRY_KEYS`,
`IMAGE_KEY`, and `naps_meta_18` without
manually locating the embedded CNT or SI ZIP. This does not recover the separate
`sc2 estimate` PFS-image key from the package alone because its passcode is not stored, but
the builder computes it and a fresh matching `IMAGE_KEY` when primary id, passcode and seed
are known. A preserved raw sidecar still belongs only to its original protected context.
The verified Publishing Tools 2.79 debug/AC profile disables keyed NAPS outer-block CMAC and
stores zero tags; `NapsOuterBlockCmacKey` remains available for other explicitly keyed profiles.
Standard Retail assembly is exposed through `ProsperoOutputFormat.RetailImage` and
`IProsperoRetailFinalizationProvider`; incomplete signed-byte-only output is refused. The provider
supplies the trusted 0x300-byte FIH and 0x180-byte CNT authentication results. The two verified
Retail APP/AC packages contain no trailing encrypted install-metadata segment. FGC/Flexible Content
uses a different 0xA00 certificate/signature protocol. It is implemented locally by
`ProsperoFlexibleContentFinalizer` and the `finalize-fgc` CLI command without invoking `fa.exe` or
`sc2.exe`; an issued FGC token and its matching partner RSA-3072 private key are still required
inputs. This does not replace the standard-Retail provider. Without a Retail provider, a console
running in **debug mode** is the intended target; acceptance still depends on console mode and
firmware.
For a byte-identical deterministic rebuild, `export-publisher-inputs` also preserves the two
standard-Retail results and their exact FIH/CNT SHA3-256 request bindings.
`ProsperoDirectoryRetailFinalizationProvider` replays them only when both requests match; it rejects
changed package content and does not replace an authorized producer for a fresh Retail package.
See [docs/implementation-status.md](docs/implementation-status.md) for the precise breakdown.

---

## License

LibProsperoPkg is licensed under the GNU General Public License v3.0 or later
(GPL-3.0-or-later). See [LICENSE](LICENSE). Third-party attributions are listed in [NOTICE](NOTICE).
