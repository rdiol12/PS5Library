using System.Text.Json;
using System.Text.Json.Serialization;
namespace PS5Library.Worker;
public static class Program
{
    public static readonly JsonSerializerOptions JsonOptions=new() { PropertyNamingPolicy=JsonNamingPolicy.CamelCase,PropertyNameCaseInsensitive=true,WriteIndented=true,Converters={new JsonStringEnumConverter()} };
    public static int Main(string[] args)
    {
        var output=Console.Out; Console.SetOut(Console.Error);
        try
        {
            object result=args.Length>1 ? args[0] switch {
                "inspect"=>InputInspector.Inspect(args[1],args.Length>2?JsonSerializer.Deserialize<Identity>(args[2],JsonOptions):null),
                "build" when args.Length>=4=>Pipeline.Build(args[1],args[2],args[3],args.Length>4?JsonSerializer.Deserialize<Identity>(args[4],JsonOptions):null,args.Length>5?args[5]:null),
                "build-verified" when args.Length is 7 or 8=>Pipeline.Build(args[1],args[2],args[3],JsonSerializer.Deserialize<Identity>(args[4],JsonOptions),args[5],expectedHash:args[6],expectedSize:args.Length==8?long.Parse(args[7]):null),
                "hash-tree" when args.Length==2=>new { sha256=Files.TreeHash(args[1]),size=Files.Enumerate(args[1]).Sum(file=>new FileInfo(file).Length) },
                "extract-zip" when args.Length==4=>Extract(args[1],args[2],long.Parse(args[3])),
                "fself-to-elf" when args.Length==3=>ConvertModule(args[1],args[2],false),
                "elf-to-fself" when args.Length==3=>ConvertModule(args[1],args[2],true),
                _=>throw new WorkerError("UNSUPPORTED_INPUT","Commands: inspect, build, extract-zip, fself-to-elf, elf-to-fself")
            } : throw new WorkerError("USAGE","PS5Library.Worker <command> <input> [output] [method]");
            output.WriteLine(JsonSerializer.Serialize(result,JsonOptions)); return 0;
        }
        catch(Exception error) { output.WriteLine(JsonSerializer.Serialize(new { error=error is WorkerError w?w.Code:"WORKER_FAILED",message=error.Message },JsonOptions)); return 1; }
    }
    static object Extract(string input,string output,long maximum) { SafeExtract.Zip(input,output,maximum); return new { outputPath=Path.GetFullPath(output),inputHash=Files.Hash(input) }; }
    static object ConvertModule(string input,string output,bool sign)
    {
        if(new FileInfo(input).Length>512*1024*1024) throw new WorkerError("INPUT_TOO_LARGE");
        var bytes=File.ReadAllBytes(input); using(var target=new FileStream(output,FileMode.CreateNew,FileAccess.Write)) { target.Write(sign?Modules.FakeSign(bytes):Modules.ToElf(bytes)); target.Flush(true); }
        return new { outputPath=Path.GetFullPath(output),inputHash=Files.Hash(input),outputHash=Files.Hash(output),tested=false };
    }
}
