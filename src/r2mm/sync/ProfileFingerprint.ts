import R2Error from '../../model/errors/R2Error';
import FileTree from '../../model/file/FileTree';
import { ImmutableProfile } from '../../model/Profile';
import FsProvider from '../../providers/generic/file/FsProvider';
import path from '../../providers/node/path/path';
import ProfileModList from '../mods/ProfileModList';

async function sha256Hex(input: string): Promise<string> {
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A stable hash of everything a profile export would contain: the manifest
 * and every config file. Two fingerprints match exactly when an export made
 * at each point would carry the same content, so comparing the fingerprint
 * stored at the last sync with a fresh one tells whether the profile has
 * unpushed local changes.
 */
export default class ProfileFingerprint {

    /** Mirrors ProfileModList.createExport's file selection. */
    public static async collectEntries(profile: ImmutableProfile): Promise<{ entryName: string, diskPath: string | null, content: string | null }[]> {
        const manifest = await ProfileModList.createExportManifest(profile);
        if (manifest instanceof R2Error) {
            throw manifest;
        }
        const entries: { entryName: string, diskPath: string | null, content: string | null }[] = [
            { entryName: 'export.r2x', diskPath: null, content: manifest },
        ];

        const configDir = profile.joinToProfilePath('BepInEx', 'config');
        if (await FsProvider.instance.exists(configDir)) {
            const tree = await FileTree.buildFromLocation(configDir);
            if (tree instanceof R2Error) {
                throw tree;
            }
            for (const file of tree.getRecursiveFiles()) {
                entries.push({ entryName: path.join('config', path.relative(configDir, file)), diskPath: file, content: null });
            }
        }

        const files = await ProfileModList.getExportFileList(profile);
        if (files instanceof R2Error) {
            throw files;
        }
        for (const file of files) {
            entries.push({ entryName: file.entryName, diskPath: file.diskPath, content: null });
        }
        return entries;
    }

    public static async compute(profile: ImmutableProfile): Promise<string> {
        const entries = await this.collectEntries(profile);
        const lines: string[] = [];
        for (const entry of entries) {
            const content = entry.content !== null
                ? entry.content
                : (await FsProvider.instance.readFile(entry.diskPath!)).toString();
            // Normalise separators so Windows and Linux agree on the entry name.
            const name = entry.entryName.split('\\').join('/');
            lines.push(`${name}\0${await sha256Hex(content)}`);
        }
        lines.sort();
        return sha256Hex(lines.join('\n'));
    }
}
