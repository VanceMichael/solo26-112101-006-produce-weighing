// 票据台账：解析完整 NDJSON 行，按“设备 + 开机期 + 原始称量号”去重，
// 维护补打、显式作废、替换票与人工核准之间的有效事实关系。

export const ticketIdentity = ticket => `${ticket.device}|${ticket.boot}|${ticket.no}`;

export class TicketLedger {
  constructor() {
    /** @type {Map<string, object>} 身份 -> 合并后的票据视图 */
    this.tickets = new Map();
    /** 完整行解析失败记录（半行不会进入这里，由流层拦截） */
    this.parseErrors = [];
    /** 同一身份重复送达但内容不一致的冲突 */
    this.conflicts = [];
  }

  addRecord(ticket, provenance) {
    if (!ticket || typeof ticket !== 'object') {
      this.parseErrors.push({ provenance, reason: '票据不是对象' });
      return;
    }
    for (const field of ['device', 'boot', 'no', 'type']) {
      if (ticket[field] === undefined) {
        this.parseErrors.push({ provenance, reason: `缺少字段 ${field}`, raw: ticket });
        return;
      }
    }
    const id = ticketIdentity(ticket);
    const record = { ...ticket, no: Number(ticket.no), provenance };
    if (record.replaces !== undefined) record.replaces = Number(record.replaces);
    const existing = this.tickets.get(id);
    if (!existing) {
      this.tickets.set(id, { ...record, duplicates: [{ ...provenance }] });
      return { id, first: true };
    }
    // 同一称量重复送达：补打（reprint）与原票是同一称量，类型/墙钟不同属于正常；
    // 但箱体、装卸关系或读数不同就是实质冲突，必须登记而不是静默吞掉。
    const businessFields = ['crate', 'kg', 'truck', 'movement', 'replaces'];
    const differs = businessFields.some(field => {
      const a = existing[field] ?? null;
      const b = record[field] ?? null;
      return String(a) !== String(b);
    });
    existing.duplicates.push({ ...provenance });
    if (differs) {
      this.conflicts.push({
        identity: id,
        first: pick(existing),
        repeated: pick(record),
      });
    }
    return { id, first: false };
  }

  get(device, boot, no) {
    return this.tickets.get(`${device}|${boot}|${no}`) ?? null;
  }

  list() {
    return [...this.tickets.values()];
  }

  // 某条票据是否被同身份/同世代的显式作废票作废
  isVoided(ticket) {
    for (const candidate of this.tickets.values()) {
      if (candidate.type !== 'void' || candidate.replaces === undefined) continue;
      if (candidate.device === ticket.device && candidate.boot === ticket.boot &&
        candidate.replaces === ticket.no) {
        return { voidTicket: candidate };
      }
    }
    return null;
  }

  // 查找某张票在同设备世代内被声明的替换票（gross/tare 替换，replaces 回指原票）
  replacementsOf(ticket) {
    return this.list().filter(candidate =>
      candidate.type !== 'void' &&
      candidate.replaces !== undefined &&
      candidate.device === ticket.device &&
      candidate.boot === ticket.boot &&
      candidate.replaces === ticket.no);
  }
}

function pick(ticket) {
  const { device, boot, no, type, crate, kg, wall, truck, movement, replaces } = ticket;
  const result = { device, boot, no, type, crate, kg, wall, truck, movement };
  if (replaces !== undefined) result.replaces = replaces;
  return result;
}

// 柜面核准索引：同设备世代 + 票号 -> 核准记录
export function approvalIndex(approvals = []) {
  const index = new Map();
  for (const approval of approvals) {
    index.set(`${approval.device}|${approval.boot}|${approval.no}`, approval);
  }
  return index;
}

// 针对一条装载/换箱关系，解析当前有效的称量事实（含状态与原因）。
// approvals 为 approvalIndex 结果。
export function resolveWeighing(ledger, ticket, approvals) {
  const voided = ledger.isVoided(ticket);
  const replacements = ledger.replacementsOf(ticket);
  const approvedReplacements = replacements.filter(candidate => approvals.has(ticketIdentity(candidate)));

  if (voided) {
    if (!approvedReplacements.length) {
      return {
        status: 'voided-pending',
        ticket,
        voidTicket: voided.voidTicket,
        reason: '原票已显式作废，替换票尚未经收购员核准',
      };
    }
    const replacement = pickApproved(approvedReplacements, approvals);
    return {
      status: 'replaced',
      ticket: replacement,
      superseded: ticket,
      voidTicket: voided.voidTicket,
      approval: approvals.get(ticketIdentity(replacement)),
    };
  }

  if (replacements.length) {
    const unapproved = replacements.some(candidate => !approvals.has(ticketIdentity(candidate)));
    if (unapproved || !approvedReplacements.length) {
      // 存在争议来源：不能用一张更新的读数直接覆盖
      return {
        status: 'disputed',
        ticket,
        reason: '存在未经核准的替换读数，争议未决前暂停该箱',
        candidates: replacements,
      };
    }
    const replacement = pickApproved(approvedReplacements, approvals);
    return {
      status: 'replaced',
      ticket: replacement,
      superseded: ticket,
      approval: approvals.get(ticketIdentity(replacement)),
    };
  }

  return { status: 'active', ticket };
}

function pickApproved(candidates, approvals) {
  // 多张核准时取最新墙钟时间；同一时刻取最大票号，保证确定
  return [...candidates].sort((a, b) => {
    const time = String(b.wall).localeCompare(String(a.wall));
    return time !== 0 ? time : b.no - a.no;
  })[0] ?? candidates[0];
}
