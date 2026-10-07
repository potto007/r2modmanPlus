<script lang="ts" setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingsViewWrapper from '../SettingsViewWrapper.vue';
import { useSettingSearch } from '../../composables/SettingSearchComposable';
import { getStore } from '../../../providers/generic/store/StoreProvider';
import { State } from '../../../store';
import R2Error from '../../../model/errors/R2Error';
import GitHubClient, { parseRepository, repositoryToString } from '../../../r2mm/github/GitHubClient';
import { hasGitHubToken, setGitHubToken } from '../../../r2mm/github/GitHubAuth';

const store = getStore<State>();
const { t } = useI18n();

const props = defineProps<{
    searchTerm?: string;
}>();

const { isVisible } = useSettingSearch(() => props.searchTerm, 'translations.pages.settings.entries.githubAccount.searchTerms');

const tokenInput = ref<string>('');
const tokenIsSet = ref<boolean>(false);
const repositoryInput = ref<string>('');
const busy = ref<boolean>(false);
const testResult = ref<string>('');

onMounted(async () => {
    tokenIsSet.value = await hasGitHubToken();
    repositoryInput.value = store.getters['settings'].getProfileSyncRepository() || '';
});

async function save() {
    busy.value = true;
    testResult.value = '';
    try {
        if (tokenInput.value.trim().length > 0) {
            await setGitHubToken(tokenInput.value);
            tokenInput.value = '';
            tokenIsSet.value = true;
        }
        const repo = repositoryInput.value.trim();
        if (repo.length > 0) {
            const normalised = repositoryToString(parseRepository(repo));
            await store.getters['settings'].setProfileSyncRepository(normalised);
            repositoryInput.value = normalised;
        } else {
            await store.getters['settings'].setProfileSyncRepository(null);
        }
    } catch (e) {
        store.commit('error/handleError', R2Error.fromThrownValue(e, 'Failed to save GitHub settings'));
    } finally {
        busy.value = false;
    }
}

async function clearToken() {
    busy.value = true;
    try {
        await setGitHubToken(null);
        tokenInput.value = '';
        tokenIsSet.value = false;
        testResult.value = '';
    } finally {
        busy.value = false;
    }
}

async function testConnection() {
    busy.value = true;
    testResult.value = t('translations.pages.settings.entries.githubAccount.testing');
    try {
        const client = new GitHubClient();
        const user = await client.getAuthenticatedUser();
        let message = t('translations.pages.settings.entries.githubAccount.testSuccess', { login: user.login });
        const repo = repositoryInput.value.trim();
        if (repo.length > 0) {
            const info = await client.getRepository(parseRepository(repo));
            message += ' ' + t('translations.pages.settings.entries.githubAccount.repositoryAccessible', {
                repository: info.fullName,
                visibility: info.private
                    ? t('translations.pages.settings.entries.githubAccount.private')
                    : t('translations.pages.settings.entries.githubAccount.public'),
            });
            if (info.permissions && info.permissions.push === false) {
                message += ' ' + t('translations.pages.settings.entries.githubAccount.readOnlyWarning');
            }
        }
        testResult.value = message;
    } catch (e) {
        testResult.value = '';
        store.commit('error/handleError', R2Error.fromThrownValue(e, 'GitHub connection test failed'));
    } finally {
        busy.value = false;
    }
}
</script>

<template>
    <SettingsViewWrapper v-show="isVisible">
        <template #title>{{ t('translations.pages.settings.entries.githubAccount.title') }}</template>
        <template #description>
            <p>{{ t('translations.pages.settings.entries.githubAccount.description') }}</p>
        </template>
        <div class="setting-column">
            <div class="setting-row">
                <span class="setting-label">{{ t('translations.pages.settings.entries.githubAccount.tokenLabel') }}</span>
                <input
                    id="github-token-input"
                    v-model="tokenInput"
                    class="input setting-input"
                    type="password"
                    autocomplete="off"
                    :placeholder="tokenIsSet
                        ? t('translations.pages.settings.entries.githubAccount.tokenSet')
                        : t('translations.pages.settings.entries.githubAccount.tokenPlaceholder')"
                />
                <button v-if="tokenIsSet" class="button" :disabled="busy" @click="clearToken">
                    {{ t('translations.pages.settings.entries.githubAccount.clear') }}
                </button>
            </div>
            <div class="setting-row">
                <span class="setting-label">{{ t('translations.pages.settings.entries.githubAccount.repositoryLabel') }}</span>
                <input
                    id="github-sync-repository-input"
                    v-model="repositoryInput"
                    class="input setting-input"
                    type="text"
                    autocomplete="off"
                    :placeholder="t('translations.pages.settings.entries.githubAccount.repositoryPlaceholder')"
                />
            </div>
            <div class="setting-row">
                <button class="button is-info" :disabled="busy" @click="save">
                    {{ t('translations.pages.settings.entries.githubAccount.save') }}
                </button>
                <button class="button" :disabled="busy" @click="testConnection">
                    {{ t('translations.pages.settings.entries.githubAccount.test') }}
                </button>
                <span v-if="testResult" class="setting-hint">{{ testResult }}</span>
            </div>
        </div>
    </SettingsViewWrapper>
</template>
