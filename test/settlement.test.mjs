import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TicketLedger, approvalIndex } from '../src/tickets.mjs';
import { reconcile } from '../src/reconcile.mjs';
import { planVouchers, commitPlans, growerStatements } from '../src/settlement.mjs';

const rates = { H1: '2.65', H2: '2.65' };
const movementsInitial = () => ([
  { id: 'MV-1', type: 'load', crate: 'C-1', grower: 'H1', truck: 'T8', station: 'farm' },
  { id: 'MV-2', type: 'load', crate: 'C-2', grower: 'H2', truck: 'T8', station: 'farm' },
  { id: 'MV-3', type: 'unload', crate: 'C-1', source: 'MV-1', truck: 'T8', station: 'plant' },
  { id: 'MV-5', type: 'unload', crate: 'C-2', source: 'MV-2', truck: 'T8', station: 'plant' },
]);

const reconcileWith = (movements, tickets, approved = []) => {
  const ledger = new TicketLedger();
  tickets.forEach((ticket, index) => ledger.addRecord(ticket, { stream: 's', bytes: [index, index + 1] }));
  return reconcile({ movements, ledger, approvals: approvalIndex(approved) });
};

const initialTickets = [
  { device: 'farm', boot: 'g3', no: 12, type: 'gross', crate: 'C-1', kg: '51.43', wall: 'w', truck: 'T8', movement: 'MV-1' },
  { device: 'farm', boot: 'g3', no: 13, type: 'gross', crate: 'C-2', kg: '47.23', wall: 'w', truck: 'T8', movement: 'MV-2' },
  { device: 'plant', boot: 'k7', no: 12, type: 'tare', crate: 'C-1', kg: '4.08', wall: 'w', truck: 'T8', movement: 'MV-1' },
  { device: 'plant', boot: 'k7', no: 13, type: 'tare', crate: 'C-2', kg: '3.78', wall: 'w', truck: 'T8', movement: 'MV-2' },
];

test('重复执行不产生第二张等额凭据', () => {
  const store = { nextVoucherSeq: 1, vouchers: [], waiting: [] };
  const reconciliation = reconcileWith(movementsInitial(), initialTickets);

  const first = commitPlans(store, planVouchers({ reconciliation, rates, store }));
  assert.equal(first.length, 2); // H1、H2 各一张
  const again = commitPlans(store, planVouchers({ reconciliation, rates, store }));
  assert.equal(again.length, 0);
  assert.equal(store.vouchers.length, 2);
});

test('部分箱先签收结算，剩余箱保留等待原因', () => {
  const movements = movementsInitial();
  // H2 皮重未到 => H1 先结，H2 等待
  const tickets = initialTickets.filter(ticket => !(ticket.movement === 'MV-2' && ticket.type === 'tare'));
  const store = { nextVoucherSeq: 1, vouchers: [], waiting: [] };
  const reconciliation = reconcileWith(movements, tickets);
  const issued = commitPlans(store, planVouchers({ reconciliation, rates, store }));

  const h1 = issued.find(voucher => voucher.grower === 'H1');
  assert.equal(h1.total, '125.48');
  assert.deepEqual(store.waiting[0].held.map(item => item.movement), ['MV-2']);

  // 补齐 H2 皮重后续跑：只开 H2 的凭据，H1 不重开
  const full = reconcileWith(movements, initialTickets);
  const second = commitPlans(store, planVouchers({ reconciliation: full, rates, store }));
  assert.equal(second.length, 1);
  assert.equal(second[0].grower, 'H2');
  assert.equal(second[0].total, '115.14');
});

test('已结算箱证据变化 => 冲正后补差，原凭据保留可查，只开差额票', () => {
  const store = { nextVoucherSeq: 1, vouchers: [], waiting: [] };
  const firstReconciliation = reconcileWith(movementsInitial(), initialTickets);
  commitPlans(store, planVouchers({ reconciliation: firstReconciliation, rates, store }));
  const original = store.vouchers.find(voucher => voucher.grower === 'H2');
  assert.equal(original.status, 'active');

  // 换箱 + 目标箱替代称量（已核准）
  const movements = [
    ...movementsInitial(),
    { id: 'MV-2B', type: 'exchange', source: 'MV-2', old: 'C-2', new: 'C-7', truck: 'T8', station: 'plant', wall: 'x' },
  ];
  const tickets = [
    ...initialTickets,
    { device: 'plant', boot: 'k7', no: 18, type: 'tare', crate: 'C-7', kg: '4.45', wall: 'w', truck: 'T8', movement: 'MV-2B' },
    { device: 'plant', boot: 'k7', no: 19, type: 'gross', crate: 'C-7', kg: '48.07', wall: 'w', truck: 'T8', movement: 'MV-2B' },
    { device: 'plant', boot: 'k7', no: 20, type: 'void', crate: 'C-7', kg: null, wall: 'w', truck: 'T8', movement: 'MV-2B', replaces: 19 },
    { device: 'plant', boot: 'k7', no: 21, type: 'gross', crate: 'C-7', kg: '47.94', wall: 'w', truck: 'T8', movement: 'MV-2B', replaces: 19 },
  ];
  const approved = [{ device: 'plant', boot: 'k7', no: 21, supersedes: 19, approvedBy: '乙' }];

  // 阶段 A：替代票尚未核准，原毛重证据被换箱打断 => 冲正
  const heldReconciliation = reconcileWith(movements, tickets.filter(ticket => ticket.no !== 21), []);
  const reversalPlans = planVouchers({ reconciliation: heldReconciliation, rates, store });
  const reversal = commitPlans(store, reversalPlans).find(voucher => voucher.grower === 'H2');
  assert.equal(reversal.kind, 'reversal');
  assert.equal(reversal.totalDelta, '-115.14');
  assert.equal(reversal.originalVoucherId, original.voucherId);
  assert.equal(store.vouchers.length, 3); // 原 H1、原 H2、冲正
  // 原凭据仍可查
  assert.equal(store.vouchers.find(voucher => voucher.voucherId === original.voucherId).status, 'active');

  // 阶段 B：核准替代称量 => 补差，金额为新票全额（冲正后净额回到应付）
  const finalReconciliation = reconcileWith(movements, tickets, approved);
  const adjustmentPlans = planVouchers({ reconciliation: finalReconciliation, rates, store });
  const adjustment = commitPlans(store, adjustmentPlans).filter(voucher => voucher.grower === 'H2');
  assert.equal(adjustment.length, 1);
  assert.equal(adjustment[0].kind, 'continuation');
  assert.equal(adjustment[0].total, '115.25');

  const statements = growerStatements(store, finalReconciliation, rates);
  const h2 = statements.find(item => item.grower === 'H2');
  assert.equal(h2.payable, '115.25'); // 115.14 - 115.14 + 115.25
  assert.ok(h2.vouchers.includes(original.voucherId));
});
