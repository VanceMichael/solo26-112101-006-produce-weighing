import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startSources } from '../sources/server.mjs';
import { DeskStore } from '../src/store.mjs';
import { runDesk } from '../src/pipeline.mjs';
import { RetentionManager } from '../src/retention.mjs';
import { reconcile } from '../src/reconcile.mjs';

async function freshStore() {
  const directory = await mkdtemp(join(tmpdir(), 'desk-'));
  const store = await DeskStore.load(join(directory, 'desk.json'));
  return { store, directory };
}

test('端到端：离线补传、换箱、作废核准、留存确认与逐户凭据', async () => {
  const source = await startSources();
  const { store, directory } = await freshStore();
  try {
    // ---------- 阶段 initial：late 503、plant/next 425，只有半段票 ----------
    await fetch(source.url + '/scenario/initial', { method: 'POST' });
    const first = await runDesk(store, source.url);

    // H1 毛重+皮重齐 => 可结；H2 皮重齐但 late 段未到（补打/后续票不影响原毛重事实）
    const h1 = first.reconciliation.lines.find(line => line.lineId === 'MV-1');
    const h2 = first.reconciliation.lines.find(line => line.lineId === 'MV-2');
    const h3 = first.reconciliation.lines.find(line => line.lineId === 'MV-4');
    assert.equal(h1.status, 'settlable');
    assert.equal(h1.netKg, '47.3500');
    assert.equal(h2.status, 'settlable');
    assert.equal(h2.netKg, '43.4500'); // 47.23 - 3.78
    assert.equal(h3.status, 'held'); // T9 只有毛重，无皮重无卸空
    assert.ok(h3.holds.some(reason => reason.includes('皮重')));
    assert.ok(h3.holds.some(reason => reason.includes('卸空')));

    // 半行不得被解析成票据
    assert.equal(store.ledger.list().length, 4);
    // 503/425 记录在案，窗口仍公布待补
    const farm = store.streams.get('farm-g');
    assert.ok(farm.fetchFailures.some(failure => failure.status === 503));
    const plant = store.streams.get('plant-k');
    assert.ok(plant.fetchFailures.some(failure => failure.status === 425));

    // 凭据只开两张（H1、H2），金额精确到分
    const h1Voucher = store.vouchers.find(v => v.grower === 'H1');
    const h2Voucher = store.vouchers.find(v => v.grower === 'H2');
    assert.equal(h1Voucher.total, '125.48');
    assert.equal(h2Voucher.total, '115.14');

    // 安全 through：farm 前两行完整 = 288；plant = 286，半张票排除
    const retention = new RetentionManager(store.streams);
    assert.equal(retention.safeThrough('farm-g'), 288);
    assert.equal(retention.safeThrough('plant-k'), 286);

    // 超界确认必须被柜面拒绝
    await assert.rejects(
      () => retention.acknowledge(source.url, 'farm-g', '/scales/farm/ack', { through: 307 }),
      error => error.code === 'UNSAFE_ACK',
    );

    // 288 确认：来源在 initial 阶段返回 504（司机拔终端），记录为回执丢失，不盲删本地判断
    const lost = await retention.acknowledge(source.url, 'farm-g', '/scales/farm/ack');
    assert.equal(lost.status, 'lost-acknowledgement');
    assert.equal(lost.requested, 288);

    // ---------- 幂等：再跑一次，零新票 ----------
    const rerun = await runDesk(store, source.url);
    assert.equal(rerun.issued.length, 0);
    assert.equal(store.vouchers.length, 2);

    // ---------- 阶段 exchange：补传到达 + 换箱登记；plant 替代毛重已作废 ----------
    await fetch(source.url + '/scenario/exchange', { method: 'POST' });
    const exchange = await runDesk(store, source.url);

    // 半行补齐：g3/13 补打与 g4/12 新毛重被认领，台账身份去重（补打不新增身份）
    assert.equal(store.ledger.list().length, 8); // 4 + 补打(同身份不新增) + g4/12 + k7/18,19,20
    const identities = store.ledger.list().map(t => `${t.device}|${t.boot}|${t.no}`);
    assert.ok(identities.includes('farm|g3|13'));
    assert.equal(identities.filter(id => id === 'farm|g3|13').length, 1);

    // 站端自行报告 farm 留存起点已到 288
    const report = await new RetentionManager(store.streams).syncRetention(source.url);
    const farmReport = report.find(item => item.stream === 'farm-g');
    assert.equal(farmReport.retentionStart, 288);

    // 换箱后 H2：目标箱毛重 19 已被 20 显式作废，替代票未核准 => 停箱，原票仅追溯
    const h2Line = exchange.reconciliation.lines.find(line => line.lineId === 'MV-2');
    assert.equal(h2Line.status, 'held');
    assert.ok(h2Line.holds.length > 0);
    assert.ok(h2Line.trace.some(entry => String(entry.role).includes('仅追溯')));

    // 已签收结果受影响 => 产生 H2 可核对的冲正，原凭据继续可查
    const reversal = store.vouchers.find(v => v.kind === 'reversal' && v.grower === 'H2');
    assert.ok(reversal);
    assert.equal(reversal.totalDelta, '-115.14');
    assert.equal(reversal.originalVoucherId, h2Voucher.voucherId);
    assert.equal(store.vouchers.find(v => v.voucherId === h2Voucher.voucherId).status, 'active');

    // H1 的已签收结果依旧有效，不动它
    assert.equal(store.vouchers.filter(v => v.grower === 'H1').length, 1);

    // T9 部分箱未完成交接 => 整车补传窗口保持开放
    const t9 = exchange.reconciliation.trucks.find(summary => summary.truck === 'T9');
    assert.equal(t9.open, true);
    const t8 = exchange.reconciliation.trucks.find(summary => summary.truck === 'T8');
    assert.equal(t8.open, true); // H2 箱停着，T8 也不能关窗

    // ---------- 阶段 reviewed：核准人工复称（21 replaces 19）----------
    await fetch(source.url + '/scenario/reviewed', { method: 'POST' });
    const reviewed = await runDesk(store, source.url);
    const finalH2 = reviewed.reconciliation.lines.find(line => line.lineId === 'MV-2');
    assert.equal(finalH2.status, 'settlable');
    assert.equal(finalH2.netKg, '43.4900'); // 47.94 - 4.45
    assert.equal(finalH2.gross.ticket.identity, 'plant|k7|21');
    assert.equal(finalH2.gross.superseded.identity, 'plant|k7|19');
    assert.equal(finalH2.gross.approval.approvedBy, '收购员乙');

    // 冲正之后只补一张 115.25 的凭据，不存在第二张等额 115.14
    const h2Vouchers = store.vouchers.filter(v => v.grower === 'H2');
    assert.equal(h2Vouchers.filter(v => v.kind === 'original' || v.kind === 'continuation').length, 2);
    const continuation = h2Vouchers.find(v => v.kind === 'continuation');
    assert.equal(continuation.total, '115.25');

    // 农户对账单：H2 净应付 115.25；H1 始终 125.48；H3 等待
    const statements = reviewed.statements;
    assert.equal(statements.find(s => s.grower === 'H2').payable, '115.25');
    assert.equal(statements.find(s => s.grower === 'H1').payable, '125.48');
    const h3Statement = statements.find(s => s.grower === 'H3');
    assert.ok(h3Statement.waiting.length >= 1);

    // 已签收凭据的票据依据仍在本地字节中（站端清缓存不影响柜面举证）
    const coverage = new RetentionManager(store.streams).evidenceCoverage(store.ledger);
    for (const entry of coverage) assert.equal(entry.local, true, entry.identity);

    // ---------- 持久化：重开存储后状态完整 ----------
    await store.save();
    const reopened = await DeskStore.load(store.path);
    assert.equal(reopened.vouchers.length, store.vouchers.length);
    assert.equal(reopened.ledger.list().length, store.ledger.list().length);
    const reopenedView = reconcile({
      movements: reopened.movements, ledger: reopened.ledger,
      approvals: reopened.approvalIndex(), unrecoverableRefs: reopened.unrecoverableIdentities(),
    });
    assert.equal(reopenedView.lines.find(line => line.lineId === 'MV-2').netKg, '43.4900');
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
