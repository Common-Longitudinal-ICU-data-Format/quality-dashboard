"""Minimal pure-Python Parquet reader (fallback only).

Used when neither pyarrow nor fastparquet is installed. Handles flat
(non-nested) files written by pyarrow/pandas: PLAIN, PLAIN_DICTIONARY /
RLE_DICTIONARY encodings, data page v1/v2, UNCOMPRESSED / SNAPPY / GZIP codecs.
On a normal site install, pandas.read_parquet (pyarrow) is used instead.
"""
from __future__ import annotations

import gzip
import json
import struct
import zlib

import numpy as np
import pandas as pd


# --------------------------------------------------------------------------- #
# Snappy (raw block format) decompression
# --------------------------------------------------------------------------- #
def _snappy_decompress(buf: bytes) -> bytes:
    pos = 0
    length = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        length |= (b & 0x7F) << shift
        if b < 0x80:
            break
        shift += 7
    out = bytearray()
    n = len(buf)
    while pos < n:
        tag = buf[pos]
        pos += 1
        t = tag & 3
        if t == 0:  # literal
            ln = tag >> 2
            if ln >= 60:
                nb = ln - 59
                ln = int.from_bytes(buf[pos:pos + nb], "little")
                pos += nb
            ln += 1
            out += buf[pos:pos + ln]
            pos += ln
            continue
        if t == 1:
            ln = ((tag >> 2) & 7) + 4
            off = ((tag >> 5) << 8) | buf[pos]
            pos += 1
        elif t == 2:
            ln = (tag >> 2) + 1
            off = int.from_bytes(buf[pos:pos + 2], "little")
            pos += 2
        else:
            ln = (tag >> 2) + 1
            off = int.from_bytes(buf[pos:pos + 4], "little")
            pos += 4
        start = len(out) - off
        if off >= ln:
            out += out[start:start + ln]
        else:
            for i in range(ln):
                out.append(out[start + i])
    return bytes(out)


def _decompress(codec: int, data: bytes, size: int) -> bytes:
    if codec == 0:
        return data
    if codec == 1:
        return _snappy_decompress(data)
    if codec == 2:
        return zlib.decompress(data, 16 + zlib.MAX_WBITS) if data[:2] == b"\x1f\x8b" else gzip.decompress(data)
    raise NotImplementedError(f"Parquet codec {codec} not supported by fallback reader; install pyarrow")


# --------------------------------------------------------------------------- #
# Thrift compact protocol (generic: returns {field_id: value})
# --------------------------------------------------------------------------- #
class _Thrift:
    def __init__(self, buf: bytes, pos: int = 0):
        self.b = buf
        self.p = pos

    def varint(self) -> int:
        r = s = 0
        while True:
            x = self.b[self.p]
            self.p += 1
            r |= (x & 0x7F) << s
            if x < 0x80:
                return r
            s += 7

    def zigzag(self) -> int:
        v = self.varint()
        return (v >> 1) ^ -(v & 1)

    def value(self, t: int):
        if t in (1, 2):  # bool true/false (in struct context)
            return t == 1
        if t == 3:
            v = self.b[self.p]
            self.p += 1
            return v - 256 if v > 127 else v
        if t in (4, 5, 6):
            return self.zigzag()
        if t == 7:
            v = struct.unpack_from("<d", self.b, self.p)[0]
            self.p += 8
            return v
        if t == 8:
            n = self.varint()
            v = self.b[self.p:self.p + n]
            self.p += n
            return v
        if t in (9, 10):
            h = self.b[self.p]
            self.p += 1
            n = h >> 4
            et = h & 0x0F
            if n == 15:
                n = self.varint()
            out = []
            for _ in range(n):
                if et in (1, 2):
                    v = self.b[self.p]
                    self.p += 1
                    out.append(v == 1)
                else:
                    out.append(self.value(et))
            return out
        if t == 12:
            return self.struct()
        raise ValueError(f"thrift type {t}")

    def struct(self) -> dict:
        out = {}
        fid = 0
        while True:
            h = self.b[self.p]
            self.p += 1
            if h == 0:
                return out
            t = h & 0x0F
            d = h >> 4
            fid = fid + d if d else self.zigzag()
            out[fid] = self.value(t)


