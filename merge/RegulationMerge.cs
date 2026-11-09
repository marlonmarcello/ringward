using Andre.Formats;
using SoulsFormats;
using System.Globalization;
using System.Text.Json;

record MergeConflict(string Table, int Row, int Index, string Field, string Previous, string Next,
    string PreviousValue, string NextValue);
record MergeSource(string Name, string Version, int Changes, string? Table = null, int RetiredPadding = 0);
record MergeReport(string Version, List<MergeSource> Sources, int ConflictCount,
    List<MergeConflict> Conflicts, bool Built);

// Smithbox's regulation merge derives a per-field delta from the corresponding vanilla
// regulation, then applies the resolved deltas to the current vanilla regulation.
// Use Smithbox's actual PARAM reader, definitions and regulation encoder in this worker.
sealed class RegulationMerge(string assets, ulong installedVersion)
{
    private readonly record struct RowKey(int Id, int Index);
    private enum Operation { Edit, Add, Delete }
    private record Choice(ModInput Mod, object? Value);
    private sealed record RowPatch(Operation Operation, ModInput Mod, Dictionary<int, Choice> Cells);
    private sealed record Table(BinderFile File, Param Param, Dictionary<RowKey, Param.Row> Rows,
        Dictionary<string, int> Fields, Dictionary<RowKey, RowPatch> Patches);

    private readonly Dictionary<string, PARAMDEF> defs = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, Table> tables = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<MergeConflict> conflicts = [];
    private int conflictCount;

    public static MergeReport Run(MergeRequest request)
    {
        var assets = Path.Combine(request.Smithbox, "Assets", "PARAM", "ER");
        using var current = SFUtil.DecryptERRegulation(request.Vanilla);
        var merger = new RegulationMerge(assets, ParseVersion(current));
        foreach (var file in Directory.EnumerateFiles(Path.Combine(assets, "Defs"), "*.xml"))
        {
            var def = PARAMDEF.XmlDeserialize(file, versionAware: true);
            merger.defs.TryAdd(def.ParamType, def);
        }
        var currentFiles = Entries(current);
        var sources = new List<MergeSource>();
        foreach (var mod in request.Mods)
        {
            try
            {
                if (mod.Filename is not null)
                {
                    sources.Add(merger.AddCsv(mod, currentFiles, current.Version));
                    continue;
                }
                using var input = SFUtil.DecryptERRegulation(mod.Path);
                var sourceVersion = ParseVersion(input);
                if (sourceVersion > merger.version) throw new InvalidDataException("This mod targets a newer game regulation.");
                if (sourceVersion == merger.version)
                {
                    sources.Add(new(mod.Name, input.Version, merger.AddChanges(mod, input, currentFiles, currentFiles)));
                }
                else
                {
                    using var older = merger.Historical(sourceVersion);
                    sources.Add(new(mod.Name, input.Version, merger.AddChanges(mod, input, Entries(older), currentFiles)));
                }
            }
            catch (Exception error)
            {
                throw new InvalidDataException($"{mod.Name}: {error.Message}", error);
            }
        }

        var built = request.Output is not null && (merger.conflictCount == 0 || request.AllowConflicts);
        if (built)
        {
            merger.Apply();
            SFUtil.EncryptERRegulation(request.Output!, current);
            using var verified = SFUtil.DecryptERRegulation(request.Output!);
            if (verified.Version != current.Version || verified.Files.Count != current.Files.Count)
                throw new InvalidDataException("The generated regulation could not be verified.");
        }
        return new(current.Version, sources, merger.conflictCount, merger.conflicts, built);
    }

    private readonly ulong version = installedVersion;

    private static ulong ParseVersion(BND4 binder) => ulong.TryParse(binder.Version, out var parsed)
        ? parsed : throw new InvalidDataException("The file has an unrecognized regulation version.");

    private static Dictionary<string, BinderFile> Entries(BND4 binder) =>
        binder.Files.ToDictionary(file => file.Name, StringComparer.OrdinalIgnoreCase);

