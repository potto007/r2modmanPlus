<script lang="ts" setup>
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

const { isVisible } = useSettingSearch(() => props.searchTerm, 'translations.pages.settings.entries.installFromGithub.searchTerms');

function open() {
    store.commit('openGitHubModImportModal');
}
</script>

<template>
    <SettingsViewWrapper v-show="isVisible">
        <template #title>{{ t('translations.pages.settings.entries.installFromGithub.title') }}</template>
        <template #description>
            {{ t('translations.pages.settings.entries.installFromGithub.description') }}
        </template>
        <button class="button" @click="open">{{ t('translations.pages.settings.entries.installFromGithub.title') }}</button>
    </SettingsViewWrapper>
</template>
