# Google Drive Vault Sync

Google Drive Vault Sync is a community plugin that syncs an Obsidian vault two-way with Google Drive using the Google OAuth 2.0 Device Authorization Flow.

## Important notice

This plugin is not affiliated with, endorsed by, or sponsored by Obsidian. Obsidian is a trademark of its respective owner.

Always make a full backup of your vault before using this plugin, especially before enabling automatic sync or using reset actions. Sync software can overwrite, move, or delete files when misconfigured, interrupted, or used with conflicting changes.

The author is not responsible for any data loss, file corruption, missed synchronization, account issues, Google Drive quota usage, or any other damage caused directly or indirectly by using this plugin.

## Features

- Two-way vault sync with Google Drive.
- Local file change sync with debounce.
- Lightweight cloud watch for faster remote change detection.
- Periodic full sync fallback.
- Manual `Sync now` command.
- Conflict policy options.
- Per-device names and sync status modal.
- Reset actions for replacing cloud data from a local vault or replacing local data from cloud.
- Manifest snapshots before cloud reset actions.
- Automatic backups with safety-only, timed, or every-sync modes.
- Named manual full backups stored separately from automatic backups.
- Backup preview with text diffs and per-file restore.
- Full backup restore and single-file restore from a selected backup.
- Separate manual backup management. Manual backups are deleted only when you delete them.
- Organized settings with grouped modals for connection, sync behavior, advanced options, and sync status details.

## Installation

### Manual installation

1. Download the latest release assets:
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. Create this folder in your vault:

```text
.obsidian/plugins/google-drive-vault-sync/
```

3. Put the release assets in that folder.
4. Restart Obsidian.
5. Enable the plugin in `Settings > Community plugins`.

### BRAT installation

BRAT can give you access to the newest plugin features before they are included in a stable release. These builds may be buggy, not fully tested, and potentially unsafe for your vault. They can overwrite, move, delete, or corrupt data if a sync bug slips through. Make an independent backup of your vault before using BRAT builds, and avoid testing them on your only copy of important notes.

If you accept that risk:

1. Install the BRAT plugin in Obsidian.
2. Open `Settings > BRAT`.
3. Choose `Add Beta plugin`.
4. Enter this repository URL:

```text
https://github.com/Haniewicz/ObsidianGoogleDriveSync
```

5. Enable `Google Drive Vault Sync` in `Settings > Community plugins`.

## Development

```bash
npm install
npm run dev
```

The plugin avoids Node-only runtime APIs where possible. Local vault access uses the Obsidian Vault API, HTTP uses `requestUrl`, and hashing uses Web Crypto.

## OAuth setup

Create a Google OAuth client suitable for TVs and limited-input devices in Google Cloud Console when available, enable the Drive API, and use the `https://www.googleapis.com/auth/drive.file` scope. Paste the OAuth client ID and client secret into the plugin settings.

Do not commit your OAuth client secret or plugin `data.json` to any repository.

## Destructive sync actions

The settings tab includes reset actions for replacing Google Drive data from the local vault or replacing the local vault from Google Drive. These actions ask for confirmation and use trash where possible, but they can still overwrite files. Review the prompts carefully before running them.

## Backups

Automatic backups can run in safety-only, timed, or every-sync mode. Safety backups are created before risky sync actions that can overwrite or remove files. Timed backups also capture routine local changes at a controlled interval. Manual full backups can be named and are stored separately from automatic backups, so they are not removed by the automatic backup retention limit.

Backup preview supports text diffs where possible. You can restore all files stored in a backup or restore a single file from that backup.

## Sync timing

Cloud watch checks the remote manifest frequently and starts a full sync only when Google Drive changes are detected. The full sync interval is kept as a slower fallback safety net. The plugin also registers a mobile `Sync now` command with an icon so it can be added to Obsidian mobile command surfaces where available.
