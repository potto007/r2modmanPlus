<script lang="ts" setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ModalCard from '../ModalCard.vue';
import { getStore } from '../../providers/generic/store/StoreProvider';
import { State } from '../../store';
import R2Error from '../../model/errors/R2Error';
import GitHubModInstaller from '../../r2mm/github/GitHubModInstaller';
import { GitHubRelease, GitHubReleaseAsset, GitHubRepositoryRef } from '../../r2mm/github/GitHubClient';
import FileUtils from '../../utils/FileUtils';
import { valueToReadableDate } from '../../utils/DateUtils';

const store = getStore<State>();
const { t } = useI18n();

const isOpen = computed(() => store.state.modals.isGitHubModImportModalOpen);
const progress = computed(() => store.state.profileSync.progress);
const phase = computed(() => store.state.profileSync.phase);

const repositoryInput = ref<string>('');
const repository = ref<GitHubRepositoryRef | null>(null);
const releases = ref<GitHubRelease[]>([]);
const selectedReleaseId = ref<number | null>(null);
const selectedAssetId = ref<number | null>(null);
const loading = ref<boolean>(false);
const installing = ref<boolean>(false);
const repositoryField = ref<HTMLInputElement>();

const selectedRelease = computed(() => releases.value.find((r) => r.id === selectedReleaseId.value) ?? null);
const installableAssets = computed<GitHubReleaseAsset[]>(() =>
    selectedRelease.value ? selectedRelease.value.assets.filter(GitHubModInstaller.isInstallableAsset) : []
);
const selectedAsset = computed(() => installableAssets.value.find((a) => a.id === selectedAssetId.value) ?? null);
const canInstall = computed(() => repository.value !== null && selectedRelease.value !== null && selectedAsset.value !== null && !installing.value);

watch(isOpen, async (open) => {
    if (open) {
        reset();
        repositoryInput.value = store.state.modals.githubModImportRepository || '';
        await nextTick();
        repositoryField.value && repositoryField.value.focus();
        if (repositoryInput.value) {
            await fetchReleases();
        }
    }
});

watch(selectedReleaseId, () => {
    const release = selectedRelease.value;
    const preferred = release ? GitHubModInstaller.pickDefaultAsset(release) : null;
    selectedAssetId.value = preferred ? preferred.id : null;
});

function reset() {
    repositoryInput.value = '';
    repository.value = null;
    releases.value = [];
    selectedReleaseId.value = null;
    selectedAssetId.value = null;
    loading.value = false;
    installing.value = false;
}

function closeModal() {
    if (installing.value) {
        return;
    }
    reset();
    store.commit('closeGitHubModImportModal');
}

async function fetchReleases() {
    if (repositoryInput.value.trim().length === 0 || loading.value) {
        return;
    }
    loading.value = true;
    releases.value = [];
    selectedReleaseId.value = null;
    try {
        const result = await GitHubModInstaller.listReleases(repositoryInput.value);
        repository.value = result.repository;
        releases.value = result.releases;
        const first = result.releases.find((r) => !r.prerelease) ?? result.releases[0];
        selectedReleaseId.value = first ? first.id : null;
    } catch (e) {
        repository.value = null;
        store.commit('error/handleError', R2Error.fromThrownValue(e, 'Failed to list GitHub releases'));
    } finally {
        loading.value = false;
    }
}

async function install() {
    if (!canInstall.value) {
        return;
    }
    installing.value = true;
    try {
        await store.dispatch('profileSync/installGitHubMod', {
            repository: repository.value!,
            release: selectedRelease.value!,
            asset: selectedAsset.value!,
        });
        installing.value = false;
        closeModal();
    } catch (e) {
        installing.value = false;
        store.commit('error/handleError', R2Error.fromThrownValue(e, 'Failed to install mod from GitHub'));
    }
}

function releaseLabel(release: GitHubRelease): string {
    const date = release.publishedAt ? valueToReadableDate(new Date(release.publishedAt).getTime()) : '';
    const flag = release.prerelease ? ` (${t('translations.modals.githubModImport.prerelease')})` : '';
    return `${release.tagName}${release.name !== release.tagName ? ` - ${release.name}` : ''}${flag}${date ? ` - ${date}` : ''}`;
}
</script>

<template>
    <ModalCard id="github-mod-import-modal" v-if="isOpen" :is-active="isOpen" :can-close="!installing" @close-modal="closeModal">
        <template v-slot:header>
            <h2 class="modal-title">{{ t('translations.modals.githubModImport.title') }}</h2>
        </template>
        <template v-slot:body>
            <p>{{ t('translations.modals.githubModImport.description') }}</p>
            <br/>
            <div class="field has-addons">
                <div class="control is-expanded">
                    <input
                        id="github-mod-repository"
                        ref="repositoryField"
                        v-model="repositoryInput"
                        class="input"
                        type="text"
                        autocomplete="off"
                        :disabled="installing"
                        :placeholder="t('translations.modals.githubModImport.repositoryPlaceholder')"
                        @keyup.enter="fetchReleases"
                    />
                </div>
                <div class="control">
                    <button class="button is-info" :disabled="loading || installing || repositoryInput.trim().length === 0" @click="fetchReleases">
                        {{ loading ? t('translations.modals.githubModImport.loading') : t('translations.modals.githubModImport.fetchReleases') }}
                    </button>
                </div>
            </div>

            <template v-if="repository !== null && !loading">
                <p v-if="releases.length === 0" class="notification is-warning">
                    {{ t('translations.modals.githubModImport.noReleases') }}
                </p>
                <template v-else>
                    <div class="field">
                        <label class="label" for="github-mod-release">{{ t('translations.modals.githubModImport.releaseLabel') }}</label>
                        <div class="control">
                            <div class="select is-fullwidth">
                                <select id="github-mod-release" v-model="selectedReleaseId" :disabled="installing">
                                    <option v-for="release in releases" :key="release.id" :value="release.id">
                                        {{ releaseLabel(release) }}
                                    </option>
                                </select>
                            </div>
                        </div>
                    </div>
                    <div class="field">
                        <label class="label" for="github-mod-asset">{{ t('translations.modals.githubModImport.assetLabel') }}</label>
                        <div class="control">
                            <div v-if="installableAssets.length > 0" class="select is-fullwidth">
                                <select id="github-mod-asset" v-model="selectedAssetId" :disabled="installing">
                                    <option v-for="asset in installableAssets" :key="asset.id" :value="asset.id">
                                        {{ asset.name }} ({{ FileUtils.humanReadableSize(asset.size) }})
                                    </option>
                                </select>
                            </div>
                            <p v-else class="notification is-warning">
                                {{ t('translations.modals.githubModImport.noAssets') }}
                            </p>
                        </div>
                    </div>
                </template>
            </template>

            <progress v-if="installing && phase === 'downloading'" class="progress is-info" :value="progress" max="100">{{ progress }}%</progress>
            <p v-else-if="installing">{{ t('translations.modals.githubModImport.installing') }}</p>
        </template>
        <template v-slot:footer>
            <button id="github-mod-install" class="button is-info" :disabled="!canInstall" @click="install">
                {{ t('translations.modals.githubModImport.install') }}
            </button>
        </template>
    </ModalCard>
</template>
