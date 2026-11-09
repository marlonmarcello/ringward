using System.Runtime.Loader;
using System.Text.Json;

Console.OutputEncoding = System.Text.Encoding.UTF8;

try
{
    var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
    if (args.Length != 1) throw new ArgumentException("Expected a regulation merge request file.");
    var request = JsonSerializer.Deserialize<MergeRequest>(File.ReadAllText(args[0]), options)
        ?? throw new InvalidDataException("Invalid merge request.");
    AssemblyLoadContext.Default.Resolving += (context, assembly) =>
    {
        var file = Path.Combine(request.Smithbox, assembly.Name + ".dll");
        return File.Exists(file) ? context.LoadFromAssemblyPath(file) : null;
    };
    Console.WriteLine(JsonSerializer.Serialize(RegulationMerge.Run(request), options));
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}

record MergeRequest(string Vanilla, string Smithbox, ModInput[] Mods, string? Output, bool AllowConflicts);
record ModInput(string Id, string Name, string Path, string? Table = null, string? Filename = null);
