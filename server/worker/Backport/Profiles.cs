using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
namespace PS5Library.Worker;
public static class Backports
{
    public static string Digest(BackportProfile p)=>Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new object?[]{p.Delivery=="INTEGRATED"?"backport-v6-integrated":"backport-v7-complete-overlay",p.Id,p.TitleId,p.ContentId,p.GameVersion,p.InputHashes.Order(StringComparer.Ordinal).ToArray(),p.TargetFirmware,p.Runtime,p.InstallationMethod,
        p.RequiredLibraries.OrderBy(f=>f.Path,StringComparer.Ordinal).Select(f=>new[]{f.Path,f.Sha256}).ToArray(),p.RequiredPatches.OrderBy(f=>f.Path,StringComparer.Ordinal).Select(f=>BinaryPatches.Automatic(f)?new object?[]{f.Path,f.InputSha256,f.OutputSha256,f.Bps?.Sha256,f.Sdk?.Ps5,f.Sdk?.Ps4,f.OutputFormat}:new object?[]{f.Path,f.InputSha256,f.OutputSha256}).ToArray(),FilesOf(p).OrderBy(f=>f.Path,StringComparer.Ordinal).Select(f=>new[]{f.Path,f.Sha256}).ToArray()},new JsonSerializerOptions {Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping}))));    public static void Validate(BackportProfile p,string input,string inputHash,Identity identity,string method)
    {
        if(p.TitleId!=identity.TitleId||p.ContentId!=identity.ContentId||p.GameVersion!=identity.Version||!p.InputHashes.Contains(inputHash)||p.InstallationMethod!=method||p.TestedState=="UNKNOWN"||!Guid.TryParse(p.Id,out _)||!Regex.IsMatch(p.TargetFirmware,@"^\d{1,2}\.\d{2}$"))throw new WorkerError("PROFILE_MISMATCH");
        var requiredFiles=FilesOf(p);
        if(p.Delivery=="INTEGRATED"){
            if(p.RequiredLibraries.Length+p.RequiredPatches.Length+requiredFiles.Length!=0)throw new WorkerError("PROFILE_MISMATCH");
            return;
        }        if(p.Delivery!="OVERLAY"||p.RequiredLibraries.Length+p.RequiredPatches.Length+requiredFiles.Length==0||p.RequiredLibraries.Length>100||p.RequiredPatches.Length>100||requiredFiles.Length>10000)throw new WorkerError("BACKPORT_FILES_MISSING");
        var patches=new Dictionary<string,BackportPatch>(StringComparer.OrdinalIgnoreCase);var targets=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        foreach(var patch in p.RequiredPatches){
            if(!Regex.IsMatch(patch.Path,@"^[A-Za-z0-9._/-]+$")||Regex.IsMatch(patch.Path,@"^dlcs?/",RegexOptions.IgnoreCase)||!patches.TryAdd(patch.Path,patch))throw new WorkerError("UNSAFE_PATH");
            var file=Files.SafeRelative(input,patch.Path);BinaryPatches.ValidateRecipe(patch);
            if(!File.Exists(file))throw new WorkerError("BACKPORT_PATCH_MISSING");
            if(new FileInfo(file).Length>BinaryPatches.MaximumModule||!targets.TryAdd(patch.Path,patch.Path)&&!targets[patch.Path].Equals(patch.Path,StringComparison.OrdinalIgnoreCase))throw new WorkerError("UNSAFE_PATH");
            var actual=Files.Hash(file);
            if(actual!=patch.OutputSha256&&(!BinaryPatches.Automatic(patch)||actual!=patch.InputSha256))throw new WorkerError("BACKPORT_PATCH_INPUT_MISMATCH");
        }
        var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach(var library in p.RequiredLibraries){
            if(!Regex.IsMatch(library.Path,@"^fakelib2?/[A-Za-z0-9._/-]+$")||!names.Add(library.Path))throw new WorkerError("UNSAFE_PATH");
            var file=Files.SafeRelative(input,library.Path);
            if(!File.Exists(file))throw new WorkerError("BACKPORT_FILES_MISSING");
            if(!targets.TryAdd(library.Path,library.Path)&&!targets[library.Path].Equals(library.Path,StringComparison.OrdinalIgnoreCase))throw new WorkerError("UNSAFE_PATH");
            if(Files.Hash(file)!=library.Sha256&&(!patches.TryGetValue(library.Path,out var patch)||patch.OutputSha256!=library.Sha256))throw new WorkerError("BACKPORT_FILES_MISMATCH");
        }
        if(p.RequiredLibraries.Any(f=>f.Path.StartsWith("fakelib/"))&&p.RequiredLibraries.Any(f=>f.Path.StartsWith("fakelib2/")))throw new WorkerError("PROFILE_MISMATCH","fakelib2 is exclusive; choose one library policy.");
        var suppliedRoot=Files.SafeRelative(input,"backport");var supplied=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        if(Directory.Exists(suppliedRoot))foreach(var file in Files.Enumerate(suppliedRoot)){var relative=Path.GetRelativePath(suppliedRoot,file).Replace('\\','/');if(!supplied.TryAdd(relative,file))throw new WorkerError("UNSAFE_PATH");}
        if(supplied.Count!=requiredFiles.Length)throw new WorkerError("BACKPORT_FILES_MISMATCH");
        foreach(var required in requiredFiles){
            _=Files.SafeRelative(suppliedRoot,required.Path);
            if(!names.Add("backport/"+required.Path)||!targets.TryAdd(required.Path,"backport/"+required.Path))throw new WorkerError("UNSAFE_PATH");
            if(!supplied.TryGetValue(required.Path,out var file)||Files.Hash(file)!=required.Sha256)throw new WorkerError("BACKPORT_FILES_MISMATCH");
        }
    }
    public static void Apply(BackportProfile p,string staging)
    {
        for(int i=0;i<p.RequiredPatches.Length;i++){
            var patch=p.RequiredPatches[i];var file=Files.SafeRelative(staging,patch.Path);
            Progress.Stage($"Applying verified patches ({i+1}/{p.RequiredPatches.Length})",2,package:"PATCHING",fakelib:"PATCHING");
            if(new FileInfo(file).Length>BinaryPatches.MaximumModule)throw new WorkerError("INPUT_TOO_LARGE");
            var output=BinaryPatches.Apply(File.ReadAllBytes(file),patch);File.WriteAllBytes(file,output);
        }
    }
    public static void Embed(BackportProfile p,string libraries,string staging)
    {
        foreach(var library in p.RequiredLibraries){
            var source=Files.SafeRelative(libraries,library.Path);var destination=Files.SafeRelative(staging,library.Path);
            if(Files.Hash(source)!=library.Sha256)throw new WorkerError("BACKPORT_FILES_MISMATCH");
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);File.Copy(source,destination,false);
        }
    }
    public static void CreateShadowMountOverlay(BackportProfile p,string source,string overlay)
    {
        Directory.CreateDirectory(overlay);
        var metadata=Files.SafeRelative(source,"sce_sys/param.json");var metadataOutput=Files.SafeRelative(overlay,"sce_sys/param.json");Directory.CreateDirectory(Path.GetDirectoryName(metadataOutput)!);File.Copy(metadata,metadataOutput,false);
        var paths=p.RequiredPatches.Select(f=>f.Path).Concat(p.RequiredLibraries.Select(f=>f.Path)).Distinct(StringComparer.OrdinalIgnoreCase);
        foreach(var path in paths){
            var input=Files.SafeRelative(source,path);if(!File.Exists(input))throw new WorkerError("BACKPORT_FILES_MISSING");
            var output=Files.SafeRelative(overlay,path);Directory.CreateDirectory(Path.GetDirectoryName(output)!);File.Copy(input,output,true);
        }
        foreach(var file in FilesOf(p)){
            var input=Files.SafeRelative(Files.SafeRelative(source,"backport"),file.Path);var output=Files.SafeRelative(overlay,file.Path);
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);File.Copy(input,output,true);
        }
        Apply(p,overlay);
        foreach(var library in p.RequiredLibraries)if(Files.Hash(Files.SafeRelative(overlay,library.Path))!=library.Sha256)throw new WorkerError("BACKPORT_FILES_MISMATCH");
        foreach(var file in FilesOf(p))if(Files.Hash(Files.SafeRelative(overlay,file.Path))!=file.Sha256)throw new WorkerError("BACKPORT_FILES_MISMATCH");
        if(!FilesOf(p).Any(file=>file.Path.Equals("sce_sys/param.json",StringComparison.OrdinalIgnoreCase)))PrepareMetadata(p,overlay);
    }
    static BackportFile[] FilesOf(BackportProfile profile)=>profile.RequiredFiles??Array.Empty<BackportFile>();
    public static void PrepareMetadata(BackportProfile p,string staging)
    {
        var file=Files.SafeRelative(staging,"sce_sys/param.json");var bytes=File.ReadAllBytes(file);var bom=bytes.AsSpan().StartsWith(new byte[]{0xef,0xbb,0xbf});var json=Encoding.UTF8.GetString(bytes,bom?3:0,bytes.Length-(bom?3:0));
        using(var document=JsonDocument.Parse(json))if(document.RootElement.ValueKind!=JsonValueKind.Object)throw new WorkerError("CORRUPT_INPUT");
        var split=p.TargetFirmware.Split('.');var major=int.Parse(split[0],System.Globalization.CultureInfo.InvariantCulture);var minor=int.Parse(split[1],System.Globalization.CultureInfo.InvariantCulture);var firmware=$"{major:00}.{minor:00}";var required=$"0x{major:00}{minor:00}000000000000";
        var sdk=$"0x{BackportDiscovery.SdkForFirmware(p.TargetFirmware).Ps5>>24:x2}00000000000000";
        json=LowerFirmware("mfsrVersion",firmware,Lower("requiredSystemSoftwareVersion",required,Lower("sdkVersion",sdk,json)));var output=Encoding.UTF8.GetBytes(json);
        File.WriteAllBytes(file,bom?new byte[]{0xef,0xbb,0xbf}.Concat(output).ToArray():output);

        static string Lower(string name,string target,string json){var matches=Regex.Matches(json,$"(\\\"{Regex.Escape(name)}\\\"\\s*:\\s*\\\")(0x[0-9a-fA-F]{{16}})(\\\")");if(matches.Count>1)throw new WorkerError("CORRUPT_INPUT");if(matches.Count==0)return json;var value=matches[0].Groups[2];if(!ulong.TryParse(value.Value.AsSpan(2),System.Globalization.NumberStyles.HexNumber,System.Globalization.CultureInfo.InvariantCulture,out var current)||!ulong.TryParse(target.AsSpan(2),System.Globalization.NumberStyles.HexNumber,System.Globalization.CultureInfo.InvariantCulture,out var wanted))throw new WorkerError("CORRUPT_INPUT");return current<=wanted?json:json[..value.Index]+target+json[(value.Index+value.Length)..];}
        static string LowerFirmware(string name,string target,string json){var matches=Regex.Matches(json,$"(\\\"{Regex.Escape(name)}\\\"\\s*:\\s*\\\")(\\d{{1,2}}\\.\\d{{2}})(\\\")");if(matches.Count>1)throw new WorkerError("CORRUPT_INPUT");if(matches.Count==0)return json;var value=matches[0].Groups[2];if(!Version.TryParse(value.Value,out var current)||!Version.TryParse(target,out var wanted))throw new WorkerError("CORRUPT_INPUT");return current.CompareTo(wanted)<=0?json:json[..value.Index]+target+json[(value.Index+value.Length)..];}
    }
}
