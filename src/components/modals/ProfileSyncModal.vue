<script lang="ts" setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ModalCard from '../ModalCard.vue';
import { getStore } from '../../providers/generic/store/StoreProvider';
import { State } from '../../store';
import R2Error from '../../model/errors/R2Error';
import ProfileSync, { RemoteProfileExistsError, SyncConflictError, SyncStatus } from '../../r2mm/sync/ProfileSync';
import { PullResult } from '../../store/modules/ProfileSyncModule';
import { useProfilesComposable } from '../composables/ProfilesComposable';
import { useDateLocale } from '../composables/DateLocaleComposable';

const store = getStore<State>();
const { t, d } = useI18n();
const { getDateLocale } = useDateLocale();
const dateLocale = getDateLocale();
const { doesProfileExist, makeProfileNameSafe } = useProfilesComposable();

type View = 'MAIN' | 'REMOTE_EXISTS' | 'CONFLICT' | 'CONFIRM_PULL' | 'CONFIRM_UNLINK' | 'CLONE' | 'RESULT';

const isOpen = computed(() => store.state.modals.isProfileSyncModalOpen);
const sync = computed(() => store.state.profileSync);
const isLinked = computed<boolean>(() => store.getters['profileSync/isLinked']);
const isBusy = computed<boolean>(() => store.getters['profileSync/isBusy']);
const activeProfileName = computed<string>(() => store.getters['profile/activeProfileName']);
const configuredRepository = computed<string | null>(() => store.getters['settings'].getProfileSyncRepository());
const remoteProfiles = computed(() => store.state.profileSync.remoteProfiles);

const view = ref<View>('MAIN');
const cloneRemoteName = ref<string>('');
const cloneLocalName = ref<string>('');
const resultUnknownMods = ref<string[]>([]);
const loadingRemote = ref<boolean>(false);

const cloneLocalNameSafe = computed(() => makeProfileNameSafe(cloneLocalName.value));
const canClone = computed(() => cloneRemoteName.value !== '' && cloneLocalNameSafe.value !== '' && !doesProfileExist(cloneLocalName.value) && !isBusy.value);

watch(isOpen, async (open) => {
    if (open) {
        view.value = 'MAIN';
        resultUnknownMods.value = [];
        await refresh();
    }
});

watch(cloneRemoteName, (name) => {
    if (cloneLocalName.value === '' || doesProfileExist(cloneLocalName.value)) {
        cloneLocalName.value = name;
    }
});

function closeModal() {
    if (isBusy.value) {
        return;
    }
    store.commit('closeProfileSyncModal');
}

function handleError(e: unknown, title: string) {
    store.commit('error/handleError', R2Error.fromThrownValue(e, title));
}

async function refresh() {
    try {
        await store.dispatch('profileSync/loadLocalState');
        if (isLinked.value) {
            await store.dispatch('profileSync/refresh');
        }
    } catch (e) {
        handleError(e, 'Failed to check profile sync status');
    }
}

async function push(force: boolean = false) {
    try {
        await store.dispatch('profileSync/push', { force });
        view.value = 'MAIN';
    } catch (e) {
        if (e instanceof RemoteProfileExistsError) {
            view.value = 'REMOTE_EXISTS';
        } else if (e instanceof SyncConflictError) {
            view.value = 'CONFLICT';
        } else {
            handleError(e, 'Failed to push profile');
        }
    }
}

async function pull() {
    try {
        const result: PullResult = await store.dispatch('profileSync/pull');
        showResult(result);
    } catch (e) {
        view.value = 'MAIN';
        handleError(e, 'Failed to pull profile');
    }
}

/** Replace the local, unlinked profile with the remote one of the same name. */
async function adoptRemote() {
    const repository = configuredRepository.value;
    if (!repository) {
        return;
    }
    try {
        const result: PullResult = await store.dispatch('profileSync/applyRemoteSnapshot', {
            repository,
            remoteZipPath: ProfileSync.remoteZipPath(store.state.activeGame, activeProfileName.value),
            targetProfileName: activeProfileName.value,
            isUpdate: true,
        });
        await store.dispatch('profileSync/refresh');
        showResult(result);
    } catch (e) {
        view.value = 'MAIN';
        handleError(e, 'Failed to replace profile with the remote one');
    }
}

function showResult(result: PullResult) {
    resultUnknownMods.value = result.unknownMods;
    view.value = result.unknownMods.length > 0 ? 'RESULT' : 'MAIN';
}

async function unlink(deleteRemote: boolean) {
    try {
        await store.dispatch('profileSync/unlink', { deleteRemote });
        view.value = 'MAIN';
    } catch (e) {
        view.value = 'MAIN';
        handleError(e, 'Failed to unlink profile');
    }
}

