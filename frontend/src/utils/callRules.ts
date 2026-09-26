/**
 * 进出港登记的统一校验规则。
 * 页面（泊位选项过滤、泊位点选、表单提交）与 portStore.registerCall 共用同一套判断：
 * - 进港：证书在登记当天结束时仍有效，且泊位空闲；
 * - 出港：不查证书，但所选泊位必须由同一艘船占用。
 */
import type { Berth } from '../types/berth';
import type { CallType } from '../types/call';
import type { FishingVessel } from '../types/vessel';

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 登记时间（datetime-local / ISO）对应的本地日期 YYYY-MM-DD，无效时返回空串 */
function localDayOf(time: string): string {
  if (!time) return '';
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 证书在登记当天结束时是否仍有效：到期日不早于登记日即有效
 * （与 tonnage.ts 中「到期日当天 23:59:59 前有效」的口径一致）。
 */
export function certificateValidOn(certificateExpiry: string, time: string): boolean {
  const day = localDayOf(time);
  if (!day || !certificateExpiry) return false;
  return certificateExpiry >= day;
}

/** 进港泊位必须空闲 */
export function berthOpenForArrival(berth: Berth | null | undefined): boolean {
  return !!berth && berth.status === '空闲';
}

/** 出港泊位必须由同一艘船占用 */
export function berthOwnedBy(berth: Berth | null | undefined, vesselId: string): boolean {
  return !!berth && !!vesselId && berth.status === '占用' && berth.vesselId === vesselId;
}

export interface CallRuleInput {
  type: CallType;
  vessel: FishingVessel | null | undefined;
  berth: Berth | null | undefined;
  /** 登记时间（datetime-local 或 ISO 字符串） */
  time: string;
}

/**
 * 校验一条进出港登记，返回 null 表示通过；
 * 否则返回带类别前缀的失败原因（「不适合进港」/「泊位归属不符」），可直接展示给用户。
 */
export function checkCallRules(input: CallRuleInput): string | null {
  const { type, vessel, berth, time } = input;
  if (!vessel) return '请选择有效的渔船';
  if (!berth) return '请选择有效的泊位';
  if (type === '进港') {
    if (!certificateValidOn(vessel.certificateExpiry, time)) {
      return `不适合进港：${vessel.name} 证书有效期至 ${vessel.certificateExpiry}，登记当天结束时已失效`;
    }
    if (!berthOpenForArrival(berth)) {
      return `不适合进港：泊位 ${berth.berthNo} 当前为「${berth.status}」，进港需选择空闲泊位`;
    }
    return null;
  }
  if (!berthOwnedBy(berth, vessel.id)) {
    const holder =
      berth.status === '占用' && berth.vesselName ? `现由 ${berth.vesselName} 占用` : `当前为「${berth.status}」`;
    return `泊位归属不符：泊位 ${berth.berthNo} ${holder}，不能登记 ${vessel.name} 出港`;
  }
  return null;
}
