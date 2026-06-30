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
- Per-device names and sync status panel.
- Reset actions for replacing cloud data from a local vault or replacing local data from cloud.
- Manifest snapshots before cloud reset actions.

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

### Beta installation

Before the plugin is accepted into the official Obsidian community plugin directory, testers can install it manually or through a GitHub-release based plugin installer such as BRAT.

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

## Sync timing

Cloud watch checks the remote manifest frequently and starts a full sync only when Google Drive changes are detected. The full sync interval is kept as a slower fallback safety net. The plugin also registers a mobile `Sync now` command with an icon so it can be added to Obsidian mobile command surfaces where available.