# --------------------------------------------------------------------------- #
# Encodings
# --------------------------------------------------------------------------- #
def _rle_bp(buf: bytes, pos: int, end: int, bw: int, n: int) -> np.ndarray:
    out = np.empty(n, dtype=np.int64)
    k = 0
    bytew = (bw + 7) // 8
    mask = (1 << bw) - 1 if bw else 0
    while k < n and pos < end:
        h = s = 0
        while True:
            x = buf[pos]
            pos += 1
            h |= (x & 0x7F) << s
            if x < 0x80:
                break
            s += 7
        if h & 1:  # bit-packed
            groups = h >> 1
            cnt = groups * 8
            nbytes = groups * bw
            val = int.from_bytes(buf[pos:pos + nbytes], "little")
            pos += nbytes
            for i in range(cnt):
                if k >= n:
                    break
                out[k] = (val >> (i * bw)) & mask
                k += 1
        else:
            cnt = h >> 1
            v = int.from_bytes(buf[pos:pos + bytew], "little") if bytew else 0
            pos += bytew
            m = min(cnt, n - k)
            out[k:k + m] = v
            k += m
    return out[:k] if k < n else out


def _plain(ptype: int, buf: bytes, pos: int, n: int, type_len: int = 0):
    if ptype == 1:
        return np.frombuffer(buf, "<i4", n, pos)
    if ptype == 2:
        return np.frombuffer(buf, "<i8", n, pos)
    if ptype == 4:
        return np.frombuffer(buf, "<f4", n, pos)
    if ptype == 5:
        return np.frombuffer(buf, "<f8", n, pos)
    if ptype == 0:
        bits = np.unpackbits(np.frombuffer(buf, np.uint8, (n + 7) // 8, pos), bitorder="little")
        return bits[:n].astype(bool)
    if ptype == 6:
        out = []
        for _ in range(n):
            ln = struct.unpack_from("<i", buf, pos)[0]
            pos += 4
            out.append(buf[pos:pos + ln])
            pos += ln
        return out
    if ptype == 7:
        return [buf[pos + i * type_len: pos + (i + 1) * type_len] for i in range(n)]
    if ptype == 3:  # INT96 timestamp
        out = []
        for i in range(n):
            nanos, jd = struct.unpack_from("<qi", buf, pos + i * 12)
            out.append((jd - 2440588) * 86400 * 10**9 + nanos)
        return np.array(out, dtype=np.int64)
    raise NotImplementedError(ptype)


def _read_column(f: bytes, chunk_md: dict, ptype: int, optional: bool, type_len: int):
    codec = chunk_md.get(4, 0)
    total = chunk_md[5]
    start = chunk_md.get(11) or chunk_md[9]
    if chunk_md.get(11) is not None:
        start = min(chunk_md[11], chunk_md[9])
    pos = start
    dictionary = None
    values, defs = [], []
    seen = 0
    while seen < total:
        th = _Thrift(f, pos)
        ph = th.struct()
        pos = th.p
        ptype_page = ph[1]
        csize = ph[3]
        usize = ph[2]
        raw = f[pos:pos + csize]
        pos += csize
        if ptype_page == 2:  # dictionary page
            data = _decompress(codec, raw, usize)
            dictionary = _plain(ptype, data, 0, ph[7][1], type_len)
            continue
        if ptype_page == 0:  # data page v1
            dph = ph[5]
            n = dph[1]
            enc = dph[2]
            data = _decompress(codec, raw, usize)
            p = 0
            if optional:
                ln = struct.unpack_from("<i", data, p)[0]
                p += 4
                d = _rle_bp(data, p, p + ln, 1, n)
                p += ln
            else:
                d = np.ones(n, dtype=np.int64)
        elif ptype_page == 3:  # data page v2
            dph = ph[8]
            n = dph[1]
            enc = dph[4]
            dl = dph[5]
            rl = dph[6]
            lv = raw[:rl + dl]
            body = raw[rl + dl:]
            if dph.get(7, True):
                body = _decompress(codec, body, usize - rl - dl)
            d = _rle_bp(lv, rl, rl + dl, 1, n) if optional else np.ones(n, dtype=np.int64)
            data = body
            p = 0
        else:
            continue
        nn = int(d.sum())
        if enc in (2, 8):
            bw = data[p]
            p += 1
            idx = _rle_bp(data, p, len(data), bw, nn)
            if isinstance(dictionary, list):
                vals = [dictionary[i] for i in idx]
            else:
                vals = dictionary[idx]
        elif enc == 0:
            vals = _plain(ptype, data, p, nn, type_len)
        else:
            raise NotImplementedError(f"encoding {enc}")
        values.append(vals)
        defs.append(d)
        seen += n
    d = np.concatenate(defs) if defs else np.array([], dtype=np.int64)
    if values and isinstance(values[0], list):
        flat = [v for part in values for v in part]
    elif values:
        flat = np.concatenate([np.asarray(v) for v in values])
    else:
        flat = []
    return d, flat


def read_parquet(path: str) -> pd.DataFrame:
    with open(path, "rb") as fh:
        f = fh.read()
    if f[:4] != b"PAR1" or f[-4:] != b"PAR1":
        raise ValueError(f"{path} is not a parquet file")
    flen = struct.unpack("<i", f[-8:-4])[0]
    md = _Thrift(f, len(f) - 8 - flen).struct()
    schema = md[2]
    leaves = schema[1:]
    kv = {e.get(1, b"").decode(): e.get(2, b"").decode() for e in md.get(5, [])}
    pandas_md = json.loads(kv["pandas"]) if "pandas" in kv else None
    cols = {}
    for li, leaf in enumerate(leaves):
        name = leaf[4].decode()
        ptype = leaf.get(1)
        optional = leaf.get(3, 0) == 1
        tlen = leaf.get(2, 0)
        parts_d, parts_v = [], []
        for rg in md[4]:
            cmd = rg[1][li][3]
            d, v = _read_column(f, cmd, ptype, optional, tlen)
            parts_d.append(d)
            parts_v.append(v)
        d = np.concatenate(parts_d) if parts_d else np.array([], dtype=np.int64)
        n = len(d)
        mask = d.astype(bool)
        logical = leaf.get(10, {}) or {}
        conv = leaf.get(6)
        if ptype == 6 or ptype == 7:
            flat = [x for p in parts_v for x in p]
            is_str = 1 in logical or conv == 0 or ptype == 6
            arr = np.empty(n, dtype=object)
            arr[:] = None
            vals = [x.decode("utf-8", "replace") if is_str else x for x in flat]
            arr[mask] = vals
            series = pd.Series(arr, dtype=object)
        else:
            flat = np.concatenate([np.asarray(p) for p in parts_v]) if parts_v else np.array([])
            ts_unit = None
            ts_utc = False
            if 8 in logical:  # TIMESTAMP
                unit = logical[8].get(2, {})
                ts_unit = "ms" if 1 in unit else ("us" if 2 in unit else "ns")
                ts_utc = logical[8].get(1, False)
            elif conv == 9:
                ts_unit = "ms"
            elif conv == 10:
                ts_unit = "us"
            elif ptype == 3:
                ts_unit = "ns"
            if ts_unit:
                full = np.zeros(n, dtype=np.int64)
                full[mask] = flat
                ser = pd.Series(full.astype(f"datetime64[{ts_unit}]"))
                ser[~mask] = pd.NaT
                if ts_utc:
                    ser = ser.dt.tz_localize("UTC")
                series = ser
            else:
                if ptype == 0:
                    full = np.empty(n, dtype=object)
                    full[:] = None
                    full[mask] = flat
                    series = pd.Series(full)
                elif mask.all():
                    series = pd.Series(np.asarray(flat))
                else:
                    full = np.full(n, np.nan, dtype="float64")
                    full[mask] = flat
                    series = pd.Series(full)
                if ptype == 1 and 6 in logical:  # DATE
                    series = pd.to_datetime(series, unit="D")
                elif ptype == 1 and conv == 6:
                    series = pd.to_datetime(series, unit="D")
        cols[name] = series
    df = pd.DataFrame(cols)
    # Re-apply tz info from pandas metadata when present
    if pandas_md:
        for c in pandas_md.get("columns", []):
            nm = c.get("name")
            if nm in df.columns and c.get("pandas_type") == "datetimetz":
                tz = (c.get("metadata") or {}).get("timezone")
                s = df[nm]
                if tz and getattr(s.dt, "tz", None) is None:
                    df[nm] = s.dt.tz_localize("UTC").dt.tz_convert(tz)
                elif tz:
                    df[nm] = s.dt.tz_convert(tz)
    return df
