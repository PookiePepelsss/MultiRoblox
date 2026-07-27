// RobloxNative.exe -- precompiled native helper that replaces the three
// PowerShell scripts (mutex.ps1, closehandles.ps1, audiovol.ps1).
//
// Why: every PowerShell invocation paid for powershell.exe startup AND an
// Add-Type C# compile on each call. Closing singleton handles runs before
// *every* launch and setting volume runs on every slider change, so that
// overhead was felt constantly. This is the same C# compiled once, ahead of
// time, and spawned directly -- no PowerShell, no per-call JIT/compile.
//
// Subcommands:
//   RobloxNative.exe daemon         -> THE mode the app actually uses. One
//                                      resident process for the entire
//                                      MultiRoblox session: it holds the
//                                      singleton mutexes, runs anti-AFK and
//                                      the PID watcher on background threads,
//                                      and serves closehandles/volume/pids/
//                                      capture as requests over stdin/stdout.
//                                      Exits when stdin hits EOF -- i.e. the
//                                      moment MultiRoblox itself is gone --
//                                      so the helper can never outlive its
//                                      parent or pile up one-per-launch.
//
//                                      Line protocol (UTF-8, '|' separated):
//                                        in   <id>|<cmd>[|arg...]
//                                        out  R|<id>|OK|<payload>
//                                             R|<id>|ERR|<message>
//                                             E|<event>|<payload>
//                                      Requests are answered by id, so a slow
//                                      capture never head-of-line blocks a
//                                      pids poll. Events (READY, PIDS, AFK)
//                                      are pushed unsolicited.
//
// The single-shot subcommands below predate daemon mode and are kept for
// manual debugging (and so build.bat's smoke test still works) -- the app
// itself no longer spawns any of them.
//
//   RobloxNative.exe mutex          -> hold ROBLOX_singletonMutex for the
//                                      session; prints MUTEX_HELD then blocks.
//   RobloxNative.exe closehandles   -> close ROBLOX_singletonEvent handles on
//                                      running Roblox; prints HANDLES_DONE.
//   RobloxNative.exe volume <0-100> -> set OS volume on every Roblox audio
//                                      session; prints SET:<count>.
//   RobloxNative.exe pids           -> one-shot: print each running
//                                      RobloxPlayerBeta PID on its own line,
//                                      then exit. Uses .NET's own
//                                      Process.GetProcessesByName instead of
//                                      shelling out to tasklist.exe/cmd.exe.
//   RobloxNative.exe watch [ms]     -> resident: print "PIDS:1,2,3" on the
//                                      given interval (default 2000ms) and
//                                      keep running. Used by the Rust watch
//                                      loop so it isn't spawning a fresh
//                                      process every poll tick.
//   RobloxNative.exe capture <pid> [xFrac yFrac wFrac hFrac] -> screenshot
//                                      that window (optionally cropped to a
//                                      fractional sub-rectangle, 0-1 of the
//                                      captured width/height), print
//                                      "CAPTURED_B64:<base64 png>" to stdout.
//                                      No disk write -- encoded straight from
//                                      a MemoryStream so the caller decides
//                                      what to do with the bytes (save,
//                                      upload, preview).
//
// Build (done once, by the app or build.bat) with the .NET Framework compiler:
//   csc /nologo /optimize+ /platform:x64 /target:exe /out:RobloxNative.exe RobloxNative.cs

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

internal static class RobloxNative
{
    private static int Main(string[] args)
    {
        try
        {
            string cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "";
            switch (cmd)
            {
                case "mutex":        return RunMutex();
                case "closehandles": return RunCloseHandles();
                case "volume":       return RunVolume(args);
                case "antiafk":      return RunAntiAfk(args);
                case "pids":         return RunPids();
                case "watch":        return RunWatch(args);
                case "capture":      return RunCapture(args);
                case "daemon":       return Daemon.Run();
                default:
                    Console.Error.WriteLine("Unknown command. Use: daemon | mutex | closehandles | volume <0-100> | antiafk <seconds> | pids | watch [ms] | capture <pid> [xFrac yFrac wFrac hFrac]");
                    return 2;
            }
        }
        catch (Exception ex)
        {
            // Never crash silently -- the parent process reads stderr.
            Console.Error.WriteLine("RobloxNative fatal: " + ex);
            return 1;
        }
    }

    // ── Persistent mutex holder ────────────────────────────────────────────
    // Hold ROBLOX_singletonMutex first (cheap, and the object Roblox's singleton
    // check keys off), signal readiness, THEN do the slow handle scan. The Mutex
    // objects are rooted in static fields so GC can't finalize them and silently
    // drop the hold.
    private static Mutex _singletonMutex;
    private static Mutex _singletonEventMutex;

