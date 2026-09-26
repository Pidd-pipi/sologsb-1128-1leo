/**
 * 进出港登记的统一把关：页面选择/换船/换类型/恢复草稿与提交保存共用同一套判断。
 *
 * - 进港：证书在登记当天结束时仍有效（证书到期日 >= 登记日），且所选泊位空闲；
 * - 出港：不检查证书，但所选泊位必须处于占用状态且由同一艘船占用。
 */
import type { Berth } from '../types/berth';
import type { FishingVessel } from '../types/vessel';
import type { CallType } from '../types/call';

/** 把关失败原因：证书不适合进港 / 泊位归属不符 等 */
export type CallRejectReason =
  | 'CERT_EXPIRED'
  | 'CERT_INVALID'
  | 'BERTH_NOT_FREE'
  | 'BERTH_OWNER_MISMATCH'
  | 'BERTH_MISSING';

export class CallGuardError extends Error {
  reason: CallRejectReason;

  constructor(reason: CallRejectReason, message: string) {
    super(message);
    this.name = 'CallGuardError';
    this.reason = reason;
  }
}

export interface CallGuardInput {
  vessel: FishingVessel;
  type: CallType;
  /** 登记时间（datetime-local 字符串或 ISO 字符串，按本地日期取「登记当天」） */
  time: string;
  berth: Berth | undefined;
}

export interface CallGuardResult {
  ok: boolean;
  reason?: CallRejectReason;
  message: string;
}

/**
 * 取登记时间对应的本地日期（YYYY-MM-DD）。
 * datetime-local 值（2026-09-26T08:30）若直接交给 new Date 再 getFullYear，
 * 在部分运行时会按 UTC 解析导致跨日偏移，故对这种格式直接截取日期段。
 */
export function registrationDay(time: string): string {
  const value = String(time ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 证书在登记当天结束时是否仍有效。
 * 证书有效期为日期粒度（YYYY-MM-DD），到期日当天全天有效，
 * 即「到期日 >= 登记日」即视为有效；日期串同格式可直接按字典序比较。
 */
export function isCertificateValidOn(certificateExpiry: string, time: string): boolean {
  const day = registrationDay(time);
  const expiry = String(certificateExpiry ?? '').trim().slice(0, 10);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return false;
  return expiry >= day;
}

/**
 * 按同一套规则校验一次进出港登记。
 * 纯查询、不修改任何数据；失败结果带可读 message，页面与 store 都直接复用。
 */
export function checkCallEligibility(input: CallGuardInput): CallGuardResult {
  const { vessel, type, time, berth } = input;
  const day = registrationDay(time);

  if (type === '进港') {
    // 进港先卡证书：证书过期/无效则不适合进港
    const expiry = String(vessel.certificateExpiry ?? '').trim().slice(0, 10);
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      return {
        ok: false,
        reason: 'CERT_INVALID',
        message: `${vessel.name} 证书有效期缺失或无效，不适合进港`,
      };
    }
    if (expiry < day) {
      return {
        ok: false,
        reason: 'CERT_EXPIRED',
        message: `${vessel.name} 的证书已于 ${expiry} 到期，登记日 ${day} 当天已失效，不适合进港`,
      };
    }
    if (!berth) {
      return { ok: false, reason: 'BERTH_MISSING', message: '所选泊位不存在，请重新选择泊位' };
    }
    if (berth.status !== '空闲') {
      return {
        ok: false,
        reason: 'BERTH_NOT_FREE',
        message: `泊位 ${berth.berthNo} 当前为「${berth.status}」，进港必须选择空闲泊位`,
      };
    }
    return { ok: true, message: '' };
  }

  // 出港不检查证书，只认泊位归属：必须由同一艘船占用，保存后只释放它的位置
  if (!berth) {
    return { ok: false, reason: 'BERTH_MISSING', message: '所选泊位不存在，请重新选择泊位' };
  }
  if (berth.status !== '占用' || !berth.vesselId) {
    return {
      ok: false,
      reason: 'BERTH_OWNER_MISMATCH',
      message: `泊位 ${berth.berthNo} 当前并非由 ${vessel.name} 占用（泊位归属不符），不能登记出港`,
    };
  }
  if (berth.vesselId !== vessel.id) {
    const owner = berth.vesselName ? `，当前占用船只为 ${berth.vesselName}` : '';
    return {
      ok: false,
      reason: 'BERTH_OWNER_MISMATCH',
      message: `泊位 ${berth.berthNo} 并非由 ${vessel.name} 占用${owner}（泊位归属不符），不能释放该泊位`,
    };
  }
  return { ok: true, message: '' };
}

/** 断言版：失败时抛 CallGuardError，供 store 保存路径复用 */
export function assertCallEligibility(input: CallGuardInput): void {
  const result = checkCallEligibility(input);
  if (!result.ok) throw new CallGuardError(result.reason!, result.message);
}

/**
 * 仅复核旧泊位选择是否仍然适配（换船、换类型、恢复草稿后用）。
 * 证书问题（不适合进港）不属于「泊位选择失效」，由提交时再拦截；
 * 只有泊位本身不再满足空闲/归属条件时才返回 false，需要清空旧选择重新核验。
 */
export function isBerthSelectionStillValid(input: CallGuardInput): boolean {
  const result = checkCallEligibility(input);
  if (result.ok) return true;
  return result.reason === 'CERT_EXPIRED' || result.reason === 'CERT_INVALID';
}
