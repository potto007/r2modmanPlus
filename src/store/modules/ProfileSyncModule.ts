import { ActionTree, GetterTree, MutationTree } from 'vuex';
import R2Error from '../../model/errors/R2Error';
import ExportFormat from '../../model/exports/ExportFormat';
import { ImmutableProfile } from '../../model/Profile';
import ThunderstoreCombo from '../../model/ThunderstoreCombo';
import GitHubModInstaller from '../../r2mm/github/GitHubModInstaller';
import ProfileSync, { RemoteProfileEntry, SyncState, SyncStatus, SyncStatusReport } from '../../r2mm/sync/ProfileSync';
import { sleep } from '../../utils/Common';
import * as DownloadUtils from '../../utils/DownloadUtils';
import * as ProfileUtils from '../../utils/ProfileUtils';
import { State as RootState } from '../../store';

export type SyncPhase =
    | 'idle'
    | 'refreshing'
    | 'exporting'
    | 'uploading'
    | 'downloading'
    | 'resolvingMods'
    | 'downloadingMods'
    | 'applying';

export interface State {
    /** Profile name the status below belongs to. */
    profileName: string | null;
    status: SyncStatus;
    state: SyncState | null;
    phase: SyncPhase;
    /** 0-100 for phases that report progress. */
    progress: number;
    lastError: R2Error | null;
    remoteProfiles: RemoteProfileEntry[];
    /** Dependency strings skipped on the last pull because they are not on Thunderstore. */
    lastPullUnknownMods: string[];
}

export interface PullResult {
    unknownMods: string[];
}

function resetProgress(state: State) {
    state.phase = 'idle';
    state.progress = 0;
}