    private static int RunMutex()
    {
        // Step 1: own the singleton mutex immediately.
        try
        {
            bool created;
            _singletonMutex = new Mutex(true, "ROBLOX_singletonMutex", out created);
            if (!created) { try { _singletonMutex.WaitOne(0); } catch (AbandonedMutexException) { } catch { } }
        }
        catch (Exception ex) { Console.Error.WriteLine("HoldMutex: " + ex.Message); }

        // Step 2: signal readiness NOW, before the slow scan, so the app never
        // lets the first launch race an unheld mutex.
        Console.Out.WriteLine("MUTEX_HELD");
        Console.Out.Flush();

        // Step 3: slow part -- close existing event handles, then hold that name.
        try { HandleCloser.CloseRobloxSingletonHandles(); }
        catch (Exception ex) { Console.Error.WriteLine("CloseHandles(mutex): " + ex.Message); }

        try
        {
            bool created;
            _singletonEventMutex = new Mutex(true, "ROBLOX_singletonEvent", out created);
            if (!created) { try { _singletonEventMutex.WaitOne(0); } catch (AbandonedMutexException) { } catch { } }
        }
        catch (Exception ex) { Console.Error.WriteLine("HoldEventMutex: " + ex.Message); }

        // Keep alive (and keep the owning thread + static refs alive) forever.
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }

    // ── One-shot handle closer ─────────────────────────────────────────────
    private static int RunCloseHandles()
    {
        try { HandleCloser.CloseRobloxSingletonHandles(); }
        catch (Exception ex) { Console.Error.WriteLine("CloseHandles: " + ex.Message); }
        Console.Out.WriteLine("HANDLES_DONE");
        Console.Out.Flush();
        return 0;
    }

    // ── Volume ─────────────────────────────────────────────────────────────
    private static int RunVolume(string[] args)
    {
        int pct = 0;
        if (args.Length > 1) int.TryParse(args[1], out pct);
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        float level = pct / 100.0f;

        int[] pids;
        try
        {
            var procs = Process.GetProcessesByName("RobloxPlayerBeta");
            pids = new int[procs.Length];
            for (int i = 0; i < procs.Length; i++) pids[i] = procs[i].Id;
        }
        catch { pids = new int[0]; }

        if (pids.Length == 0) { Console.Out.WriteLine("SET:0"); Console.Out.Flush(); return 0; }

        int n = 0;
        try { n = AudioControl.Apply(level, pids); }
        catch (Exception ex) { Console.Error.WriteLine("Volume: " + ex.Message); }
        Console.Out.WriteLine("SET:" + n);
        Console.Out.Flush();
        return 0;
    }

    // ── Anti-AFK ───────────────────────────────────────────────────────────
    // Roblox only registers input while a window is focused, so keeping every
    // instance alive means briefly focusing it and tapping a key. Each instance
    // gets its OWN deadline timer (see AntiAfk.RunLoop): the moment one reaches
    // the deadline it's tapped, others are untouched, and an instance you're
    // actively playing in the foreground is never tapped. Default deadline is
    // 18 min -- safely under Roblox's ~20-minute idle kick.
    private static int RunAntiAfk(string[] args)
    {
        int deadlineSec = 18 * 60; // tap each instance once it hits 18 min
        if (args.Length > 1) { int d; if (int.TryParse(args[1], out d)) deadlineSec = d; }
        if (deadlineSec < 60)   deadlineSec = 60;
        if (deadlineSec > 1140) deadlineSec = 1140; // never let it exceed 19 min (kick is ~20)

        // Optional virtual-key override (decimal). Default 0x10 = VK_SHIFT
        // (registers as input, moves nothing, opens no chat).
        int vk = 0x10;
        if (args.Length > 2) { int v; if (int.TryParse(args[2], out v) && v > 0 && v < 256) vk = v; }

        Console.Out.WriteLine("ANTIAFK_ON:" + deadlineSec);
        Console.Out.Flush();
        AntiAfk.RunLoop(deadlineSec, vk, pid => {
            Console.Out.WriteLine("ANTIAFK_TICK:" + pid);
            Console.Out.Flush();
        }, null);
        return 0;
    }

    // One-shot PID dump for the Rust watch loop -- Process.GetProcessesByName
    // is the same reliable, in-process enumeration AntiAfk already uses, so
    // the watch loop no longer has to shell out to tasklist.exe/cmd.exe and
    // regex-parse CSV (which can silently miss/misread under load).
    private static int RunPids()
    {
        foreach (var p in Process.GetProcessesByName("RobloxPlayerBeta"))
        {
            try { Console.Out.WriteLine(p.Id); } catch { }
        }
        return 0;
    }

