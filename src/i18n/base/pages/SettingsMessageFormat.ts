export type SettingsEntry = {
    title: string;
    description: string;
    searchTerms: string[];
};

export type SettingsMessageFormat = {
    hero: {
        title: string;
        subtitle: string;
    },
    nav: {
        label: string;
        categories: {
            all: string;
            directories: string;
            profile: string;
            appearance: string;
            debugging: string;
            modpacks: string;
            other: string;
        }
    },
    search: {
        label: string;
        placeholder: string;
    },
    actions: {
        change: string;
        browse: string;
        notSet: string;
    },
    entries: {
        changeLaunchBehaviour: SettingsEntry & { current: string; },
        cleanOnlineModListCache: SettingsEntry & { action: string; },
        copyLogToClipboard: SettingsEntry,
        copyTroubleshooting: SettingsEntry,
        dataDirectory: SettingsEntry & {
            warning: string;
            dataFolder: string;
            profileFolder: string;
            dialog: {
                title: string;
                button: string;
            };
        },
        downloadCache: SettingsEntry & {
            enabled: string;
            disabled: string;
        },
        expandCards: SettingsEntry & {
            expanded: string;
            collapsed: string;
        },
        exportProfile: SettingsEntry & {
            asFile: string;
            asCode: string;
            dialog: {
                title: string;
                button: string;
            };
        },
        funkyMode: SettingsEntry & {
            enabled: string;
            disabled: string;
        },
        gameDirectory: SettingsEntry & {
            warning: string;
            unsure: string;
        },
        importLocalMod: SettingsEntry,
        launchArguments: SettingsEntry & { action: string; },
        modCache: SettingsEntry & {
            stillWritten: string;
            action: string;
            actionDescription: string;
            enabled: string;
            disabled: string;
            enabledHint: string;
            disabledHint: string;
        },
        modState: SettingsEntry & {
            enableAll: string;
            disableAll: string;
            allEnabled: string;
            allDisabled: string;
            someDisabled: string;
        },
        onlineModList: SettingsEntry & {
            refresh: string;
            deleteCopy: string;
            states: {
                refreshing: string;
                error: string;
                disabledWhileDownloading: string;
                lastUpdated: string;
                noApiInfo: string;
            }
        },
        refreshOnlineModList: SettingsEntry & {
            action: string;
            states: {
                refreshing: string;
                error: string;
                disabledWhileDownloading: string;
                cacheDate: string;
                noApiInfo: string;
            }
        },
        resetGameInstallation: SettingsEntry & { action: string; },
        showDependencyStrings: SettingsEntry,
        steamDirectory: SettingsEntry & { value: string; },
        theme: SettingsEntry & {
            light: string;
            dark: string;
        },
        toggleCdn: SettingsEntry & {
            action: string;
            current: string;
        },
        updateAllMods: SettingsEntry & { status: string; },
        githubAccount: SettingsEntry & {
            tokenLabel: string;
            tokenPlaceholder: string;
            tokenSet: string;
            repositoryLabel: string;
            repositoryPlaceholder: string;
            save: string;
            clear: string;
            test: string;
            testing: string;
            testSuccess: string;
            repositoryAccessible: string;
            private: string;
            public: string;
            readOnlyWarning: string;
        },
        profileSync: SettingsEntry & {
            open: string;
            linked: string;
            notLinked: string;
            pullBeforeLaunch: string;
        },
        installFromGithub: SettingsEntry,
    }
};
