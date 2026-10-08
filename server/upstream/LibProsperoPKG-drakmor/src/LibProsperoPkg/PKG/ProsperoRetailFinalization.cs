// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK

using System;

namespace LibProsperoPkg.PKG;

/// <summary>Immutable inputs passed to the standard Retail finalization boundary.</summary>
/// <remarks>
/// <see cref="FihHeader"/> already carries signed byte <c>0x80</c>, all structural fields and
/// image/CNT digests, but its protected <c>0xF000..0xF2FF</c> area is zero. Passing only the
/// 64-KiB FIH keeps the trust boundary independent of package size.
/// </remarks>
public sealed class ProsperoRetailFinalizationRequest
{
    /// <summary>
    /// Exact 0x10000-byte FIH block with a zeroed standard-Retail finalization area.
    /// </summary>
    public required ReadOnlyMemory<byte> FihHeader { get; init; }

    /// <summary>Offset of the protected material inside the FIH block.</summary>
    public int FihFinalizationOffset => ProsperoPkgLayout.FihRetailFinalizationOffset;

    /// <summary>Required size of the protected material.</summary>
    public int FihFinalizationSize => ProsperoPkgLayout.FihRetailFinalizationSize;
}

/// <summary>Outputs returned by a trusted Retail finalizer.</summary>
public sealed class ProsperoRetailFinalizationResult
{
    /// <summary>Exact <c>0x300</c>-byte protected result written at FIH <c>0xF000..0xF2FF</c>.</summary>
    public required byte[] FihFinalizationMaterial { get; init; }

    /// <summary>
    /// Optional bytes appended after the embedded CNT. Standard Retail APP and AC reference
    /// packages have no trailing segment, so the normal value is an empty array.
    /// </summary>
    public byte[] SupplementalData { get; init; } = [];
}

/// <summary>Input to the standard Retail CNT-header authentication step.</summary>
public sealed class ProsperoRetailCntFinalizationRequest
{
    /// <summary>
    /// Exact finalized CNT bytes <c>[0x0000..0x0FFF]</c>, including the package digest at
    /// <c>+0xFE0</c>. The returned authentication material is stored at CNT+0x1000.
    /// </summary>
    public required ReadOnlyMemory<byte> CntHeader { get; init; }
}

/// <summary>
/// Boundary between deterministic managed package construction and the trusted console/tooling
/// operation that finalizes a standard Official FIH.
/// </summary>
/// <remarks>
/// Implementations may call a console service, an authorized publishing backend, or a test double.
/// The separate FGC/Flexible Content protocol is deliberately not represented by this interface:
/// it uses a 0xA00 certificate/signature block and also mutates the PFS superblock and CNT.
/// </remarks>
public interface IProsperoRetailFinalizationProvider
{
    /// <summary>Creates the protected material for a standard Official FIH.</summary>
    ProsperoRetailFinalizationResult FinalizeFih(ProsperoRetailFinalizationRequest request);

    /// <summary>
    /// Creates the exact 0x180-byte standard Retail authentication material for CNT+0x1000.
    /// This is a trusted-profile operation and is not the library's deterministic research wrap.
    /// </summary>
    byte[] FinalizeCntHeader(ProsperoRetailCntFinalizationRequest request);
}
