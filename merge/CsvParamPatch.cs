using System.Globalization;
using System.Text;
using Microsoft.VisualBasic.FileIO;
using Andre.Formats;

sealed class CsvParamPatch : IDisposable
{
    private readonly TextFieldParser parser;
    private readonly int width;
    public bool HasName { get; }
    public string[] Fields { get; }

    public CsvParamPatch(string path)
    {
        if (new FileInfo(path).Length > 64 * 1024 * 1024)
            throw new InvalidDataException("CSV patches must be 64 MB or smaller.");
        var encoding = new UTF8Encoding(false, true);
        using var reader = new StreamReader(path, encoding);
        var first = reader.ReadLine() ?? "";
        var separator = first.FirstOrDefault(c => c is ',' or ';' or '\t');
        if (separator == '\0') throw new InvalidDataException("Expected a Smithbox CSV header starting with ID.");
        parser = new TextFieldParser(path, encoding)
        {
            Delimiters = [separator.ToString()],
            HasFieldsEnclosedInQuotes = true,
            TrimWhiteSpace = true
        };
        try
        {
            var header = parser.ReadFields() ?? [];
            width = Array.FindLastIndex(header, value => value.Length > 0) + 1;
            if (width < 2 || !string.Equals(header[0], "ID", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Expected a Smithbox CSV header starting with ID.");
            HasName = string.Equals(header[1], "Name", StringComparison.OrdinalIgnoreCase);
            Fields = header[(HasName ? 2 : 1)..width];
            if (Fields.Any(string.IsNullOrEmpty)) throw new InvalidDataException("The CSV header has an unnamed column.");
        }
        catch
        {
            parser.Dispose();
            throw;
        }
    }

    public IEnumerable<(int Id, string? Name, string[] Values)> ReadRows()
    {
        var seen = new HashSet<int>();
        while (!parser.EndOfData)
        {
            var line = parser.LineNumber;
            string[] row;
            try { row = parser.ReadFields() ?? []; }
            catch (MalformedLineException error) { throw new InvalidDataException($"Malformed CSV on line {line}.", error); }
            if (row.Length < width || row.Skip(width).Any(value => value.Length != 0))
                throw new InvalidDataException($"CSV line {line} has a different column count from the header.");
            if (!int.TryParse(row[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var id))
                throw new InvalidDataException($"CSV line {line} has an invalid row ID.");
            if (!seen.Add(id)) throw new InvalidDataException($"CSV row ID {id} occurs more than once.");
            var name = HasName && row[1] is not ("" or "null") ? row[1] : null;
            yield return (id, name, row[(HasName ? 2 : 1)..width]);
        }
        if (seen.Count == 0) throw new InvalidDataException("The CSV contains no parameter rows.");
    }

    public static object ParseValue(string value, Param.Column column, int id)
    {
        try
        {
            if (column.ValueType == typeof(byte[]))
            {
                if (value.Length < 2 || value[0] != '[' || value[^1] != ']') throw new FormatException();
                var bytes = value[1..^1].Split('|');
                if (bytes.Length != column.Def.ArrayLength) throw new FormatException();
                return bytes.Select(item => byte.Parse(item, CultureInfo.InvariantCulture)).ToArray();
            }
            var parsed = Convert.ChangeType(value, column.ValueType, CultureInfo.InvariantCulture);
            if (column.Def.BitSize > 0 && Convert.ToUInt64(parsed, CultureInfo.InvariantCulture) >= (1UL << column.Def.BitSize))
                throw new OverflowException();
            return parsed;
        }
        catch (Exception error) when (error is FormatException or OverflowException or InvalidCastException)
        {
            throw new InvalidDataException($"Row {id} has an invalid value for {column.Def.InternalName}.", error);
        }
    }

    public static bool IsZeroPadding(string value, int length)
    {
        if (length == 1 && value == "0") return true;
        if (value.Length < 2 || value[0] != '[' || value[^1] != ']') return false;
        var bytes = value[1..^1].Split('|');
        return bytes.Length == length && bytes.All(item => item.Trim() == "0");
    }

    public void Dispose() => parser.Dispose();
}
