// Copyright (c) 2026, SvenGDK
// Licensed under the BSD 2-Clause License. See LICENSE file for details.

namespace UFS2Tool
{
    /// <summary>
    /// Wraps a device FileStream to provide sector-aligned buffered writes.
    /// Windows requires all I/O to raw devices be aligned to the physical sector size.
    /// This class accumulates writes into an aligned buffer and flushes whole sectors.
    /// </summary>
    public class AlignedStream : IDisposable
    {
        private readonly FileStream _deviceStream;
        private readonly int _sectorSize;
        private readonly byte[] _sectorBuffer;
        private readonly long _deviceSize;
        private long _position;
        private bool _disposed;

        public long DeviceSize => _deviceSize;
        public int SectorSize => _sectorSize;

        public long Position
        {
            get => _position;
            set
            {
                if (value % _sectorSize != 0)
                    throw new ArgumentException(
                        $"Position must be aligned to sector size ({_sectorSize} bytes). Got: {value}");
                _position = value;
                _deviceStream.Position = value;
            }
        }

        public AlignedStream(FileStream deviceStream, int sectorSize, long deviceSize)
        {
            _deviceStream = deviceStream ?? throw new ArgumentNullException(nameof(deviceStream));
            if (sectorSize <= 0)
                throw new ArgumentOutOfRangeException(nameof(sectorSize), "Sector size must be positive.");
            _sectorSize = sectorSize;
            _deviceSize = deviceSize;
            _sectorBuffer = new byte[sectorSize];
            _position = 0;
        }

        /// <summary>
        /// Write a block of data that is already sector-aligned in both position and length.
        /// If the data length is not a multiple of sector size, it will be zero-padded.
        /// </summary>
        public void WriteAligned(byte[] data, long deviceOffset)
        {
            if (deviceOffset % _sectorSize != 0)
                throw new ArgumentException(
                    $"Write offset must be sector-aligned. Offset: {deviceOffset}, Sector: {_sectorSize}");

            _deviceStream.Position = deviceOffset;

            // If data is already sector-aligned, write directly
            if (data.Length % _sectorSize == 0)
            {
                _deviceStream.Write(data, 0, data.Length);
            }
            else
            {
                // Write full sectors
                int fullSectors = data.Length / _sectorSize;
                if (fullSectors > 0)
                {
                    _deviceStream.Write(data, 0, fullSectors * _sectorSize);
                }

                // Pad the remaining partial sector with zeros
                int remainder = data.Length % _sectorSize;
                if (remainder > 0)
                {
                    Array.Clear(_sectorBuffer, 0, _sectorSize);
                    Buffer.BlockCopy(data, fullSectors * _sectorSize, _sectorBuffer, 0, remainder);
                    _deviceStream.Write(_sectorBuffer, 0, _sectorSize);
                }
            }

            _position = _deviceStream.Position;
        }

        /// <summary>
        /// Write zeros to the specified region. Both offset and length must be sector-aligned.
        /// </summary>
        public void WriteZeros(long deviceOffset, long length)
        {
            if (deviceOffset % _sectorSize != 0 || length % _sectorSize != 0)
                throw new ArgumentException("Both offset and length must be sector-aligned for zeroing.");

            _deviceStream.Position = deviceOffset;
            Array.Clear(_sectorBuffer, 0, _sectorSize);

            long remaining = length;
            while (remaining > 0)
            {
                _deviceStream.Write(_sectorBuffer, 0, _sectorSize);
                remaining -= _sectorSize;
            }

            _position = _deviceStream.Position;
        }

        /// <summary>
        /// Read sector-aligned data from the device.
        /// </summary>
        public byte[] ReadAligned(long deviceOffset, int length)
        {
            if (deviceOffset % _sectorSize != 0)
                throw new ArgumentException("Read offset must be sector-aligned.");

            int alignedLength = ((length + _sectorSize - 1) / _sectorSize) * _sectorSize;
            byte[] buffer = new byte[alignedLength];

            _deviceStream.Position = deviceOffset;
            _deviceStream.Read(buffer, 0, alignedLength);

            // Return only the requested portion
            if (alignedLength != length)
            {
                byte[] trimmed = new byte[length];
                Buffer.BlockCopy(buffer, 0, trimmed, 0, length);
                return trimmed;
            }

            return buffer;
        }

        public void Flush()
        {
            _deviceStream.Flush();
        }

        public void Dispose()
        {
            if (!_disposed)
            {
                _deviceStream.Flush();
                _deviceStream.Dispose();
                _disposed = true;
            }
        }
    }
}