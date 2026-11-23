// 只读柜面服务：收购员逐户核实结算凭据、停箱原因、票据依据与留存状态。
// 写操作（采集/确认）走 CLI 或直接调用流水线，保证审计路径单一。

import { createServer } from 'node:http';
import { DeskStore } from './store.mjs';
import { reconcile } from './reconcile.mjs';
import { growerStatements } from './settlement.mjs';
import { RetentionManager } from './retention.mjs';

export async function startDesk(port = 0, statePath = process.env.STATE_FILE ?? 'state/desk.json') {
  const store = await DeskStore.load(statePath);
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (status, payload) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(payload));
    };
    try {
      const reconciliation = reconcile({
        movements: store.movements,
        ledger: store.ledger,
        approvals: store.approvalIndex(),
        unrecoverableRefs: store.unrecoverableIdentities(),
      });
      if (request.method !== 'GET') return send(405, { message: '柜面服务只读' });

      if (url.pathname === '/health') return send(200, { ok: true });
      if (url.pathname === '/statements') {
        return send(200, { statements: growerStatements(store, reconciliation, store.rates) });
      }
      if (url.pathname === '/lines') return send(200, { lines: reconciliation.lines });
      if (url.pathname === '/trucks') return send(200, { trucks: reconciliation.trucks });
      if (url.pathname === '/vouchers') return send(200, { vouchers: store.vouchers });
      if (url.pathname === '/tickets') {
        return send(200, {
          tickets: store.ledger.list().map(ticket => ({
            identity: `${ticket.device}|${ticket.boot}|${ticket.no}`,
            type: ticket.type, crate: ticket.crate, kg: ticket.kg, wall: ticket.wall,
            truck: ticket.truck, movement: ticket.movement, replaces: ticket.replaces ?? null,
            copies: ticket.duplicates.length, provenance: ticket.provenance,
          })),
          conflicts: store.ledger.conflicts,
          parseErrors: store.ledger.parseErrors,
        });
      }
      if (url.pathname === '/retention') {
        const manager = new RetentionManager(store.streams);
        return send(200, {
          streams: [...store.streams.values()].map(stream => ({
            stream: stream.id,
            retentionStart: stream.retentionStart,
            safeThrough: manager.safeThrough(stream.id),
            coverage: stream.coverage(),
            missing: stream.missingWindows(),
            unrecoverable: stream.unrecoverableGaps(),
            fetchFailures: stream.fetchFailures,
          })),
          acks: store.ackHistory,
        });
      }
      return send(404, { message: '未知柜面资源' });
    } catch (error) {
      return send(500, { message: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
