using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace PS5Library.Worker;

public static class Files
{
    static readonly HashSet<string> BaseExcluded = new(StringComparer.OrdinalIgnoreCase)
    {
        "fakelib",
        "fakelib2",
        "backport",
        "backports",
        "decrypted",
        "dlc",
        "dlcs",
        "sce_suppl",
        "sce_sc",
        "playgo-languages",
    };

    public static bool ExcludedFromBase(string directory) =>
        BaseExcluded.Contains(Path.GetFileName(directory));

    public static string SafeRelative(string root, string relative)
    {
        if (Path.IsPathRooted(relative) || relative.Contains('\\'))
            throw new WorkerError("UNSAFE_PATH");
        foreach (var part in relative.Split('/'))
            if (
                part.Length == 0
                || part is "." or ".."
                || part.EndsWith('.')
                || part.EndsWith(' ')
                || part.IndexOfAny("<>:\"|?*\0".ToCharArray()) >= 0
                || part.Any(char.IsControl)
                || Regex.IsMatch(
                    part,
                    "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)",
                    RegexOptions.IgnoreCase
                )
            )
                throw new WorkerError("UNSAFE_PATH");
        var target = Path.GetFullPath(Path.Combine(root, relative));
        if (
            !target.StartsWith(
                Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)
                    + Path.DirectorySeparatorChar,
                OperatingSystem.IsWindows()
                    ? StringComparison.OrdinalIgnoreCase
                    : StringComparison.Ordinal
            )
        )
            throw new WorkerError("UNSAFE_PATH");
        return target;
    }

    public static IEnumerable<string> Enumerate(string directory) =>
        EnumerateFiles(directory, false).Select(file => file.FullName);

    public static IEnumerable<string> EnumerateBase(string directory) =>
        EnumerateFiles(directory, true).Select(file => file.FullName);

    static IEnumerable<FileInfo> EnumerateFiles(string directory, bool excludeTopLevel) =>
        EnumerateFiles(new DirectoryInfo(directory), excludeTopLevel);

    static IEnumerable<FileInfo> EnumerateFiles(DirectoryInfo directory, bool excludeTopLevel)
    {
        if ((directory.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new WorkerError("UNSAFE_PATH");
        foreach (
            var entry in directory
                .EnumerateFileSystemInfos()
                .OrderBy(entry => entry.FullName, StringComparer.Ordinal)
        )
        {
            var attributes = entry.Attributes;
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new WorkerError("UNSAFE_PATH");
            if ((attributes & FileAttributes.Directory) != 0)
            {
                if (excludeTopLevel && ExcludedFromBase(entry.FullName))
                    continue;
                foreach (var file in EnumerateFiles(new DirectoryInfo(entry.FullName), false))
                    yield return file;
            }
            else
                yield return (FileInfo)entry;
        }
    }

    public static string Hash(string filename, Action<long, long>? progress = null)
    {
        using var file = new FileStream(
            filename,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            1024 * 1024,
            FileOptions.SequentialScan
        );
        if (progress is null)
            return Convert.ToHexStringLower(SHA256.HashData(file));
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[1024 * 1024];
        long completed = 0,
            total = file.Length;
        progress(0, total);
        int read;
        while ((read = file.Read(buffer)) > 0)
        {
            hash.AppendData(buffer, 0, read);
            completed = checked(completed + read);
            if (completed > total)
                throw new WorkerError("SOURCE_CHANGED");
            progress(completed, total);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static (string Sha256, string PrefixSha256) HashWithPrefix(
        string filename,
        long prefixLength,
        Action<long, long>? progress = null
    )
    {
        using var file = new FileStream(
            filename,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            1024 * 1024,
            FileOptions.SequentialScan
        );
        if (prefixLength < 0 || prefixLength > file.Length)
            throw new WorkerError("CORRUPT_INPUT", "Invalid installed-image range.");
        using var full = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using var prefix = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[1024 * 1024];
        long remaining = prefixLength,
            completed = 0,
            total = file.Length;
        progress?.Invoke(0, total);
        int read;
        while ((read = file.Read(buffer)) > 0)
        {
            full.AppendData(buffer, 0, read);
            var count = (int)Math.Min(read, remaining);
            if (count > 0)
            {
                prefix.AppendData(buffer, 0, count);
                remaining -= count;
            }
            completed = checked(completed + read);
            if (completed > total)
                throw new WorkerError("SOURCE_CHANGED");
            progress?.Invoke(completed, total);
        }
        return (
            Convert.ToHexStringLower(full.GetHashAndReset()),
            Convert.ToHexStringLower(prefix.GetHashAndReset())
        );
    }

    public static string TreeHash(string root, Action<long, long>? progress = null) =>
        TreeHash(root, EnumerateFiles(root, false), progress);

    public static string BaseTreeHash(string root, Action<long, long>? progress = null) =>
        TreeHash(root, EnumerateFiles(root, true), progress);

    public static (string BaseSha256, long BaseSize, string TreeSha256, long TreeSize) HashTrees(
        string root,
        Action<long, long>? progress = null
    )
    {
        var files = EnumerateFiles(root, false)
            .Select(file =>
            {
                var relative = Path.GetRelativePath(root, file.FullName).Replace('\\', '/');
                var slash = relative.IndexOf('/');
                return (
                    File: file,
                    Relative: relative,
                    Base: slash < 0 || !BaseExcluded.Contains(relative[..slash])
                );
            })
            .ToArray();
        var total = files.Sum(file => file.File.Length);
        var digests = HashFiles(files.Select(file => file.File).ToArray(), total, progress);
        long baseSize = 0;
        using var tree = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using var baseTree = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        for (var i = 0; i < files.Length; i++)
        {
            var file = files[i];
            var entry = Encoding.UTF8.GetBytes(file.Relative + "\0" + digests[i] + "\n");
            tree.AppendData(entry);
            if (file.Base)
            {
                baseTree.AppendData(entry);
                baseSize = checked(baseSize + file.File.Length);
            }
        }
        return (
            Convert.ToHexStringLower(baseTree.GetHashAndReset()),
            baseSize,
            Convert.ToHexStringLower(tree.GetHashAndReset()),
            total
        );
    }

    static string TreeHash(string root, IEnumerable<FileInfo> source, Action<long, long>? progress)
    {
        var files = source.ToArray();
        var total = files.Sum(file => file.Length);
        var digests = HashFiles(files, total, progress);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        for (var i = 0; i < files.Length; i++)
            hash.AppendData(
                Encoding.UTF8.GetBytes(
                    Path.GetRelativePath(root, files[i].FullName).Replace('\\', '/')
                        + "\0"
                        + digests[i]
                        + "\n"
                )
            );
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    static string[] HashFiles(FileInfo[] files, long total, Action<long, long>? progress)
    {
        var digests = new string[files.Length];
        long completed = 0,
            reported = 0;
        var reportLock = new object();
        progress?.Invoke(0, total);
        Parallel
            .ForEachAsync(
                Enumerable.Range(0, files.Length),
                new ParallelOptions
                {
                    MaxDegreeOfParallelism = Math.Min(Environment.ProcessorCount, 4),
                },
                (index, _) =>
                {
                    long previous = 0;
                    digests[index] = Hash(
                        files[index].FullName,
                        progress is null
                            ? null
                            : (current, _) =>
                            {
                                var value = Interlocked.Add(
                                    ref completed,
                                    checked(current - previous)
                                );
                                previous = current;
                                lock (reportLock)
                                {
                                    if (value <= reported)
                                        return;
                                    if (value > total)
                                        throw new WorkerError("SOURCE_CHANGED");
                                    reported = value;
                                    progress(value, total);
                                }
                            }
                    );
                    return ValueTask.CompletedTask;
                }
            )
            .GetAwaiter()
            .GetResult();
        if (progress is not null && completed != total)
            throw new WorkerError("SOURCE_CHANGED");
        return digests;
    }

    public static string TreeStamp(string root) => TreeStamp(root, EnumerateFiles(root, false));

    public static string BaseTreeStamp(string root) => TreeStamp(root, EnumerateFiles(root, true));

    static string TreeStamp(string root, IEnumerable<FileInfo> files)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var file in files)
        {
            hash.AppendData(
                Encoding.UTF8.GetBytes(
                    $"{Path.GetRelativePath(root, file.FullName).Replace('\\', '/')}\0{file.Length}\0{file.LastWriteTimeUtc.Ticks}\0{file.CreationTimeUtc.Ticks}\n"
                )
            );
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static (long Bytes, string Sha256) CopyTree(
        string source,
        string destination,
        Action<long>? progress = null
    )
    {
        Directory.CreateDirectory(destination);
        var buffer = new byte[1024 * 1024];
        long copied = 0;
        using var treeHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var file in Enumerate(source))
        {
            var relative = Path.GetRelativePath(source, file).Replace('\\', '/');
            var output = SafeRelative(destination, relative);
            var mode = default(UnixFileMode);
            if (!OperatingSystem.IsWindows())
                mode = File.GetUnixFileMode(file);
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            using var fileHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using (
                var input = new FileStream(
                    file,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read,
                    buffer.Length,
                    FileOptions.SequentialScan
                )
            )
            using (
                var target = new FileStream(
                    output,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None,
                    buffer.Length,
                    FileOptions.SequentialScan
                )
            )
            {
                int read;
                while ((read = input.Read(buffer)) > 0)
                {
                    target.Write(buffer, 0, read);
                    fileHash.AppendData(buffer, 0, read);
                    copied = checked(copied + read);
                    progress?.Invoke(copied);
                }
            }
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(output, mode);
            treeHash.AppendData(
                Encoding.UTF8.GetBytes(
                    relative + "\0" + Convert.ToHexStringLower(fileHash.GetHashAndReset()) + "\n"
                )
            );
        }
        return (copied, Convert.ToHexStringLower(treeHash.GetHashAndReset()));
    }
}
