<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { useBerthStatus } from '../hooks/useBerthStatus';
import BerthGrid from '../components/common/BerthGrid.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { Berth } from '../types/berth';
import { CALL_TYPES, VISA_STATUSES, emptyCallDraft, type CallDraft } from '../types/call';
import { formatDateTime, formatNumber, isToday, nowLocalInputValue, toPlain } from '../utils/format';
import { berthOpenForArrival, berthOwnedBy, certificateValidOn, checkCallRules } from '../utils/callRules';

interface CallForm extends CallDraft {
  portId: string;
}

const router = useRouter();
const portStore = usePortStore();
const vesselStore = useVesselStore();

const { draft, restored, savedAt, storageKey, persist, restore, clearDraft } = useLocalDraft<CallForm>('call-board', () => ({
  ...emptyCallDraft(),
  portId: '',
  time: nowLocalInputValue(),
}));
const form = draft;

const formRef = ref<FormInstance>();
const submitting = ref(false);
const focusPortId = ref('');

const rules: FormRules = {
  vesselId: [{ required: true, message: '请选择渔船', trigger: 'change' }],
  portId: [{ required: true, message: '请选择泊位', trigger: 'change' }],
  time: [{ required: true, message: '请选择进出港时间', trigger: 'change' }],
};

const vesselOptions = computed(() => vesselStore.vessels);

const selectedVessel = computed(() => vesselStore.vesselById(form.value.vesselId));