export default {
    namespaced: true,

    state: (): State => ({
        profileName: null,
        status: SyncStatus.OFF,
        state: null,
        phase: 'idle',
        progress: 0,
        lastError: null,
        remoteProfiles: [],
        lastPullUnknownMods: [],
    }),

    getters: <GetterTree<State, RootState>>{
        isLinked(state): boolean {
            return state.state !== null;
        },

        isBusy(state): boolean {
            return state.phase !== 'idle';
        },

        /** True while a push or pull is a sensible next action. */
        hasPendingChanges(state): boolean {
            return [SyncStatus.LOCAL_CHANGES, SyncStatus.REMOTE_CHANGES, SyncStatus.CONFLICT].includes(state.status);
        },
    },

    mutations: <MutationTree<State>>{
        reset(state: State) {
            state.profileName = null;
            state.status = SyncStatus.OFF;
            state.state = null;
            state.lastError = null;
            state.lastPullUnknownMods = [];
            resetProgress(state);
        },

        setReport(state: State, params: { profileName: string, report: SyncStatusReport }) {
            state.profileName = params.profileName;
            state.status = params.report.status;
            state.state = params.report.state;
        },

        setPhase(state: State, phase: SyncPhase) {
            state.phase = phase;
            state.progress = 0;
        },

        setProgress(state: State, progress: number) {
            state.progress = Math.max(0, Math.min(100, Math.floor(progress)));
        },

        setLastError(state: State, error: R2Error | null) {
            state.lastError = error;
        },

        setRemoteProfiles(state: State, profiles: RemoteProfileEntry[]) {
            state.remoteProfiles = profiles;
        },

        setLastPullUnknownMods(state: State, mods: string[]) {
            state.lastPullUnknownMods = mods;
        },

        finish(state: State) {
            resetProgress(state);
        },
    },

    actions: <ActionTree<State, RootState>>{

        /** Re-reads local state and remote metadata for the active profile. */
        async refresh({commit, rootGetters}) {
            const profile: ImmutableProfile = rootGetters['profile/activeProfileOrThrow'].asImmutableProfile();
            commit('setPhase', 'refreshing');
            try {
                const report = await ProfileSync.getStatus(profile);
                commit('setReport', { profileName: profile.getProfileName(), report });
                commit('setLastError', null);
            } catch (e) {
                const err = R2Error.fromThrownValue(e, 'Failed to check profile sync status');
                commit('setLastError', err);
                throw err;
            } finally {
                commit('finish');
            }
        },

        /** Cheap local-only refresh used on profile switch; no network. */
        async loadLocalState({commit, rootGetters}) {
            const profile: ImmutableProfile = rootGetters['profile/activeProfileOrThrow'].asImmutableProfile();
            const state = await ProfileSync.readState(profile);
            commit('setReport', {
                profileName: profile.getProfileName(),
                report: {
                    status: state === null ? SyncStatus.OFF : SyncStatus.SYNCED,
                    state,
                    remoteSha: null,
                    localFingerprint: null,
                },
            });
        },

        /**
         * Uploads the active profile. For an unlinked profile this links it to
         * the configured repository. Throws RemoteProfileExistsError or
         * SyncConflictError unless force is set.
         */
        async push({commit, dispatch, rootGetters, rootState}, params: { force?: boolean } = {}) {
            const profile: ImmutableProfile = rootGetters['profile/activeProfileOrThrow'].asImmutableProfile();
            const existing = await ProfileSync.readState(profile);
            const repository = existing ? existing.repository : rootGetters['settings'].getProfileSyncRepository();
            if (!repository) {
                throw new R2Error(
                    'No sync repository configured',
                    'Set the GitHub repository used for profile sync in the settings first.',
                    null
                );
            }
            commit('setPhase', 'uploading');
            try {
                await ProfileSync.push(profile, rootState.activeGame, repository, params.force === true);
            } finally {
                commit('finish');
            }
            await dispatch('refresh');
        },

        /**
         * Downloads the remote snapshot and rebuilds the local profile from
         * it. Mods that are neither on Thunderstore nor on GitHub are skipped
         * and reported in the result.
         */
        async pull({commit, dispatch, rootGetters}): Promise<PullResult> {
            const profile: ImmutableProfile = rootGetters['profile/activeProfileOrThrow'].asImmutableProfile();
            const state = await ProfileSync.readState(profile);
            if (state === null) {
                throw new R2Error('Profile is not linked', 'Link the profile to a repository before pulling.', null);
            }
            const result = await dispatch('applyRemoteSnapshot', {
                repository: state.repository,
                remoteZipPath: state.remotePath,
                targetProfileName: profile.getProfileName(),
                isUpdate: true,
            }) as PullResult;
            await dispatch('refresh');
            return result;
        },

        /** Pulls only when the remote moved and the local profile did not. */
        async pullIfRemoteChanged({dispatch, state}): Promise<boolean> {
            await dispatch('refresh');
            if (state.status === SyncStatus.REMOTE_CHANGES) {
                await dispatch('pull');
                return true;
            }
            return false;
        },

        async listRemoteProfiles({commit, rootGetters, rootState}) {
            const repository = rootGetters['settings'].getProfileSyncRepository();
            if (!repository) {
                commit('setRemoteProfiles', []);
                return;
            }
            commit('setRemoteProfiles', await ProfileSync.listRemoteProfiles(repository, rootState.activeGame));
        },

        /** Imports a remote profile as a new local profile and links it. */
        async clone({dispatch, rootGetters, rootState}, params: { remoteName: string, localName: string }): Promise<PullResult> {
            const repository = rootGetters['settings'].getProfileSyncRepository();
            if (!repository) {
                throw new R2Error('No sync repository configured', 'Set the sync repository in the settings first.', null);
            }
            await dispatch('profiles/addProfile', params.localName, { root: true });
            try {
                const result = await dispatch('applyRemoteSnapshot', {
                    repository,
                    remoteZipPath: ProfileSync.remoteZipPath(rootState.activeGame, params.remoteName),
                    targetProfileName: params.localName,
                    isUpdate: false,
                }) as PullResult;
                await dispatch('refresh');
                return result;
            } catch (e) {
                await dispatch('profiles/ensureProfileExists', null, { root: true });
                throw e;
            }
        },

        async unlink({commit, dispatch, rootGetters}, params: { deleteRemote: boolean }) {
            const profile: ImmutableProfile = rootGetters['profile/activeProfileOrThrow'].asImmutableProfile();
            await ProfileSync.unlink(profile, params.deleteRemote);
            commit('reset');
            await dispatch('loadLocalState');
        },

        /** Shared tail of pull and clone. */
        async applyRemoteSnapshot(
            {commit, dispatch, rootState, rootGetters},
            params: { repository: string, remoteZipPath: string, targetProfileName: string, isUpdate: boolean }
        ): Promise<PullResult> {
            commit('setPhase', 'downloading');
            try {
                const snapshot = await ProfileSync.fetchSnapshot(params.repository, params.remoteZipPath, (loaded) => {
                    commit('setProgress', (loaded / ProfileSync.MAX_SYNC_SIZE) * 100);
                });

                commit('setPhase', 'resolvingMods');
                const yamlContent = await ProfileUtils.readProfileFile(snapshot.zipPath);
                const exportFormat: ExportFormat = await ProfileUtils.parseYamlToExportFormat(yamlContent);
                let resolved = await ProfileUtils.exportModsToCombos(exportFormat.getMods(), rootState.activeGame);

                if (resolved.unknown.length > 0) {
                    // The package list may be stale; refresh once before giving up.
                    while (rootGetters['download/activeDownloadCount'] > 0) {
                        await sleep(100);
                    }
                    await dispatch('tsMods/syncPackageList', null, { root: true });
                    while (rootState.tsMods.isThunderstoreModListUpdateInProgress) {
                        await sleep(100);
                    }
                    resolved = await ProfileUtils.exportModsToCombos(exportFormat.getMods(), rootState.activeGame);
                }

                commit('setPhase', 'downloadingMods');
                const combos = resolved.known as ThunderstoreCombo[];
                if (combos.length > 0) {
                    const total = await DownloadUtils.getTotalDownloadSizeInBytes(combos, rootState.download.ignoreCache);
                    await dispatch('download/downloadToCache', {
                        combos,
                        progressCallback: (downloaded: number) => {
                            commit('setProgress', DownloadUtils.generateProgressPercentage(downloaded, total));
                        },
                    }, { root: true });
                }

                commit('setPhase', 'applying');
                await ProfileUtils.populateImportedProfile(
                    combos,
                    exportFormat.getMods(),
                    params.targetProfileName,
                    params.isUpdate,
                    snapshot.zipPath,
                    (_status, _modName, progress) => {
                        if (typeof progress === 'number') {
                            commit('setProgress', progress);
                        }
                    }
                );

                const targetProfile = new ImmutableProfile(params.targetProfileName);
                await ProfileSync.markSynced(targetProfile, params.repository, params.remoteZipPath, snapshot.remoteSha);
                commit('setLastPullUnknownMods', resolved.unknown);

                await dispatch('profiles/setSelectedProfile', { profileName: params.targetProfileName, prewarmCache: true }, { root: true });
                return { unknownMods: resolved.unknown };
            } finally {
                commit('finish');
            }
        },

        /** Installs one GitHub release asset into the active profile. */
        async installGitHubMod({commit, dispatch, rootGetters}, params: Parameters<typeof GitHubModInstaller.install>[0]) {
            const profile: ImmutableProfile = rootGetters['profile/activeProfileOrThrow'].asImmutableProfile();
            commit('setPhase', 'downloading');
            try {
                await GitHubModInstaller.install(params, profile, (loaded) => {
                    commit('setProgress', params.asset.size > 0 ? (loaded / params.asset.size) * 100 : 0);
                });
            } finally {
                commit('finish');
            }
            await dispatch('profile/updateModListFromFile', null, { root: true });
        },
    }
}
