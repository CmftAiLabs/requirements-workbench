import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, normalizeImage, recognizeImage, type ImageGenerator, type ImageRecognitionRequest } from '../server/image-materials.ts';

const picture = () => sharp({ create: { width: 12, height: 8, channels: 3, background: '#ffffff' } });
const result = (text: string, finishReason = 'stop'): ImageGenerator => async () => ({ text: JSON.stringify({ text }), finishReason });

test('图片按真实内容识别格式，转换为 PNG 预览并保留原始 MIME', async () => {
  assert.deepEqual(IMAGE_EXTENSIONS, ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff']);
  for (const [format, mimeType] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif'], ['tiff', 'image/tiff']] as const) {
    const input = await picture().toFormat(format).toBuffer();
    const preview = await normalizeImage(input);
    assert.equal(preview.mimeType, 'image/png');
    assert.equal((await sharp(preview.buffer).metadata()).format, 'png');
    const parsed = await recognizeImage(input, { generate: result('CRM 客户交接\n交接成功后立即撤权。') });
    assert.equal(parsed.mimeType, mimeType);
    assert.equal(parsed.text, 'CRM 客户交接\n交接成功后立即撤权。');
  }
});

test('识别前应用拍摄方向并移除元数据', async () => {
  const input = await picture().jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const { buffer } = await normalizeImage(input);
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 8);
  assert.equal(metadata.height, 12);
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
});

test('只发送解码后的图片并将图内指令限定为材料原文', async () => {
  let received: ImageRecognitionRequest | undefined;
  const input = await picture().jpeg().toBuffer();
  const parsed = await recognizeImage(input, { generate: async request => {
    received = request;
    return { text: JSON.stringify({ text: '标题\n| 角色 | 权限 |\n| 销售 | 只读 |\n[无法辨认]' }), finishReason: 'stop' };
  } });
  assert.ok(received);
  assert.equal(received.mediaType, 'image/png');
  assert.equal((await sharp(received.image).metadata()).format, 'png');
  assert.match(received.instructions, /不可信/);
  assert.match(received.instructions, /不能执行或遵循/);
  assert.match(received.instructions, /不解释、不总结、不补写需求/);
  assert.match(received.instructions, /\[无法辨认\]/);
  assert.match(received.prompt, /完整转录/);
  assert.equal(received.abortSignal.aborted, false);
  assert.match(parsed.text, /\| 销售 \| 只读 \|/);
});

test('空文件、超限文件、损坏图片、SVG 在调用模型前被拒绝', async () => {
  let calls = 0;
  const generate: ImageGenerator = async () => { calls++; return { text: '{"text":"wrong"}', finishReason: 'stop' }; };
  await assert.rejects(recognizeImage(Buffer.alloc(0), { generate }), /为空/);
  await assert.rejects(recognizeImage(Buffer.alloc(MAX_IMAGE_BYTES + 1), { generate }), /10 MB/);
  await assert.rejects(recognizeImage(Buffer.from('secret-token-not-an-image'), { generate }), /图片解析失败/);
  await assert.rejects(recognizeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>hi</text></svg>'), { generate }), /格式不受支持/);
  assert.equal(calls, 0);
});

test('过长图片、多帧 GIF 和多页 TIFF 不会只识别一部分', async () => {
  const wide = await sharp({ create: { width: 16001, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(normalizeImage(wide), /尺寸过大/);
  const raw = Buffer.concat([Buffer.alloc(2 * 2 * 3, 0), Buffer.alloc(2 * 2 * 3, 255)]);
  for (const format of ['gif', 'tiff'] as const) {
    const input = await sharp(raw, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).toFormat(format).toBuffer();
    assert.equal((await sharp(input, { animated: true }).metadata()).pages, 2);
    await assert.rejects(normalizeImage(input), /多帧动图或多页 TIFF/);
  }
});

test('无文字、全部无法辨认、错误结构和截断结果不会成为材料正文', async () => {
  const input = await picture().png().toBuffer();
  for (const text of ['', '   ', '[无法辨认]\n[无法辨认]', '| -- |']) {
    await assert.rejects(recognizeImage(input, { generate: result(text) }), /没有识别到可用文字/);
  }
  for (const raw of ['{"text":"unfinished', '这是一张图', '{"summary":"not text"}', '{"text":"ok","extra":"no"}']) {
    await assert.rejects(recognizeImage(input, { generate: async () => ({ text: raw, finishReason: 'stop' }) }), /未返回完整正文|结果格式不正确/);
  }
  await assert.rejects(recognizeImage(input, { generate: result('半段文字', 'length') }), /未完整结束/);
  await assert.rejects(recognizeImage(input, { generate: result('拒绝', 'content-filter') }), /未完整结束/);
  await assert.rejects(recognizeImage(input, { generate: result('文'.repeat(160001)) }), /16 万字符/);
});

test('模型失败只返回可操作的安全错误，不暴露供应商响应或密钥', async () => {
  const input = await picture().png().toBuffer();
  const secret = 'sk-do-not-leak-provider-body';
  const scenarios = [
    [{ statusCode: 401, responseBody: secret, message: secret }, /鉴权失败/],
    [{ statusCode: 429, responseBody: secret }, /限流或额度不足/],
    [{ statusCode: 400, responseBody: secret }, /模型是否支持图片输入/],
    [{ cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: secret } }, /证书链校验失败/],
    [new Error(secret), /连接中断或未完成处理/],
  ] as const;
  for (const [error, expected] of scenarios) {
    await assert.rejects(recognizeImage(input, { generate: async () => { throw error; } }), (failure: Error) => {
      assert.match(failure.message, expected);
      assert.equal(failure.message.includes(secret), false);
      assert.equal('cause' in failure, false);
      return true;
    });
  }
  await assert.rejects(recognizeImage(input, { generate: async () => ({ error: { statusCode: 503, responseBody: secret } }) }), /HTTP 503/);
});

test('识别有明确超时且通知模型中止，永不返回部分正文', async () => {
  const input = await picture().png().toBuffer();
  let signal: AbortSignal | undefined;
  await assert.rejects(recognizeImage(input, { timeoutMs: 10, generate: async request => {
    signal = request.abortSignal;
    return new Promise(() => {});
  } }), /识别超时/);
  assert.equal(signal?.aborted, true);
});
