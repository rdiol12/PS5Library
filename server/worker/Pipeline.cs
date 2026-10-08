using System.Text.Json;
namespace PS5Library.Worker;
public static class Pipeline
{
    public static BackportPreparation PrepareBackport(string input,string output,string method,Identity expected,string expectedHash,BackportProfile profile)
    {
        input=Path.GetFullPath(input);output=Path.GetFullPath(output);
        if(output==input||output.StartsWith(input.TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,OperatingSystem.IsWindows()?StringComparison.OrdinalIgnoreCase:StringComparison.Ordinal))throw new WorkerError("UNSAFE_PATH");
        Progress.Start(method);var inspected=InputInspector.Inspect(input,expected);
        if(inspected.Format!="folder"||inspected.Identity is null||profile.Delivery!="OVERLAY")throw new WorkerError("UNSUPPORTED_INPUT");
        var stamp=Files.TreeStamp(input);
        Progress.Stage("Verifying compatibility source",1,fakelib:"VERIFYING");
        var profileInputHash=Files.TreeHash(input,(completed,total)=>Progress.Operation("Verifying compatibility source",1,completed,total,fakelib:"VERIFYING"));
        Backports.Validate(profile,input,profileInputHash,inspected.Identity,method);
        var inputHash=Files.BaseTreeHash(input);
        if(inputHash!=expectedHash)throw new WorkerError("CORRUPT_INPUT","Source tree hash differs from the selected release.");
        Directory.CreateDirectory(output);var stage=Path.Combine(output,".staging",Guid.NewGuid().ToString());var overlay=Path.Combine(stage,"backport");
        try{
            Backports.CreateShadowMountOverlay(profile,input,overlay);
            var identity=InputInspector.ReadIdentity(File.ReadAllBytes(Files.SafeRelative(overlay,"sce_sys/param.json")));
            if(identity?.MinimumFirmware is null||decimal.Parse(identity.MinimumFirmware,System.Globalization.CultureInfo.InvariantCulture)>decimal.Parse(profile.TargetFirmware,System.Globalization.CultureInfo.InvariantCulture))throw new WorkerError("BACKPORT_PATCH_MISSING");
            if(Files.TreeStamp(input)!=stamp)throw new WorkerError("SOURCE_CHANGED");
            Progress.Stage("Verifying separate libraries",6,fakelib:"VERIFYING");
            var hash=Files.TreeHash(overlay,(completed,total)=>Progress.Operation("Verifying separate libraries",6,completed,total,fakelib:"VERIFYING"));var size=Files.Enumerate(overlay).Sum(file=>new FileInfo(file).Length);var destination=Path.Combine(output,"backports",hash);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            if(!Directory.Exists(destination))Directory.Move(overlay,destination);else if(Files.TreeHash(destination)!=hash)throw new WorkerError("CACHE_CORRUPT");
            Progress.Stage("Verified on server",7,fakelib:"VERIFIED",fakelibBytes:size);
            return new(inputHash,profile.Id,Backports.Digest(profile),new(destination,hash,size));
        }finally{if(Directory.Exists(stage))Directory.Delete(stage,true);}
    }
    public static BuildResult BuildArchive(string input,string output,string method,Identity expected,string releaseId,string expectedHash,long maximum,BackportProfile? profile=null)
    {
        Progress.Start(method);
        Directory.CreateDirectory(output);
        Progress.Stage("Verifying archive volumes",0);
        var extraction=Path.Combine(output,".extracted-"+Guid.NewGuid());
        try {
            var (folder,inputHash)=Archives.ExtractVerified(input,extraction,expected,expectedHash,maximum,5);
            var result=Build(folder,output,method,expected,releaseId,profile:profile,profileInputHash:inputHash);
            Progress.Stage("Rechecking archive volumes",6);
            if(Archives.Hash(input,(completed,total)=>Progress.Operation("Rechecking archive volumes",6,completed,total,package:"VERIFYING")).Sha256!=inputHash)throw new WorkerError("SOURCE_CHANGED");
            result=result with {InputHash=inputHash};File.WriteAllText(result.OutputPath+".json",JsonSerializer.Serialize(result,Program.JsonOptions));
            Progress.Stage("Verified on server",7);return result;
        }finally{if(Directory.Exists(extraction))Directory.Delete(extraction,true);}
    }
    public static BuildResult Build(string input,string output,string method,Identity? expected=null,string? releaseId=null,string? profileId=null,string? expectedHash=null,long? expectedSize=null,BackportProfile? profile=null,string? profileInputHash=null)
    {
        input=Path.GetFullPath(input); output=Path.GetFullPath(output);
        if(output==input || output.StartsWith(input.TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,OperatingSystem.IsWindows()?StringComparison.OrdinalIgnoreCase:StringComparison.Ordinal)) throw new WorkerError("UNSAFE_PATH");
        if(profileId is not null) throw new WorkerError("PROFILE_NOT_APPLIED","Use the verified backport preparation step; profile IDs are not decorative metadata.");
        Progress.Start(method);
        var before=InputInspector.Inspect(input,expected);
        if(before.Format!="folder" || before.Identity is null) throw new WorkerError("UNSUPPORTED_INPUT","Builder accepts an inspected prepared folder.");
        IPackageBuilder builder=method switch { "FPKG"=>new ProsperoPackageBuilderAdapter(),"SHADOWMOUNT"=>new UFS2ImageBuilderAdapter(),_=>throw new WorkerError("UNSUPPORTED_METHOD") };
        var direct=method=="FPKG";
        var size=(direct?Files.EnumerateBase(input):Files.Enumerate(input)).Sum(file=>new FileInfo(file).Length);
        if(expectedSize is not null && size!=expectedSize) throw new WorkerError("CORRUPT_INPUT","Source size differs from the manifest and reserved quota.");
        Directory.CreateDirectory(output);
        var patchGrowth=(long)(profile?.RequiredPatches.Count(BinaryPatches.Automatic)??0)*BinaryPatches.MaximumGrowth;
        if(new DriveInfo(Path.GetPathRoot(output)!).AvailableFreeSpace < checked(direct?size+patchGrowth+64*1024*1024:(size+patchGrowth)*4+64*1024*1024)) throw new WorkerError("INSUFFICIENT_SPACE");
        var hasLibraries=Directory.GetDirectories(input).Any(d=>new[]{"fakelib","fakelib2"}.Contains(Path.GetFileName(d),StringComparer.OrdinalIgnoreCase)&&Files.Enumerate(d).Any());
        var sourceStamp=direct&&expectedHash is not null?(profile is null?Files.BaseTreeStamp(input):Files.TreeStamp(input)):null;
        Progress.Stage("Checking source manifest",1,fakelib:hasLibraries?"WAITING":"NOT_REQUIRED");
        var inputHash=expectedHash??(direct?Files.BaseTreeHash(input,(completed,total)=>Progress.Operation("Checking source manifest",1,completed,total,fakelib:hasLibraries?"WAITING":"NOT_REQUIRED")):Files.TreeHash(input,(completed,total)=>Progress.Operation("Checking source manifest",1,completed,total,fakelib:hasLibraries?"WAITING":"NOT_REQUIRED")));
        var stage=Path.Combine(output,".staging",Guid.NewGuid().ToString());
        try {
        if(profile is not null)Backports.Validate(profile,input,profileInputHash??(direct?Files.TreeHash(input):inputHash),before.Identity,method);
        var copy=Path.Combine(stage,"source"); var build=Path.Combine(stage,"build"); Directory.CreateDirectory(build);var packageSource=input;
        if(direct) {
            Progress.Stage("Building directly from source",2,package:"STAGING",fakelib:hasLibraries?"COPYING":"NOT_REQUIRED");
        } else {
            Progress.Stage("Copying to staging",2,package:"STAGING",fakelib:hasLibraries?"COPYING":"NOT_REQUIRED");
            Progress.Staging(0,size);var last=DateTime.UtcNow;long reported=0;
            var copied=Files.CopyTree(input,copy,completed=>{if(completed>size)throw new WorkerError("SOURCE_CHANGED");if((DateTime.UtcNow-last).TotalMilliseconds>=500){Progress.Staging(completed,size);reported=completed;last=DateTime.UtcNow;}});
            if(copied.Bytes!=size)throw new WorkerError("SOURCE_CHANGED");if(copied.Bytes!=reported)Progress.Staging(copied.Bytes,size);
            if(copied.Sha256!=inputHash)throw new WorkerError(expectedHash is null?"SOURCE_CHANGED":"CORRUPT_INPUT","Source tree hash differs from the selected release.");
            Progress.Stage("Verifying staging copy",2,package:"VERIFYING",fakelib:hasLibraries?"VERIFYING":"NOT_REQUIRED");
            if(Files.TreeHash(copy,(completed,total)=>Progress.Operation("Verifying staging copy",2,completed,total,package:"VERIFYING",fakelib:hasLibraries?"VERIFYING":"NOT_REQUIRED"))!=inputHash) throw new WorkerError("SOURCE_CHANGED");packageSource=copy;
        }
        var backportStage=Path.Combine(stage,"backport");
        if(profile is not null&&profile.Delivery!="INTEGRATED") {
            Backports.CreateShadowMountOverlay(profile,packageSource,backportStage);
        }
        // Both images and installed packages stay reusable; 1.7beta2 applies the exact title overlay at launch.
        foreach(var directory in Directory.GetDirectories(packageSource).Where(d=>new[]{"fakelib","fakelib2"}.Contains(Path.GetFileName(d),StringComparer.OrdinalIgnoreCase))) {
            if(direct) {if(profile is null)Files.CopyTree(directory,Files.SafeRelative(backportStage,Path.GetFileName(directory).ToLowerInvariant()));}
            else if(profile is not null)Directory.Delete(directory,true);
            else { Directory.CreateDirectory(backportStage);Directory.Move(directory,Files.SafeRelative(backportStage,Path.GetFileName(directory).ToLowerInvariant())); }
        }
        if(!direct)foreach(var excluded in Directory.GetDirectories(packageSource).Where(Files.ExcludedFromBase))Directory.Delete(excluded,true);
        Progress.Stage("Building package",3,package:"BUILDING",fakelib:hasLibraries?"SEPARATED":"NOT_REQUIRED");
        var result=builder.Build(packageSource,build,before.Identity,(completed,total)=>Progress.Operation("Building package",3,completed,total,package:"BUILDING",fakelib:hasLibraries?"SEPARATED":"NOT_REQUIRED"));
        Progress.Stage("Inspecting output",4,package:"INSPECTING");
        var inspection=InputInspector.Inspect(result,before.Identity,out var artifactSha256,(completed,total)=>Progress.Operation("Inspecting output",4,completed,total,package:"INSPECTING"));
        var preparedIdentity=profile is not null&&profile.Delivery!="INTEGRATED"?InputInspector.ReadIdentity(File.ReadAllBytes(Files.SafeRelative(backportStage,"sce_sys/param.json"))):inspection.Identity;
        if(profile is not null&&profile.Delivery!="INTEGRATED"&&(preparedIdentity?.MinimumFirmware is null||decimal.Parse(preparedIdentity.MinimumFirmware,System.Globalization.CultureInfo.InvariantCulture)>decimal.Parse(profile.TargetFirmware,System.Globalization.CultureInfo.InvariantCulture)))throw new WorkerError("BACKPORT_PATCH_MISSING","The executable or builder still requires newer firmware; libraries and metadata alone are insufficient.");
        Progress.Stage("Rechecking source",4,package:"INSPECTING");
        if(sourceStamp is not null&&(profile is null?Files.BaseTreeStamp(input):Files.TreeStamp(input))!=sourceStamp)throw new WorkerError("SOURCE_CHANGED");
        if((direct?Files.BaseTreeHash(input,(completed,total)=>Progress.Operation("Rechecking source",4,completed,total,package:"INSPECTING")):Files.TreeHash(input,(completed,total)=>Progress.Operation("Rechecking source",4,completed,total,package:"INSPECTING")))!=inputHash)throw new WorkerError(expectedHash is null?"SOURCE_CHANGED":"CORRUPT_INPUT","Source tree hash differs from the selected release.");
        Progress.Stage("Verifying output",5,package:"VERIFYING");
        var hash=artifactSha256??Files.Hash(result,(completed,total)=>Progress.Operation("Verifying output",5,completed,total,package:"VERIFYING")); var final=Path.Combine(output,hash+"."+builder.Format);
        Progress.Stage("Publishing package",6,package:"PUBLISHING");
        if(!File.Exists(final)) File.Move(result,final);
        else if(Files.Hash(final,(completed,total)=>Progress.Operation("Verifying published package",6,completed,total,package:"PUBLISHING"))!=hash) throw new WorkerError("CORRUPT_INPUT");
        BackportCopy? backport=null;
        if(Directory.Exists(backportStage)) {
            Progress.Stage("Verifying separate libraries",6,fakelib:"VERIFYING");
            var backportHash=Files.TreeHash(backportStage,(completed,total)=>Progress.Operation("Verifying separate libraries",6,completed,total,package:"PUBLISHING",fakelib:"VERIFYING"));var backportSize=Files.Enumerate(backportStage).Sum(file=>new FileInfo(file).Length);
            var destination=Path.Combine(output,"backports",backportHash);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            if(!Directory.Exists(destination))Directory.Move(backportStage,destination);
            else if(Files.TreeHash(destination,(completed,total)=>Progress.Operation("Verifying published libraries",6,completed,total,package:"PUBLISHING",fakelib:"VERIFYING"))!=backportHash)throw new WorkerError("CACHE_CORRUPT");
            backport=new(destination,backportHash,backportSize);
        }
        var provenance=new BuildResult(final,builder.Format,hash,new FileInfo(final).Length,inputHash,builder.Version,releaseId,profile?.Id,DateTimeOffset.UtcNow,inspection,backport,"CLEAN_PACKAGE_EXTERNAL_BACKPORT_AND_SEPARATE_DLC",profile is null?null:Backports.Digest(profile));
        File.WriteAllText(final+".json",JsonSerializer.Serialize(provenance,Program.JsonOptions));
        Progress.Stage("Verified on server",7,package:"VERIFIED",fakelib:hasLibraries?"VERIFIED":"NOT_REQUIRED",fakelibBytes:backport?.Size);
        return provenance;
        }finally{if(Directory.Exists(stage))Directory.Delete(stage,true);}
    }
}
