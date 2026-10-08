using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
namespace PS5Library.Worker;
public static class Files
{
    static readonly HashSet<string> BaseExcluded=new(StringComparer.OrdinalIgnoreCase){"fakelib","fakelib2","backport","backports","decrypted","dlc","dlcs","sce_suppl","sce_sc","playgo-languages"};
    public static bool ExcludedFromBase(string directory)=>BaseExcluded.Contains(Path.GetFileName(directory));
    public static string SafeRelative(string root, string relative)
    {
        if (Path.IsPathRooted(relative) || relative.Contains('\\')) throw new WorkerError("UNSAFE_PATH");
        foreach (var part in relative.Split('/'))
            if (part.Length == 0 || part is "." or ".." || part.EndsWith('.') || part.EndsWith(' ') || part.IndexOfAny("<>:\"|?*\0".ToCharArray()) >= 0 || part.Any(char.IsControl) || Regex.IsMatch(part, "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)", RegexOptions.IgnoreCase)) throw new WorkerError("UNSAFE_PATH");
        var target = Path.GetFullPath(Path.Combine(root, relative));
        if (!target.StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)) throw new WorkerError("UNSAFE_PATH");
        return target;
    }
    public static IEnumerable<string> Enumerate(string directory)=>Enumerate(directory,false);
    public static IEnumerable<string> EnumerateBase(string directory)=>Enumerate(directory,true);
    static IEnumerable<string> Enumerate(string directory,bool excludeTopLevel)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new WorkerError("UNSAFE_PATH");
        foreach (var entry in Directory.EnumerateFileSystemEntries(directory).Order(StringComparer.Ordinal))
        {
            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new WorkerError("UNSAFE_PATH");
            if ((attributes & FileAttributes.Directory) != 0) { if(excludeTopLevel&&ExcludedFromBase(entry))continue;foreach (var file in Enumerate(entry,false)) yield return file; }
            else yield return entry;
        }
    }
    public static string Hash(string filename,Action<long,long>? progress=null)
    {
        using var file=new FileStream(filename,FileMode.Open,FileAccess.Read,FileShare.Read,1024*1024,FileOptions.SequentialScan);
        if(progress is null)return Convert.ToHexStringLower(SHA256.HashData(file));
        using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);var buffer=new byte[1024*1024];long completed=0,total=file.Length;progress(0,total);int read;
        while((read=file.Read(buffer))>0){hash.AppendData(buffer,0,read);completed=checked(completed+read);if(completed>total)throw new WorkerError("SOURCE_CHANGED");progress(completed,total);}
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }
    public static (string Sha256,string PrefixSha256) HashWithPrefix(string filename,long prefixLength,Action<long,long>? progress=null)
    {
        using var file=new FileStream(filename,FileMode.Open,FileAccess.Read,FileShare.Read,1024*1024,FileOptions.SequentialScan);
        if(prefixLength<0||prefixLength>file.Length)throw new WorkerError("CORRUPT_INPUT","Invalid installed-image range.");
        using var full=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);using var prefix=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);var buffer=new byte[1024*1024];long remaining=prefixLength,completed=0,total=file.Length;progress?.Invoke(0,total);int read;
        while((read=file.Read(buffer))>0){full.AppendData(buffer,0,read);var count=(int)Math.Min(read,remaining);if(count>0){prefix.AppendData(buffer,0,count);remaining-=count;}completed=checked(completed+read);if(completed>total)throw new WorkerError("SOURCE_CHANGED");progress?.Invoke(completed,total);}
        return (Convert.ToHexStringLower(full.GetHashAndReset()),Convert.ToHexStringLower(prefix.GetHashAndReset()));
    }
    public static string TreeHash(string root,Action<long,long>? progress=null)=>TreeHash(root,Enumerate(root),progress);
    public static string BaseTreeHash(string root,Action<long,long>? progress=null)=>TreeHash(root,EnumerateBase(root),progress);
    public static (string BaseSha256,long BaseSize,string TreeSha256,long TreeSize) HashTrees(string root,Action<long,long>? progress=null)
    {
        var files=Enumerate(root).Select(file=>{var relative=Path.GetRelativePath(root,file).Replace('\\','/');var slash=relative.IndexOf('/');return (Path:file,Relative:relative,Size:new FileInfo(file).Length,Base:slash<0||!BaseExcluded.Contains(relative[..slash]));}).ToArray();
        var total=files.Sum(file=>file.Size);long completed=0,baseSize=0;progress?.Invoke(0,total);
        using var tree=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);using var baseTree=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach(var file in files){var digest=Hash(file.Path,(current,_)=>progress?.Invoke(checked(completed+current),total));completed=checked(completed+file.Size);var entry=Encoding.UTF8.GetBytes(file.Relative+"\0"+digest+"\n");tree.AppendData(entry);if(file.Base){baseTree.AppendData(entry);baseSize=checked(baseSize+file.Size);}}
        return (Convert.ToHexStringLower(baseTree.GetHashAndReset()),baseSize,Convert.ToHexStringLower(tree.GetHashAndReset()),total);
    }
    static string TreeHash(string root,IEnumerable<string> source,Action<long,long>? progress)
    {
        var files=source.Select(file=>(Path:file,Size:new FileInfo(file).Length)).ToArray();var total=files.Sum(file=>file.Size);long completed=0;progress?.Invoke(0,total);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var file in files) {var digest=Hash(file.Path,(current,_)=>progress?.Invoke(checked(completed+current),total));completed=checked(completed+file.Size);hash.AppendData(Encoding.UTF8.GetBytes(Path.GetRelativePath(root,file.Path).Replace('\\','/') + "\0" + digest + "\n"));}
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }
    public static string TreeStamp(string root)=>TreeStamp(root,Enumerate(root));
    public static string BaseTreeStamp(string root)=>TreeStamp(root,EnumerateBase(root));
    static string TreeStamp(string root,IEnumerable<string> files)
    {
        using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach(var file in files){var info=new FileInfo(file);hash.AppendData(Encoding.UTF8.GetBytes($"{Path.GetRelativePath(root,file).Replace('\\','/')}\0{info.Length}\0{info.LastWriteTimeUtc.Ticks}\0{info.CreationTimeUtc.Ticks}\n"));}
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }
    public static (long Bytes,string Sha256) CopyTree(string source, string destination,Action<long>? progress=null)
    {
        Directory.CreateDirectory(destination);var buffer=new byte[1024*1024];long copied=0;using var treeHash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var file in Enumerate(source))
        {
            var relative=Path.GetRelativePath(source,file).Replace('\\','/');var output=SafeRelative(destination,relative);var mode=default(UnixFileMode);if(!OperatingSystem.IsWindows())mode=File.GetUnixFileMode(file);
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            using var fileHash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using(var input=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read,buffer.Length,FileOptions.SequentialScan))
            using(var target=new FileStream(output,FileMode.CreateNew,FileAccess.Write,FileShare.None,buffer.Length,FileOptions.SequentialScan))
            {int read;while((read=input.Read(buffer))>0){target.Write(buffer,0,read);fileHash.AppendData(buffer,0,read);copied=checked(copied+read);progress?.Invoke(copied);}}
            if(!OperatingSystem.IsWindows())File.SetUnixFileMode(output,mode);
            treeHash.AppendData(Encoding.UTF8.GetBytes(relative+"\0"+Convert.ToHexStringLower(fileHash.GetHashAndReset())+"\n"));
        }
        return (copied,Convert.ToHexStringLower(treeHash.GetHashAndReset()));
    }
}
