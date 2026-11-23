#!/usr/bin/env node
// 柜面命令行：
//   run       采集并结算（幂等，可反复执行）
//   status    查看逐户逐车结算与待办
//   retention 查站端留存起点与缺口
//   ack       对某条流发送留存确认（默认取本地安全 through）
//   vouchers  列出全部凭据（含冲正/补差与原票依据）

import { DeskStore } from './store.mjs';
import { runDesk } from './pipeline.mjs';
import { RetentionManager } from './retention.mjs';
import { reconcile } from './reconcile.mjs';

const [command, ...args] = process.argv.slice(2);
const baseUrl = process.env.SOURCE_URL ?? 'http://127.0.0.1:4180';
const statePath = process.env.STATE_FILE ?? 'state/desk.json';

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) flags[token.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return flags;
}

async function main() {
  const store = await DeskStore.load(statePath);
  const flags = parseFlags(args);

  switch (command) {
    case 'run': {
      const result = await runDesk(store, baseUrl);
      printRun(result);
      break;
    }
    case 'status': {
      const reconciliation = reconcile({
        movements: store.movements,
        ledger: store.ledger,
        approvals: store.approvalIndex(),
        unrecoverableRefs: store.unrecoverableIdentities(),
      });
      console.log(JSON.stringify({
        trucks: reconciliation.trucks,
        groups: reconciliation.groups,
        lines: reconciliation.lines,
        statements: await statementsOnly(store, reconciliation),
        conflicts: store.ledger.conflicts,
        parseErrors: store.ledger.parseErrors,
      }, null, 2));
      break;
    }
    case 'retention': {
      const manager = new RetentionManager(store.streams);
      const report = await manager.syncRetention(baseUrl);
      console.log(JSON.stringify(report, null, 2));
      break;
    }
    case 'ack': {
      const streamId = flags.stream;
      if (!streamId) throw new Error('用法：ack --stream farm-g [--through 288] [--endpoint /scales/farm/ack]');
      const manager = new RetentionManager(store.streams);
      const endpoint = flags.endpoint ?? `/scales/${streamId.split('-')[0]}/ack`;
      const record = await manager.acknowledge(
        baseUrl, streamId, endpoint,
        flags.through === undefined ? {} : { through: Number(flags.through) },
      );
      store.ackHistory[streamId] = manager.acks.get(streamId);
      await store.save();
      console.log(JSON.stringify(record, null, 2));
      break;
    }
    case 'vouchers': {
      console.log(JSON.stringify(store.vouchers, null, 2));
      break;
    }
    default:
      console.error('可用命令：run | status | retention | ack | vouchers');
      process.exitCode = 1;
  }
}

async function statementsOnly(store, reconciliation) {
  const { growerStatements } = await import('./settlement.mjs');
  return growerStatements(store, reconciliation, store.rates);
}

function printRun(result) {
  const { collected, reconciliation, issued } = result;
  console.log(`采集：新认领票据 ${collected.accepted.length} 张，抓取 ${collected.fetchLog.length} 个窗口`);
  for (const entry of collected.fetchLog) {
    console.log(`  - ${entry.url} ${entry.skipped ? '跳过（已覆盖）' : entry.status ?? entry.error ?? ''}`);
  }
  console.log(`核对：可结箱 ${reconciliation.lines.filter(line => line.status === 'settlable').length}，` +
    `停箱 ${reconciliation.lines.filter(line => line.status === 'held').length}`);
  for (const line of reconciliation.lines) {
    const detail = line.status === 'settlable'
      ? `净重 ${line.netKg} kg`
      : `等待：${line.holds.join('；')}`;
    console.log(`  [${line.status}] ${line.grower}/${line.truck} ${line.movement} 箱 ${line.crate} ${detail}`);
  }
  if (!issued.length) console.log('凭据：无新开票（证据未变化，幂等）');
  for (const voucher of issued) {
    if (voucher.kind === 'reversal' || voucher.kind === 'adjustment') {
      console.log(`凭据 ${voucher.voucherId} ${voucher.kind}（依据 ${voucher.originalVoucherId}）差额 ${voucher.totalDelta} 元`);
    } else {
      console.log(`凭据 ${voucher.voucherId} ${voucher.kind} ${voucher.grower}@${voucher.truck} 合计 ${voucher.total} 元`);
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
