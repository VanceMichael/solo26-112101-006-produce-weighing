// 留存确认：
//  柜面只能确认“可独立重放的完整票前缀”之后的字节，半张票/字节缺口绝不让站端删掉；
//  站端返回实际清到的偏移；司机拔终端导致回执丢失时，下一班先查留存起点再决定补传。

export class RetentionManager {
  constructor(streams) {
    this.streams = streams;
    /** streamId -> 历次确认 */
    this.acks = new Map();
  }

  // 计算某条流当前允许发送的最大 through（不含）
  safeThrough(streamId) {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`未知流 ${streamId}`);
    return stream.safeThrough();
  }

  // 发送确认。baseUrl 上的端点约定：POST /scales/{name}/ack {stream, through}
  // 返回 { requested, applied, lostAcknowledgement }
  async acknowledge(baseUrl, streamId, endpoint, options = {}) {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`未知流 ${streamId}`);
    const requested = options.through ?? stream.safeThrough();
    const ceiling = stream.safeThrough();
    if (requested > ceiling) {
      const error = new Error(`拒绝确认 through=${requested}：本地只能独立重放到 ${ceiling}，半张票必须留在站端`);
      error.code = 'UNSAFE_ACK';
      throw error;
    }

    const record = {
      stream: streamId, requested, at: new Date().toISOString(),
      status: 'pending', applied: null,
    };
    try {
      const response = await fetch(baseUrl + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stream: streamId, through: requested }),
      });
      record.httpStatus = response.status;
      if (!response.ok) {
        // 504 等：司机可能已拔终端，站端可能已应用也可能没有，回执不可信
        record.status = 'lost-acknowledgement';
        record.message = (await response.text()).slice(0, 200);
      } else {
        const payload = await response.json();
        record.status = 'confirmed';
        record.applied = payload.applied ?? payload.through ?? requested;
        stream.retentionStart = Math.max(stream.retentionStart, Number(record.applied));
      }
    } catch (error) {
      record.status = 'lost-acknowledgement';
      record.message = error.message;
    }
    if (!this.acks.has(streamId)) this.acks.set(streamId, []);
    this.acks.get(streamId).push(record);
    return record;
  }

  // 下一班开班：拉取站端公布的留存起点，与本地已保存原字节对齐
  async syncRetention(baseUrl) {
    const response = await fetch(baseUrl + '/scales/retention');
    if (!response.ok) throw new Error(`留存起点查询失败：${response.status}`);
    const published = await response.json();
    const report = [];
    for (const [streamId, start] of Object.entries(published)) {
      const stream = this.streams.get(streamId);
      if (!stream) continue;
      stream.retentionStart = Math.max(stream.retentionStart, Number(start));
      report.push({
        stream: streamId,
        retentionStart: stream.retentionStart,
        safeThrough: stream.safeThrough(),
        missing: stream.missingWindows(),
        unrecoverable: stream.unrecoverableGaps(),
      });
    }
    return report;
  }

  // 已确认清缓存但票据仍在本地完整保存：已签收凭据不会因清缓存失去票据依据
  // 这里给出每个已签收票据身份对应的本地字节证据位置
  evidenceCoverage(ledger) {
    const coverage = [];
    for (const ticket of ledger.list()) {
      const provenance = ticket.provenance;
      const stream = this.streams.get(provenance.stream);
      const local = stream?.coverage().some(([start, end]) =>
        start <= provenance.bytes[0] && end >= provenance.bytes[1]) ?? false;
      coverage.push({ identity: `${ticket.device}|${ticket.boot}|${ticket.no}`, local, provenance });
    }
    return coverage;
  }
}
