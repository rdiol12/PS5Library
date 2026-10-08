using System.Text.Json;
using System.Text.Json.Serialization;
namespace PS5Library.Worker;
public static class Program
{
    public static readonly JsonSerializerOptions JsonOptions=new() { PropertyNamingPolicy=JsonNamingPolicy.CamelCase,PropertyNameCaseInsensitive=true,WriteIndented=true,DefaultIgnoreCondition=JsonIgnoreCondition.WhenWritingNull,Converters={new JsonStringEnumConverter()} };
    public static int Main(string[] args)
    {
        var output=Console.Out; Console.SetOut(Console.Error);
        try
        {
            object result=args.Length>1 ? args[0] switch {
                "inspect"=>InputInspector.Inspect(args[1],args.Length>2?JsonSerializer.Deserialize<Identity>(args[2],JsonOptions):null),
                "extract-pkg-artwork" when args.Length==3=>PackageAssets.Extract(args[1],args[2]),
                "encode-dds" when args.Length==3=>EncodeDds(args[1],args[2]),
                "build" when args.Length>=4=>Pipeline.Build(args[1],args[2],args[3],args.Length>4?JsonSerializer.Deserialize<Identity>(args[4],JsonOptions):null,args.Length>5?args[5]:null),
                "build-verified" when args.Length is >=7 and <=9=>Pipeline.Build(args[1],args[2],args[3],JsonSerializer.Deserialize<Identity>(args[4],JsonOptions),args[5],expectedHash:args[6],expectedSize:args.Length>=8?long.Parse(args[7]):null,profile:args.Length==9?ReadProfile(args[8]):null),
                "build-backport" when args.Length==7=>Pipeline.PrepareBackport(args[1],args[2],args[3],JsonSerializer.Deserialize<Identity>(args[4],JsonOptions)!,args[5],ReadProfile(args[6])),
                "hash-file" when args.Length==2=>HashFile(args[1]),
                "hash-tree" when args.Length==2=>HashTree(args[1]),
                "hash-base-tree" when args.Length==2=>HashBaseTree(args[1]),
                "package-chunk-crc" when args.Length==3=>WritePackageChunkCrc(args[1],args[2]),
                "archive-parts" when args.Length==2=>Archives.Signature(args[1]),
                "hash-archive" when args.Length==2=>HashArchive(args[1]),
                "build-archive" when args.Length is 8 or 9=>Pipeline.BuildArchive(args[1],args[2],args[3],JsonSerializer.Deserialize<Identity>(args[4],JsonOptions)!,args[5],args[6],long.Parse(args[7]),args.Length==9?ReadProfile(args[8]):null),
                "extract-archive" when args.Length==4=>ExtractArchive(args[1],args[2],long.Parse(args[3])),
                "extract-zip" when args.Length==4=>Extract(args[1],args[2],long.Parse(args[3])),
                "extract-pfs" when args.Length==5=>ExtractPfs(args[1],args[2],ParseLong(args[3]),ParseLong(args[4])),
                "fself-to-elf" when args.Length==3=>ConvertModule(args[1],args[2],false),
                "elf-to-fself" when args.Length==3=>ConvertModule(args[1],args[2],true),
                "generate-backport-profile" when args.Length is 6 or 7=>BackportDiscovery.Generate(args[1],JsonSerializer.Deserialize<Identity>(args[2],JsonOptions)!,args[3],args[4],args[5],args.Length==7?args[6]:null),
                "generate-backport-profile-archive" when args.Length==9=>BackportDiscovery.GenerateArchive(args[1],args[2],JsonSerializer.Deserialize<Identity>(args[3],JsonOptions)!,args[4],args[5],args[6],args[7],long.Parse(args[8])),
                _=>throw new WorkerError("UNSUPPORTED_INPUT","Commands: inspect, extract-pkg-artwork, build, extract-zip, extract-pfs, fself-to-elf, elf-to-fself, generate-backport-profile")
            } : throw new WorkerError("USAGE","PS5Library.Worker <command> <input> [output] [method]");
            output.WriteLine(JsonSerializer.Serialize(result,JsonOptions)); return 0;
        }
        catch(Exception error) { output.WriteLine(JsonSerializer.Serialize(new { error=error is WorkerError w?w.Code:"WORKER_FAILED",message=error.Message },JsonOptions)); return 1; }
    }
    static BackportProfile ReadProfile(string file){if(new FileInfo(file).Length>1024*1024)throw new WorkerError("INPUT_TOO_LARGE");return JsonSerializer.Deserialize<BackportProfile>(File.ReadAllText(file),JsonOptions)??throw new WorkerError("PROFILE_MISMATCH");}
    static long ParseLong(string value)=>value.StartsWith("0x",StringComparison.OrdinalIgnoreCase)?Convert.ToInt64(value[2..],16):long.Parse(value,System.Globalization.CultureInfo.InvariantCulture);
    static object Extract(string input,string output,long maximum) { SafeExtract.Zip(input,output,maximum); return new { outputPath=Path.GetFullPath(output),inputHash=Files.Hash(input) }; }
    public static object ExtractPfs(string input,string output,long superblockOffset,long maximumBytes)
    {
        var inputPath=Path.GetFullPath(input);var outputPath=Path.GetFullPath(output);
        if(Directory.Exists(outputPath)||File.Exists(outputPath))throw new WorkerError("OUTPUT_EXISTS");
        if(maximumBytes<0)throw new WorkerError("QUOTA_EXCEEDED");
        var attributes=File.GetAttributes(inputPath);if((attributes&(FileAttributes.Directory|FileAttributes.ReparsePoint))!=0)throw new WorkerError("UNSAFE_PATH");
        using var inputStream=new FileStream(inputPath,FileMode.Open,FileAccess.Read,FileShare.Read,1024*1024,FileOptions.RandomAccess);
        if(superblockOffset<0||(superblockOffset&0xffff)!=0||superblockOffset>inputStream.Length-0x400)throw new WorkerError("CORRUPT_INPUT","Invalid PFS superblock offset.");
        LibProsperoPkg.PFS.PfsHeader header;
        try{inputStream.Position=superblockOffset;header=LibProsperoPkg.PFS.PfsHeader.ReadFromStream(inputStream);}
        catch(Exception error) when(error is InvalidDataException or EndOfStreamException){throw new WorkerError("CORRUPT_INPUT",error.Message);}
        var inodeSize=header.Mode.HasFlag(LibProsperoPkg.PFS.PfsMode.PprDirectOffsets)?LibProsperoPkg.PFS.DinodePpr.SizeOf
            :header.Mode.HasFlag(LibProsperoPkg.PFS.PfsMode.Signed)?header.Mode.HasFlag(LibProsperoPkg.PFS.PfsMode.Is64Bit)?LibProsperoPkg.PFS.DinodeS64.SizeOf:LibProsperoPkg.PFS.DinodeS32.SizeOf
            :LibProsperoPkg.PFS.DinodeD32.SizeOf;
        var inodeBlock=header.InodeBlockSig.db[0].block;
        if(header.BlockSize!=0x10000||header.DinodeCount<=0||header.DinodeCount>250000||header.Ndblock<=0||header.DinodeBlockCount<=0||inodeBlock<0
            ||header.Ndblock>inputStream.Length/header.BlockSize||header.DinodeBlockCount>inputStream.Length/header.BlockSize
            ||header.DinodeCount>header.DinodeBlockCount*(header.BlockSize/inodeSize)
            ||inodeBlock>inputStream.Length/header.BlockSize-header.DinodeBlockCount)throw new WorkerError("CORRUPT_INPUT","Invalid PFS geometry.");
        LibProsperoPkg.PFS.PfsReader reader;
        try{using var source=new LibProsperoPkg.Util.StreamReader(inputStream);reader=new(source,superblockOffset:superblockOffset,encryptedDataAlreadyDecrypted:true);}
        catch(Exception error) when(error is InvalidDataException or EndOfStreamException or ArgumentException or IndexOutOfRangeException or OverflowException){throw new WorkerError("CORRUPT_INPUT",error.Message);}
        var entries=new List<(LibProsperoPkg.PFS.PfsReader.File File,string Relative,string Target,long Size)>();var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);long total=0;
        foreach(var file in reader.GetAllFiles())
        {
            var relative=file.FullName.TrimStart('/');if(relative.StartsWith("uroot/",StringComparison.Ordinal))relative=relative[6..];
            var target=Files.SafeRelative(outputPath,relative);var size=file.flags.HasFlag(LibProsperoPkg.PFS.InodeFlags.compressed)?file.compressed_size:file.size;
            if(size<0)throw new WorkerError("CORRUPT_INPUT");if(!names.Add(relative))throw new WorkerError("UNSAFE_PATH","Duplicate PFS path.");
            if(size>maximumBytes-total)throw new WorkerError("QUOTA_EXCEEDED");total+=size;entries.Add((file,relative,target,size));
        }
        foreach(var name in names)for(var slash=name.LastIndexOf('/');slash>0;slash=name.LastIndexOf('/',slash-1))if(names.Contains(name[..slash]))throw new WorkerError("UNSAFE_PATH","A PFS file is also used as a directory.");
        Directory.CreateDirectory(outputPath);long written=0;
        foreach(var entry in entries)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(entry.Target)!);
            using var target=new FileStream(entry.Target,FileMode.CreateNew,FileAccess.Write,FileShare.None,1024*1024,FileOptions.SequentialScan);entry.File.CopyTo(target,decompress:true);target.Flush(true);
            if(target.Length!=entry.Size)throw new WorkerError("CORRUPT_INPUT","PFS file size changed during extraction.");written+=target.Length;
        }
        return new {outputPath,fileCount=entries.Count,size=written,superblockOffset};
    }
    static object EncodeDds(string input,string output) {
        if(new FileInfo(input).Length>32*1024*1024)throw new WorkerError("INPUT_TOO_LARGE");
        var bytes=LibProsperoPkg.PKG.ProsperoDdsEncoder.EncodePngToDds(File.ReadAllBytes(input));
        using(var target=new FileStream(output,FileMode.CreateNew,FileAccess.Write)){target.Write(bytes);target.Flush(true);}
        return new {outputPath=Path.GetFullPath(output),size=bytes.Length,sha256=Files.Hash(output)};
    }
    static object HashFile(string input){long size=0;var digest=Files.Hash(input,(completed,total)=>{size=total;Progress.Operation("Hashing file",6,completed,total,package:"VERIFYING");});return new {sha256=digest,size};}
    static object HashTree(string input){long size=0;var digest=Files.TreeHash(input,(completed,total)=>{size=total;Progress.Operation("Hashing files",6,completed,total,package:"VERIFYING");});return new {sha256=digest,size};}
    static object HashBaseTree(string input){var digest=Files.HashTrees(input,(completed,total)=>Progress.Operation("Hashing files",6,completed,total,package:"VERIFYING"));return new {sha256=digest.BaseSha256,size=digest.BaseSize,sourceTreeSha256=digest.TreeSha256,sourceTreeSize=digest.TreeSize};}
    static object HashArchive(string input){var digest=Archives.Hash(input,(completed,total)=>Progress.Operation("Hashing archive",6,completed,total,package:"VERIFYING"));return new {sha256=digest.Sha256,size=digest.Size};}
    public static object WritePackageChunkCrc(string input,string output)
    {
        using var source=new FileStream(input,FileMode.Open,FileAccess.Read,FileShare.Read);
        if(source.Length==0)throw new WorkerError("UNSUPPORTED_INPUT","Package is empty.");
        var bytes=LibProsperoPkg.PlayGo.ProsperoPlayGo.BuildChunkCrc(source,source.Length);
        using(var target=new FileStream(output,FileMode.CreateNew,FileAccess.Write,FileShare.None)){target.Write(bytes);target.Flush(true);}
        return new {outputPath=Path.GetFullPath(output),size=bytes.Length,sha256=Files.Hash(output)};
    }
    static object ExtractArchive(string input,string output,long maximum){Archives.Extract(input,output,maximum);return new {outputPath=Path.GetFullPath(output)};}
    static object ConvertModule(string input,string output,bool sign)
    {
        if(new FileInfo(input).Length>512*1024*1024) throw new WorkerError("INPUT_TOO_LARGE");
        var bytes=File.ReadAllBytes(input); using(var target=new FileStream(output,FileMode.CreateNew,FileAccess.Write)) { target.Write(sign?Modules.FakeSign(bytes):Modules.ToElf(bytes)); target.Flush(true); }
        return new { outputPath=Path.GetFullPath(output),inputHash=Files.Hash(input),outputHash=Files.Hash(output),tested=false };
    }
}