    // Resident mode for the Rust watch loop: instead of spawning a fresh
    // process every poll tick (measurable CPU/AV-scan overhead at a 2s
    // cadence -- the reported cause of high idle CPU with instances open),
    // this stays running and reports PIDs on an interval, matching the same
    // long-lived-helper pattern mutex/antiafk already use. The Rust side
    // just reads whatever this already-running process last printed.
    private static int RunWatch(string[] args)
    {
        int intervalMs = 2000;
        if (args.Length > 1) { int v; if (int.TryParse(args[1], out v) && v >= 250) intervalMs = v; }
        while (true)
        {
            var ids = new System.Collections.Generic.List<string>();
            foreach (var p in Process.GetProcessesByName("RobloxPlayerBeta"))
            {
                try { ids.Add(p.Id.ToString()); } catch { }
            }
            Console.Out.WriteLine("PIDS:" + string.Join(",", ids));
            Console.Out.Flush();
            Thread.Sleep(intervalMs);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    // Screenshots one Roblox window (by PID), optionally cropped to a
    // fractional sub-rectangle of the captured image, and prints the PNG as
    // base64 -- no temp file. Briefly focuses/restores the window like
    // AntiAfk's taps do, since a minimised or occluded window can't be
    // captured correctly with CopyFromScreen.
    private static int RunCapture(string[] args)
    {
        if (args.Length < 2) { Console.Error.WriteLine("Capture requires a PID"); return 2; }
        int pid;
        if (!int.TryParse(args[1], out pid) || pid <= 0) { Console.Error.WriteLine("Invalid PID"); return 2; }

        double xFrac = 0, yFrac = 0, wFrac = 1, hFrac = 1;
        bool hasCrop = false;
        if (args.Length >= 6)
        {
            double x, y, w, h;
            if (double.TryParse(args[2], out x) && double.TryParse(args[3], out y) &&
                double.TryParse(args[4], out w) && double.TryParse(args[5], out h))
            {
                xFrac = x; yFrac = y; wFrac = w; hFrac = h;
                hasCrop = true;
            }
        }

        try
        {
            Console.Out.WriteLine("CAPTURED_B64:" + CaptureBase64(pid, hasCrop, xFrac, yFrac, wFrac, hFrac));
            Console.Out.Flush();
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("Capture: " + ex.Message);
            return 1;
        }
    }

    // Shared by the standalone subcommand and daemon mode. Throws with a
    // user-facing message on failure so daemon mode can forward it verbatim
    // as an ERR payload instead of inventing its own error text.
    public static string CaptureBase64(int pid, bool hasCrop, double xFrac, double yFrac, double wFrac, double hFrac)
    {
        Process process;
        try { process = Process.GetProcessById(pid); }
        catch { throw new Exception("Process not found"); }

        var hwnd = process.MainWindowHandle;
        if (hwnd == IntPtr.Zero) throw new Exception("Roblox window not found");

        bool wasMinimised = IsIconic(hwnd);
        try
        {
            if (wasMinimised) ShowWindowCapture(hwnd, SW_RESTORE_CAPTURE);
            AntiAfk.ForceForeground(hwnd);
            Thread.Sleep(150);

            RECT rect;
            if (!GetWindowRect(hwnd, out rect)) throw new Exception("Could not read Roblox window bounds");
            int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) throw new Exception("Roblox window has invalid bounds");

            using (var full = new Bitmap(width, height))
            {
                using (var g = Graphics.FromImage(full))
                {
                    g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height));
                }

                Bitmap output = full;
                Bitmap cropped = null;
                if (hasCrop)
                {
                    int cx = Clamp((int)(xFrac * width), 0, width - 1);
                    int cy = Clamp((int)(yFrac * height), 0, height - 1);
                    int cw = Clamp((int)(wFrac * width), 1, width - cx);
                    int ch = Clamp((int)(hFrac * height), 1, height - cy);
                    cropped = full.Clone(new Rectangle(cx, cy, cw, ch), full.PixelFormat);
                    output = cropped;
                }

                try
                {
                    using (var ms = new System.IO.MemoryStream())
                    {
                        output.Save(ms, ImageFormat.Png);
                        return Convert.ToBase64String(ms.ToArray());
                    }
                }
                finally { if (cropped != null) cropped.Dispose(); }
            }
        }
        finally
        {
            if (wasMinimised) ShowWindowCapture(hwnd, SW_MINIMIZE_CAPTURE);
        }
    }

    public static int[] RobloxPids()
    {
        try
        {
            var procs = Process.GetProcessesByName("RobloxPlayerBeta");
            var ids = new int[procs.Length];
            for (int i = 0; i < procs.Length; i++) ids[i] = procs[i].Id;
            return ids;
        }
        catch { return new int[0]; }
    }

    static int Clamp(int v, int min, int max) { return v < min ? min : (v > max ? max : v); }

    const int SW_RESTORE_CAPTURE = 9, SW_MINIMIZE_CAPTURE = 6;
    [DllImport("user32.dll", EntryPoint = "IsIconic")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", EntryPoint = "ShowWindow")] static extern bool ShowWindowCapture(IntPtr hWnd, int nCmdShow);
}

// ── ROBLOX_singletonEvent handle closing (ported from closehandles.ps1) ─────
internal static class HandleCloser
{
    [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int size, out int ret);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool DuplicateHandle(IntPtr srcProc, IntPtr srcHandle, IntPtr tgtProc, out IntPtr tgtHandle, int access, bool inherit, int opts);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtQueryObject(IntPtr h, int cls, IntPtr buf, int size, out int ret);

    const int SystemExtendedHandleInformation = 64;
    const int PROCESS_DUP_HANDLE = 0x0040;
    const int DUPLICATE_CLOSE_SOURCE = 0x1;
    const int DUPLICATE_SAME_ACCESS = 0x2;

    [StructLayout(LayoutKind.Sequential)]
    struct SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX
    {
        public IntPtr Object;
        public IntPtr UniqueProcessId;
        public IntPtr HandleValue;
        public int GrantedAccess;
        public short CreatorBackTraceIndex;
        public short ObjectTypeIndex;
        public int HandleAttributes;
        public int Reserved;
    }

