import path from 'node:path';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';

export const MAX_ARCHIVE_BYTES = 30 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 100;
export const MAX_ARCHIVE_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const supportedExtensions = new Set(['.txt', '.md', '.csv', '.pdf', '.docx', '.xlsx', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff']);
const archiveExtensions = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.gzip', '.bz2', '.xz', '.tgz']);
export interface ExpandedArchiveFile { path: string; buffer?: Buffer; error?: string }

const crcTable = Array.from({length: 256}, (_, number) => {
  let crc = number;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function updateCrc(crc: number, bytes: Buffer) {
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return crc >>> 0;
}
function checksum(bytes: Buffer) { return (updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0; }

// ZIP names are UTF-8 when flagged, or CP437; Info-ZIP may supply an authoritative Unicode name.
const cp437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
function entryName(entry: yauzl.Entry): string {
  const raw = entry.fileNameRaw;
  const utf8 = new TextDecoder('utf-8', {fatal: true});
  for (const field of entry.extraFields) {
    if (field.id === 0x7075 && field.data.length >= 5 && field.data[0] === 1 && field.data.readUInt32LE(1) === checksum(raw)) {
      try { return utf8.decode(field.data.subarray(5)); } catch { /* Fall back to the primary ZIP filename. */ }
    }
  }
  if (entry.generalPurposeBitFlag & 0x800) return utf8.decode(raw);
  // Some upload tools omit the UTF-8 flag; prefer valid UTF-8 before the ZIP legacy default.
  try { return utf8.decode(raw); } catch { return [...raw].map(byte => byte < 128 ? String.fromCharCode(byte) : cp437[byte - 128]).join(''); }
}
function safeName(name: string) { return name.replace(/[\x00-\x1f\x7f]/g, '�').slice(0, 1024) || '未命名文件'; }
function invalidPath(name: string) {
  return /[\x00-\x1f\x7f]/.test(name) || name.length > 1024 || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..');
}
function isMetadata(name: string) {
  const segments = name.split('/');
  return segments.some(segment => segment === '__MACOSX' || segment.startsWith('._')) || ['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(segments.at(-1) || '');
}
class ArchiveLimitError extends Error {}

/** Reads entries in memory only. Entry paths are labels and are never used as filesystem paths. */
export async function expandZip(buffer: Buffer): Promise<ExpandedArchiveFile[]> {
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error('ZIP 压缩包最多 30 MB，请拆分后上传。');
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buffer, {lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true}, (error, value) => {
      if (error || !value) reject(new Error('ZIP 压缩包无法打开，请检查文件是否完整，或重新压缩后上传。'));
      else resolve(value);
    });
  });
  return new Promise((resolve, reject) => {
    const results: ExpandedArchiveFile[] = [], names = new Set<string>();
    let settled = false, count = 0, declaredTotal = 0, actualTotal = 0;
    let currentStream: Readable | undefined;
    const close = () => { currentStream?.destroy(); zip.close(); };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true; close(); reject(error);
    };
    zip.on('error', () => fail(new Error('ZIP 压缩包结构损坏，请重新压缩后上传。')));
    zip.on('end', () => { if (!settled) { settled = true; close(); resolve(results); } });
    if (zip.entryCount > MAX_ARCHIVE_ENTRIES) {
      fail(new Error('ZIP 压缩包最多包含 100 个文件或目录，请拆分后上传。'));
      return;
    }

    const readEntry = async (entry: yauzl.Entry) => {
      if (++count > MAX_ARCHIVE_ENTRIES) throw new ArchiveLimitError('ZIP 压缩包最多包含 100 个文件或目录，请拆分后上传。');
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) throw new Error('无效文件大小');
      declaredTotal += entry.uncompressedSize;
      if (declaredTotal > MAX_ARCHIVE_EXPANDED_BYTES) throw new ArchiveLimitError('ZIP 解压后的文件合计最多 50 MB，请拆分后上传。');
      let name: string;
      try { name = entryName(entry).replaceAll('\\', '/'); }
      catch { results.push({path: '文件名编码异常', error: '无法识别文件名编码，请使用 UTF-8 文件名重新压缩。'}); return; }
      const record: ExpandedArchiveFile = {path: safeName(name)};
      if (invalidPath(name)) { record.error = '文件路径不安全，已跳过；请将文件放在普通文件夹内重新压缩。'; results.push(record); return; }
      name = path.posix.normalize(name).normalize('NFC');
      const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (unixType === 0o120000) { record.error = '不支持压缩包中的符号链接，请放入实际文件。'; results.push(record); return; }
      if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) { record.error = '不支持压缩包中的特殊文件。'; results.push(record); return; }
      if (name.endsWith('/') || unixType === 0o040000 || isMetadata(name)) return;
      record.path = name;
      const key = name.toLocaleLowerCase('en-US');
      if (names.has(key)) { record.error = '压缩包内文件路径重复，已跳过重复项，请重命名后上传。'; results.push(record); return; }
      names.add(key);
      results.push(record);
      if (entry.generalPurposeBitFlag & 1) { record.error = '不支持加密文件，请解密后重新压缩上传。'; return; }
      const ext = path.posix.extname(name).toLowerCase();
      if (archiveExtensions.has(ext)) { record.error = '不展开压缩包内的压缩包，请解压后直接上传其中的材料。'; return; }
      if (!supportedExtensions.has(ext)) { record.error = '暂不支持此文件格式，请转换为文字、文档、表格或支持的图片格式。'; return; }
      if (entry.uncompressedSize > MAX_ENTRY_BYTES) { record.error = '解压后单个文件最多 10 MB，请拆分后上传。'; return; }
      if (entry.uncompressedSize / Math.max(1, entry.compressedSize) > MAX_COMPRESSION_RATIO) { record.error = '文件压缩比超过安全限制（200 倍），请解压后直接上传。'; return; }
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) { record.error = '此文件的 ZIP 压缩方式暂不支持，请使用标准 ZIP 重新压缩。'; return; }
      try {
        record.buffer = await new Promise<Buffer>((resolveEntry, rejectEntry) => {
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) { rejectEntry(error || new Error('无法读取文件')); return; }
            if (settled) { stream.destroy(); rejectEntry(new Error('压缩包已停止读取')); return; }
            currentStream = stream;
            const chunks: Buffer[] = [];
            let size = 0, crc = 0xffffffff;
            stream.on('data', (chunk: Buffer) => {
              size += chunk.length; actualTotal += chunk.length;
              if (actualTotal > MAX_ARCHIVE_EXPANDED_BYTES) { stream.destroy(new ArchiveLimitError('ZIP 实际解压内容超过 50 MB，请拆分后上传。')); return; }
              if (size > MAX_ENTRY_BYTES || size > entry.uncompressedSize) { stream.destroy(new Error('实际文件大小超出限制')); return; }
              crc = updateCrc(crc, chunk); chunks.push(chunk);
            });
            stream.on('error', rejectEntry);
            stream.on('end', () => {
              currentStream = undefined;
              if (size !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) rejectEntry(new Error('文件校验失败'));
              else resolveEntry(Buffer.concat(chunks, size));
            });
          });
        });
      } catch (error) {
        if (error instanceof ArchiveLimitError) throw error;
        record.error = '文件内容或校验损坏，无法读取；请重新压缩后上传。';
      }
    };
    zip.on('entry', (entry: yauzl.Entry) => {
      void readEntry(entry).then(() => { if (!settled) zip.readEntry(); }, error => {
        fail(error instanceof ArchiveLimitError ? error : new Error('ZIP 压缩包结构损坏，请重新压缩后上传。'));
      });
    });
    zip.readEntry();
  });
}
