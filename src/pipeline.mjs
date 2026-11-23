// 一次柜面作业的完整流水线：采集 -> 核对 -> 凭据计划 -> 落库。
// 任意阶段重复执行都保持幂等：字节按偏移合并、票据按身份去重、凭据按指纹决定是否新开。

import { collect } from './client.mjs';
import { reconcile } from './reconcile.mjs';
import { planVouchers, commitPlans, growerStatements } from './settlement.mjs';

export async function runDesk(store, baseUrl, options = {}) {
  const approvals = { rates: store.rates, index: store.approvalIndex() };
  const collected = await collect({
    baseUrl,
    streams: store.streams,
    ledger: store.ledger,
    approvals,
  });

  store.movements = collected.movements;
  store.rates = collected.rates;
  store.approved = collected.approved;
  store.runs.push({ at: new Date().toISOString(), accepted: collected.accepted, fetchLog: collected.fetchLog });

  const reconciliation = reconcile({
    movements: store.movements,
    ledger: store.ledger,
    approvals: store.approvalIndex(),
    unrecoverableRefs: store.unrecoverableIdentities(),
  });

  const voucherStore = {
    nextVoucherSeq: store.nextVoucherSeq,
    vouchers: store.vouchers,
    waiting: store.waiting,
  };
  const plans = planVouchers({
    reconciliation,
    rates: store.rates,
    store: voucherStore,
    now: options.now ?? new Date().toISOString(),
  });
  const issued = commitPlans(voucherStore, plans);
  store.nextVoucherSeq = voucherStore.nextVoucherSeq;

  const statements = growerStatements(store, reconciliation, store.rates);
  await store.save();

  return { collected, reconciliation, plans, issued, statements };
}