    // Returns how many singleton-event handles were closed. Deliberately
    // writes nothing to stdout -- daemon mode multiplexes a line protocol
    // over that stream, and a stray "CLOSED:<pid>" would desync it.
    public static int CloseRobloxSingletonHandles()
    {
        int closed = 0;
        var robloxPids = new System.Collections.Generic.HashSet<int>();
        foreach (var p in Process.GetProcessesByName("RobloxPlayerBeta"))
            robloxPids.Add(p.Id);
        if (robloxPids.Count == 0) return 0;

        int size = 1 << 20;
        IntPtr buf = IntPtr.Zero;
        int needed;
        try
        {
            while (true)
            {
                buf = Marshal.AllocHGlobal(size);
                int status = NtQuerySystemInformation(SystemExtendedHandleInformation, buf, size, out needed);
                if (status == 0) break;
                Marshal.FreeHGlobal(buf); buf = IntPtr.Zero;
                if (status == unchecked((int)0xC0000004)) { size *= 2; continue; } // STATUS_INFO_LENGTH_MISMATCH
                return closed;
            }

            long count = Marshal.ReadInt64(buf);
            int entrySize = Marshal.SizeOf(typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
            IntPtr entries = buf + IntPtr.Size * 2; // skip NumberOfHandles + Reserved

            IntPtr self = GetCurrentProcess();

            for (long i = 0; i < count; i++)
            {
                var entry = (SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX)Marshal.PtrToStructure(
                    entries + (int)(i * entrySize),
                    typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));

                int pid = (int)entry.UniqueProcessId;
                if (!robloxPids.Contains(pid)) continue;

                IntPtr srcProc = OpenProcess(PROCESS_DUP_HANDLE, false, pid);
                if (srcProc == IntPtr.Zero) continue;

                try
                {
                    IntPtr dupHandle;
                    if (!DuplicateHandle(srcProc, entry.HandleValue, self, out dupHandle, 0, false, DUPLICATE_SAME_ACCESS))
                        continue;

                    try
                    {
                        int nameBufSize = 1024;
                        IntPtr nameBuf = Marshal.AllocHGlobal(nameBufSize);
                        try
                        {
                            int nameRet;
                            NtQueryObject(dupHandle, 1, nameBuf, nameBufSize, out nameRet); // ObjectNameInformation = 1
                            short len = Marshal.ReadInt16(nameBuf);
                            if (len > 0)
                            {
                                IntPtr strPtr = Marshal.ReadIntPtr(nameBuf, IntPtr.Size == 8 ? 8 : 4);
                                string name = Marshal.PtrToStringUni(strPtr, len / 2);
                                if (name != null && name.Contains("ROBLOX_singletonEvent"))
                                {
                                    IntPtr dummy;
                                    DuplicateHandle(srcProc, entry.HandleValue, IntPtr.Zero, out dummy, 0, false, DUPLICATE_CLOSE_SOURCE);
                                    closed++;
                                }
                            }
                        }
                        finally { Marshal.FreeHGlobal(nameBuf); }
                    }
                    finally { CloseHandle(dupHandle); }
                }
                finally { CloseHandle(srcProc); }
            }
        }
        finally
        {
            if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
        }
        return closed;
    }
}

// ── OS-level Roblox volume (ported from audiovol.ps1) ───────────────────────
internal static class AudioControl
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        int NotUsed1();
        int NotUsed2();
        int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl session);
    }

    [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl
    {
        int GetState(out int state);
        int GetDisplayName(out IntPtr name);
        int SetDisplayName(string value, ref Guid ctx);
        int GetIconPath(out IntPtr path);
        int SetIconPath(string value, ref Guid ctx);
        int GetGroupingParam(out Guid param);
        int SetGroupingParam(ref Guid over, ref Guid ctx);
        int RegisterAudioSessionNotification(IntPtr n);
        int UnregisterAudioSessionNotification(IntPtr n);
    }

    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        // 9 inherited IAudioSessionControl methods (must be present so the
        // derived methods land at the correct vtable slots).
        int R1(); int R2(); int R3(); int R4(); int R5();
        int R6(); int R7(); int R8(); int R9();
        int GetSessionIdentifier(out IntPtr id);
        int GetSessionInstanceIdentifier(out IntPtr id);
        int GetProcessId(out int pid);
    }

    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume
    {
        int SetMasterVolume(float level, ref Guid eventContext);
        int GetMasterVolume(out float level);
        int SetMute(bool mute, ref Guid eventContext);
        int GetMute(out bool mute);
    }

    const int eRender = 0;
    const int eConsole = 0;
    const int CLSCTX_ALL = 0x17;

    public static int Apply(float level, int[] pids)
    {
        int changed = 0;
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out device) != 0 || device == null)
            return 0;

        Guid IID_ISessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        object mgrObj;
        if (device.Activate(ref IID_ISessionManager2, CLSCTX_ALL, IntPtr.Zero, out mgrObj) != 0)
            return 0;
        var mgr = (IAudioSessionManager2)mgrObj;

        IAudioSessionEnumerator sessions;
        if (mgr.GetSessionEnumerator(out sessions) != 0) return 0;

        int count;
        sessions.GetCount(out count);
        Guid empty = Guid.Empty;

        for (int i = 0; i < count; i++)
        {
            IAudioSessionControl ctl;
            if (sessions.GetSession(i, out ctl) != 0 || ctl == null) continue;
            var ctl2 = ctl as IAudioSessionControl2;
            if (ctl2 == null) continue;
            int pid;
            if (ctl2.GetProcessId(out pid) != 0) continue;
            bool match = false;
            foreach (int p in pids) { if (p == pid) { match = true; break; } }
            if (!match) continue;
            var vol = ctl as ISimpleAudioVolume;
            if (vol == null) continue;
            if (vol.SetMasterVolume(level, ref empty) == 0) changed++;
        }
        return changed;
    }
}

