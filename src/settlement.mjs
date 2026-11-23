// 结算凭据：买入凭据以“户 + 车次”为单位，逐箱列示。
// 幂等规则：同一装载关系的证据指纹不变，绝不产生第二张等额凭据；
// 指纹变化且原凭据已签收时，只开差额冲正/补差，原凭据保留可查。

import { decimal } from './decimal.mjs';

function voucherId(sequence) {
  return `V-${String(sequence).padStart(4, '0')}`;
}

function lineMoney(line, rates) {
  if (line.status !== 'settlable' || line.netKg === null) return null;
  const rate = rates[line.grower];
  if (rate === undefined) return null;
  return decimal.money(line.netKg, rate);
}

// 根据核对结果与既有凭据，生成需要新开/冲正的凭据计划。
// store: { nextVoucherSeq, vouchers: [] }；reconciliation: reconcile() 结果
export function planVouchers({ reconciliation, rates, store, now = new Date().toISOString() }) {
  const plans = [];
  for (const group of reconciliation.groups) {
    const lines = group.lines
      .map(id => reconciliation.lines.find(line => line.lineId === id))
      .sort((a, b) => a.lineId.localeCompare(b.lineId));
    const settlable = lines.filter(line => line.status === 'settlable' && lineMoney(line, rates) !== null);
    const held = lines.filter(line => line.status === 'held');

    const previous = store.vouchers
      .filter(voucher => voucher.grower === group.grower && voucher.truck === group.truck)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // 每个装载关系的签收状态：以最近一张凭据为准
    //   signed   -> 当前仍签收，记录最近一次凭据与指纹
    //   reversed -> 已冲正、等待重新核清开票
    const stateById = new Map();
    for (const voucher of previous) {
      if (voucher.kind === 'original' || voucher.kind === 'continuation') {
        for (const entry of voucher.entries) {
          stateById.set(entry.movement, {
            state: 'signed', voucherId: voucher.voucherId,
            netKg: entry.netKg, amount: entry.amount, fingerprint: entry.fingerprint,
          });
        }
      } else if (voucher.kind === 'reversal' || voucher.kind === 'adjustment') {
        for (const correction of voucher.corrections) {
          // 冲正使签收失效；补差（仍有正余额）保留签收状态但更新基线金额由续票/原票承载，
          // 这里只标记发生过差额，不改变 signed 事实
          if (voucher.kind === 'reversal') stateById.set(correction.movement, { state: 'reversed' });
        }
      }
    }

    // 已签收且当前仍有效行的证据指纹变化 => 补差/冲正（逐行差额，不重发等额整票）
    const corrections = [];
    const referenceVoucherId = previous.find(voucher =>
      voucher.kind === 'original' || voucher.kind === 'continuation')?.voucherId ?? null;

    for (const line of lines) {
      const state = stateById.get(line.lineId);
      if (!state || state.state !== 'signed') continue;
      if (line.status === 'held') {
        corrections.push({
          movement: line.lineId,
          reason: line.holds.join('；'),
          deltaKg: decimal.subtract('0', state.netKg),
          deltaMoney: decimal.subtract('0', state.amount),
          priorFingerprint: state.fingerprint,
          fingerprint: null,
        });
        continue;
      }
      if (line.fingerprint !== state.fingerprint) {
        const amount = lineMoney(line, rates);
        corrections.push({
          movement: line.lineId,
          reason: '换箱/核准替代称量导致证据变化',
          deltaKg: decimal.subtract(line.netKg, state.netKg),
          deltaMoney: decimal.subtract(amount, state.amount),
          priorFingerprint: state.fingerprint,
          fingerprint: line.fingerprint,
          nextAmount: amount,
          nextNetKg: line.netKg,
        });
      }
    }

    // 新可结算箱：从未签收，或曾被冲正后重新核清
    const fresh = settlable.filter(line => {
      const state = stateById.get(line.lineId);
      return !state || state.state === 'reversed';
    });

    if (corrections.length) {
      const totalDelta = corrections
        .map(correction => correction.deltaMoney)
        .reduce((sum, value) => decimal.add(sum, value), '0.00');
      if (decimal.compare(totalDelta, '0.00') !== 0) {
        plans.push({
          kind: decimal.compare(totalDelta, '0') < 0 ? 'reversal' : 'adjustment',
          groupId: group.groupId,
          grower: group.grower,
          truck: group.truck,
          originalVoucherId: referenceVoucherId,
          corrections,
          totalDelta,
          now,
        });
      }
      // 差额为 0 也不允许制造第二张等额凭据：记录但不开票
    }

    if (fresh.length) {
      const entries = fresh.map(line => ({
        movement: line.lineId,
        crate: line.crate,
        netKg: line.netKg,
        rate: rates[line.grower],
        amount: lineMoney(line, rates),
        fingerprint: line.fingerprint,
        gross: line.gross?.ticket?.identity ?? null,
        tare: line.tare?.ticket?.identity ?? null,
      }));
      const total = entries
        .map(entry => entry.amount)
        .reduce((sum, value) => decimal.add(sum, value), '0.00');
      // 该户该车已有过任何凭据（含冲正）=> 新开的是续票，否则是首张开票
      const kind = previous.length ? 'continuation' : 'original';
      plans.push({
        kind,
        groupId: group.groupId,
        grower: group.grower,
        truck: group.truck,
        originalVoucherId: referenceVoucherId,
        entries,
        total,
        held: held.map(line => ({ movement: line.lineId, crate: line.crate, reasons: line.holds })),
        now,
      });
    } else if (!previous.length && held.length) {
      // 整户整车暂无可结箱：只登记等待，不产生凭据
      plans.push({
        kind: 'waiting',
        groupId: group.groupId,
        grower: group.grower,
        truck: group.truck,
        held: held.map(line => ({ movement: line.lineId, crate: line.crate, reasons: line.holds })),
        now,
      });
    }
  }
  return plans;
}

