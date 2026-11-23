// 字节流拼装：秤站线路按绝对字节偏移提供 NDJSON 片段，
// 片段可能从半行开始、相互重叠，也可能整段缺失（离线缓存/传输失败）。
// 本模块只负责字节层面的覆盖、缺口与“完整行”判定，不解释票据业务。

const NEWLINE = 0x0a;

export class ByteStream {
  constructor(id) {
    this.id = id;
    /** @type {Map<number, Buffer>} 已收到的原始片段，键为绝对偏移 */
    this.fragments = new Map();
    /** 站端公布过的可拉取窗口 */
    this.windows = [];
    /** 拉取失败记录（503/425 等），保留原因供补传判断 */
    this.fetchFailures = [];
    /** 站端滑动缓存当前留存起点 */
    this.retentionStart = 0;
  }

  // 登记公布窗口（去重）
  publishWindow(window) {
    const exists = this.windows.some(
      entry => entry.offset === window.offset && entry.bytes === window.bytes && entry.url === window.url,
    );
    if (!exists) this.windows.push({ ...window });
  }

  recordFailure(url, status, message) {
    this.fetchFailures.push({ url, status, message, at: new Date().toISOString() });
  }

  // 汇入一个片段。重叠区逐字节校验；重叠但内容不一致属于传输冲突，明确报错而不是静默覆盖。
  ingest(offset, buffer) {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('偏移必须为非负整数');
    const incoming = Buffer.from(buffer);
    for (const [existingOffset, existing] of this.fragments) {
      const existingEnd = existingOffset + existing.length;
      const incomingEnd = offset + incoming.length;
      const overlapStart = Math.max(offset, existingOffset);
      const overlapEnd = Math.min(incomingEnd, existingEnd);
      if (overlapStart < overlapEnd) {
        const a = incoming.subarray(overlapStart - offset, overlapEnd - offset);
        const b = existing.subarray(overlapStart - existingOffset, overlapEnd - existingOffset);
        if (!a.equals(b)) {
          const conflict = new Error(`流 ${this.id} 在 [${overlapStart},${overlapEnd}) 出现重叠字节冲突`);
          conflict.code = 'BYTE_CONFLICT';
          throw conflict;
        }
      }
    }
    const previous = this.fragments.get(offset);
    if (!previous || incoming.length > previous.length) this.fragments.set(offset, incoming);
  }