// ── Anti-AFK input injection ────────────────────────────────────────────────
// Roblox only registers input while its window is focused, so a background
// PostMessage is ignored by unfocused instances. To keep EVERY instance alive,
// each Roblox window is briefly foregrounded in turn (restoring it first if it
// was minimised), given a real key tap via keybd_event, then put back. The
// originally-focused window is restored after each pass. Per-instance timers
// mean each account is tapped the moment IT reaches the deadline (instances
// launched at different times have independent countdowns) -- including
// whichever one you're currently playing, since being focused doesn't by
// itself prove Roblox saw real input.
internal static class AntiAfk
{
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint uCode, uint uMapType);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    const int SW_RESTORE = 9, SW_MINIMIZE = 6;
    const uint KEYEVENTF_KEYUP = 0x0002;

    static readonly Random _rng = new Random();

    static uint PidOf(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return 0;
        uint pid; GetWindowThreadProcessId(hWnd, out pid); return pid;
    }

    // pid -> main visible window, for every running Roblox client.
    static System.Collections.Generic.Dictionary<uint, IntPtr> EnumRobloxWindows()
    {
        var robloxPids = new System.Collections.Generic.HashSet<uint>();
        foreach (var p in Process.GetProcessesByName("RobloxPlayerBeta"))
        {
            try { robloxPids.Add((uint)p.Id); } catch { }
        }
        var map = new System.Collections.Generic.Dictionary<uint, IntPtr>();
        if (robloxPids.Count == 0) return map;
        EnumWindows((hWnd, lp) =>
        {
            if (!IsWindowVisible(hWnd)) return true;
            if (GetWindowTextLength(hWnd) == 0) return true; // main game window has a title
            uint pid; GetWindowThreadProcessId(hWnd, out pid);
            if (robloxPids.Contains(pid) && !map.ContainsKey(pid)) map[pid] = hWnd;
            return true;
        }, IntPtr.Zero);
        return map;
    }

    // Force a window to the foreground, defeating Windows' foreground lock by
    // attaching to the currently-foreground thread's input queue for the call.
    public static void ForceForeground(IntPtr hWnd)
    {
        IntPtr fg = GetForegroundWindow();
        uint thisThread = GetCurrentThreadId();
        uint fgThread = (fg != IntPtr.Zero) ? PidOf(fg) : 0;
        bool attached = false;
        if (fgThread != 0 && fgThread != thisThread) attached = AttachThreadInput(thisThread, fgThread, true);
        try { SetForegroundWindow(hWnd); BringWindowToTop(hWnd); }
        finally { if (attached) AttachThreadInput(thisThread, fgThread, false); }
    }

    // Focus one window and send a single benign key tap. Does NOT restore the
    // previous foreground (the caller does that once after all due taps).
    static bool TapWindow(IntPtr hWnd, byte bVk, byte bScan)
    {
        bool wasMinimised = IsIconic(hWnd);
        try
        {
            if (wasMinimised) ShowWindow(hWnd, SW_RESTORE);
            ForceForeground(hWnd);
            Thread.Sleep(50 + _rng.Next(40)); // let focus settle; slight jitter
            keybd_event(bVk, bScan, 0, IntPtr.Zero);               // key down
            Thread.Sleep(35 + _rng.Next(40));
            keybd_event(bVk, bScan, KEYEVENTF_KEYUP, IntPtr.Zero); // key up
            Thread.Sleep(30 + _rng.Next(30));
            return true;
        }
        catch { return false; }
        finally { if (wasMinimised) ShowWindow(hWnd, SW_MINIMIZE); }
    }

    // Per-instance anti-AFK loop. Each Roblox window gets its own countdown from
    // when it launched or was last tapped. The instant an instance reaches the
    // deadline it is tapped, including the one you're playing, then focus is
    // handed straight back to whatever window you were on.
    // onTap reports each tapped PID (daemon mode turns that into an event
    // line; standalone mode prints ANTIAFK_TICK). stop lets daemon mode
    // reconfigure or switch anti-AFK off without killing the process --
    // there is only ever one helper process, so the loop has to be
    // interruptible rather than terminated.
    public static void RunLoop(int deadlineSec, int vk, Action<uint> onTap, WaitHandle stop)
    {
        // Disable the foreground lock timeout so SetForegroundWindow reliably
        // brings each Roblox window to the front, even across many instances.
        // This is a SYSTEM-WIDE setting that applies to every app until the
        // next reboot, so read the old value first and put it back when
        // anti-AFK stops (see the finally below) instead of leaving the
        // machine altered after we're done with it.
        const uint SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
        const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
        uint previousTimeout = 0;
        bool restoreTimeout = false;
        try
        {
            IntPtr buf = Marshal.AllocHGlobal(sizeof(int));
            try
            {
                if (SystemParametersInfo(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, buf, 0))
                {
                    previousTimeout = (uint)Marshal.ReadInt32(buf);
                    restoreTimeout = true;
                }
            }
            finally { Marshal.FreeHGlobal(buf); }
            // For this action the new value travels *in* pvParam, it is not a
            // pointer to it -- zero here means "no delay".
            SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, IntPtr.Zero, 0);
        }
        catch { }

        try
        {
            RunLoopCore(deadlineSec, vk, onTap, stop);
        }
        finally
        {
            if (restoreTimeout)
            {
                try { SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, new IntPtr((int)previousTimeout), 0); }
                catch { }
            }
        }
    }

    static void RunLoopCore(int deadlineSec, int vk, Action<uint> onTap, WaitHandle stop)
    {
        byte bVk = (byte)vk;
        byte bScan = (byte)MapVirtualKey((uint)vk, 0);
        // pid -> UTC time its idle timer last reset (launch or our tap)
        var lastReset = new System.Collections.Generic.Dictionary<uint, DateTime>();

        while (true)
        {
            // fire within ~15s of the deadline, but wake immediately on stop
            if (stop != null && stop.WaitOne(15 * 1000)) return;
            if (stop == null) Thread.Sleep(15 * 1000);
            DateTime now = DateTime.UtcNow;

            // Capture the window you're on BEFORE touching anything, so we can
            // always hand focus back exactly where it was.
            IntPtr originalFg = GetForegroundWindow();

            var windows = EnumRobloxWindows();

            var gone = new System.Collections.Generic.List<uint>();
            foreach (var pid in lastReset.Keys) if (!windows.ContainsKey(pid)) gone.Add(pid);
            foreach (var pid in gone) lastReset.Remove(pid);
            foreach (var pid in windows.Keys) if (!lastReset.ContainsKey(pid)) lastReset[pid] = now;

            // Foreground state alone doesn't prove Roblox saw real input --
            // being focused without pressing anything still reads as idle to
            // Roblox's own kick timer, so exempting the foreground window let
            // it get missed and kicked anyway. Every window is tapped on its
            // own deadline regardless of focus; the tap is a harmless single
            // key and focus is handed back right after (see below).
            var due = new System.Collections.Generic.List<uint>();
            foreach (var kv in windows)
            {
                if ((now - lastReset[kv.Key]).TotalSeconds >= deadlineSec) due.Add(kv.Key);
            }
            if (due.Count == 0) continue;

            foreach (var pid in due)
            {
                if (TapWindow(windows[pid], bVk, bScan) && onTap != null) onTap(pid);
                lastReset[pid] = DateTime.UtcNow;
            }

            // Return focus to the original window. Done robustly: minimised
            // targets are restored above, so a couple of attempts with a short
            // settle reliably lands focus back where you were.
            RestoreForeground(originalFg);
        }
    }

    static void RestoreForeground(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return;
        try
        {
            Thread.Sleep(40);
            ForceForeground(hWnd);
            Thread.Sleep(40);
            SetForegroundWindow(hWnd); // second pass; focus has settled by now
        }
        catch { }
    }
}

