import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { expandZip, MAX_ARCHIVE_BYTES } from '../server/archive-materials.ts';

interface FixtureEntry {
  name: string; body?: string | Buffer; flags?: number; mode?: number;
  compressed?: boolean; declaredSize?: number; crc?: number;
}
function crc32(buffer: Buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(files: FixtureEntry[]) {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), body = Buffer.from(file.body || ''), encoded = file.compressed ? deflateRawSync(body) : body;
    const checksum = file.crc ?? crc32(body), size = file.declaredSize ?? body.length, flags = file.flags ?? 0x800;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(file.compressed ? 8 : 0, 8); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(encoded.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, encoded);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x314, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8); entry.writeUInt16LE(file.compressed ? 8 : 0, 10);
    entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(encoded.length, 20); entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(((file.mode ?? 0o100644) * 0x10000) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += header.length + name.length + encoded.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test('ZIP 展开中文目录里的文档与图片，保留路径及原始字节，忽略系统附属文件', async () => {
  const picture = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const files = await expandZip(zip([
    {name: '项目/', mode: 0o040755},
    {name: '项目/需求.txt', body: '交接后立即撤权', compressed: true},
    {name: '项目/会议截图.PNG', body: picture},
    {name: '未标记中文.md', flags: 0, body: '# 范围'},
    {name: '__MACOSX/项目/._需求.txt', body: 'resource fork'},
    {name: '项目/.DS_Store', body: 'metadata'},
  ]));
  assert.deepEqual(files.map(file => file.path), ['项目/需求.txt', '项目/会议截图.PNG', '未标记中文.md']);
  assert.equal(files[0].buffer!.toString(), '交接后立即撤权'); assert.deepEqual(files[1].buffer, picture);
  assert.ok(files.every(file => file.buffer && !file.error));
});

test('ZIP 每个不支持、嵌套、加密或重复文件单独报告，不影响普通材料', async () => {
  const files = await expandZip(zip([
    {name: '需求.txt', body: '有效需求'}, {name: './需求.txt', body: '重复需求'},
    {name: '开发程序.exe', body: 'binary'}, {name: '更多资料.zip', body: 'nested'},
    {name: '秘密.md', body: 'encrypted', flags: 0x801, compressed: true}, {name: '结论.md', body: '可用'},
  ]));
  assert.equal(files.length, 6);
  assert.equal(files[0].buffer!.toString(), '有效需求');
  assert.match(files[1].error!, /重复/); assert.match(files[2].error!, /暂不支持/);
  assert.match(files[3].error!, /压缩包内的压缩包/); assert.match(files[4].error!, /加密/);
  assert.equal(files[5].buffer!.toString(), '可用');
  assert.ok(files.slice(1, 5).every(file => !file.buffer));
});

test('ZIP 拒绝越界路径、绝对路径与符号链接，路径仅在内存处理', async () => {
  const names = ['../越界.txt', '/绝对路径.txt', 'C:\\系统\\资料.txt', '正常/../../越界.txt', '\\\\服务器\\资料.txt', '含\x00字符.txt'];
  const files = await expandZip(zip([...names.map(name => ({name, body: 'bad'})), {name: '软链接.txt', body: '/etc/passwd', mode: 0o120777}, {name: '普通.txt', body: 'ok'}]));
  assert.ok(files.slice(0, names.length).every(file => !file.buffer && /路径不安全/.test(file.error!)));
  assert.match(files[names.length].error!, /符号链接/); assert.equal(files.at(-1)!.buffer!.toString(), 'ok');
  assert.doesNotMatch(files[5].path, /\x00/);
});

test('ZIP 解压时校验 CRC 与实际大小，损坏条目不混入正文', async () => {
  const files = await expandZip(zip([
    {name: '校验损坏.txt', body: '真实内容', compressed: true, crc: 0},
    {name: '隐瞒大小.txt', body: '实际内容多于声明', compressed: true, declaredSize: 1},
    {name: '完整.txt', body: '原文保留'},
  ]));
  assert.ok(files.slice(0, 2).every(file => !file.buffer && /损坏/.test(file.error!)));
  assert.equal(files[2].buffer!.toString(), '原文保留');
});

test('ZIP 单文件大小和压缩比超限分别报告', async () => {
  const files = await expandZip(zip([
    {name: '过大.txt', body: 'x', compressed: true, declaredSize: 10 * 1024 * 1024 + 1},
    {name: '过高压缩比.txt', body: 'A'.repeat(512 * 1024), compressed: true},
    {name: '普通.txt', body: 'ok'},
  ]));
  assert.match(files[0].error!, /10 MB/); assert.match(files[1].error!, /200 倍/);
  assert.equal(files[2].buffer!.toString(), 'ok');
});

test('ZIP 整包限制与损坏结构拒绝，不返回已处理的一部分', async () => {
  await assert.rejects(() => expandZip(Buffer.alloc(MAX_ARCHIVE_BYTES + 1)), /30 MB/);
  await assert.rejects(() => expandZip(Buffer.from('并非 ZIP')), /无法打开/);
  await assert.rejects(() => expandZip(zip(Array.from({length: 101}, (_, i) => ({name: `${i}.txt`, body: 'x'})))), /100 个/);
  await assert.rejects(() => expandZip(zip(Array.from({length: 6}, (_, i) => ({name: `${i}.txt`, body: 'x', compressed: true, declaredSize: 9 * 1024 * 1024})))), /50 MB/);
  const damaged = zip([{name: '先前.txt', body: 'ok'}, {name: '损坏.txt', body: 'later'}]);
  const secondDirectoryEntry = damaged.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  damaged[secondDirectoryEntry] = 0;
  await assert.rejects(() => expandZip(damaged), /结构损坏/);
});

test('ZIP 空包和只包含系统附属文件的包返回空列表', async () => {
  assert.deepEqual(await expandZip(zip([])), []);
  assert.deepEqual(await expandZip(zip([{name: '__MACOSX/._a.txt', body: 'metadata'}])), []);
});
