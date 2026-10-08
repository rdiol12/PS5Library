// Copyright (c) 2026, SvenGDK
// Licensed under the BSD 2-Clause License. See LICENSE file for details.

using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace UFS2Tool
{
    /// <summary>
    /// Provides low-level Windows disk I/O operations for writing to
    /// physical drives (\\.\PhysicalDriveN) and volumes (\\.\X:).
    /// Requires Administrator privileges.
    /// </summary>
    [SupportedOSPlatform("windows")]
    public static class DriveIO
    {
        // --- Win32 P/Invoke declarations ---

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern SafeFileHandle CreateFileW(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DeviceIoControl(
            SafeFileHandle hDevice,
            uint dwIoControlCode,
            IntPtr lpInBuffer,
            uint nInBufferSize,
            IntPtr lpOutBuffer,
            uint nOutBufferSize,
            out uint lpBytesReturned,
            IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DeviceIoControl(
            SafeFileHandle hDevice,
            uint dwIoControlCode,
            IntPtr lpInBuffer,
            uint nInBufferSize,
            out DISK_GEOMETRY_EX lpOutBuffer,
            uint nOutBufferSize,
            out uint lpBytesReturned,
            IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DeviceIoControl(
            SafeFileHandle hDevice,
            uint dwIoControlCode,
            IntPtr lpInBuffer,
            uint nInBufferSize,
            out long lpOutBuffer,
            uint nOutBufferSize,
            out uint lpBytesReturned,
            IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DeviceIoControl(
            SafeFileHandle hDevice,
            uint dwIoControlCode,
            IntPtr lpInBuffer,
            uint nInBufferSize,
            out PARTITION_INFORMATION_EX lpOutBuffer,
            uint nOutBufferSize,
            out uint lpBytesReturned,
            IntPtr lpOverlapped);

        // Access flags
        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_FLAG_NO_BUFFERING = 0x20000000;
        private const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x80;

        // IOCTL codes
        private const uint FSCTL_LOCK_VOLUME = 0x00090018;
        private const uint FSCTL_UNLOCK_VOLUME = 0x0009001C;
        private const uint FSCTL_DISMOUNT_VOLUME = 0x00090020;
        private const uint IOCTL_DISK_GET_DRIVE_GEOMETRY_EX = 0x000700A0;
        private const uint IOCTL_DISK_GET_LENGTH_INFO = 0x0007405C;
        private const uint IOCTL_DISK_GET_PARTITION_INFO_EX = 0x00070048;

        [StructLayout(LayoutKind.Sequential)]
        private struct DISK_GEOMETRY
        {
            public long Cylinders;
            public int MediaType;
            public uint TracksPerCylinder;
            public uint SectorsPerTrack;
            public uint BytesPerSector;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DISK_GEOMETRY_EX
        {
            public DISK_GEOMETRY Geometry;
            public long DiskSize;
            // Followed by variable-length data we don't need
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PARTITION_INFORMATION_EX
        {
            public int PartitionStyle; // 0=MBR, 1=GPT
            public long StartingOffset;
            public long PartitionLength;
            public uint PartitionNumber;
            public byte RewritePartition;
            public byte IsServicePartition;
            // Union follows (MBR or GPT info) — we only need the length
        }

        /// <summary>
        /// Determines whether a path refers to a physical drive or volume device.
        /// Matches: \\.\PhysicalDriveN, \\.\X:, \\.\Volume{guid}
        /// </summary>
        public static bool IsDevicePath(string path)
        {
            if (string.IsNullOrEmpty(path))
                return false;

            string normalized = path.Replace("/", "\\");

            // \\.\PhysicalDrive0, \\.\PhysicalDrive1, etc.
            if (normalized.StartsWith(@"\\.\PhysicalDrive", StringComparison.OrdinalIgnoreCase))
                return true;

            // \\.\C:, \\.\D:, etc. (volume letter)
            if (normalized.StartsWith(@"\\.\") && normalized.Length >= 6 &&
                char.IsLetter(normalized[4]) && normalized[5] == ':')
                return true;

            // \\.\Volume{GUID}
            if (normalized.StartsWith(@"\\.\Volume", StringComparison.OrdinalIgnoreCase))
                return true;

            // \\.\HarddiskVolumeN
            if (normalized.StartsWith(@"\\.\Harddisk", StringComparison.OrdinalIgnoreCase))
                return true;

            return false;
        }

        /// <summary>
        /// Query the total usable size of a device in bytes.
        /// Works for both physical drives and partitions/volumes.
        /// </summary>
        public static long GetDeviceSize(string devicePath)
        {
            using var handle = OpenDevice(devicePath, readOnly: true);

            // Try partition length first (works for volumes / partitions)
            if (TryGetPartitionLength(handle, out long partitionSize))
                return partitionSize;

            // Try IOCTL_DISK_GET_LENGTH_INFO (works for physical drives and partitions)
            if (TryGetLengthInfo(handle, out long lengthInfo))
                return lengthInfo;

            // Fall back to disk geometry
            if (TryGetDiskGeometry(handle, out long geoSize, out _))
                return geoSize;

            throw new IOException(
                $"Unable to determine size of device '{devicePath}'. " +
                "Ensure you are running as Administrator.");
        }

        /// <summary>
        /// Query the physical sector size of the device.
        /// </summary>
        public static int GetSectorSize(string devicePath)
        {
            using var handle = OpenDevice(devicePath, readOnly: true);

            if (TryGetDiskGeometry(handle, out _, out uint sectorSize))
                return (int)sectorSize;

            // Default to 512 if we can't determine
            return 512;
        }

        /// <summary>
        /// Open a device for direct I/O. Returns a FileStream with no buffering.
        /// The caller must ensure all reads/writes are sector-aligned.
        /// </summary>
        /// <param name="devicePath">Device path (e.g., \\.\PhysicalDrive2)</param>
        /// <param name="readOnly">Open read-only if true</param>
        /// <param name="lockVolume">Attempt to lock and dismount the volume</param>
        public static FileStream OpenDeviceStream(string devicePath, bool readOnly = false, bool lockVolume = true)
        {
            var handle = OpenDevice(devicePath, readOnly);

            if (!readOnly && lockVolume)
            {
                // Lock the volume so Windows doesn't interfere
                if (!TryLockVolume(handle))
                {
                    Console.Error.WriteLine(
                        "Warning: Could not lock volume. Ensure no other process is using the drive.");
                }

                // Dismount so cached filesystem data is flushed
                TryDismountVolume(handle);
            }

            // Wrap in FileStream — the handle was opened with FILE_FLAG_NO_BUFFERING
            // so all I/O must be sector-aligned
            var access = readOnly ? FileAccess.Read : FileAccess.ReadWrite;
            return new FileStream(handle, access, bufferSize: 0, isAsync: false);
        }

        /// <summary>
        /// Unlock a previously locked volume. Call after writing is complete.
        /// </summary>
        public static void UnlockVolume(SafeFileHandle handle)
        {
            DeviceIoControl(handle, FSCTL_UNLOCK_VOLUME,
                IntPtr.Zero, 0, IntPtr.Zero, 0, out _, IntPtr.Zero);
        }

        // --- Private helpers ---

        private static SafeFileHandle OpenDevice(string devicePath, bool readOnly)
        {
            uint access = GENERIC_READ | (readOnly ? 0 : GENERIC_WRITE);

            var handle = CreateFileW(
                devicePath,
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_NO_BUFFERING | FILE_FLAG_WRITE_THROUGH,
                IntPtr.Zero);

            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                throw new IOException(
                    $"Failed to open device '{devicePath}'. Win32 error: {error}. " +
                    (error == 5
                        ? "Access denied — run as Administrator."
                        : "Ensure the device path is correct."),
                    new Win32Exception(error));
            }

            return handle;
        }

        private static bool TryLockVolume(SafeFileHandle handle)
        {
            return DeviceIoControl(handle, FSCTL_LOCK_VOLUME,
                IntPtr.Zero, 0, IntPtr.Zero, 0, out _, IntPtr.Zero);
        }

        private static bool TryDismountVolume(SafeFileHandle handle)
        {
            return DeviceIoControl(handle, FSCTL_DISMOUNT_VOLUME,
                IntPtr.Zero, 0, IntPtr.Zero, 0, out _, IntPtr.Zero);
        }

        private static bool TryGetPartitionLength(SafeFileHandle handle, out long size)
        {
            size = 0;
            bool result = DeviceIoControl(handle, IOCTL_DISK_GET_PARTITION_INFO_EX,
                IntPtr.Zero, 0,
                out PARTITION_INFORMATION_EX partInfo,
                (uint)Marshal.SizeOf<PARTITION_INFORMATION_EX>(),
                out _, IntPtr.Zero);

            if (result && partInfo.PartitionLength > 0)
            {
                size = partInfo.PartitionLength;
                return true;
            }
            return false;
        }

        private static bool TryGetLengthInfo(SafeFileHandle handle, out long size)
        {
            bool result = DeviceIoControl(handle, IOCTL_DISK_GET_LENGTH_INFO,
                IntPtr.Zero, 0,
                out size, sizeof(long),
                out _, IntPtr.Zero);
            return result && size > 0;
        }

        private static bool TryGetDiskGeometry(SafeFileHandle handle, out long totalSize, out uint sectorSize)
        {
            totalSize = 0;
            sectorSize = 512;

            bool result = DeviceIoControl(handle, IOCTL_DISK_GET_DRIVE_GEOMETRY_EX,
                IntPtr.Zero, 0,
                out DISK_GEOMETRY_EX geoEx,
                (uint)Marshal.SizeOf<DISK_GEOMETRY_EX>(),
                out _, IntPtr.Zero);

            if (result)
            {
                totalSize = geoEx.DiskSize;
                sectorSize = geoEx.Geometry.BytesPerSector;
                return true;
            }
            return false;
        }
    }
}