/** 进港只能选空闲泊位；出港只能选本船占用的泊位（与提交校验同一套判断） */
const berthOptions = computed(() => {
  const type = form.value.type;
  const vesselId = form.value.vesselId;
  return portStore.berths
    .filter((b) => (type === '进港' ? berthOpenForArrival(b) : berthOwnedBy(b, vesselId)))
    .map((b) => ({
      value: `${b.portId}|${b.berthNo}`,
      label: `${portStore.portById(b.portId)?.name ?? b.portId} · ${b.berthNo}`,
      portId: b.portId,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
});

const berthPlaceholder = computed(() => {
  if (form.value.type === '进港') return '选择空闲泊位';
  return form.value.vesselId ? '选择本船占用的泊位' : '请先选择渔船';
});

/** 进港且证书在登记当天结束时已失效时给出提示（与提交校验同一套判断） */
const certificateHint = computed(() => {
  const vessel = selectedVessel.value;
  if (!vessel || form.value.type !== '进港' || !form.value.time) return '';
  if (certificateValidOn(vessel.certificateExpiry, form.value.time)) return '';
  return `不适合进港：证书有效期至 ${vessel.certificateExpiry}，登记当天结束时已失效`;
});

const berthKey = computed({
  get: () => (form.value.portId && form.value.berthNo ? `${form.value.portId}|${form.value.berthNo}` : ''),
  set: (key: string) => {
    const [portId, berthNo] = String(key).split('|');
    form.value.portId = portId ?? '';
    form.value.berthNo = berthNo ?? '';
    focusPortId.value = portId ?? '';
  },
});

const focusBerths = computed<Berth[]>(() =>
  focusPortId.value ? portStore.berthsOf(focusPortId.value) : [],
);

const berthRef = computed(() => portStore.berths);
const { summary } = useBerthStatus(berthRef, computed(() => focusPortId.value));

const todayCalls = computed(() => portStore.callsSorted.filter((c) => isToday(c.time)));

const todayStats = computed(() => ({
  inbound: todayCalls.value.filter((c) => c.type === '进港').length,
  outbound: todayCalls.value.filter((c) => c.type === '出港').length,
  ice: todayCalls.value.reduce((sum, c) => sum + c.iceKg, 0),
  fuel: todayCalls.value.reduce((sum, c) => sum + c.fuelL, 0),
  unload: todayCalls.value.reduce((sum, c) => sum + c.unloadKg, 0),
}));

function hasContent(value: CallForm): boolean {
  return (
    Boolean(value.vesselId) ||
    Boolean(value.berthNo) ||
    Number(value.iceKg) > 0 ||
    Number(value.fuelL) > 0 ||
    Number(value.unloadKg) > 0
  );
}

/** 换船、换类型或恢复草稿后重新核验旧泊位选择，不符合当前规则即清空 */
function revalidateBerth(): void {
  if (!form.value.portId || !form.value.berthNo) return;
  const berth = portStore.berths.find((b) => b.portId === form.value.portId && b.berthNo === form.value.berthNo);
  const ok =
    form.value.type === '进港' ? berthOpenForArrival(berth) : berthOwnedBy(berth, form.value.vesselId);
  if (!ok) berthKey.value = '';
}

onMounted(async () => {
  if (!portStore.ports.length) await portStore.loadAll();
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  if (restore()) {
    if (hasContent(form.value)) {
      ElMessage.info(`已恢复本地草稿（保存于 ${formatDateTime(savedAt.value)}）`);
    } else {
      // 空草稿没有恢复价值，直接清掉，避免误报「已恢复草稿」
      clearDraft();
    }
  }
  // 草稿可能是很久前保存的，泊位占用与船舶状态已变化，恢复后必须重新核验
  revalidateBerth();
  if (form.value.portId) focusPortId.value = form.value.portId;
});

watch(
  () => toPlain(form.value),
  (value) => {
    // 只有存在有效输入时才落草稿；提交后表单被重置，草稿同步清空
    if (hasContent(value)) persist();
    else clearDraft();
  },
  { deep: true },
);

watch([() => form.value.type, () => form.value.vesselId], () => {
  revalidateBerth();
});

function selectBerth(berth: Berth): void {
  // 与提交校验同一套判断：进港需空闲泊位，出港需本船占用的泊位
  if (form.value.type === '进港' && !berthOpenForArrival(berth)) {
    ElMessage.warning(`不适合进港：泊位 ${berth.berthNo} 当前为「${berth.status}」，进港需选择空闲泊位`);
    return;
  }
  if (form.value.type === '出港' && !berthOwnedBy(berth, form.value.vesselId)) {
    ElMessage.warning(
      form.value.vesselId
        ? `泊位归属不符：泊位 ${berth.berthNo} 未由所选渔船占用，不能登记出港`
        : '请先选择渔船，出港只能选本船占用的泊位',
    );
    return;
  }
  berthKey.value = `${berth.portId}|${berth.berthNo}`;
  ElMessage.info(`已选择 ${berth.berthNo}`);
}

async function submit(): Promise<void> {
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;
  const vessel = selectedVessel.value;
  if (!vessel) {
    ElMessage.warning('请选择有效的渔船');
    return;
  }
  // 提交时再查一遍（泊位占用可能已被其他操作改变）；失败时表单与泊位都保持不变
  const berth = portStore.berths.find((b) => b.portId === form.value.portId && b.berthNo === form.value.berthNo);
  const failure = checkCallRules({ type: form.value.type, vessel, berth, time: form.value.time });
  if (failure) {
    ElMessage.error(failure);
    return;
  }
  submitting.value = true;
  try {
    const payload: CallDraft = {
      vesselId: form.value.vesselId,
      type: form.value.type,
      time: form.value.time,
      berthNo: form.value.berthNo,
      iceKg: Number(form.value.iceKg) || 0,
      fuelL: Number(form.value.fuelL) || 0,
      unloadKg: Number(form.value.unloadKg) || 0,
      visaStatus: form.value.visaStatus,
    };
    const call = await portStore.registerCall(payload, vessel, form.value.portId);
    ElMessage.success(`已登记 ${call.vesselName} ${call.type} · 泊位 ${call.berthNo}`);
    clearDraft();
    Object.assign(form.value, {
      ...emptyCallDraft(),
      portId: '',
      time: nowLocalInputValue(),
    });
    focusPortId.value = '';
  } catch (error) {
    ElMessage.error(`登记失败：${(error as Error).message}`);
  } finally {
    submitting.value = false;
  }
}

function openVessel(vesselId: string): void {
  void router.push(`/vessels/${vesselId}`);
}
</script>

<template>
  <section class="page">
    <header class="page__head">
      <div>
        <h1>进出港登记</h1>
        <p class="page__sub">
          选择渔船与进出港类型，填写泊位号、加冰量、加油量与卸货量，提交后自动同步泊位占用状态。
          进港要求证书在登记当天结束时仍有效且泊位空闲；出港不查证书，但只能释放本船占用的泊位。
        </p>
      </div>
    </header>

    <el-alert
      v-if="restored"
      type="info"
      show-icon
      :closable="false"
      title="已从浏览器本地草稿恢复未提交的表单"
      data-testid="draft-alert"
      class="draft-alert"
    >
      <template #default>
        草稿保存在 localStorage（键 {{ storageKey }}），提交成功后会清空。
      </template>
    </el-alert>

    <el-row :gutter="16">
      <el-col :lg="13" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header><span class="card-title">登记表单</span></template>
          <el-form ref="formRef" :model="form" :rules="rules" label-width="110px" data-testid="call-form">
            <el-form-item label="渔船" prop="vesselId">
              <el-select id="call-vessel" v-model="form.vesselId" placeholder="请选择渔船" filterable style="width: 100%">
                <el-option
                  v-for="v in vesselOptions"
                  :key="v.id"
                  :label="`${v.name}（${v.homePort} · ${formatNumber(v.enginePower, 0)}kW）`"
                  :value="v.id"
                />
              </el-select>
              <p v-if="certificateHint" class="form-hint" data-testid="certificate-hint">{{ certificateHint }}</p>
            </el-form-item>

            <el-form-item label="进出港类型" prop="type">
              <el-radio-group v-model="form.type" data-testid="call-type">
                <el-radio-button v-for="t in CALL_TYPES" :key="t" :value="t">{{ t }}</el-radio-button>
              </el-radio-group>
            </el-form-item>

            <el-form-item label="时间" prop="time">
              <el-date-picker
                id="call-time"
                v-model="form.time"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                placeholder="选择时间"
                style="width: 100%"
              />
            </el-form-item>

            <el-form-item label="泊位号" prop="portId">
              <el-select
                id="call-berth"
                v-model="berthKey"
                :placeholder="berthPlaceholder"
                style="width: 100%"
                data-testid="call-berth"
              >
                <el-option v-for="opt in berthOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>

            <el-row :gutter="12">
              <el-col :span="8">
                <el-form-item label="加冰 kg" prop="iceKg">
                  <el-input-number id="call-ice" v-model="form.iceKg" :min="0" :max="20000" :step="50" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="加油 L" prop="fuelL">
                  <el-input-number id="call-fuel" v-model="form.fuelL" :min="0" :max="20000" :step="50" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="卸货量 kg" prop="unloadKg">
                  <el-input-number id="call-unload" v-model="form.unloadKg" :min="0" :max="200000" :step="100" style="width: 100%" />
                </el-form-item>
              </el-col>
            </el-row>

            <el-form-item label="签证状态" prop="visaStatus">
              <el-select id="call-visa" v-model="form.visaStatus" style="width: 100%">
                <el-option v-for="s in VISA_STATUSES" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>

            <el-form-item>
              <el-button type="primary" :loading="submitting" data-testid="submit-call" @click="submit">保存登记</el-button>
              <el-button data-testid="clear-draft" @click="clearDraft(); ElMessage.success('草稿已清空')">清空草稿</el-button>
              <el-button v-if="selectedVessel" text type="primary" @click="openVessel(selectedVessel.id)">查看渔船档案</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>

      <el-col :lg="11" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">今日统计</span>
          </template>
          <div class="stat-row">
            <div class="stat"><span class="stat__label">进港</span><b>{{ todayStats.inbound }}</b></div>
            <div class="stat"><span class="stat__label">出港</span><b>{{ todayStats.outbound }}</b></div>
            <div class="stat"><span class="stat__label">加冰 kg</span><b>{{ formatNumber(todayStats.ice, 0) }}</b></div>
            <div class="stat"><span class="stat__label">加油 L</span><b>{{ formatNumber(todayStats.fuel, 0) }}</b></div>
            <div class="stat"><span class="stat__label">卸货 kg</span><b>{{ formatNumber(todayStats.unload, 0) }}</b></div>
          </div>
        </el-card>

        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">
              泊位占用网格{{ focusPortId ? ` · ${portStore.portById(focusPortId)?.name ?? ''}` : '（选择泊位后聚焦对应渔港）' }}
            </span>
          </template>
          <BerthGrid v-if="focusBerths.length" :berths="focusBerths" @select="selectBerth" />
          <EmptyState v-else title="尚未选择渔港泊位" description="在左侧表单选择泊位，或直接点击泊位网格中的方块。">
            <el-button type="primary" @click="focusPortId = portStore.ports[0]?.id ?? ''">聚焦第一座渔港</el-button>
          </EmptyState>
          <p v-if="focusBerths.length" class="detail-hint">
            占用率 {{ (summary.occupancyRate * 100).toFixed(1) }}% · 占用 {{ summary.occupied }} · 空闲 {{ summary.free }} · 维修 {{ summary.maintenance }}
          </p>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="detail-card">
      <template #header><span class="card-title">今日流水（{{ todayCalls.length }} 条）</span></template>
      <el-table :data="todayCalls" size="small" border empty-text="今日暂无进出港流水" data-testid="today-calls">
        <el-table-column prop="vesselName" label="船名" min-width="130" />
        <el-table-column prop="type" label="类型" width="80" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column prop="berthNo" label="泊位号" width="90" />
        <el-table-column label="加冰 kg" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.iceKg, 0) }}</template>
        </el-table-column>
        <el-table-column label="加油 L" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.fuelL, 0) }}</template>
        </el-table-column>
        <el-table-column label="卸货 kg" min-width="110">
          <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
        </el-table-column>
        <el-table-column prop="visaStatus" label="签证状态" width="110" />
      </el-table>
    </el-card>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page__head h1 {
  margin: 0;
  font-size: 22px;
  color: #17324d;
}
.page__sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6b7c8c;
}
.detail-card {
  border-radius: 10px;
  margin-bottom: 16px;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.draft-alert {
  border-radius: 10px;
}
.stat-row {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat__label {
  font-size: 12px;
  color: #7b8a99;
}
.stat b {
  font-size: 18px;
  color: #17324d;
}
.detail-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #6b7c8c;
}
.form-hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: #e6a23c;
}
</style>
