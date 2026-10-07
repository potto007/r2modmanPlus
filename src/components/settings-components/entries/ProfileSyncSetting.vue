<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingsViewWrapper from '../SettingsViewWrapper.vue';
import { useSettingSearch } from '../../composables/SettingSearchComposable';
import { getStore } from '../../../providers/generic/store/StoreProvider';
import { State } from '../../../store';

const store = getStore<State>();
const { t } = useI18n();

const props = defineProps<{
    searchTerm?: string;
}>();

const { isVisible } = useSettingSearch(() => props.searchTerm, 'translations.pages.settings.entries.profileSync.searchTerms');

const status = computed(() => store.state.profileSync.status);
const linkedRepository = computed(() => store.state.profileSync.state?.repository ?? null);
const pullBeforeLaunch = ref<boolean>(false);

onMounted(async () => {
    pullBeforeLaunch.value = store.getters['settings'].getPullProfileBeforeLaunch();
    await store.dispatch('profileSync/loadLocalState');
});

function openSync() {
    store.commit('openProfileSyncModal');
}

async function togglePullBeforeLaunch() {
    pullBeforeLaunch.value = !pullBeforeLaunch.value;
    await store.getters['settings'].setPullProfileBeforeLaunch(pullBeforeLaunch.value);
}
</script>

<template>
    <SettingsViewWrapper v-show="isVisible">
        <template #title>{{ t('translations.pages.settings.entries.profileSync.title') }}</template>
        <template #description>
            <p>{{ t('translations.pages.settings.entries.profileSync.description') }}</p>
            <p v-if="linkedRepository">
                {{ t('translations.pages.settings.entries.profileSync.linked', { repository: linkedRepository }) }}
                {{ t(`translations.modals.profileSync.status.${status}`) }}
            </p>
            <p v-else>{{ t('translations.pages.settings.entries.profileSync.notLinked') }}</p>
        </template>
        <div class="setting-column">
            <div class="setting-row">
                <button class="button is-info" @click="openSync">
                    {{ t('translations.pages.settings.entries.profileSync.open') }}
                </button>
            </div>
            <div class="setting-row">
                <div class="field">
                    <input
                        id="pull-before-launch-switch"
                        type="checkbox"
                        class="switch is-info"
                        :checked="pullBeforeLaunch"
                        @change="togglePullBeforeLaunch"
                    />
                    <label for="pull-before-launch-switch">
                        {{ t('translations.pages.settings.entries.profileSync.pullBeforeLaunch') }}
                    </label>
                </div>
            </div>
        </div>
    </SettingsViewWrapper>
</template>
