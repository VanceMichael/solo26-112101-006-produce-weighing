import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TicketLedger, approvalIndex, resolveWeighing, ticketIdentity } from '../src/tickets.mjs';

const provenance = { stream: 's', bytes: [0, 1] };
const ticket = overrides => ({
  device: 'plant', boot: 'k7', no: 19, type: 'gross', crate: 'C-7',
  kg: 48.07, wall: '2026-10-18T00:25:00+08:00', truck: 'T8', movement: 'MV-2B',
  ...overrides,
});

test('补打是同一称量：身份去重，不产生第二张事实', () => {
  const ledger = new TicketLedger();
  const first = ledger.addRecord(ticket(), provenance);
  const reprint = ledger.addRecord(ticket({ type: 'reprint', wall: '2026-10-18T00:01:00+08:00' }), provenance);
  assert.equal(first.first, true);
  assert.equal(reprint.first, false);
  assert.equal(ledger.list().length, 1);
  assert.equal(ledger.conflicts.length, 0);
});

test('同身份重复送达但读数不一致，登记冲突', () => {
  const ledger = new TicketLedger();
  ledger.addRecord(ticket(), provenance);
  ledger.addRecord(ticket({ kg: 49.99 }), provenance);
  assert.equal(ledger.conflicts.length, 1);
  assert.equal(ledger.list().length, 1);
});

test('显式作废后无核准替换 => 事实挂起，不能结算', () => {
  const ledger = new TicketLedger();
  ledger.addRecord(ticket(), provenance);
  ledger.addRecord(ticket({ no: 20, type: 'void', kg: null, replaces: 19, wall: '2026-10-18T02:40:00+08:00' }), provenance);
  const resolved = resolveWeighing(ledger, ledger.get('plant', 'k7', 19), approvalIndex([]));
  assert.equal(resolved.status, 'voided-pending');
});

test('替换读数未经核准不能覆盖争议来源；核准后才生效且引用被替换票', () => {
  const ledger = new TicketLedger();
  ledger.addRecord(ticket(), provenance);
  ledger.addRecord(ticket({ no: 20, type: 'void', kg: null, replaces: 19, wall: '2026-10-18T02:40:00+08:00' }), provenance);
  ledger.addRecord(ticket({ no: 21, kg: 47.94, replaces: 19, wall: '2026-10-18T02:41:00+08:00' }), provenance);

  const pending = resolveWeighing(ledger, ledger.get('plant', 'k7', 19), approvalIndex([]));
  assert.equal(pending.status, 'voided-pending');

  const approved = approvalIndex([
    { device: 'plant', boot: 'k7', no: 21, supersedes: 19, approvedBy: '收购员乙' },
  ]);
  const resolved = resolveWeighing(ledger, ledger.get('plant', 'k7', 19), approved);
  assert.equal(resolved.status, 'replaced');
  assert.equal(resolved.ticket.kg, 47.94);
  assert.equal(ticketIdentity(resolved.superseded), 'plant|k7|19');
  assert.equal(resolved.approval.approvedBy, '收购员乙');
});

test('未作废但出现未核准的新读数 => 争议挂起', () => {
  const ledger = new TicketLedger();
  ledger.addRecord(ticket(), provenance);
  ledger.addRecord(ticket({ no: 21, kg: 47.94, replaces: 19, wall: '2026-10-18T02:41:00+08:00' }), provenance);
  const resolved = resolveWeighing(ledger, ledger.get('plant', 'k7', 19), approvalIndex([]));
  assert.equal(resolved.status, 'disputed');
});