    private BND4 Historical(ulong sourceVersion)
    {
        var directory = Path.Combine(assets, "Regulations");
        var file = Directory.EnumerateDirectories(directory, $"* ({sourceVersion})")
            .Select(folder => Path.Combine(folder, "regulation.bin")).SingleOrDefault(File.Exists);
        if (file is null) throw new InvalidDataException($"Smithbox has no vanilla baseline for regulation {sourceVersion}. Update the mod for your game version.");
        var binder = SFUtil.DecryptERRegulation(file);
        if (ParseVersion(binder) == sourceVersion) return binder;
        binder.Dispose();
        throw new InvalidDataException("The historical vanilla regulation has the wrong version.");
    }

    private Param Read(BinderFile file, ulong sourceVersion)
    {
        var param = Param.ReadIgnoreCompression(file.Bytes);
        var type = param.ParamType ?? "";
        if (!defs.TryGetValue(type, out var def)) throw new InvalidDataException($"Smithbox has no definition for {type}.");
        // Elden Ring's stock tables use these short layouts. Smithbox expands them before applying paramdefs.
        if (sourceVersion >= 10601000 && type == "CHR_MODEL_PARAM_ST") param.ExpandParamSize(12, 16);
        if (sourceVersion >= 11210015)
        {
            if (type == "GAME_SYSTEM_COMMON_PARAM_ST") param.ExpandParamSize(880, 1024);
            if (type == "POSTURE_CONTROL_PARAM_WEP_RIGHT_ST") param.ExpandParamSize(112, 144);
            if (type == "SIGN_PUDDLE_PARAM_ST") param.ExpandParamSize(32, 48);
        }
        var filename = Path.GetFileNameWithoutExtension(file.Name.Replace('\\', '/'));
        param.ApplyParamdef(def, sourceVersion, filename);
        return param;
    }

    private int AddChanges(ModInput mod, BND4 source, Dictionary<string, BinderFile> baseline,
        Dictionary<string, BinderFile> current)
    {
        var inputs = Entries(source);
        var sourceVersion = ParseVersion(source);
        var count = 0;
        foreach (var (name, file) in inputs)
        {
            if (!baseline.TryGetValue(name, out var original))
                throw new InvalidDataException($"Adds an unsupported regulation entry {Display(name)}.");
            if (file.Bytes.Span.SequenceEqual(original.Bytes.Span)) continue;
            if (!name.EndsWith(".param", StringComparison.OrdinalIgnoreCase) || !current.TryGetValue(name, out var target))
                throw new InvalidDataException($"Changes an unsupported regulation entry {Display(name)}.");

            try
            {
                var table = GetTable(target);
                var before = ReferenceEquals(current, baseline) ? table.Param : Read(original, sourceVersion);
                var after = Read(file, sourceVersion);
                if (before.ParamType != after.ParamType || before.ParamType != table.Param.ParamType ||
                    before.RowSize != after.RowSize || before.BigEndian != after.BigEndian ||
                    before.ParamdefDataVersion != after.ParamdefDataVersion)
                    throw new InvalidDataException("The parameter layout differs from vanilla.");
                count += Compare(mod, table, before, after);
            }
            catch (Exception error)
            {
                throw new InvalidDataException($"{Display(name)}: {error.Message}", error);
            }
        }
        var removed = baseline.Keys.FirstOrDefault(name => !inputs.ContainsKey(name));
        if (removed is not null) throw new InvalidDataException($"Removes an unsupported regulation entry {Display(removed)}.");
        return count;
    }

    private Table GetTable(BinderFile file)
    {
        if (tables.TryGetValue(file.Name, out var table)) return table;
        var param = Read(file, version);
        table = new(file, param, MapRows(param), MapFields(param), []);
        tables.Add(file.Name, table);
        return table;
    }

