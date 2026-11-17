import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { config } from '../server/config.ts';
import { MAX_FILE_BYTES, MAX_TEXT, parseFile, textMaterial } from '../server/materials.ts';

// Minimal fixtures are built here so this test does not rely on user documents or extra packages.
function crc32(buffer: Buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(files: Record<string, string>) {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [filename, text] of Object.entries(files)) {
    const name = Buffer.from(filename), body = Buffer.from(text), checksum = crc32(body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function docxFixture() {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>CRM 客户交接需求</w:t></w:r></w:p><w:p><w:r><w:t>交接成功后原负责人立即撤权。</w:t></w:r></w:p></w:body></w:document>',
  });
}
function pdfFixture(withText: boolean) {
  const content = withText ? 'BT /F1 12 Tf 72 720 Td (CRM transfer audit requirement) Tj ET' : 'q 100 0 0 100 72 620 cm /Im0 Do Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> /XObject << /Im0 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 3 >>\nstream\n00>\nendstream',
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => {offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;});
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test('隔离目录中的材料格式与失败回归', async t => {
  const originalDataDir = config.dataDir;
  const directory = await mkdtemp(path.join(tmpdir(), 'requirements-materials-'));
  config.dataDir = directory; await mkdir(path.join(directory, 'materials'));
  try {
    await t.test('TXT、MD、CSV 按 UTF-8 读取中文，保留原文件', async () => {
      for (const [name, content] of [['访谈.txt', '客户转交后原负责人立即撤权'], ['规则.md', '# 客户交接\n由销售主管操作'], ['清单.csv', '角色,权限\n销售主管,转交客户']]) {
        const bytes = Buffer.from(content), material = await parseFile(name, bytes);
        assert.equal(material.status, '待整理'); assert.equal(material.text, content); assert.equal(material.error, undefined);
        assert.deepEqual(await readFile(path.join(directory, material.filePath!)), bytes);
      }
    });
    await t.test('DOCX 读取真实段落正文，不丢失中文', async () => {
      const material = await parseFile('需求说明.docx', docxFixture());
      assert.equal(material.status, '待整理'); assert.match(material.text, /CRM 客户交接需求/);
      assert.match(material.text, /原负责人立即撤权/); assert.equal(material.error, undefined);
    });
    await t.test('XLSX 保留行列定位、富文本、公式结果与零值', async () => {
      const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('客户规则');
      sheet.addRow(['角色', '期限', '规则']);
      sheet.getCell('A2').value = {richText: [{text: '原负责'}, {text: '人'}]};
      sheet.getCell('B2').value = {formula: '1+6', result: 7};
      sheet.getCell('C2').value = '七天只读，到期撤权';
      sheet.getCell('D2').value = 0; sheet.getCell('E2').value = false;
      sheet.getCell('B3').value = {formula: 'SUM(B2:B2)'};
      const material = await parseFile('规则.xlsx', Buffer.from(await book.xlsx.writeBuffer()));
      assert.equal(material.status, '待整理'); assert.match(material.text, /工作表：客户规则/); assert.match(material.text, /行 2/);
      assert.match(material.text, /原负责人/); assert.match(material.text, /列 B\] 7/); assert.match(material.text, /列 D\] 0/);
      assert.match(material.text, /列 E\] false/); assert.match(material.text, /未含计算结果/); assert.doesNotMatch(material.text, /\[object Object\]/);
    });
    await t.test('PDF 读取真实文本并保留页码', async () => {
      const material = await parseFile('需求.pdf', pdfFixture(true));
      assert.equal(material.status, '待整理'); assert.match(material.text, /CRM transfer audit requirement/);
      assert.match(material.text, /第 1 页/); assert.equal(material.error, undefined);
    });
    await t.test('扫描 PDF 与空工作表不得仅凭页码或表名判为可读', async () => {
      const imagePDF = pdfFixture(false), material = await parseFile('扫描件.pdf', imagePDF);
      assert.equal(material.status, '待解析'); assert.equal(material.text, ''); assert.match(material.error!, /文字识别/);
      assert.deepEqual(await readFile(path.join(directory, material.filePath!)), imagePDF);
      const emptyBook = new ExcelJS.Workbook(); emptyBook.addWorksheet('只有名称没有正文');
      const empty = await parseFile('空表.xlsx', Buffer.from(await emptyBook.xlsx.writeBuffer()));
      assert.equal(empty.status, '待解析'); assert.equal(empty.text, ''); assert.ok(empty.error);
    });
    await t.test('损坏文件与非法 UTF-8 保留原件，待解析并提供错误', async () => {
      for (const name of ['损坏.docx', '损坏.xlsx', '损坏.pdf', '旧编码.txt']) {
        const bytes = Buffer.from([0xff, 0xfe, 0x01, 0x02]);
        const material = await parseFile(name, bytes);
        assert.equal(material.status, '待解析'); assert.equal(material.text, ''); assert.ok(material.error);
        assert.deepEqual(await readFile(path.join(directory, material.filePath!)), bytes);
      }
    });
    await t.test('文件大小、不支持格式和文字超限被拒绝，不截断正文', async () => {
      const before = await readdir(path.join(directory, 'materials'));
      await assert.rejects(() => parseFile('超过限制.txt', Buffer.alloc(MAX_FILE_BYTES + 1)), /10 MB/);
      await assert.rejects(() => parseFile('程序.exe', Buffer.from('not accepted')), /支持/);
      assert.deepEqual(await readdir(path.join(directory, 'materials')), before);
      assert.throws(() => textMaterial('超长粘贴', 'A'.repeat(MAX_TEXT + 1)), /16万/);
      const bytes = Buffer.from('A'.repeat(MAX_TEXT + 1)), material = await parseFile('超长正文.txt', bytes);
      assert.equal(material.status, '待解析'); assert.equal(material.text, ''); assert.match(material.error!, /没有截断原文/);
      assert.deepEqual(await readFile(path.join(directory, material.filePath!)), bytes);
    });
  } finally { config.dataDir = originalDataDir; await rm(directory, {recursive: true, force: true}); }
});
