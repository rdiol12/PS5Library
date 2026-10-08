using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using LibProsperoPkg.Content;

namespace PS5Library.Worker;

public static class BackportDiscovery
{
    static readonly HashSet<string> Extensions=new(StringComparer.OrdinalIgnoreCase){".bin",".elf",".prx",".self",".sprx"};
    static readonly ElfSdk[] SdkPresets={
        new(0x01000050,0x07590001),new(0x02000009,0x08050001),new(0x03000027,0x08540001),new(0x04000031,0x09040001),new(0x05000033,0x09590001),
        new(0x06000038,0x10090001),new(0x07000038,0x10590001),new(0x08000041,0x11090001),new(0x09000040,0x11590001),new(0x10000040,0x12090001),
    };
    static string Sha(byte[] bytes)=>Convert.ToHexStringLower(SHA256.HashData(bytes));

    public static ElfSdk SdkForFirmware(string firmware)
    {
        if(!Regex.IsMatch(firmware,@"^\d{1,2}\.\d{2}$")||!int.TryParse(firmware.AsSpan(0,firmware.IndexOf('.')),out var major)||major<1||major>SdkPresets.Length)throw new WorkerError("BACKPORT_TARGET_UNVERIFIED");
        return SdkPresets[major-1];
    }

    public static BackportProfile Generate(string input,Identity identity,string targetFirmware,string runtime,string method,string? exactInputHash=null)
    {
        var sdk=SdkForFirmware(targetFirmware);
        if(!Directory.Exists(input)||!Regex.IsMatch(runtime,@"^[A-Za-z0-9._-]{1,64}$")||method is not "FPKG" and not "SHADOWMOUNT"||exactInputHash is not null&&!Regex.IsMatch(exactInputHash,"^[0-9a-f]{64}$"))throw new WorkerError("PROFILE_MISMATCH");
        InputInspector.Inspect(input,identity);
        var treeHash=exactInputHash is null?Files.TreeHash(input):null;var inputHash=exactInputHash??treeHash!;
        var suppliedRoots=Directory.GetDirectories(input).Where(path=>Path.GetFileName(path).Equals("backport",StringComparison.OrdinalIgnoreCase)).ToArray();
        if(suppliedRoots.Length>1)throw new WorkerError("PROFILE_MISMATCH");var suppliedRoot=suppliedRoots.SingleOrDefault();
        var suppliedFiles=suppliedRoot is null?Array.Empty<string>():Files.Enumerate(suppliedRoot).ToArray();
        var suppliedTargets=suppliedFiles.Select(file=>Path.GetRelativePath(suppliedRoot!,file).Replace('\\','/')).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var libraryRoots=Directory.GetDirectories(input).Where(path=>Path.GetFileName(path).Equals("fakelib",StringComparison.OrdinalIgnoreCase)||Path.GetFileName(path).Equals("fakelib2",StringComparison.OrdinalIgnoreCase)).ToArray();
        if(libraryRoots.Length>1)throw new WorkerError("PROFILE_MISMATCH","fakelib2 is exclusive; choose one library policy.");
        var libraryFiles=libraryRoots.SelectMany(Files.Enumerate).Where(file=>!suppliedTargets.Contains(Path.GetRelativePath(input,file).Replace('\\','/'))).ToArray();
        var header=new byte[64];var recognizedLibrary=false;
        foreach(var file in libraryFiles){if(!Extensions.Contains(Path.GetExtension(file)))continue;using var stream=File.OpenRead(file);var read=stream.Read(header);if(ProsperoFself.IsElf(header.AsSpan(0,read))||ProsperoFself.IsSelf(header.AsSpan(0,read))){recognizedLibrary=true;break;}}
        if(libraryFiles.Length>0&&!recognizedLibrary)throw new WorkerError("BACKPORT_FILES_MISSING","Supplied fakelib contains no recognized SELF or ELF module.");

        var patches=new List<BackportPatch>();
        foreach(var file in Files.Enumerate(input))
        {
            var relative=Path.GetRelativePath(input,file).Replace('\\','/');
            var top=relative.Split('/')[0];
            if(top.Equals("backport",StringComparison.OrdinalIgnoreCase)||top.Equals("backports",StringComparison.OrdinalIgnoreCase)||top.Equals("DLC",StringComparison.OrdinalIgnoreCase)||top.Equals("DLCs",StringComparison.OrdinalIgnoreCase)||suppliedTargets.Contains(relative)||!Extensions.Contains(Path.GetExtension(file)))continue;
            using(var stream=File.OpenRead(file))
            {
                var read=stream.Read(header);
                if(!ProsperoFself.IsElf(header.AsSpan(0,read))&&!ProsperoFself.IsSelf(header.AsSpan(0,read)))continue;
                if(stream.Length>BinaryPatches.MaximumModule){if(libraryFiles.Length+suppliedFiles.Length>0)continue;throw new WorkerError("INPUT_TOO_LARGE");}
            }
            byte[] source,plain;
            try{source=File.ReadAllBytes(file);plain=Modules.ToElf(source);}
            catch(WorkerError error) when((error.Code=="UNSUPPORTED_INPUT"||error.Code=="INPUT_TOO_LARGE")&&libraryFiles.Length+suppliedFiles.Length>0){continue;}
            byte[] patched;ElfSdk? appliedSdk=sdk;
            try{patched=BinaryPatches.PatchSdk(plain,sdk);}
            catch(WorkerError error) when(error.Code=="BACKPORT_SDK_RECORD_MISSING"){
                if(!top.Equals("fakelib",StringComparison.OrdinalIgnoreCase)&&!top.Equals("fakelib2",StringComparison.OrdinalIgnoreCase))continue;
                patched=plain;appliedSdk=null;
            }
            byte[] output;try{output=Modules.FakeSign(patched);}catch(ArgumentException) when(libraryFiles.Length+suppliedFiles.Length>0){continue;}
            var inputSha=Sha(source);var outputSha=Sha(output);
            if(inputSha!=outputSha)patches.Add(new(relative,inputSha,outputSha,Sdk:appliedSdk,OutputFormat:"FSELF"));
            if(patches.Count>100)throw new WorkerError("BACKPORT_FILES_MISSING");
        }

        var byPath=patches.ToDictionary(p=>p.Path,StringComparer.OrdinalIgnoreCase);
        var libraries=libraryFiles.Select(file=>{
            var relative=Path.GetRelativePath(input,file).Replace('\\','/');
            return new BackportLibrary(relative,byPath.TryGetValue(relative,out var patch)?patch.OutputSha256:Files.Hash(file));
        }).ToArray();
        var files=suppliedFiles.Select(file=>new BackportFile(Path.GetRelativePath(suppliedRoot!,file).Replace('\\','/'),Files.Hash(file))).ToArray();
        var profile=new BackportProfile(Guid.NewGuid().ToString(),identity.TitleId,identity.ContentId,identity.Version,new[]{inputHash},targetFirmware,runtime,method,"UNTESTED",libraries,patches.ToArray(),RequiredFiles:files);
        Backports.Validate(profile,input,inputHash,identity,method);
        if(treeHash is not null&&Files.TreeHash(input)!=treeHash)throw new WorkerError("SOURCE_CHANGED");
        return profile;
    }

    public static BackportProfile GenerateArchive(string input,string extraction,Identity identity,string targetFirmware,string runtime,string method,string expectedHash,long maximum)
    {
        try{
            var (folder,inputHash)=Archives.ExtractVerified(input,extraction,identity,expectedHash,maximum,1);
            var profile=Generate(folder,identity,targetFirmware,runtime,method,inputHash);
            if(Archives.Hash(input).Sha256!=inputHash)throw new WorkerError("SOURCE_CHANGED");
            return profile;
        }finally{if(Directory.Exists(extraction))Directory.Delete(extraction,true);}
    }
}