    private BinderFile CsvTable(ModInput input, string[] fields, Dictionary<string, BinderFile> current)
    {
        var available = current.Values.Where(file => file.Name.EndsWith(".param", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(file => Display(file.Name), StringComparer.OrdinalIgnoreCase);
        var name = string.IsNullOrEmpty(input.Table) ? Path.GetFileNameWithoutExtension(input.Filename!) : input.Table;
        if (available.TryGetValue(name, out var match)) return match;
        if (!string.IsNullOrEmpty(input.Table))
            throw new InvalidDataException($"The installed regulation has no Smithbox table named {input.Table}.");
        if (fields.Length > 0)
        {
            using var info = JsonDocument.Parse(File.ReadAllText(Path.Combine(assets, "Param Type Info.json")),
                new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
            var required = CsvFieldKeys(fields).ToArray();
            var candidates = info.RootElement.GetProperty("Mapping").EnumerateObject()
                .Where(entry => available.ContainsKey(entry.Name) && defs.TryGetValue(entry.Value.GetString() ?? "", out var def) &&
                    required.All(MapDefFields(def).Contains))
                .Select(entry => entry.Name).ToList();
            if (candidates.Count == 1) return available[candidates[0]];
            if (candidates.Count > 1)
                throw new InvalidDataException($"The CSV matches several tables ({string.Join(", ", candidates.Take(6))}). Choose the table in Manage.");
        }
        throw new InvalidDataException("Could not identify the CSV table from its name or columns. Enter the Smithbox table name in Manage.");
    }

    private bool IsRetiredPadding(PARAMDEF.Field field) =>
        field.DisplayType == PARAMDEF.DefType.dummy8 && field.InternalName.StartsWith("pad", StringComparison.OrdinalIgnoreCase) &&
        field.RemovedRegulationVersion > 0 && field.RemovedRegulationVersion <= version;

    private HashSet<string> MapDefFields(PARAMDEF definition)
    {
        var current = CsvFieldKeys(definition.Fields.Where(field => field.IsValidForRegulationVersion(version))
            .Select(field => field.InternalName)).ToHashSet();
        current.UnionWith(CsvFieldKeys(definition.Fields.Where(IsRetiredPadding).Select(field => field.InternalName)));
        return current;
    }

    private static IEnumerable<string> CsvFieldKeys(IEnumerable<string> fields)
    {
        var occurrences = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var name in fields)
        {
            var occurrence = occurrences.GetValueOrDefault(name);
            occurrences[name] = occurrence + 1;
            yield return FieldKey(name, occurrence);
        }
    }

    private static string FieldKey(string name, int occurrence) => name + "\u0000" + occurrence;

    private MergeSource AddCsv(ModInput input, Dictionary<string, BinderFile> current, string gameVersion)
    {
        using var csv = new CsvParamPatch(input.Path);
        var target = CsvTable(input, csv.Fields, current);
        var table = GetTable(target);
        var retired = defs[table.Param.ParamType!].Fields.Where(IsRetiredPadding)
            .GroupBy(field => field.InternalName).Where(group => group.Count() == 1)
            .ToDictionary(group => group.Key, group => group.Single().ArrayLength);
        var columns = CsvFieldKeys(csv.Fields).Select((key, index) =>
        {
            if (table.Fields.TryGetValue(key, out var column)) return (Index: column, Padding: 0);
            if (key == FieldKey(csv.Fields[index], 0) && retired.TryGetValue(csv.Fields[index], out var length))
                return (Index: -1, Padding: length);
            throw new InvalidDataException($"Field {csv.Fields[index]} is unavailable in {Display(target.Name)} for the installed game.");
        }).ToArray();
        var mapped = columns.Count(column => column.Index >= 0);
        var count = 0;
        foreach (var (id, name, values) in csv.ReadRows())
        {
            var key = new RowKey(id, 0);
            if (table.Rows.ContainsKey(new(id, 1)))
                throw new InvalidDataException($"Row ID {id} is duplicated in {Display(target.Name)}. Edit that row in Smithbox.");
            table.Rows.TryGetValue(key, out var vanilla);
            var cells = new Dictionary<int, Choice>();
            if (csv.HasName && (vanilla is null || !Equal(vanilla.Name, name))) cells[-1] = new(input, name);
            for (var i = 0; i < columns.Length; i++)
            {
                var (index, padding) = columns[i];
                if (index < 0)
                {
                    if (!CsvParamPatch.IsZeroPadding(values[i], padding))
                        throw new InvalidDataException($"Row {id} has data in retired padding field {csv.Fields[i]}.");
                    continue;
                }
                var column = table.Param.Columns[index];
                var value = CsvParamPatch.ParseValue(values[i], column, id);
                if (vanilla is null || !Equal(column.GetValue(vanilla), value)) cells[index] = new(input, value);
            }
            if (cells.Count == 0) continue;
            if (vanilla is null && mapped != table.Param.Columns.Count)
            {
                if (!table.Patches.TryGetValue(key, out var added) || added.Operation != Operation.Add)
                    throw new InvalidDataException($"New row {id} needs all fields for {Display(target.Name)} or a mod that adds the row earlier in the load order.");
                MergeFields(table, key, added, new(Operation.Add, input, cells));
                count += cells.Count;
                continue;
            }
            Merge(table, key, new(vanilla is null ? Operation.Add : Operation.Edit, input, cells));
            count += vanilla is null ? 1 : cells.Count;
        }
        return new(input.Name, gameVersion, count, Display(target.Name), columns.Length - mapped);
    }

    private static string Display(string name) => Path.GetFileNameWithoutExtension(name.Replace('\\', '/'));

    private static Dictionary<RowKey, Param.Row> MapRows(Param param)
    {
        var indexes = new Dictionary<int, int>();
        var result = new Dictionary<RowKey, Param.Row>();
        foreach (var row in param.Rows)
        {
            var index = indexes.GetValueOrDefault(row.ID);
            result.Add(new(row.ID, index), row);
            indexes[row.ID] = index + 1;
        }
        return result;
    }

    private static Dictionary<string, int> MapFields(Param param)
    {
        return CsvFieldKeys(param.Columns.Select(column => column.Def.InternalName))
            .Select((key, index) => (key, index)).ToDictionary(item => item.key, item => item.index, StringComparer.Ordinal);
    }

    private static bool Equal(object? a, object? b) => (a, b) switch
    {
        (byte[] left, byte[] right) => left.AsSpan().SequenceEqual(right),
        (float left, float right) => BitConverter.SingleToInt32Bits(left) == BitConverter.SingleToInt32Bits(right),
        (double left, double right) => BitConverter.DoubleToInt64Bits(left) == BitConverter.DoubleToInt64Bits(right),
        _ => Equals(a, b)
    };

    private int Compare(ModInput mod, Table table, Param before, Param after)
    {
        var originals = MapRows(before);
        var modified = MapRows(after);
        var fields = MapFields(after);
        if (!originals.Keys.Where(modified.ContainsKey).SequenceEqual(modified.Keys.Where(originals.ContainsKey)))
            throw new InvalidDataException("Changes the order of existing rows. Merge this table manually in Smithbox.");
        var oldCounts = RowCounts(originals);
        var newCounts = RowCounts(modified);
        var currentCounts = ReferenceEquals(before, table.Param) ? oldCounts : RowCounts(table.Rows);
        var count = 0;
        foreach (var key in originals.Keys.Union(modified.Keys))
        {
            originals.TryGetValue(key, out var previous);
            modified.TryGetValue(key, out var next);
            table.Rows.TryGetValue(key, out var current);
            if (next is null)
            {
                if (current is null) continue;
                if (AmbiguousUpgrade(key, oldCounts, currentCounts))
                    throw new InvalidDataException($"The installed game changed the number of rows with ID {key.Id}.");
                Merge(table, key, new(Operation.Delete, mod, []));
                count++;
                continue;
            }

            var cells = new Dictionary<int, Choice>();
            if (previous is null || previous.Name != next.Name) cells[-1] = new(mod, next.Name);
            foreach (var (field, index) in fields)
            {
                var column = after.Columns[index];
                var value = column.GetValue(next);
                if (previous is not null && Equal(value, before.Columns[index].GetValue(previous))) continue;
                if (!table.Fields.TryGetValue(field, out var targetIndex) || !Compatible(column, table.Param.Columns[targetIndex]))
                    throw new InvalidDataException($"Row {key.Id} changes a field unavailable in your game version ({column.Def.InternalName}).");
                cells[targetIndex] = new(mod, value);
            }
            if (cells.Count == 0) continue;
            if (AmbiguousUpgrade(key, oldCounts, currentCounts))
                throw new InvalidDataException($"The installed game changed the number of rows with ID {key.Id}.");
            var oldCount = oldCounts.GetValueOrDefault(key.Id);
            var newCount = newCounts.GetValueOrDefault(key.Id);
            if (previous is not null && oldCount != newCount && Math.Max(oldCount, newCount) > 1)
                throw new InvalidDataException($"Changes the count and contents of duplicate rows with ID {key.Id}. Merge those rows manually in Smithbox.");
            if (previous is null)
            {
                if (current is not null) throw new InvalidDataException($"New row {key.Id} already exists in the installed game version.");
                if (cells.Count != table.Fields.Count + 1)
                    throw new InvalidDataException($"New row {key.Id} uses an older schema. Use an updated version of this mod.");
            }
            else if (current is null)
            {
                throw new InvalidDataException($"Edited row {key.Id} is missing from your game version.");
            }
            Merge(table, key, new(previous is null ? Operation.Add : Operation.Edit, mod, cells));
            count += previous is null ? 1 : cells.Count;
        }
        return count;
    }

    private static Dictionary<int, int> RowCounts(Dictionary<RowKey, Param.Row> rows) =>
        rows.Keys.GroupBy(key => key.Id).ToDictionary(group => group.Key, group => group.Count());

    private static bool AmbiguousUpgrade(RowKey row, Dictionary<int, int> original, Dictionary<int, int> current)
    {
        var before = original.GetValueOrDefault(row.Id);
        var after = current.GetValueOrDefault(row.Id);
        return before != after && Math.Max(before, after) > 1;
    }

    private static bool Compatible(Param.Column a, Param.Column b) =>
        a.Def.DisplayType == b.Def.DisplayType && a.Def.ArrayLength == b.Def.ArrayLength && a.Def.BitSize == b.Def.BitSize;

    private void Merge(Table table, RowKey row, RowPatch incoming)
    {
        if (!table.Patches.TryGetValue(row, out var previous))
        {
            table.Patches.Add(row, incoming);
            return;
        }
        if (previous.Operation != Operation.Edit || incoming.Operation != Operation.Edit)
        {
            var same = previous.Operation == incoming.Operation && previous.Cells.Count == incoming.Cells.Count &&
                previous.Cells.All(cell => incoming.Cells.TryGetValue(cell.Key, out var other) && Equal(cell.Value.Value, other.Value));
            if (!same) AddConflict(table, row, "Entire row", previous.Mod, incoming.Mod, previous.Operation, incoming.Operation);
            table.Patches[row] = incoming;
            return;
        }
        MergeFields(table, row, previous, incoming);
    }

    private void MergeFields(Table table, RowKey row, RowPatch previous, RowPatch incoming)
    {
        foreach (var (index, cell) in incoming.Cells)
        {
            if (previous.Cells.TryGetValue(index, out var prior) && !Equal(prior.Value, cell.Value))
            {
                var field = index == -1 ? "Row name" : table.Param.Columns[index].Def.InternalName;
                AddConflict(table, row, field, prior.Mod, cell.Mod, prior.Value, cell.Value);
            }
            previous.Cells[index] = cell;
        }
        table.Patches[row] = previous with { Mod = incoming.Mod };
    }

    private void AddConflict(Table table, RowKey row, string field, ModInput previous, ModInput next,
        object? previousValue, object? nextValue)
    {
        conflictCount++;
        if (conflicts.Count >= 300) return;
        static string Format(object? value) => value is byte[] bytes
            ? Convert.ToHexString(bytes.AsSpan(0, Math.Min(bytes.Length, 40))) : Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
        conflicts.Add(new(Display(table.File.Name), row.Id, row.Index, field, previous.Name, next.Name,
            Format(previousValue), Format(nextValue)));
    }

    private void Apply()
    {
        foreach (var table in tables.Values.Where(table => table.Patches.Count > 0))
        {
            foreach (var (key, patch) in table.Patches)
            {
                if (patch.Operation == Operation.Delete)
                {
                    table.Rows.Remove(key);
                    continue;
                }
                var row = patch.Operation == Operation.Add
                    ? table.Rows[key] = new Param.Row(key.Id, null, table.Param)
                    : table.Rows[key];
                foreach (var (index, cell) in patch.Cells)
                {
                    if (index == -1) row.Name = (string?)cell.Value;
                    else table.Param.Columns[index].SetValue(row, cell.Value!);
                }
            }
            var sorted = table.Param.Rows.Select(row => row.ID).SequenceEqual(table.Param.Rows.Select(row => row.ID).Order());
            table.Param.ClearRows();
            var rows = sorted ? table.Rows.OrderBy(pair => pair.Key.Id).ThenBy(pair => pair.Key.Index) : table.Rows.AsEnumerable();
            foreach (var pair in rows) table.Param.AddRow(pair.Value);
            table.File.Bytes = table.Param.Write();
        }
    }
}
