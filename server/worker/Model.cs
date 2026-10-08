namespace PS5Library.Worker;
public sealed class WorkerError(string code, string? message = null) : Exception(message ?? code) { public string Code { get; } = code; }
public sealed record Identity(string TitleId, string ContentId, string Version, string Title = "", string? MinimumFirmware = null, string? BaseContentVersion = null);
public sealed record InstalledImage(long Size, string Sha256);
public sealed record Inspection(string Format, bool StructurallyRecognized, bool MetadataVerified, Identity? Identity, bool LaunchTested = false, string? Note = null, string Kind = "BASE", ArchiveInfo? Archive = null, InstalledImage? InstalledImage = null);
public sealed record ArchiveInfo(string GameRoot, long ExpandedSize, int PartCount);
public sealed record BackportCopy(string OutputPath, string Sha256, long Size);
public sealed record BackportPreparation(string InputHash,string ProfileId,string ProfileHash,BackportCopy ShadowMountBackport);
public sealed record BuildResult(string OutputPath, string Format, string Sha256, long Size, string InputHash, string BuilderVersion, string? ReleaseId, string? ProfileId, DateTimeOffset CreatedAt, Inspection Inspection, BackportCopy? ShadowMountBackport = null, string LibraryPolicy = "CLEAN_PACKAGE_EXTERNAL_BACKPORT_AND_SEPARATE_DLC", string? ProfileHash = null);
public sealed record BackportLibrary(string Path,string Sha256);
public sealed record BackportFile(string Path,string Sha256);
public sealed record BpsPatch(string Data,string Sha256);
public sealed record ElfSdk(uint Ps5,uint Ps4);
public sealed record BackportPatch(string Path,string InputSha256,string OutputSha256,BpsPatch? Bps=null,ElfSdk? Sdk=null,string? OutputFormat=null);
public sealed record BackportProfile(string Id,string TitleId,string ContentId,string GameVersion,string[] InputHashes,string TargetFirmware,string Runtime,string InstallationMethod,string TestedState,BackportLibrary[] RequiredLibraries,BackportPatch[] RequiredPatches,string Delivery="OVERLAY",BackportFile[]? RequiredFiles=null);
public interface IPackageBuilder { string Version { get; } string Format { get; } string Build(string staging, string output, Identity identity,Action<long,long>? progress=null); }
