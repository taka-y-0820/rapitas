// Dedicated launcher only. Never load Run into the backend or another shared process.
// The launcher joins its private job BEFORE creating the CLI, closing the spawn/assign race.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class RapitasAuxJob
{
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    // -1 means the named job is absent. Permission/query failures throw, never return empty.
    public static int ActiveProcesses(string token) {
        Guid id;
        if (!Guid.TryParseExact(token, "D", out id)) throw new ArgumentException("Invalid job token");
        IntPtr job = OpenJobObject(4, false, "Local\\RapitasAux-" + id.ToString("D"));
        if (job == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            if (error == 2) return -1;
            throw new Win32Exception(error);
        }
        try {
            Accounting info;
            Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
            return checked((int)info.ActiveProcesses);
        } finally { CloseHandle(job); }
    }
    // Only the durable token for this launch authorizes targeting this private job.
    // This does not report termination success: callers must subsequently observe absence.
    public static void RequestStop(string token) {
        Guid id;
        if (!Guid.TryParseExact(token, "D", out id)) throw new ArgumentException("Invalid job token");
        IntPtr job = OpenJobObject(8, false, "Local\\RapitasAux-" + id.ToString("D"));
        if (job == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            if (error == 2) return;
            throw new Win32Exception(error);
        }
        try { Check(TerminateJobObject(job, 1)); }
        finally { CloseHandle(job); }
    }
    static IntPtr InheritStandard(int kind) {
        IntPtr handle;
        Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(),
            out handle, 0, true, 2));
        return handle;
    }

    public static void Run(string token, string command, string directory, uint timeoutMs) {
        Guid id;
        if (!Guid.TryParseExact(token, "D", out id) || String.IsNullOrWhiteSpace(command) || timeoutMs == 0 || timeoutMs == UInt32.MaxValue)
            throw new ArgumentException("Invalid auxiliary job launch");
        IntPtr job = CreateJobObject(IntPtr.Zero, "Local\\RapitasAux-" + id.ToString("D"));
        int createError = Marshal.GetLastWin32Error();
        if (job == IntPtr.Zero) throw new Win32Exception(createError);
        if (createError == 183) {
            CloseHandle(job);
            throw new InvalidOperationException("Auxiliary job already exists");
        }
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; deliberately no breakaway flags.
        try {
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            Check(AssignProcessToJobObject(job, GetCurrentProcess()));
        } catch { CloseHandle(job); throw; }
        // From this point every failure exits this dedicated launcher. Its non-inheritable
        // job handle closes at OS teardown and terminates all ordinary descendants.
        try {
            var startup = new StartupInfo();
            startup.Size = Marshal.SizeOf(startup);
            startup.Flags = 0x100; // STARTF_USESTDHANDLES
            startup.Input = InheritStandard(-10);
            startup.Output = InheritStandard(-11);
            startup.Error = InheritStandard(-12);
            ProcessInfo child;
            Check(CreateProcess(null, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
                true, 0x08000000, IntPtr.Zero, directory, ref startup, out child));
            CloseHandle(startup.Input); CloseHandle(startup.Output); CloseHandle(startup.Error);
            CloseHandle(child.Thread);
            uint waitResult = WaitForSingleObject(child.Process, timeoutMs);
            if (waitResult == 258) { // WAIT_TIMEOUT: OS teardown closes job and terminates descendants.
                Console.Error.WriteLine("Auxiliary CLI launcher deadline exceeded");
                Environment.Exit(124);
            }
            if (waitResult != 0)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            uint code;
            Check(GetExitCodeProcess(child.Process, out code));
            CloseHandle(child.Process);
            Environment.Exit(unchecked((int)code));
        } catch (Exception error) {
            Console.Error.WriteLine("Auxiliary job launch failed: " + error.Message);
            Environment.Exit(1);
        }
    }
}
