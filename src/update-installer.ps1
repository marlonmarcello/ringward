$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public static class RingwardUpdate
{
    private const uint ReadData = 1;
    private const uint BackupSemantics = 0x02000000;
    private const uint OpenReparsePoint = 0x00200000;
    private const int ErrorCancelled = 1223;

    public static void Run(string file, string digest, string scope)
    {
        if (scope != "/currentuser" && scope != "/allusers")
            throw new ArgumentException("Invalid installation scope.");

        file = Path.GetFullPath(file);
        var drive = new DriveInfo(Path.GetPathRoot(file));
        if (drive.DriveType != DriveType.Fixed || drive.DriveFormat != "NTFS")
            throw new IOException("Automatic updates require local NTFS storage.");

        var directories = new Stack<DirectoryInfo>();
        for (var directory = Directory.GetParent(file); directory != null && directory.Parent != null; directory = directory.Parent)
            directories.Push(directory);

        // Pin the path from the drive root down before opening and hashing the payload.
        var locks = new Stack<SafeFileHandle>();
        try
        {
            foreach (var directory in directories)
                locks.Push(Open(directory.FullName, FileShare.Read | FileShare.Write, BackupSemantics));

            using (var handle = Open(file, FileShare.Read, 0))
            using (var stream = new FileStream(handle, FileAccess.Read))
            using (var hash = SHA256.Create())
            {
                var actual = BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "");
                if (!string.Equals(actual, digest, StringComparison.OrdinalIgnoreCase))
                {
                    Console.WriteLine("changed");
                    return;
                }

                var elevated = scope == "/allusers";
                var start = new ProcessStartInfo(file, "--updated /S --force-run " + scope)
                {
                    WorkingDirectory = Environment.SystemDirectory,
                    UseShellExecute = elevated,
                    Verb = elevated ? "runas" : ""
                };
                try
                {
                    using (var installer = Process.Start(start))
                    {
                        if (installer == null) throw new InvalidOperationException("Windows did not start the installer.");
                        // Wait for the UAC result before acknowledging launch. Keep the locks
                        // after Ringward exits while NSIS reads its payload from the executable.
                        Console.WriteLine("started");
                        Console.Out.Flush();
                        installer.WaitForExit();
                    }
                }
                catch (Win32Exception error)
                {
                    if (error.NativeErrorCode != ErrorCancelled) throw;
                    Console.WriteLine("cancelled");
                }
            }
        }
        finally
        {
            foreach (var handle in locks) handle.Dispose();
        }
    }

    private static SafeFileHandle Open(string file, FileShare share, uint flags)
    {
        var handle = CreateFile(file, ReadData, share, IntPtr.Zero, FileMode.Open, flags | OpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        FileAttributeTagInfo attributes;
        if (!GetFileInformationByHandleEx(handle, 9 /* FileAttributeTagInfo */, out attributes, 8))
        {
            var error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        if ((attributes.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            handle.Dispose();
            throw new IOException("The update path contains a redirect.");
        }
        return handle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInfo
    {
        public FileAttributes Attributes;
        public uint ReparseTag;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string file, uint access, FileShare share, IntPtr security,
        FileMode mode, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass,
        out FileAttributeTagInfo attributes, uint size);
}
'@
    [RingwardUpdate]::Run($env:RINGWARD_UPDATE_FILE, $env:RINGWARD_UPDATE_DIGEST, $env:RINGWARD_UPDATE_SCOPE)
} catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    exit 1
}
