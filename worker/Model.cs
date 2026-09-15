namespace PS5Library.Worker;
public sealed class WorkerError(string code, string? message = null) : Exception(message ?? code) { public string Code { get; } = code; }
public sealed record Identity(string TitleId, string ContentId, string Version, string Title = "");
public sealed record Inspection(string Format, bool StructurallyRecognized, bool MetadataVerified, Identity? Identity, bool LaunchTested = false, string? Note = null);
public sealed record BuildResult(string OutputPath, string Format, string Sha256, long Size, string InputHash, string BuilderVersion, string? ReleaseId, string? ProfileId, DateTimeOffset CreatedAt, Inspection Inspection);
public interface IPackageBuilder { string Version { get; } string Format { get; } string Build(string staging, string output, Identity identity); }
