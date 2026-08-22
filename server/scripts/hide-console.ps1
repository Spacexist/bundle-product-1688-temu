$signature = @"
using System;
using System.Runtime.InteropServices;

/// <summary>Win32 helpers used to hide the current startup console.</summary>
public static class NativeConsole
{
    /// <summary>Return the console window attached to this process.</summary>
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();

    /// <summary>Change the visibility state of a native window.</summary>
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

Add-Type -TypeDefinition $signature
[NativeConsole]::ShowWindow([NativeConsole]::GetConsoleWindow(), 0) | Out-Null
