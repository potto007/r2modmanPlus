import { ActionTree, GetterTree, MutationTree } from 'vuex';
import ManifestV2 from '../../model/ManifestV2';
import { GitHubRelease } from '../../r2mm/github/GitHubClient';
import GitHubModInstaller from '../../r2mm/github/GitHubModInstaller';
import { State as RootState } from '../../store';

export interface State {
    /** Latest release per "owner/name", null when the check found nothing newer. */
    latestReleases: Record<string, GitHubRelease | null>;
    /** Repositories with a check in flight, to avoid duplicate requests. */
    pending: string[];
}

/**
 * Session cache of "is there a newer release" per repository. One request per
 * repository per session keeps installed-mod cards cheap on the API quota.
 */
export default {
    namespaced: true,

    state: (): State => ({
        latestReleases: {},
        pending: [],
    }),

    getters: <GetterTree<State, RootState>>{
        updateFor: (state) => (mod: ManifestV2): GitHubRelease | null => {
            const source = mod.getGitHubSource();
            if (source === null) {
                return null;
            }
            const latest = state.latestReleases[source.repository];
            return latest && latest.tagName !== source.tag ? latest : null;
        },

        isChecked: (state) => (repository: string): boolean => {
            return repository in state.latestReleases;
        },
    },

    mutations: <MutationTree<State>>{
        setLatest(state: State, params: { repository: string, release: GitHubRelease | null }) {
            state.latestReleases = { ...state.latestReleases, [params.repository]: params.release };
        },

        setPending(state: State, params: { repository: string, pending: boolean }) {
            state.pending = params.pending
                ? [...state.pending, params.repository]
                : state.pending.filter((r) => r !== params.repository);
        },

        reset(state: State) {
            state.latestReleases = {};
            state.pending = [];
        },
    },

    actions: <ActionTree<State, RootState>>{
        /** Checks once per session unless force is set. Failures are swallowed. */
        async checkForUpdate({commit, state}, params: { mod: ManifestV2, force?: boolean }) {
            const source = params.mod.getGitHubSource();
            if (source === null) {
                return;
            }
            const repository = source.repository;
            if ((!params.force && repository in state.latestReleases) || state.pending.includes(repository)) {
                return;
            }
            commit('setPending', { repository, pending: true });
            try {
                const release = await GitHubModInstaller.checkForUpdate(source);
                commit('setLatest', { repository, release });
            } catch (e) {
                console.warn(`GitHub update check failed for ${repository}`, e);
                commit('setLatest', { repository, release: null });
            } finally {
                commit('setPending', { repository, pending: false });
            }
        },
    }
}
