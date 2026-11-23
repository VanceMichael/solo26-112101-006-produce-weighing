// 来源采集：从秤站清单发现可补传片段，容忍 503（待补传）/425（先确认）等响应，
// 按绝对偏移汇入 ByteStream；同一称量重复到达时由票据台账去重，绝不重复认领。

import { ByteStream } from './streams.mjs';
import { TicketLedger, ticketIdentity } from './tickets.mjs';

export class SourceError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'SourceError';
    Object.assign(this, details);
  }
}

async function getJson(baseUrl, path) {
  const response = await fetch(baseUrl + path);
  const text = await response.text();
  if (!response.ok) {
    let message = `来源 ${path} 返回 ${response.status}`;
    try { message = JSON.parse(text).message ?? message; } catch { /* 非 JSON 错误页 */ }
    throw new SourceError(message, { path, status: response.status, body: text });
  }
  return JSON.parse(text);
}

// 拉取并消化一个阶段可见的全部来源。重复执行是安全的：
// 片段重叠只按字节合并，票据按身份去重。
export async function collect({ baseUrl, streams, ledger, approvals }) {
  const catalog = await getJson(baseUrl, '/scales');
  const fetchLog = [];

  for (const [streamId, windows] of Object.entries(catalog.streams)) {
    if (!streams.has(streamId)) streams.set(streamId, new ByteStream(streamId));
    const stream = streams.get(streamId);
    for (const window of windows) {
      stream.publishWindow(window);
      // 已完整覆盖的窗口不重复拉取
      const already = stream.coverage().some(([start, end]) => start <= window.offset &&
        end >= window.offset + window.bytes);
      if (already) {
        fetchLog.push({ url: window.url, skipped: 'already-covered' });
        continue;
      }
      try {
        const response = await fetch(baseUrl + window.url);
        if (!response.ok) {
          const text = await response.text();
          let message = `状态 ${response.status}`;
          try { message = JSON.parse(text).message ?? message; } catch { /* 忽略解析失败 */ }
          stream.recordFailure(window.url, response.status, message);
          fetchLog.push({ url: window.url, status: response.status, message });
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        stream.ingest(window.offset, buffer);
        fetchLog.push({ url: window.url, status: 200, bytes: buffer.length, offset: window.offset });
      } catch (error) {
        stream.recordFailure(window.url, 0, error.message);
        fetchLog.push({ url: window.url, error: error.message });
      }
    }
  }

  // 从完整行解析票据；半行继续留在字节缓冲里等待补齐
  const accepted = [];
  for (const stream of streams.values()) {
    for (const line of stream.completeLines()) {
      if (line.partial) continue;
      if (!line.text.trim()) continue;
      let ticket;
      try {
        ticket = JSON.parse(line.text);
      } catch {
        ledger.parseErrors.push({
          provenance: { stream: stream.id, bytes: [line.start, line.lineEnd] },
          reason: '完整行不是合法 JSON',
          raw: line.text,
        });
        continue;
      }
      const result = ledger.addRecord(ticket, {
        stream: stream.id, bytes: [line.start, line.lineEnd],
      });
      if (result?.first) accepted.push(ticketIdentity(ticket));
    }
  }

  // 车队与核准：整单重发，按 id 覆盖（车队登记以最新一次为准，历史关系仍在单据内）
  const movements = await getJson(baseUrl, '/fleet/movements');
  const desk = await getJson(baseUrl, '/desk/approvals');
  approvals.rates = desk.rates;
  approvals.list = desk.approved;
  approvals.index = new Map(desk.approved.map(item =>
    [`${item.device}|${item.boot}|${item.no}`, item]));

  return { fetchLog, accepted, movements, rates: desk.rates, approved: desk.approved };
}
