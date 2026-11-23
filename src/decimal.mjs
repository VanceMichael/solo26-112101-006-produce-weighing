// 十进制运算：所有重量与金额都按整数放大保存，避免二进制浮点误差。
// 外部输入一律为十进制字符串或 number（number 仅在 JSON 数字时出现，先转字符串）。

const SCALE = { kg: 4, money: 2 };

function parseDecimal(raw) {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim();
  let negative = false;
  if (text.startsWith('-') || text.startsWith('+')) {
    negative = text.startsWith('-');
    text = text.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`无法识别的十进制数值：${raw}`);
  }
  const [whole, fraction = ''] = text.split('.');
  return { negative, whole: whole || '0', fraction };
}

// 统一放到 9 位小数的整数空间内做精确运算。
const COMMON_PLACES = 9;

function toScaledInteger(raw) {
  if (raw === null || raw === undefined) return null;
  const parsed = parseDecimal(raw);
  if (parsed === null) return null;
  const fraction = parsed.fraction.padEnd(COMMON_PLACES, '0').slice(0, COMMON_PLACES);
  const value = BigInt(parsed.whole) * 10n ** BigInt(COMMON_PLACES) + BigInt(fraction || '0');
  return parsed.negative ? -value : value;
}

function fromScaledInteger(value, places = COMMON_PLACES) {
  // value 始终是 9 位小数空间的整数；places 是要展示/舍入到的小数位
  const rounded = roundScaled(value, places);
  const factor = 10n ** BigInt(COMMON_PLACES - places);
  const units = rounded / factor; // 目标单位下的整数（负号保留）
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

// 四舍五入到指定小数位（半数向上，符合收购柜面习惯）。
function roundScaled(value, places) {
  const factor = 10n ** BigInt(COMMON_PLACES - places);
  const half = factor / 2n;
  if (value >= 0n) return ((value + half) / factor) * factor;
  return -(((-value) + half) / factor) * factor;
}

function operate(a, b, fn) {
  return fn(toScaledInteger(a), toScaledInteger(b));
}

export const decimal = {
  // 加减结果归整到分（金额口径），重量请使用 net/roundKg
  add: (a, b) => fromScaledInteger(roundScaled(operate(a, b, (x, y) => x + y), SCALE.money), SCALE.money),
  subtract: (a, b) => fromScaledInteger(roundScaled(operate(a, b, (x, y) => x - y), SCALE.money), SCALE.money),
  compare(a, b) {
    const [x, y] = [toScaledInteger(a), toScaledInteger(b)];
    return x === y ? 0 : x < y ? -1 : 1;
  },
  // 净重：差值舍入到 4 位小数（kg）
  net(gross, tare) {
    return fromScaledInteger(roundScaled(operate(gross, tare, (x, y) => x - y), SCALE.kg), SCALE.kg);
  },
  // 金额 = 净重(kg) × 单价(元/kg)，结果四舍五入到分。
  // 两个 9 位小数整数相乘得到 18 位小数，先收回 9 位空间再舍到 2 位。
  money(kg, rate) {
    const product = toScaledInteger(kg) * toScaledInteger(rate);
    const shrink = 10n ** BigInt(COMMON_PLACES);
    const normalized = product >= 0n
      ? (product + shrink / 2n) / shrink
      : -(((-product) + shrink / 2n) / shrink);
    return fromScaledInteger(roundScaled(normalized, SCALE.money), SCALE.money);
  },
  roundKg(kg) {
    return fromScaledInteger(roundScaled(toScaledInteger(kg), SCALE.kg), SCALE.kg);
  },
  roundMoney(money) {
    return fromScaledInteger(roundScaled(toScaledInteger(money), SCALE.money), SCALE.money);
  },
  toScaledInteger,
  fromScaledInteger,
};
