using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
namespace PS5Library.Worker;
public static class Files
{
    public static string SafeRelative(string root, string relative)
    {
        if (Path.IsPathRooted(relative) || relative.Contains('\\')) throw new WorkerError("UNSAFE_PATH");
        foreach (var part in relative.Split('/'))
            if (part.Length == 0 || part is "." or ".." || part.EndsWith('.') || part.EndsWith(' ') || part.IndexOfAny("<>:\"|?*\0".ToCharArray()) >= 0 || part.Any(char.IsControl) || Regex.IsMatch(part, "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)", RegexOptions.IgnoreCase)) throw new WorkerError("UNSAFE_PATH");
        var target = Path.GetFullPath(Path.Combine(root, relative));
        if (!target.StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)) throw new WorkerError("UNSAFE_PATH");
        return target;
    }
    public static IEnumerable<string> Enumerate(string directory)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new WorkerError("UNSAFE_PATH");
        foreach (var entry in Directory.EnumerateFileSystemEntries(directory).Order(StringComparer.Ordinal))
        {
            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new WorkerError("UNSAFE_PATH");
            if ((attributes & FileAttributes.Directory) != 0) { foreach (var file in Enumerate(entry)) yield return file; }
            else yield return entry;
        }
    }
    public static string Hash(string filename) { using var file = File.OpenRead(filename); return Convert.ToHexStringLower(SHA256.HashData(file)); }
    public static string TreeHash(string root)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var file in Enumerate(root)) hash.AppendData(Encoding.UTF8.GetBytes(Path.GetRelativePath(root,file).Replace('\\','/') + "\0" + Hash(file) + "\n"));
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }
    public static void CopyTree(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Enumerate(source))
        {
            var output = SafeRelative(destination,Path.GetRelativePath(source,file).Replace('\\','/'));
            Directory.CreateDirectory(Path.GetDirectoryName(output)!); File.Copy(file,output,false);
        }
    }
}
