import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ByteStream } from '../src/streams.mjs';
import { RetentionManager } from '../src/retention.mjs';
import { TicketLedger } from '../src/tickets.mjs';

test('安全确认止于完整票前缀，半张票不能让站端删除', async () => {
  const streams = new Map([['farm-g', new ByteStream('farm-g')]]);
  const stream = streams.get('farm-g');
  stream.ingest(0, Buffer.concat([Buffer.from('{"no":1}\n'), Buffer.from('{"par')]));
  const manager = new RetentionManager(streams);
  assert.equal(manager.safeThrough('farm-g'), 9);
  // 超界 through 在发请求前就被本地拒绝
  await assert.rejects(
    () => manager.acknowledge('http://127.0.0.1:9', 'farm-g', '/scales/farm/ack', { through: 13 }),
    error => error.code === 'UNSAFE_ACK',
  );
  assert.equal(manager.acks.get('farm-g'), undefined); // 被拒请求不留确认记录
});

test('回执丢失只登记待核实，不改动本地留存判断', async () => {
  const streams = new Map([['farm-g', new ByteStream('farm-g')]]);
  const stream = streams.get('farm-g');
  stream.ingest(0, Buffer.from('{"no":1}\n'));
  const manager = new RetentionManager(streams);
  // 指向一个必然连接失败的端口，模拟司机拔终端
  const record = await manager.acknowledge('http://127.0.0.1:9', 'farm-g', '/scales/farm/ack');
  assert.equal(record.status, 'lost-acknowledgement');
  assert.equal(record.requested, 9);
  assert.equal(stream.retentionStart, 0); // 没收到回执，本地不前进
});

test('不可补缺口与仍可补缺口分开列示，已保存票据依据保留', () => {
  const streams = new Map([['s', new ByteStream('s')]]);
  const stream = streams.get('s');
  stream.publishWindow({ offset: 0, bytes: 100, url: '/x' });
  stream.ingest(0, Buffer.from('{"no":1}\n')); // 仅持有 [0,9)
  stream.retentionStart = 30;

  assert.deepEqual(stream.unrecoverableGaps(), [[9, 30]]);
  assert.deepEqual(stream.missingWindows(), [[30, 100]]);

  const ledger = new TicketLedger();
  ledger.addRecord({ device: 'd', boot: 'b', no: 1, type: 'gross' }, { stream: 's', bytes: [0, 9] });
  const coverage = new RetentionManager(streams).evidenceCoverage(ledger);
  assert.deepEqual(coverage.map(item => ({ identity: item.identity, local: item.local })), [
    { identity: 'd|b|1', local: true },
  ]);
});
