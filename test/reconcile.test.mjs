import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TicketLedger, approvalIndex } from '../src/tickets.mjs';
import { reconcile, HOLD } from '../src/reconcile.mjs';

const gross = (overrides = {}) => ({
  device: 'farm', boot: 'g3', no: 1, type: 'gross', crate: 'C-1', kg: '51.43',
  wall: '2026-10-17T23:50:00+08:00', truck: 'T8', movement: 'MV-1', ...overrides,
});
const tare = (overrides = {}) => ({
  device: 'plant', boot: 'k7', no: 1, type: 'tare', crate: 'C-1', kg: '4.08',
  wall: '2026-10-18T00:23:00+08:00', truck: 'T8', movement: 'MV-1', ...overrides,
});
const baseMovements = () => ([
  { id: 'MV-1', type: 'load', crate: 'C-1', grower: 'H1', truck: 'T8', station: 'farm' },
  { id: 'MV-3', type: 'unload', crate: 'C-1', source: 'MV-1', truck: 'T8', station: 'plant' },
]);
const build = ({ movements = baseMovements(), tickets = [], approved = [] }) => {
  const ledger = new TicketLedger();
  tickets.forEach((item, index) => ledger.addRecord(item, { stream: 's', bytes: [index, index + 1] }));
  return reconcile({ movements, ledger, approvals: approvalIndex(approved) });
};

test('毛重+本次卸空皮重齐备时可结，净重精确', () => {
  const result = build({ tickets: [gross(), tare()] });
  const line = result.lines[0];
  assert.equal(line.status, 'settlable');
  assert.equal(line.netKg, '47.3500');
});

test('皮重票缺失 => 停箱并保留等待原因，不关闭整车窗口', () => {
  const result = build({ tickets: [gross()] });
  assert.equal(result.lines[0].status, 'held');
  assert.ok(result.lines[0].holds.includes(HOLD.TARE_MISSING));
  assert.equal(result.trucks[0].open, true);
});

test('卸空交接缺失 => 停箱', () => {
  const movements = [baseMovements()[0]];
  const result = build({ movements, tickets: [gross(), tare()] });
  assert.ok(result.lines[0].holds.includes(HOLD.UNLOAD_MISSING));
});

test('箱码重复周转：昨日皮重不能套今天（皮重按 movement 绑定而非箱码）', () => {
  // C-1 在 T8/MV-1 卸空后，又装给 T9/MV-4 的 H3
  const movements = [
    ...baseMovements(),
    { id: 'MV-4', type: 'load', crate: 'C-1', grower: 'H3', truck: 'T9', station: 'farm' },
  ];
  const result = build({
    movements,
    tickets: [
      gross(),
      tare(), // 属于 MV-1
      gross({ device: 'farm', boot: 'g4', no: 12, kg: '33.76', wall: '2026-10-18T00:45:00+08:00', truck: 'T9', movement: 'MV-4' }),
      // 没有 MV-4 的皮重
    ],
  });
  const h3 = result.lines.find(line => line.lineId === 'MV-4');
  assert.equal(h3.status, 'held');
  assert.ok(h3.holds.includes(HOLD.TARE_MISSING));
  assert.equal(h3.netKg, null); // 绝不使用 MV-1 的 4.08
});

test('换箱后原箱重量仅追溯：缺替代满箱称量时停箱', () => {
  const movements = [
    { id: 'MV-2', type: 'load', crate: 'C-2', grower: 'H2', truck: 'T8', station: 'farm' },
    { id: 'MV-5', type: 'unload', crate: 'C-2', source: 'MV-2', truck: 'T8', station: 'plant' },
    { id: 'MV-2B', type: 'exchange', source: 'MV-2', old: 'C-2', new: 'C-7', truck: 'T8', station: 'plant', wall: '2026-10-18T00:24:30+08:00' },
  ];
  const result = build({
    movements,
    tickets: [
      gross({ no: 13, crate: 'C-2', kg: '47.23', movement: 'MV-2', wall: '2026-10-17T23:53:00+08:00' }),
      tare({ no: 13, crate: 'C-2', kg: '3.78', movement: 'MV-2', wall: '2026-10-18T00:26:00+08:00' }),
    ],
  });
  const line = result.lines[0];
  assert.equal(line.status, 'held');
  assert.ok(line.holds.includes(HOLD.EXCHANGE_WEIGHING_MISSING));
  assert.ok(line.trace.some(entry => String(entry.role).includes('仅追溯')));
  assert.equal(line.netKg, null);
});

