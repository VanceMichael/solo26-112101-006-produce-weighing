// 核对引擎：把车队装卸关系与秤站票据事实合成“逐户、逐车次、逐箱”的可核实结论。
// 关键约束：
//  - 皮重只认同一次卸空、对应箱体、经核实的装卸关系（按 movement 绑定，不按箱码套用）；
//  - 换箱后不能再用换箱前箱体的重量；替代称量未核准时原票只用于追溯；
//  - 同箱证据冲突先停箱；部分箱未核清不关闭整车补传窗口。

import { decimal } from './decimal.mjs';
import { resolveWeighing, ticketIdentity } from './tickets.mjs';

export const HOLD = Object.freeze({
  GROSS_MISSING: '缺少装货毛重票，待秤站补传',
  TARE_MISSING: '缺少本次卸空对应箱体的皮重票，待秤站补传',
  UNLOAD_MISSING: '箱子尚未完成厂里卸空交接，补传窗口保持开放',
  GROSS_VOIDED: '毛重票已显式作废，核准的替代称量尚未到齐',
  TARE_VOIDED: '皮重票已显式作废，核准的替代称量尚未到齐',
  DISPUTED: '同箱证据冲突，争议未决前暂停该箱',
  EXCHANGE_WEIGHING_MISSING: '换箱登记已到，但换箱后满箱替代称量未核实，原票仅保留追溯',
  MOVEMENT_MISMATCH: '票据绑定的车次/装卸关系与车队登记不一致',
  UNRECOVERABLE: '该票据字节缺口已越过站端留存起点，确实不可补，需人工处理',
});

// 按 movement id 索引票据（同一 movement 上可能有多张，例如补打）
function indexTicketsByMovement(ledger) {
  const index = new Map();
  for (const ticket of ledger.list()) {
    if (!ticket.movement) continue;
    if (!index.has(ticket.movement)) index.set(ticket.movement, []);
    index.get(ticket.movement).push(ticket);
  }
  return index;
}

function selectWeighing(ledger, candidates, approvals, wantedType) {
  const weighings = candidates
    .filter(ticket => ticket.type === wantedType || ticket.type === 'reprint')
    .map(ticket => ({ source: ticket, resolved: resolveWeighing(ledger, ticket, approvals) }));
  if (!weighings.length) return null;
  // 优先选择当前“有效”的称量；多张有效时取墙钟最新（补打与原票同值时等价）
  const ranked = weighings.sort((a, b) =>
    String(b.resolved.ticket.wall).localeCompare(String(a.resolved.ticket.wall)));
  return ranked[0];
}