  // 合并后的连续覆盖区间列表 [start, end)
  coverage() {
    const intervals = [...this.fragments.entries()]
      .map(([offset, buffer]) => [offset, offset + buffer.length])
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of intervals) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    return merged;
  }

  // 取 [start, end) 内已覆盖的字节；区间内只要有缺口就返回 null
  slice(start, end) {
    const parts = [];
    let cursor = start;
    const ordered = [...this.fragments.entries()].sort((a, b) => a[0] - b[0]);
    for (const [offset, buffer] of ordered) {
      const fragmentEnd = offset + buffer.length;
      if (fragmentEnd <= cursor) continue;
      if (offset >= end) break;
      if (offset > cursor) return null; // 中间出现缺口
      const sliceEnd = Math.min(fragmentEnd, end);
      parts.push(buffer.subarray(cursor - offset, sliceEnd - offset));
      cursor = sliceEnd;
      if (cursor === end) break;
    }
    if (cursor !== end || !parts.length) return null;
    return Buffer.concat(parts);
  }

  // 解析当前覆盖下所有“完整行”。
  // 完整行：从行首到换行符全部字节都在同一连续覆盖区间内。
  // 跨行缺口或末尾半行不会被当成完整票据。
  completeLines() {
    const lines = [];
    for (const [intervalStart, intervalEnd] of this.coverage()) {
      const buffer = this.slice(intervalStart, intervalEnd);
      let lineStart = intervalStart;
      for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] !== NEWLINE) continue;
        const lineEndInclusive = intervalStart + index; // 换行符位置
        lines.push({
          start: lineStart,
          end: lineEndInclusive, // 不含换行
          lineEnd: lineEndInclusive + 1, // 含换行
          text: buffer.subarray(lineStart - intervalStart, index).toString('utf8'),
        });
        lineStart = lineEndInclusive + 1;
      }
      // 区间末尾没有换行 => 半张票，留给后续片段补齐
      if (lineStart < intervalEnd) {
        lines.push({ start: lineStart, end: intervalEnd, lineEnd: null, partial: true });
      }
    }
    return lines;
  }

  // 相对留存起点，最长连续完整行前缀的终点（半开区间）。
  // 这是柜面可以独立重放、允许站端腾缓存的最大安全 through。
  // 仅确认从留存起点开始连续覆盖的区间；留存起点切进的行整行保留；
  // 留存起点已高于本地覆盖时（站端先行滑动），退回到本地仍持有的完整行边界。
  safeThrough() {
    const intervals = this.coverage();
    const first = intervals.find(([start, end]) => end > this.retentionStart);
    if (!first) {
      // 本地覆盖全部位于留存起点之前：确认上限就是已保存的完整行终点
      const saved = intervals.filter(([start, end]) => end <= this.retentionStart);
      return saved.length ? saved[saved.length - 1][1] : this.retentionStart;
    }
    const [intervalStart, intervalEnd] = first;
    if (intervalStart > this.retentionStart) {
      // 留存起点与首个覆盖区间不连续：没有可确认的连续前缀
      const saved = intervals.filter(([start, end]) => end <= this.retentionStart);
      return saved.length ? saved[saved.length - 1][1] : this.retentionStart;
    }
    const buffer = this.slice(intervalStart, intervalEnd);
    // 留存起点切进某行内部时，先定位它之后的第一个行首；
    // 起点所在的残行不完整，不能确认，through 先停在留存起点。
    let lineStart = intervalStart;
    let through = this.retentionStart;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== NEWLINE) continue;
      const lineEnd = intervalStart + index + 1; // 含换行的行终点（下一行行首）
      // 只有“整行都位于留存起点之后”（行首 >= 留存起点）才计入确认前缀
      if (lineStart >= this.retentionStart) through = lineEnd;
      lineStart = lineEnd;
    }
    return through;
  }

  // 公布窗口中仍缺字节的区间（原始计算，不按留存起点过滤）
  rawMissingWindows() {
    const covered = this.coverage();
    const missing = [];
    for (const window of this.windows) {
      const windowEnd = window.offset + window.bytes;
      let cursor = window.offset;
      for (const [start, end] of covered) {
        if (end <= cursor) continue;
        if (start >= windowEnd) break;
        if (start > cursor) missing.push([cursor, Math.min(start, windowEnd)]);
        cursor = Math.max(cursor, Math.min(end, windowEnd));
      }
      if (cursor < windowEnd) missing.push([cursor, windowEnd]);
    }
    return missing;
  }

  // 仍在留存起点之后、还能向站端要回的缺口
  missingWindows() {
    return this.rawMissingWindows()
      .filter(([start, end]) => end > this.retentionStart)
      .map(([start, end]) => [Math.max(start, this.retentionStart), end]);
  }

  // 留存起点已越过、但柜面未保存到的字节区间：确实不可补
  unrecoverableGaps() {
    const gaps = [];
    for (const [start, end] of this.rawMissingWindows()) {
      if (start < this.retentionStart) gaps.push([start, Math.min(end, this.retentionStart)]);
    }
    return gaps;
  }

  toJSON() {
    return {
      id: this.id,
      fragments: [...this.fragments.entries()].map(([offset, buffer]) => [
        offset,
        buffer.toString('base64'),
      ]),
      windows: this.windows,
      fetchFailures: this.fetchFailures,
      retentionStart: this.retentionStart,
    };
  }

  static fromJSON(id, data) {
    const stream = new ByteStream(id);
    for (const [offset, base64] of data.fragments ?? []) {
      stream.ingest(Number(offset), Buffer.from(base64, 'base64'));
    }
    stream.windows = data.windows ?? [];
    stream.fetchFailures = data.fetchFailures ?? [];
    stream.retentionStart = data.retentionStart ?? 0;
    return stream;
  }
}