// ── Singleton mutex ownership ───────────────────────────────────────────────
// A Windows mutex is owned by the THREAD that acquired it -- if that thread
// exits, the mutex is abandoned and Roblox's singleton check starts passing
// again. So exactly one dedicated thread acquires both names and then parks
// forever, servicing hold/release/re-hold requests without ever unwinding.
// (The old design got this for free by dedicating a whole PROCESS to it; the
// point of daemon mode is that we no longer spend a process per concern.)
internal static class MutexHolder
{
    static Mutex _singleton, _event;
    static readonly AutoResetEvent _wake = new AutoResetEvent(false);
    static readonly ManualResetEvent _ready = new ManualResetEvent(false);
    static readonly ManualResetEvent _done = new ManualResetEvent(false);
    static readonly object _applyLock = new object();
    static volatile bool _wantHeld = true;
    static volatile bool _reholdRequested;
    static volatile bool _held;

    public static bool Held { get { return _held; } }

    public static void Start()
    {
        var t = new Thread(Loop);
        t.IsBackground = true;
        t.Name = "MutexHolder";
        t.Start();
        // Matches the old "MUTEX_HELD within 8s" contract the launch path
        // relied on, so a launch can never race an unheld mutex.
        _ready.WaitOne(8000);
    }

    // Serialized so two racing settings toggles can't interleave a release
    // with a re-acquire. Blocks until the holder thread has actually applied
    // the change -- callers (kill-all, multi-instance toggle) need the new
    // state to be real before they return, not merely queued.
    public static bool Apply(bool hold, bool rehold, int timeoutMs)
    {
        lock (_applyLock)
        {
            _wantHeld = hold;
            _reholdRequested = rehold;
            _done.Reset();
            _wake.Set();
            _done.WaitOne(timeoutMs);
            return _held;
        }
    }

    static void Loop()
    {
        Acquire();
        _ready.Set();
        SlowPart();
        _done.Set();
        while (true)
        {
            _wake.WaitOne();
            bool rehold = _reholdRequested;
            _reholdRequested = false;
            try
            {
                if (!_wantHeld) Release();
                else if (!_held || rehold)
                {
                    Release(); // drop any stale/abandoned ownership first
                    Acquire();
                    SlowPart();
                }
            }
            catch (Exception ex) { Daemon.Warn("MutexHolder: " + ex.Message); }
            _done.Set();
        }
    }