// 构造证据指纹：指纹变化才允许产生冲正/补差，保证不重复发等额凭据
export function evidenceFingerprint(parts) {
  const json = JSON.stringify(parts);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function ticketRef(ticket) {
  if (!ticket) return null;
  return { identity: ticketIdentity(ticket), kg: ticket.kg ?? null, wall: ticket.wall, type: ticket.type };
}

// movements: 车队装卸单；ledger: 票据台账；approvals: approvalIndex；unrecoverableRefs: 不可补身份集合
export function reconcile({ movements, ledger, approvals, unrecoverableRefs = new Set() }) {
  const byId = new Map(movements.map(movement => [movement.id, movement]));
  const byMovement = indexTicketsByMovement(ledger);
  const loads = movements.filter(movement => movement.type === 'load');
  const lines = [];

  for (const load of loads) {
    const line = buildLoadLine({ load, byId, byMovement, ledger, approvals, unrecoverableRefs });
    lines.push(line);
  }

  const groups = groupLines(lines);
  const trucks = summarizeTrucks(lines);
  return { lines, groups, trucks };
}

function buildLoadLine({ load, byId, byMovement, ledger, approvals, unrecoverableRefs }) {
  const holds = [];
  const trace = []; // 仅追溯、不参与结算的票据

  // 沿 source 链收集全部换箱登记（换箱可能多次发生，箱码重复周转）
  const exchanges = [];
  let pendingSources = [load.id];
  while (pendingSources.length) {
    const nextRound = [];
    for (const sourceId of pendingSources) {
      for (const movement of byId.values()) {
        if (movement.type === 'exchange' && movement.source === sourceId) {
          exchanges.push(movement);
          nextRound.push(movement.id);
        }
      }
    }
    pendingSources = nextRound;
  }
  exchanges.sort((a, b) => String(a.wall ?? '').localeCompare(String(b.wall ?? '')) || a.id.localeCompare(b.id));

  // 校验票据上的 truck 与车队登记一致
  const movementTicketMismatch = tickets => tickets.some(ticket => ticket.truck && ticket.truck !== load.truck);

  // ---- 装货毛重 ----
  const grossCandidates = byMovement.get(load.id) ?? [];
  if (movementTicketMismatch(grossCandidates)) holds.push(HOLD.MOVEMENT_MISMATCH);
  const grossChoice = selectWeighing(ledger, grossCandidates, approvals, 'gross');

  // ---- 卸空关系 ----
  const unload = [...byId.values()].find(movement => movement.type === 'unload' && movement.source === load.id) ?? null;
  if (!unload) holds.push(HOLD.UNLOAD_MISSING);

  // ---- 无换箱：常规毛重 + 本次卸空皮重 ----
  if (!exchanges.length) {
    // 皮重票与装货票同 movement 绑定（数据中皮重 movement 回指装货关系），
    // 且必须存在对应卸空交接；不按箱码跨车次套用昨日/他箱皮重
    const tareCandidates = unload ? (byMovement.get(load.id) ?? []) : [];
    const tareChoice = selectWeighing(ledger, tareCandidates, approvals, 'tare');
    return finalizeLine({
      load, unload, exchanges: [], grossChoice, tareChoice, holds, trace, unrecoverableRefs,
    });
  }

  // ---- 有换箱：原票只用于追溯，结算必须使用换箱后满箱称量与目标箱皮重 ----
  if (grossChoice) trace.push({ role: '换箱前装货毛重（仅追溯）', ...ticketRef(grossChoice.resolved.ticket) });
  const sourceTare = selectWeighing(ledger, byMovement.get(load.id) ?? [], approvals, 'tare');
  if (sourceTare) trace.push({ role: '换箱前原箱皮重（不得用于换箱后净重）', ...ticketRef(sourceTare.resolved.ticket) });

  const lastExchange = exchanges[exchanges.length - 1];
  const exchangeTickets = byMovement.get(lastExchange.id) ?? [];
  if (movementTicketMismatch(exchangeTickets)) holds.push(HOLD.MOVEMENT_MISMATCH);

  const targetTare = selectWeighing(ledger, exchangeTickets, approvals, 'tare');
  const targetGross = selectWeighing(ledger, exchangeTickets, approvals, 'gross');

  // 同一次卸空、同一秤分别证明原箱与目标箱皮重时，换箱校正才具备完整依据
  const sameScaleTareProof = sourceTare && targetTare &&
    sourceTare.resolved.ticket.device === targetTare.resolved.ticket.device;
  if (!sameScaleTareProof) {
    trace.push({ role: '换箱校正说明', note: '未取得同秤对原箱与目标箱的皮重证明，换箱称量校正不成立' });
  }

  return finalizeLine({
    load, unload, exchanges, grossChoice: targetGross, tareChoice: targetTare,
    holds, trace, unrecoverableRefs,
    exchangeContext: { sameScaleTareProof: Boolean(sameScaleTareProof) },
  });
}

function finalizeLine(context) {
  const {
    load, unload, exchanges, grossChoice, tareChoice, holds, trace, unrecoverableRefs,
    exchangeContext = null,
  } = context;

  const pushUnrecoverable = choice => {
    if (!choice) return;
    const id = ticketIdentity(choice.resolved.ticket);
    if (unrecoverableRefs.has(id)) holds.push(HOLD.UNRECOVERABLE);
  };

  // 毛重状态
  if (!grossChoice) {
    holds.push(exchangeContext ? HOLD.EXCHANGE_WEIGHING_MISSING : HOLD.GROSS_MISSING);
  } else {
    pushUnrecoverable(grossChoice);
    const state = grossChoice.resolved.status;
    if (state === 'voided-pending') holds.push(HOLD.GROSS_VOIDED);
    if (state === 'disputed') holds.push(HOLD.DISPUTED);
  }

  // 皮重状态
  if (!tareChoice) {
    holds.push(HOLD.TARE_MISSING);
  } else {
    pushUnrecoverable(tareChoice);
    const state = tareChoice.resolved.status;
    if (state === 'voided-pending') holds.push(HOLD.TARE_VOIDED);
    if (state === 'disputed') holds.push(HOLD.DISPUTED);
  }

  // 换箱场景下，同秤皮重证明缺失时不允许用有据校正
  if (exchangeContext && !exchangeContext.sameScaleTareProof && grossChoice && tareChoice) {
    holds.push(HOLD.EXCHANGE_WEIGHING_MISSING);
  }

  const gross = grossChoice?.resolved.status === 'active' || grossChoice?.resolved.status === 'replaced'
    ? grossChoice.resolved : null;
  const tare = tareChoice?.resolved.status === 'active' || tareChoice?.resolved.status === 'replaced'
    ? tareChoice.resolved : null;

  let netKg = null;
  let fingerprintParts = null;
  if (gross && tare && !holds.length) {
    netKg = decimal.net(gross.ticket.kg, tare.ticket.kg);
    fingerprintParts = [
      ticketIdentity(gross.ticket), gross.ticket.kg,
      ticketIdentity(tare.ticket), tare.ticket.kg,
      exchanges.map(exchange => exchange.id),
      unload?.id ?? null,
    ];
  }

  return {
    lineId: load.id,
    movement: load.id,
    grower: load.grower,
    truck: load.truck,
    crate: load.crate,
    station: load.station,
    unload: unload ? { id: unload.id, station: unload.station } : null,
    exchanges: exchanges.map(exchange => ({
      id: exchange.id, old: exchange.old, new: exchange.new,
      station: exchange.station, wall: exchange.wall, source: exchange.source,
    })),
    gross: gross ? describeResolved(gross) : (grossChoice ? describeResolved(grossChoice.resolved) : null),
    tare: tare ? describeResolved(tare) : (tareChoice ? describeResolved(tareChoice.resolved) : null),
    trace,
    status: holds.length ? 'held' : 'settlable',
    holds: [...new Set(holds)],
    netKg,
    fingerprint: fingerprintParts ? evidenceFingerprint(fingerprintParts) : null,
  };
}

function describeResolved(resolved) {
  return {
    status: resolved.status,
    ticket: ticketRef(resolved.ticket),
    superseded: resolved.superseded ? ticketRef(resolved.superseded) : null,
    approval: resolved.approval ? { approvedBy: resolved.approval.approvedBy, supersedes: resolved.approval.supersedes } : null,
    reason: resolved.reason ?? null,
  };
}

function groupLines(lines) {
  const map = new Map();
  for (const line of lines) {
    const key = `${line.grower}@${line.truck}`;
    if (!map.has(key)) {
      map.set(key, {
        groupId: key, grower: line.grower, truck: line.truck,
        lines: [], settlable: [], held: [],
      });
    }
    const group = map.get(key);
    group.lines.push(line.lineId);
    group[line.status === 'held' ? 'held' : 'settlable'].push(line.lineId);
  }
  return [...map.values()];
}

function summarizeTrucks(lines) {
  const map = new Map();
  for (const line of lines) {
    if (!map.has(line.truck)) map.set(line.truck, { truck: line.truck, total: 0, settled: 0, held: 0, open: false });
    const summary = map.get(line.truck);
    summary.total += 1;
    if (line.status === 'held') {
      summary.held += 1;
      summary.open = true; // 有箱未核清 => 整车补传窗口不关闭
    } else {
      summary.settled += 1;
    }
  }
  return [...map.values()];
}
