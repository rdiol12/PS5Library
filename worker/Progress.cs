using System.Text.Json;
namespace PS5Library.Worker;
public static class Progress
{
    public static void Stage(string stage,int completedStages) => Console.Error.WriteLine("PS5LIBRARY_PROGRESS "+JsonSerializer.Serialize(new { stage,completedStages,totalStages=7 }));
}