test('同秤证明原箱与目标箱皮重 + 核准替代毛重后，换箱校正可结', () => {
  const movements = [
    { id: 'MV-2', type: 'load', crate: 'C-2', grower: 'H2', truck: 'T8', station: 'farm' },
    { id: 'MV-5', type: 'unload', crate: 'C-2', source: 'MV-2', truck: 'T8', station: 'plant' },
    { id: 'MV-2B', type: 'exchange', source: 'MV-2', old: 'C-2', new: 'C-7', truck: 'T8', station: 'plant', wall: '2026-10-18T00:24:30+08:00' },
  ];
  const result = build({
    movements,
    approved: [{ device: 'plant', boot: 'k7', no: 21, supersedes: 19, approvedBy: '收购员乙' }],
    tickets: [
      gross({ no: 13, crate: 'C-2', kg: '47.23', movement: 'MV-2' }),
      tare({ no: 13, crate: 'C-2', kg: '3.78', movement: 'MV-2' }), // 同秤 plant/k7 的原箱皮重
      tare({ no: 18, crate: 'C-7', kg: '4.45', movement: 'MV-2B', wall: '2026-10-18T00:26:00+08:00' }),
      gross({ device: 'plant', boot: 'k7', no: 19, crate: 'C-7', kg: '48.07', movement: 'MV-2B', wall: '2026-10-18T00:25:00+08:00' }),
      gross({ device: 'plant', boot: 'k7', no: 20, type: 'void', crate: 'C-7', kg: null, movement: 'MV-2B', replaces: 19, wall: '2026-10-18T02:40:00+08:00' }),
      gross({ device: 'plant', boot: 'k7', no: 21, crate: 'C-7', kg: '47.94', movement: 'MV-2B', replaces: 19, wall: '2026-10-18T02:41:00+08:00' }),
    ],
  });
  const line = result.lines[0];
  assert.equal(line.status, 'settlable', JSON.stringify(line.holds));
  assert.equal(line.netKg, '43.4900'); // 47.94 - 4.45
  assert.equal(line.gross.ticket.identity, 'plant|k7|21');
  assert.equal(line.gross.superseded.identity, 'plant|k7|19');
});

test('目标箱皮重来自不同秤时，换箱校正不成立', () => {
  const movements = [
    { id: 'MV-2', type: 'load', crate: 'C-2', grower: 'H2', truck: 'T8', station: 'farm' },
    { id: 'MV-5', type: 'unload', crate: 'C-2', source: 'MV-2', truck: 'T8', station: 'plant' },
    { id: 'MV-2B', type: 'exchange', source: 'MV-2', old: 'C-2', new: 'C-7', truck: 'T8', station: 'plant', wall: 'x' },
  ];
  const result = build({
    movements,
    approved: [{ device: 'plant', boot: 'k7', no: 21, supersedes: 19, approvedBy: '乙' }],
    tickets: [
      gross({ no: 13, crate: 'C-2', kg: '47.23', movement: 'MV-2' }),
      tare({ device: 'other-scale', boot: 'z1', no: 13, crate: 'C-2', kg: '3.78', movement: 'MV-2' }),
      tare({ no: 18, crate: 'C-7', kg: '4.45', movement: 'MV-2B' }),
      gross({ device: 'plant', boot: 'k7', no: 21, crate: 'C-7', kg: '47.94', movement: 'MV-2B', replaces: 19 }),
    ],
  });
  assert.equal(result.lines[0].status, 'held');
  assert.ok(result.lines[0].holds.includes(HOLD.EXCHANGE_WEIGHING_MISSING));
});
