import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ByteStream } from '../src/streams.mjs';

const line1 = Buffer.from('{"no":1}\n');
const line2 = Buffer.from('{"no":2}\n');
const line3 = Buffer.from('{"no":3}\n');

test('重叠片段按字节合并，半行不得被当成完整票', () => {
  const stream = new ByteStream('s');
  // 完整报文三行；第一段只拿到前两行 + 第三行的前半
  const full = Buffer.concat([line1, line2, Buffer.from('{"device":"x"}\n')]);
  const splitAt = line1.length + line2.length + 7; // 第三行被切成两半
  const part1 = full.subarray(0, splitAt);
  stream.ingest(0, part1);
  assert.equal(part1.length, splitAt);

  const linesAfterFirst = stream.completeLines();
  assert.equal(linesAfterFirst.filter(line => !line.partial).length, 2);
  assert.ok(linesAfterFirst.at(-1).partial);
  assert.equal(stream.safeThrough(), line1.length + line2.length);

  // 第二段从半行内部开始（与第一段末尾 7 字节逐字节重叠，模拟整车重发）
  const part2 = full.subarray(splitAt - 7);
  stream.ingest(splitAt - 7, part2);
  const merged = stream.completeLines();
  assert.equal(merged.filter(line => !line.partial).length, 3);
  assert.deepEqual(JSON.parse(merged[2].text), { device: 'x' });
  assert.equal(stream.safeThrough(), full.length);
});

test('重叠字节内容不一致时显式报错而不是静默覆盖', () => {
  const stream = new ByteStream('s');
  stream.ingest(0, Buffer.from('abcdef\n'));
  assert.throws(() => stream.ingest(3, Buffer.from('XYZ\n')), /字节冲突/);
});

test('字节缺口存在时，缺口之后的完整行仍可解析，但安全确认止于缺口前', () => {
  const stream = new ByteStream('s');
  stream.publishWindow({ offset: 0, bytes: line1.length + line2.length + line3.length, url: '/x' });
  stream.ingest(0, line1);
  stream.ingest(line1.length + line2.length, line3); // 中间缺 line2
  const lines = stream.completeLines().filter(line => !line.partial);
  assert.deepEqual(lines.map(line => JSON.parse(line.text).no), [1, 3]);
  // 只能确认第一行；缺口区仍在留存起点之后，列入 missing
  assert.equal(stream.safeThrough(), line1.length);
  const missing = stream.missingWindows();
  assert.deepEqual(missing, [[line1.length, line1.length + line2.length]]);
});

test('留存起点越过缺口后，缺口被标记为不可补，safeThrough 不前移', () => {
  const stream = new ByteStream('s');
  stream.publishWindow({ offset: 0, bytes: line1.length + line2.length, url: '/x' });
  stream.ingest(0, line1);
  stream.retentionStart = line1.length + line2.length;
  assert.deepEqual(stream.unrecoverableGaps(), [[line1.length, line1.length + line2.length]]);
  // 留存起点高于本地覆盖：本地仍只持有第一行，安全确认不能超过它
  assert.equal(stream.safeThrough(), line1.length);
});

test('留存起点切进行内时，该行不能计入确认前缀', () => {
  const stream = new ByteStream('s');
  stream.ingest(0, Buffer.concat([line1, line2]));
  stream.retentionStart = 2; // 切进第一行：第一行整行保留；第二行行首(9)在起点之后，可确认
  assert.equal(stream.safeThrough(), line1.length + line2.length); // 18
  // 留存起点对齐行首时，后续完整行同样可确认
  stream.retentionStart = line1.length;
  assert.equal(stream.safeThrough(), line1.length + line2.length);
  // 留存起点切进最后一行且后面没有完整行时，through 停在起点
  stream.retentionStart = line1.length + 2;
  assert.equal(stream.safeThrough(), line1.length + 2);
});
