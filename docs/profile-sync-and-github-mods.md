# Profile sync and GitHub-hosted mods

Design notes for two related features added to r2modmanPlus:

1. **Mods from GitHub releases** (including private repositories).
2. **Profile sync** backed by a GitHub repository.

Both use one GitHub personal access token configured in Settings. The design was
derived from Gale's profile sync (whole-profile zip snapshots on a server, last
write wins) and improves on its weak points: optimistic concurrency on push,
local dirty tracking, and inclusion of non-Thunderstore mods in the snapshot.

## GitHub access

- `src/r2mm/github/GitHubClient.ts` wraps the REST API with axios. Every request
  carries `Authorization: Bearer <token>` when a token is set; public
  repositories work without one.
- The token lives in global settings as `githubToken`. When Electron
  `safeStorage` is available the stored value is encrypted and prefixed with
  `enc:`; otherwise it is stored as-is (`SecretStorageProvider`).
- The sync repository is global setting `profileSyncRepository` (`owner/name`).

## Mods from GitHub releases

- A mod installed from a release records its origin on the `ManifestV2` entry
  in `mods.yml`:

  ```yaml
  githubSource:
    repository: owner/name
    tag: v1.2.3
    assetName: MyMod.zip
  ```

- Install flow (`GitHubModInstaller`): resolve the release, download the chosen
  asset through the API (`Accept: application/octet-stream`, so private assets
  work), build a `ManifestV2` from `manifest.json` inside the zip when present
  (fall back to repository owner and name, version from the tag), and hand the
  file to the existing `LocalModInstaller`. The mod is therefore a local mod
  from the installer's point of view, with provenance attached.
- Mod names follow the Thunderstore `Author-Name` convention with characters
  outside `[A-Za-z0-9_]` replaced by `_`.
- Updates: the installed-mod card shows "Update from GitHub" when the latest
  release tag differs from the recorded one (checked once per repository per
  session).
- Export: `export.r2x` entries carry the same `githubSource` block, so profile
  codes, files and sync snapshots re-install GitHub mods on import. Older
  managers ignore the field and report those mods as not found, as before.

## Profile sync

### Remote layout

```
profiles/<game internal folder>/<profile name>/profile.r2z
profiles/<game internal folder>/<profile name>/export.r2x
```

`profile.r2z` is the normal export zip. `export.r2x` is a copy of the manifest
so the remote list can be previewed without downloading the zip.

### Local state

`<profile>/_state/sync.json` (the `_state` directory is already excluded from
exports):

```json
{
  "repository": "owner/name",
  "remotePath": "profiles/Valheim/MyProfile/profile.r2z",
  "remoteSha": "<git blob sha of profile.r2z>",
  "syncedAt": 1760000000000,
  "fingerprint": "<sha256 of export content>"
}
```

- `remoteSha` is the blob sha GitHub reported at the last push or pull. It is
  the concurrency token: a push sends it as `sha`, and GitHub answers 409 when
  the remote moved. The client checks first to give a clear conflict message.
- `fingerprint` hashes exactly what an export would contain (manifest plus
  every included config file). Comparing it to a fresh fingerprint tells
  whether the profile has unpushed local changes. This is the dirty tracking
  Gale lacks.

### Status

| Remote moved | Local changed | Status           |
| ------------ | ------------- | ---------------- |
| no           | no            | `SYNCED`         |
| no           | yes           | `LOCAL_CHANGES`  |
| yes          | no            | `REMOTE_CHANGES` |
| yes          | yes           | `CONFLICT`       |
| 404          | any           | `MISSING`        |

### Operations

- **Link**: export and create the remote files. If the remote already exists
  the user chooses to overwrite it or to replace the local profile with it.
- **Push**: export and update with the stored sha. Refused on `CONFLICT`
  unless forced.
- **Pull**: download `profile.r2z` and run the existing import-as-update path
  (`populateImportedProfile` with `isUpdate`), which rebuilds the profile from
  the snapshot. Thunderstore mods, GitHub mods, enabled state and config files
  are restored. Mods imported from local files without a GitHub source are not
  part of the snapshot and are removed by a pull, the same as a profile update
  from a code.
- **Clone**: list remote profiles for the active game, pick one, import it as a
  new local profile and link it.
- **Unlink**: delete local state; optionally delete the remote files.
- **Pull before launch**: optional global setting, default off. When the
  linked profile has `REMOTE_CHANGES` at launch, pull first.

### Limits

- Snapshot size is capped at 50 MB (`MAX_SYNC_SIZE`), under the 100 MB raw
  download limit of the Contents API.
- No live updates. Status is refreshed on profile switch and on demand.