    static void Acquire()
    {
        try
        {
            bool created;
            _singleton = new Mutex(true, "ROBLOX_singletonMutex", out created);
            bool owned = created;
            if (!created)
            {
                try { owned = _singleton.WaitOne(0); }
                catch (AbandonedMutexException) { owned = true; }
                catch { owned = false; }
            }
            _held = owned;
        }
        catch (Exception ex) { _held = false; Daemon.Warn("HoldMutex: " + ex.Message); }
    }

    // The slow half: close any singleton-event handles Roblox already opened,
    // then hold that name too. Runs after readiness is signalled so a cold
    // start never blocks the first launch on a full handle-table scan.
    static void SlowPart()
    {
        try { HandleCloser.CloseRobloxSingletonHandles(); }
        catch (Exception ex) { Daemon.Warn("CloseHandles(hold): " + ex.Message); }
        try
        {
            bool created;
            _event = new Mutex(true, "ROBLOX_singletonEvent", out created);
            if (!created) { try { _event.WaitOne(0); } catch (AbandonedMutexException) { } catch { } }
        }
        catch (Exception ex) { Daemon.Warn("HoldEventMutex: " + ex.Message); }
    }

    static void Release()
    {
        if (_event != null)
        {
            try { _event.ReleaseMutex(); } catch { }
            try { _event.Dispose(); } catch { }
            _event = null;
        }
        if (_singleton != null)
        {
            try { _singleton.ReleaseMutex(); } catch { }
            try { _singleton.Dispose(); } catch { }
            _singleton = null;
        }
        _held = false;
    }
}

// ── Daemon: the one and only helper process ─────────────────────────────────
internal static class Daemon
{
    static readonly object _outLock = new object();
    static System.IO.StreamWriter _out;

    static Thread _watchThread; static ManualResetEvent _watchStop;
    static Thread _afkThread;   static ManualResetEvent _afkStop;
    static readonly object _threadLock = new object();

    // Named per user session (no "Global\") -- MultiRoblox is a per-user app.
    // Bump the suffix if the line protocol ever changes incompatibly.
    const string SINGLETON_NAME = "MultiRoblox_NativeHelper_v1";
    static Mutex _singleInstance;