export function commitPlans(store, plans) {
  const issued = [];
  for (const plan of plans) {
    if (plan.kind === 'waiting') {
      store.waiting = store.waiting ?? [];
      store.waiting.push({ ...plan, committedAt: plan.now });
      continue;
    }
    const voucherIdValue = voucherId(store.nextVoucherSeq++);
    const voucher = {
      voucherId: voucherIdValue,
      kind: plan.kind,
      status: 'active',
      grower: plan.grower,
      truck: plan.truck,
      groupId: plan.groupId,
      originalVoucherId: plan.originalVoucherId,
      createdAt: plan.now,
    };
    if (plan.kind === 'reversal' || plan.kind === 'adjustment') {
      voucher.corrections = plan.corrections;
      voucher.totalDelta = plan.totalDelta;
    } else {
      voucher.entries = plan.entries;
      voucher.total = plan.total;
      voucher.held = plan.held ?? [];
    }
    store.vouchers.push(voucher);
    issued.push(voucher);
  }
  return issued;
}

// 农户视图：逐户逐车的净应付（原凭据 + 冲正/补差代数和），并保留每张票据依据
export function growerStatements(store, reconciliation, rates) {
  const statements = new Map();
  const ensure = (grower, truck) => {
    const key = `${grower}@${truck}`;
    if (!statements.has(key)) {
      statements.set(key, {
        grower, truck, vouchers: [], payable: '0.00', settledMovements: [], waiting: [],
      });
    }
    return statements.get(key);
  };

  for (const voucher of store.vouchers) {
    const statement = ensure(voucher.grower, voucher.truck);
    statement.vouchers.push(voucher.voucherId);
    if (voucher.kind === 'original' || voucher.kind === 'continuation') {
      statement.payable = decimal.add(statement.payable, voucher.total);
      for (const entry of voucher.entries) {
        if (!statement.settledMovements.includes(entry.movement)) {
          statement.settledMovements.push(entry.movement);
        }
      }
    } else {
      statement.payable = decimal.add(statement.payable, voucher.totalDelta);
    }
  }

  for (const group of reconciliation.groups) {
    const statement = ensure(group.grower, group.truck);
    for (const lineId of group.held) {
      const line = reconciliation.lines.find(entry => entry.lineId === lineId);
      statement.waiting.push({ movement: line.lineId, crate: line.crate, reasons: line.holds });
    }
    // 附加单价与逐箱金额，方便收购员逐户核实
    statement.lines = reconciliation.lines
      .filter(line => line.grower === group.grower && line.truck === group.truck)
      .map(line => ({
        movement: line.lineId,
        crate: line.crate,
        status: line.status,
        netKg: line.netKg,
        rate: rates[line.grower] ?? null,
        amount: lineMoney(line, rates),
        reasons: line.holds,
      }));
  }
  return [...statements.values()];
}
