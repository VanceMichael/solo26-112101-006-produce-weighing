import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decimal } from '../src/decimal.mjs';

test('十进制金额与重量不产生二进制浮点误差', () => {
  assert.equal(decimal.net('47.23', '3.78'), '43.4500');
  assert.equal(decimal.net('51.43', '4.08'), '47.3500');
  assert.equal(decimal.money('43.4500', '2.65'), '115.14');
  assert.equal(decimal.money('43.4900', '2.65'), '115.25'); // 115.2485 四舍五入
  assert.equal(decimal.money('47.3500', '2.65'), '125.48'); // 125.4775 四舍五入
  assert.equal(decimal.subtract('115.25', '115.14'), '0.11');
  assert.equal(decimal.compare('0.110000000', '0.11'), 0);
  assert.equal(decimal.add('115.14', '-115.14'), '0.00');
});

test('常见浮点陷阱值保持精确', () => {
  assert.equal(decimal.add('0.1', '0.2'), '0.30'); // 金额口径归整到分
  assert.equal(decimal.money('0.07', '2.65'), '0.19'); // 0.1855 -> 0.19
  assert.equal(decimal.net('0.3', '0.1'), '0.2000'); // 重量口径保留 4 位
});
