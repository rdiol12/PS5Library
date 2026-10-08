using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using SharpCompress.Archives;
using SharpCompress.Common;
namespace PS5Library.Worker;

public static class Archives
{
    public static bool IsArchive(string input) => Regex.IsMatch(input,@"\.(rar|zip|7z)(\.001)?$",RegexOptions.IgnoreCase);
    public static string[] Parts(string input)
    {
        input=Path.GetFullPath(input);
        var name=Path.GetFileName(input);var folder=Path.GetDirectoryName(input)!;
        var modern=Regex.Match(name,@"^(.*\.part)(\d+)(\.rar)$",RegexOptions.IgnoreCase);
        var split=Regex.Match(name,@"^(.*\.(?:7z|zip)\.)(\d{3})$",RegexOptions.IgnoreCase);
        string pattern;Func<Match,int> index;
        if(modern.Success) {
            if(int.Parse(modern.Groups[2].Value)!=1)throw new WorkerError("MISSING_ARCHIVE_PART","Select the first archive volume");
            pattern="^"+Regex.Escape(modern.Groups[1].Value)+@"(\d+)\.rar$";index=m=>int.Parse(m.Groups[1].Value)-1;
        } else if(split.Success) {
            if(split.Groups[2].Value!="001")throw new WorkerError("MISSING_ARCHIVE_PART");
            pattern="^"+Regex.Escape(split.Groups[1].Value)+@"(\d{3})$";index=m=>int.Parse(m.Groups[1].Value)-1;
        } else if(name.EndsWith(".rar",StringComparison.OrdinalIgnoreCase)) {
            pattern="^"+Regex.Escape(name[..^4])+@"\.(rar|[r-z][0-9]{2})$";
            index=m=>m.Groups[1].Value.Equals("rar",StringComparison.OrdinalIgnoreCase)?0:1+(char.ToLowerInvariant(m.Groups[1].Value[0])-'r')*100+int.Parse(m.Groups[1].Value[1..]);
        } else return Checked([input]);
        var numbered=Directory.EnumerateFiles(folder).Select(f=>(file:f,match:Regex.Match(Path.GetFileName(f),pattern,RegexOptions.IgnoreCase))).Where(p=>p.match.Success).Select(p=>(p.file,index:index(p.match))).OrderBy(p=>p.index).ToArray();
        if(numbered.Length==0||numbered.Length>10000)throw new WorkerError("INPUT_TOO_LARGE");
        for(int i=0;i<numbered.Length;i++)if(numbered[i].index!=i)throw new WorkerError("MISSING_ARCHIVE_PART","Archive volume sequence has a gap or duplicate");
        return Checked(numbered.Select(p=>p.file).ToArray());
    }
    static string[] Checked(string[] files) {
        foreach(var f in files)if((File.GetAttributes(f)&(FileAttributes.ReparsePoint|FileAttributes.Directory))!=0)throw new WorkerError("UNSAFE_PATH");
        return files;
    }
    public static object Signature(string input) => Parts(input).Select(p=>new {name=Path.GetFileName(p),size=new FileInfo(p).Length,modified=new FileInfo(p).LastWriteTimeUtc.Ticks}).ToArray();
    public static (string Sha256,long Size) Hash(string input,Action<long,long>? progress=null) {
        var parts=Parts(input);var total=parts.Sum(part=>new FileInfo(part).Length);long size=0;
        if(parts.Length==1)return (Files.Hash(parts[0],progress),total);
        progress?.Invoke(0,total);
        using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach(var part in parts) {var before=size;var length=new FileInfo(part).Length;hash.AppendData(Encoding.UTF8.GetBytes(Path.GetFileName(part)+"\0"+Files.Hash(part,(completed,_)=>progress?.Invoke(checked(before+completed),total))+"\n"));size=checked(size+length);}
        return (Convert.ToHexStringLower(hash.GetHashAndReset()),size);
    }
    static T Guard<T>(Func<T> operation) {
        try{return operation();}
        catch(IncompleteArchiveException e){throw new WorkerError("MISSING_ARCHIVE_PART",e.Message);}
        catch(SharpCompress.Common.CryptographicException){throw new WorkerError("ENCRYPTED_INPUT","Password-protected archives need to be decrypted by their owner first");}
        catch(Exception e) when(e is SharpCompressException or InvalidDataException or EndOfStreamException){throw new WorkerError("CORRUPT_INPUT",e.Message);}
    }
    static IArchive Open(string input) {
        var archive=ArchiveFactory.OpenArchive(Parts(input).Select(p=>new FileInfo(p)).ToArray());
        if(archive.Type is not (ArchiveType.Rar or ArchiveType.Zip or ArchiveType.SevenZip)){archive.Dispose();throw new WorkerError("UNSUPPORTED_INPUT");}
        return archive;
    }
    static string Name(IEntry entry) {
        var name=(entry.Key??"").Replace('\\','/').TrimEnd('/');
        _=Files.SafeRelative(Path.GetTempPath(),name);
        var type=(entry.Attrib??0)&0xf000;
        if(entry.LinkTarget is not null || type is not (0 or 0x8000 or 0x4000) || ((entry.Attrib??0)&(int)FileAttributes.ReparsePoint)!=0)throw new WorkerError("UNSAFE_PATH");
        return name;
    }
    static (IArchiveEntry[] Entries,long Size) Validate(IArchive archive,long maximum) {
        var entries=archive.Entries.Take(250001).ToArray();
        if(entries.Length>250000)throw new WorkerError("INPUT_TOO_LARGE");
        if(archive.IsEncrypted||entries.Any(e=>e.IsEncrypted))throw new WorkerError("ENCRYPTED_INPUT");
        if(entries.Any(e=>!e.IsComplete)||!archive.IsComplete)throw new WorkerError("MISSING_ARCHIVE_PART");
        long size=0;var names=new Dictionary<string,bool>(StringComparer.OrdinalIgnoreCase);
        foreach(var e in entries) {
            var name=Name(e);
            if(!names.TryAdd(name,e.IsDirectory))throw new WorkerError("UNSAFE_PATH","Duplicate archive entry");
            if(e.Size<0)throw new WorkerError("CORRUPT_INPUT");
            size=checked(size+e.Size);if(size>maximum)throw new WorkerError("QUOTA_EXCEEDED");
        }
        foreach(var name in names.Keys)for(var i=name.LastIndexOf('/');i>0;i=name.LastIndexOf('/',i-1))if(names.TryGetValue(name[..i],out var directory)&&!directory)throw new WorkerError("UNSAFE_PATH","A file is also used as a directory");
        return (entries,size);
    }
    public static Inspection Inspect(string input) => Guard(()=>{
        using var archive=Open(input);var (entries,size)=Validate(archive,long.MaxValue);
        var roots=entries.Where(e=>!e.IsDirectory&&Name(e).EndsWith("sce_sys/param.json",StringComparison.OrdinalIgnoreCase))
            .Select(e=>(entry:e,root:Name(e)[..^18].TrimEnd('/')))
            .Where(p=>entries.Any(e=>!e.IsDirectory&&Name(e)==(p.root.Length>0?p.root+"/":"")+"eboot.bin")).ToArray();
        if(roots.Length!=1)throw new WorkerError("UNSUPPORTED_INPUT","Archive must contain exactly one prepared game root with sce_sys/param.json and eboot.bin");
        var param=roots[0].entry;if(param.Size>2*1024*1024)throw new WorkerError("CORRUPT_INPUT");
        using var stream=param.OpenEntryStream();var bytes=new byte[checked((int)param.Size)];stream.ReadExactly(bytes);if(stream.ReadByte()!=-1)throw new WorkerError("CORRUPT_INPUT");
        return new Inspection(archive.Type==ArchiveType.Rar?"rar":archive.Type==ArchiveType.SevenZip?"7z":"zip",true,true,InputInspector.ReadIdentity(bytes),Note:"Archive metadata inspected; extraction, file checks and building are still required.",Archive:new(roots[0].root,size,Parts(input).Length));
    });
    public static (string Folder,string Sha256) ExtractVerified(string input,string output,Identity identity,string expectedHash,long maximum,int spaceFactor)
    {
        var archive=InputInspector.Inspect(input,identity).Archive??throw new WorkerError("UNSUPPORTED_INPUT");
        if(archive.ExpandedSize>maximum)throw new WorkerError("QUOTA_EXCEEDED");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
        if(new DriveInfo(Path.GetPathRoot(Path.GetFullPath(output))!).AvailableFreeSpace<checked(archive.ExpandedSize*spaceFactor+64*1024*1024))throw new WorkerError("INSUFFICIENT_SPACE");
        var digest=Hash(input,(completed,total)=>Progress.Operation("Verifying archive volumes",0,completed,total,package:"VERIFYING")).Sha256;if(digest!=expectedHash)throw new WorkerError("SOURCE_CHANGED");
        Extract(input,output,maximum);
        return (archive.GameRoot.Length==0?output:Files.SafeRelative(output,archive.GameRoot),digest);
    }
    public static void Extract(string input,string output,long maximum) => Guard(()=>{
        using var archive=Open(input);var (entries,total)=Validate(archive,maximum);
        if(Directory.Exists(output)||File.Exists(output))throw new WorkerError("OUTPUT_EXISTS");
        Directory.CreateDirectory(output);long copied=0;var last=DateTime.UtcNow;var expected=entries.ToDictionary(Name,StringComparer.OrdinalIgnoreCase);
        using var reader=archive.IsSolid?archive.ExtractAllEntries():null;var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var buffer=new byte[1024*1024];
        IEnumerable<(IEntry Entry,Func<Stream> Open)> ReadEntries() {
            if(reader is null){foreach(var entry in entries)yield return (entry,entry.OpenEntryStream);}
            else while(reader.MoveToNextEntry())yield return (reader.Entry,()=>reader.OpenEntryStream());
        }
        foreach(var item in ReadEntries()) {
            var entry=item.Entry;var name=Name(entry);
            if(!seen.Add(name)||!expected.TryGetValue(name,out var original)||original.Size!=entry.Size)throw new WorkerError("SOURCE_CHANGED");
            var file=Files.SafeRelative(output,name);
            if(entry.IsDirectory){Directory.CreateDirectory(file);continue;}
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            using var source=item.Open();using var dest=new FileStream(file,FileMode.CreateNew,FileAccess.Write);long count=0;int read;
            while((read=source.Read(buffer))>0) {
                count+=read;copied+=read;if(count>original.Size||copied>maximum)throw new WorkerError("CORRUPT_INPUT");dest.Write(buffer,0,read);
                if((DateTime.UtcNow-last).TotalMilliseconds>=500){Progress.Extraction(copied,total);last=DateTime.UtcNow;}
            }
            if(count!=original.Size)throw new WorkerError("INCOMPLETE_INPUT");dest.Flush(true);
        }
        if(seen.Count!=entries.Length||copied!=total)throw new WorkerError("INCOMPLETE_INPUT");
        Progress.Extraction(copied,total);return true;
    });
}
