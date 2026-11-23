// 柜面持久化：跨班次保存原始字节、票据台账、车队快照、核准、凭据与确认记录。
// 重开服务不丢已收票据；清缓存只影响站端，本地证据始终可查。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ByteStream } from './streams.mjs';
import { TicketLedger, ticketIdentity } from './tickets.mjs';

export class DeskStore {
  constructor(path) {
    this.path = path;
    this.streams = new Map();
    this.ledger = new TicketLedger();
    this.movements = [];
    this.rates = {};
    this.approved = [];
    this.nextVoucherSeq = 1;
    this.vouchers = [];
    this.waiting = [];
    this.ackHistory = {};
    this.runs = [];
  }

  static async load(path) {
    const store = new DeskStore(path);
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      for (const [id, data] of Object.entries(raw.streams ?? {})) {
        store.streams.set(id, ByteStream.fromJSON(id, data));
      }
      store.ledger = new TicketLedger();
      for (const data of raw.tickets ?? []) {
        store.ledger.addRecord(data.ticket, data.provenance);
      }
      store.ledger.parseErrors = raw.parseErrors ?? [];
      store.ledger.conflicts = raw.conflicts ?? [];
      store.movements = raw.movements ?? [];
      store.rates = raw.rates ?? {};
      store.approved = raw.approved ?? [];
      store.nextVoucherSeq = raw.nextVoucherSeq ?? 1;
      store.vouchers = raw.vouchers ?? [];
      store.waiting = raw.waiting ?? [];
      store.ackHistory = raw.ackHistory ?? {};
      store.runs = raw.runs ?? [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return store;
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const payload = {
      streams: Object.fromEntries([...this.streams].map(([id, stream]) => [id, stream.toJSON()])),
      tickets: this.ledger.list().map(ticket => ({
        ticket: structuredClone(cleanTicket(ticket)),
        provenance: ticket.provenance,
      })),
      parseErrors: this.ledger.parseErrors,
      conflicts: this.ledger.conflicts,
      movements: this.movements,
      rates: this.rates,
      approved: this.approved,
      nextVoucherSeq: this.nextVoucherSeq,
      vouchers: this.vouchers,
      waiting: this.waiting,
      ackHistory: this.ackHistory,
      runs: this.runs,
    };
    await writeFile(this.path, JSON.stringify(payload, null, 2));
  }

  approvalIndex() {
    return new Map(this.approved.map(item =>
      [`${item.device}|${item.boot}|${item.no}`, item]));
  }

  // 越过站端留存起点仍缺失的票据身份：确实不可补，与待核结算分开列示
  unrecoverableIdentities() {
    const result = new Set();
    for (const stream of this.streams.values()) {
      const gaps = stream.unrecoverableGaps();
      if (!gaps.length) continue;
      for (const ticket of this.ledger.list()) {
        if (ticket.provenance.stream !== stream.id) continue;
        const [start, end] = ticket.provenance.bytes;
        if (gaps.some(([gapStart, gapEnd]) => start < gapEnd && end > gapStart)) {
          result.add(ticketIdentity(ticket));
        }
      }
    }
    return result;
  }
}

function cleanTicket(ticket) {
  const { duplicates, provenance, ...fields } = ticket;
  return fields;
}