async function openClone() {
    view.value = 'CLONE';
    cloneRemoteName.value = '';
    cloneLocalName.value = '';
    loadingRemote.value = true;
    try {
        await store.dispatch('profileSync/listRemoteProfiles');
    } catch (e) {
        handleError(e, 'Failed to list remote profiles');
        view.value = 'MAIN';
    } finally {
        loadingRemote.value = false;
    }
}

async function clone() {
    if (!canClone.value) {
        return;
    }
    try {
        const result: PullResult = await store.dispatch('profileSync/clone', {
            remoteName: cloneRemoteName.value,
            localName: cloneLocalNameSafe.value,
        });
        showResult(result);
    } catch (e) {
        view.value = 'MAIN';
        handleError(e, 'Failed to clone remote profile');
    }
}

function statusClass(status: SyncStatus): string {
    switch (status) {
        case SyncStatus.SYNCED: return 'is-success';
        case SyncStatus.LOCAL_CHANGES:
        case SyncStatus.REMOTE_CHANGES: return 'is-warning';
        case SyncStatus.CONFLICT:
        case SyncStatus.MISSING: return 'is-danger';
        default: return 'is-dark';
    }
}
</script>

<template>
    <ModalCard id="profile-sync-modal" v-if="isOpen" :is-active="isOpen" :can-close="!isBusy" @close-modal="closeModal">
        <template v-slot:header>
            <h2 class="modal-title">{{ t('translations.modals.profileSync.title', { profileName: activeProfileName }) }}</h2>
        </template>

        <template v-slot:body>
            <!-- Progress, shown on top of whatever view is active. -->
            <div v-if="isBusy" class="margin-bottom">
                <p>{{ t(`translations.modals.profileSync.phases.${sync.phase}`) }}</p>
                <progress class="progress is-info" :value="sync.progress" max="100">{{ sync.progress }}%</progress>
            </div>

            <template v-if="view === 'MAIN'">
                <template v-if="isLinked && sync.state">
                    <p>
                        {{ t('translations.modals.profileSync.linkedTo', { repository: sync.state.repository, path: sync.state.remotePath }) }}
                    </p>
                    <p v-if="sync.state.syncedAt">
                        {{ t('translations.modals.profileSync.lastSynced', { formattedDate: d(sync.state.syncedAt, 'long', dateLocale) }) }}
                    </p>
                    <p class="margin-top">
                        <span :class="['tag', statusClass(sync.status)]">{{ t(`translations.modals.profileSync.status.${sync.status}`) }}</span>
                        <span class="margin-left margin-left--half-width">{{ t(`translations.modals.profileSync.statusHelp.${sync.status}`) }}</span>
                    </p>
                </template>
                <template v-else>
                    <p>{{ t('translations.modals.profileSync.notLinked') }}</p>
                    <p v-if="configuredRepository" class="margin-top">
                        {{ t('translations.modals.profileSync.willLinkTo', { repository: configuredRepository }) }}
                    </p>
                    <p v-else class="notification is-warning margin-top">
                        {{ t('translations.modals.profileSync.noRepository') }}
                    </p>
                </template>
            </template>

            <template v-else-if="view === 'REMOTE_EXISTS'">
                <p>{{ t('translations.modals.profileSync.remoteExists.description', { profileName: activeProfileName }) }}</p>
            </template>

            <template v-else-if="view === 'CONFLICT'">
                <p>{{ t('translations.modals.profileSync.conflict.description') }}</p>
            </template>

            <template v-else-if="view === 'CONFIRM_PULL'">
                <p>{{ t('translations.modals.profileSync.confirmPull.description') }}</p>
            </template>

            <template v-else-if="view === 'CONFIRM_UNLINK'">
                <p>{{ t('translations.modals.profileSync.confirmUnlink.description') }}</p>
            </template>

            <template v-else-if="view === 'CLONE'">
                <p>{{ t('translations.modals.profileSync.clone.description') }}</p>
                <br/>
                <p v-if="loadingRemote">{{ t('translations.modals.profileSync.clone.loading') }}</p>
                <p v-else-if="remoteProfiles.length === 0" class="notification is-warning">
                    {{ t('translations.modals.profileSync.clone.noRemoteProfiles') }}
                </p>
                <template v-else>
                    <div class="field">
                        <label class="label" for="profile-sync-clone-remote">{{ t('translations.modals.profileSync.clone.remoteLabel') }}</label>
                        <div class="control">
                            <div class="select is-fullwidth">
                                <select id="profile-sync-clone-remote" v-model="cloneRemoteName" :disabled="isBusy">
                                    <option v-for="remote in remoteProfiles" :key="remote.name" :value="remote.name">{{ remote.name }}</option>
                                </select>
                            </div>
                        </div>
                    </div>
                    <div class="field">
                        <label class="label" for="profile-sync-clone-local">{{ t('translations.modals.profileSync.clone.localNameLabel') }}</label>
                        <div class="control">
                            <input id="profile-sync-clone-local" v-model="cloneLocalName" class="input" type="text" autocomplete="off" :disabled="isBusy" @keyup.enter="clone"/>
                        </div>
                    </div>
                    <span class="tag is-dark" v-if="cloneLocalNameSafe === ''">
                        {{ t('translations.modals.createProfile.tagStates.required') }}
                    </span>
                    <span class="tag is-success" v-else-if="!doesProfileExist(cloneLocalName)">
                        {{ t('translations.modals.createProfile.tagStates.valid', { profileName: cloneLocalNameSafe }) }}
                    </span>
                    <span class="tag is-danger" v-else>
                        {{ t('translations.modals.createProfile.tagStates.error', { profileName: cloneLocalNameSafe }) }}
                    </span>
                </template>
            </template>

            <template v-else-if="view === 'RESULT'">
                <div class="notification is-warning">
                    <p>{{ t('translations.modals.profileSync.unknownMods.description') }}</p>
                    <p class="margin-top">{{ resultUnknownMods.join(', ') }}</p>
                </div>
            </template>
        </template>

        <template v-slot:footer>
            <template v-if="view === 'MAIN'">
                <template v-if="isLinked">
                    <button class="button" :disabled="isBusy" @click="refresh">{{ t('translations.modals.profileSync.actions.refresh') }}</button>
                    <button id="profile-sync-push" class="button is-info" :disabled="isBusy || sync.status === SyncStatus.SYNCED" @click="push(false)">{{ t('translations.modals.profileSync.actions.push') }}</button>
                    <button id="profile-sync-pull" class="button is-info" :disabled="isBusy || sync.status === SyncStatus.SYNCED || sync.status === SyncStatus.MISSING" @click="view = 'CONFIRM_PULL'">{{ t('translations.modals.profileSync.actions.pull') }}</button>
                    <button class="button is-danger" :disabled="isBusy" @click="view = 'CONFIRM_UNLINK'">{{ t('translations.modals.profileSync.actions.unlink') }}</button>
                </template>
                <template v-else>
                    <button id="profile-sync-link" class="button is-info" :disabled="isBusy || !configuredRepository" @click="push(false)">{{ t('translations.modals.profileSync.actions.link') }}</button>
                    <button id="profile-sync-clone" class="button" :disabled="isBusy || !configuredRepository" @click="openClone">{{ t('translations.modals.profileSync.actions.clone') }}</button>
                </template>
            </template>

            <template v-else-if="view === 'REMOTE_EXISTS'">
                <button class="button is-danger" :disabled="isBusy" @click="push(true)">{{ t('translations.modals.profileSync.actions.overwriteRemote') }}</button>
                <button class="button is-info" :disabled="isBusy" @click="adoptRemote">{{ t('translations.modals.profileSync.actions.replaceLocal') }}</button>
                <button class="button" :disabled="isBusy" @click="view = 'MAIN'">{{ t('translations.modals.profileSync.actions.cancel') }}</button>
            </template>

            <template v-else-if="view === 'CONFLICT'">
                <button class="button is-danger" :disabled="isBusy" @click="push(true)">{{ t('translations.modals.profileSync.actions.forcePush') }}</button>
                <button class="button is-info" :disabled="isBusy" @click="pull">{{ t('translations.modals.profileSync.actions.pull') }}</button>
                <button class="button" :disabled="isBusy" @click="view = 'MAIN'">{{ t('translations.modals.profileSync.actions.cancel') }}</button>
            </template>

            <template v-else-if="view === 'CONFIRM_PULL'">
                <button class="button is-info" :disabled="isBusy" @click="pull">{{ t('translations.modals.profileSync.actions.pull') }}</button>
                <button class="button" :disabled="isBusy" @click="view = 'MAIN'">{{ t('translations.modals.profileSync.actions.cancel') }}</button>
            </template>

            <template v-else-if="view === 'CONFIRM_UNLINK'">
                <button class="button" :disabled="isBusy" @click="unlink(false)">{{ t('translations.modals.profileSync.actions.unlink') }}</button>
                <button class="button is-danger" :disabled="isBusy" @click="unlink(true)">{{ t('translations.modals.profileSync.actions.unlinkAndDelete') }}</button>
                <button class="button" :disabled="isBusy" @click="view = 'MAIN'">{{ t('translations.modals.profileSync.actions.cancel') }}</button>
            </template>

            <template v-else-if="view === 'CLONE'">
                <button id="profile-sync-clone-confirm" class="button is-info" :disabled="!canClone" @click="clone">{{ t('translations.modals.profileSync.actions.clone') }}</button>
                <button class="button" :disabled="isBusy" @click="view = 'MAIN'">{{ t('translations.modals.profileSync.actions.cancel') }}</button>
            </template>

            <template v-else-if="view === 'RESULT'">
                <button class="button is-info" @click="view = 'MAIN'">{{ t('translations.modals.actions.close') }}</button>
            </template>
        </template>
    </ModalCard>
</template>
