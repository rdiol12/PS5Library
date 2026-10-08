using System.Text.Json;
namespace PS5Library.Worker;
public static class Progress
{
    private static string method="",packageState="WAITING",libraryState="UNKNOWN";
    private static long? libraryBytes;
    private static string operationStage="";
    private static long operationCompleted=-1,operationTotal=-1;
    private static DateTime operationReportedAt=DateTime.MinValue;
    public static void Extraction(long completed,long total) => Console.Error.WriteLine("PS5LIBRARY_PROGRESS "+JsonSerializer.Serialize(new {stage="Extracting archive",completedStages=0,totalStages=7,extraction=new {completedBytes=completed,totalBytes=total},package=new {method,state="EXTRACTING"},fakelib=new {state="WAITING"}}));
    public static void Staging(long completed,long total) => Console.Error.WriteLine("PS5LIBRARY_PROGRESS "+JsonSerializer.Serialize(new {stage="Copying to staging",completedStages=2,totalStages=7,staging=new {completedBytes=completed,totalBytes=total},package=new {method,state=packageState},fakelib=new {state=libraryState,size=libraryBytes}}));
    public static void Start(string installationMethod) {
        method=installationMethod;packageState="WAITING";libraryState="UNKNOWN";libraryBytes=null;operationStage="";operationCompleted=operationTotal=-1;operationReportedAt=DateTime.MinValue;
        Stage("Inspecting input",0);
    }
    public static void Stage(string stage,int completedStages,string? package=null,string? fakelib=null,long? fakelibBytes=null) {
        if(package is not null)packageState=package;if(fakelib is not null)libraryState=fakelib;if(fakelibBytes is not null)libraryBytes=fakelibBytes;
        // These upstream operations expose stages, not byte completion percentages.
        Console.Error.WriteLine("PS5LIBRARY_PROGRESS "+JsonSerializer.Serialize(new { stage,completedStages,totalStages=7,
            package=new {method,state=packageState},fakelib=new {state=libraryState,size=libraryBytes} }));
    }
    public static void Operation(string stage,int completedStages,long completed,long total,string? package=null,string? fakelib=null) {
        if(completed<0||total<completed)throw new WorkerError("CORRUPT_INPUT","Invalid byte progress.");
        if(package is not null)packageState=package;if(fakelib is not null)libraryState=fakelib;
        if(stage==operationStage&&completed==operationCompleted&&total==operationTotal)return;
        var now=DateTime.UtcNow;if(stage==operationStage&&completed!=total&&(now-operationReportedAt).TotalMilliseconds<500)return;
        operationStage=stage;operationCompleted=completed;operationTotal=total;operationReportedAt=now;
        Console.Error.WriteLine("PS5LIBRARY_PROGRESS "+JsonSerializer.Serialize(new {stage,completedStages,totalStages=7,
            operation=new {completedBytes=completed,totalBytes=total},package=new {method,state=packageState},fakelib=new {state=libraryState,size=libraryBytes}}));
    }
}
