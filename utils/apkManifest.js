// Reads package name / versionCode / versionName straight from an APK, in plain Node.js
// (no Android SDK needed on the server). An APK is a ZIP; AndroidManifest.xml inside it is
// Android "binary XML" (AXML). Only the <manifest> element attributes are decoded.
const fs = require("fs");
const zlib = require("zlib");

const ANDROID_ATTR_VERSION_CODE = 0x0101021b;
const ANDROID_ATTR_VERSION_NAME = 0x0101021c;

const readAt = (fd, position, length) => {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
};

// Extracts one entry from a ZIP file without loading the whole archive.
const readZipEntry = (file, entryName) => {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a ZIP archive (end of central directory not found)");
    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = readAt(fd, cdOffset, cdSize);

    let p = 0;
    for (let i = 0; i < entries && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt ZIP central directory");
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      if (name === entryName) {
        const local = readAt(fd, localOffset, 30);
        if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("corrupt ZIP local header");
        const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        const data = readAt(fd, dataStart, compSize);
        if (method === 0) return data;
        if (method === 8) return zlib.inflateRawSync(data);
        throw new Error(`unsupported ZIP compression method ${method}`);
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
};

const readStringPool = (buf, start) => {
  const headerSize = buf.readUInt16LE(start + 2);
  const count = buf.readUInt32LE(start + 8);
  const isUtf8 = (buf.readUInt32LE(start + 16) & (1 << 8)) !== 0;
  const stringsStart = start + buf.readUInt32LE(start + 20);
  const strings = [];
  for (let i = 0; i < count; i++) {
    let p = stringsStart + buf.readUInt32LE(start + headerSize + i * 4);
    if (isUtf8) {
      p += buf[p] & 0x80 ? 2 : 1; // UTF-16 length (skipped)
      let len = buf[p];
      if (len & 0x80) { len = ((len & 0x7f) << 8) | buf[p + 1]; p += 2; } else p += 1;
      strings.push(buf.toString("utf8", p, p + len));
    } else {
      let len = buf.readUInt16LE(p);
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p + 2); p += 4; } else p += 2;
      strings.push(buf.toString("utf16le", p, p + len * 2));
    }
  }
  return strings;
};

// Decodes the attributes of the root <manifest> element of an AXML document.
const parseManifest = (axml) => {
  if (axml.readUInt16LE(0) !== 0x0003) throw new Error("AndroidManifest.xml is not binary XML");
  let strings = [];
  let resIds = [];
  let p = axml.readUInt16LE(2);
  while (p + 8 <= axml.length) {
    const type = axml.readUInt16LE(p);
    const headerSize = axml.readUInt16LE(p + 2);
    const size = axml.readUInt32LE(p + 4);
    if (size < 8) break;
    if (type === 0x0001) strings = readStringPool(axml, p);
    else if (type === 0x0180) {
      resIds = [];
      for (let q = p + headerSize; q < p + size; q += 4) resIds.push(axml.readUInt32LE(q));
    } else if (type === 0x0102) {
      const ext = p + headerSize;
      if (strings[axml.readUInt32LE(ext + 4)] === "manifest") {
        const attrStart = axml.readUInt16LE(ext + 8);
        const attrSize = axml.readUInt16LE(ext + 10);
        const attrCount = axml.readUInt16LE(ext + 12);
        const out = {};
        for (let i = 0; i < attrCount; i++) {
          const a = ext + attrStart + i * attrSize;
          const nameIdx = axml.readUInt32LE(a + 4);
          const raw = axml.readUInt32LE(a + 8);
          const dataType = axml[a + 15];
          const data = axml.readUInt32LE(a + 16);
          const name = resIds[nameIdx] === ANDROID_ATTR_VERSION_CODE ? "versionCode"
            : resIds[nameIdx] === ANDROID_ATTR_VERSION_NAME ? "versionName"
            : strings[nameIdx];
          const value = dataType === 0x03 ? strings[data] : raw !== 0xffffffff ? strings[raw] : data;
          out[name] = value;
        }
        return out;
      }
    }
    p += size;
  }
  throw new Error("<manifest> element not found");
};

/** Returns { packageName, versionCode, versionName } of an APK file. Throws if it cannot be read. */
const readApkManifest = (apkPath) => {
  const axml = readZipEntry(apkPath, "AndroidManifest.xml");
  if (!axml) throw new Error("AndroidManifest.xml not found in APK");
  const m = parseManifest(axml);
  const versionCode = Number(m.versionCode);
  if (!m.package || !Number.isInteger(versionCode) || versionCode < 1) {
    throw new Error("APK manifest has no valid package / versionCode");
  }
  return { packageName: String(m.package), versionCode, versionName: String(m.versionName || "") };
};

module.exports = { readApkManifest };