    public static int Run()
    {
        _out = new System.IO.StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false), 1 << 16);
        _out.AutoFlush = false;

        // Belt to the caller's braces: the app already sweeps strays and
        // serializes its own spawns, but this makes "exactly one helper" an
        // OS-enforced invariant instead of a promise the caller has to keep.
        // Checked before touching Roblox's mutexes so a stray second copy
        // can't disturb the incumbent on its way out.
        bool createdNew;
        _singleInstance = new Mutex(true, SINGLETON_NAME, out createdNew);
        if (!createdNew)
        {
            Emit("DUPLICATE", "another helper is already running");
            return 3;
        }

        MutexHolder.Start();
        Emit("READY", MutexHolder.Held ? "1" : "0");

        var stdin = new System.IO.StreamReader(Console.OpenStandardInput(), System.Text.Encoding.UTF8);
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            string work = line.Trim();
            if (work.Length == 0) continue;
            if (work == "0|shutdown") break; // fast path, no reply expected
            // Off the read loop: a capture takes ~200ms and closehandles can
            // take seconds, and neither may stall a pids poll behind it.
            // Responses carry their request id, so out-of-order is fine.
            ThreadPool.QueueUserWorkItem(delegate { Handle(work); });
        }

        // stdin EOF means MultiRoblox is gone -- exited cleanly, crashed, or
        // was force-killed. Either way this process must not survive it, so
        // there is never an orphaned helper holding Roblox's mutex.
        StopWatch();
        StopAfk();
        return 0;
    }

    static void Handle(string line)
    {
        string[] p = line.Split('|');
        string id = p.Length > 0 ? p[0] : "0";
        string cmd = p.Length > 1 ? p[1].ToLowerInvariant() : "";
        try
        {
            switch (cmd)
            {
                case "ping":
                    Reply(id, "pong");
                    break;

                case "pids":
                    Reply(id, PidList());
                    break;

                case "closehandles":
                    Reply(id, HandleCloser.CloseRobloxSingletonHandles().ToString());
                    break;

                case "mutex":
                {
                    string mode = p.Length > 2 ? p[2].ToLowerInvariant() : "on";
                    bool held;
                    if (mode == "off") held = MutexHolder.Apply(false, false, 15000);
                    else if (mode == "rehold") held = MutexHolder.Apply(true, true, 15000);
                    else held = MutexHolder.Apply(true, false, 15000);
                    Reply(id, held ? "1" : "0");
                    break;
                }

                case "volume":
                {
                    int pct = 0;
                    if (p.Length > 2) int.TryParse(p[2], out pct);
                    if (pct < 0) pct = 0;
                    if (pct > 100) pct = 100;
                    int[] pids = RobloxNative.RobloxPids();
                    int n = pids.Length == 0 ? 0 : AudioControl.Apply(pct / 100.0f, pids);
                    Reply(id, n.ToString());
                    break;
                }

                case "watch":
                {
                    int ms = 0;
                    if (p.Length > 2) int.TryParse(p[2], out ms);
                    if (ms <= 0) StopWatch();
                    else StartWatch(ms < 250 ? 250 : ms);
                    Reply(id, "ok");
                    break;
                }

                case "antiafk":
                {
                    int sec = 0;
                    if (p.Length > 2) int.TryParse(p[2], out sec);
                    int vk = 0x10;
                    if (p.Length > 3) { int v; if (int.TryParse(p[3], out v) && v > 0 && v < 256) vk = v; }
                    if (sec <= 0) { StopAfk(); Reply(id, "off"); break; }
                    if (sec < 60) sec = 60;
                    if (sec > 1140) sec = 1140; // stay under Roblox's ~20-min kick
                    StartAfk(sec, vk);
                    Reply(id, sec.ToString());
                    break;
                }

                case "capture":
                {
                    int pid;
                    if (p.Length < 3 || !int.TryParse(p[2], out pid) || pid <= 0) { Fail(id, "Invalid PID"); break; }
                    double x = 0, y = 0, w = 1, h = 1;
                    bool crop = false;
                    if (p.Length >= 7 && TryParseD(p[3], out x) && TryParseD(p[4], out y)
                                      && TryParseD(p[5], out w) && TryParseD(p[6], out h))
                        crop = true;
                    Reply(id, RobloxNative.CaptureBase64(pid, crop, x, y, w, h));
                    break;
                }

                case "shutdown":
                    Reply(id, "ok");
                    // Stop the workers first: Environment.Exit kills background
                    // threads outright, so anti-AFK's finally -- which restores
                    // the system foreground-lock timeout -- would never run.
                    StopWatch();
                    StopAfk();
                    Environment.Exit(0);
                    break;

                default:
                    Fail(id, "unknown command: " + cmd);
                    break;
            }
        }
        catch (Exception ex) { Fail(id, ex.Message); }
    }

    // Always invariant: the Rust side formats fractions with '.', which
    // current-culture parsing would reject outright on a comma-decimal
    // locale -- silently turning every cropped capture into a full-window one.
    static bool TryParseD(string s, out double v)
    {
        return double.TryParse(s, System.Globalization.NumberStyles.Float,
                               System.Globalization.CultureInfo.InvariantCulture, out v);
    }

    static string PidList()
    {
        int[] ids = RobloxNative.RobloxPids();
        var parts = new string[ids.Length];
        for (int i = 0; i < ids.Length; i++) parts[i] = ids[i].ToString();
        return string.Join(",", parts);
    }

    static void StartWatch(int intervalMs)
    {
        lock (_threadLock)
        {
            StopWatchLocked();
            var stop = new ManualResetEvent(false);
            var t = new Thread(delegate()
            {
                while (true)
                {
                    Emit("PIDS", PidList());
                    if (stop.WaitOne(intervalMs)) return;
                }
            });
            t.IsBackground = true;
            t.Name = "PidWatch";
            t.Start();
            _watchThread = t;
            _watchStop = stop;
        }
    }

    public static void StopWatch() { lock (_threadLock) { StopWatchLocked(); } }

    static void StopWatchLocked()
    {
        if (_watchStop != null) { try { _watchStop.Set(); } catch { } }
        if (_watchThread != null) { try { _watchThread.Join(2000); } catch { } }
        _watchThread = null;
        _watchStop = null;
    }

    static void StartAfk(int deadlineSec, int vk)
    {
        lock (_threadLock)
        {
            StopAfkLocked();
            var stop = new ManualResetEvent(false);
            var t = new Thread(delegate()
            {
                AntiAfk.RunLoop(deadlineSec, vk, delegate(uint pid) { Emit("AFK", pid.ToString()); }, stop);
            });
            t.IsBackground = true;
            t.Name = "AntiAfk";
            t.Start();
            _afkThread = t;
            _afkStop = stop;
        }
    }

    public static void StopAfk() { lock (_threadLock) { StopAfkLocked(); } }

    static void StopAfkLocked()
    {
        if (_afkStop != null) { try { _afkStop.Set(); } catch { } }
        // Bounded: a tap in progress holds the loop for a few hundred ms.
        if (_afkThread != null) { try { _afkThread.Join(3000); } catch { } }
        _afkThread = null;
        _afkStop = null;
    }

    static void Reply(string id, string payload) { WriteLine("R|" + id + "|OK|" + payload); }
    static void Fail(string id, string message)  { WriteLine("R|" + id + "|ERR|" + San(message)); }
    static void Emit(string name, string payload) { WriteLine("E|" + name + "|" + payload); }
    public static void Warn(string message) { try { Console.Error.WriteLine(message); } catch { } }

    // Error text is the only field that can contain a separator or newline;
    // neutralise both so one bad message can't desync the whole stream.
    static string San(string s)
    {
        if (s == null) return "";
        return s.Replace("\r", " ").Replace("\n", " ").Replace("|", "/");
    }

    static void WriteLine(string s)
    {
        lock (_outLock)
        {
            try { _out.Write(s); _out.Write('\n'); _out.Flush(); } catch { }
        }
    }
}
