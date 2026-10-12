# ✨ Blinkers Application

An application where you turn your day into a blink of tasks

## Here is a link to the documentation of the project: 

## Install

Download the installer for your system from the [latest release](https://github.com/goostty/blinkers/releases/latest).

Blinkers is not code-signed yet (signing costs money, and this is an early version), so Windows and macOS will warn you the first time. The app is the same either way.

### Windows

1. Run the `.exe` (or `.msi`) installer.
2. If Windows shows **"Windows protected your PC"**, click **More info**, then **Run anyway**.

### macOS

Pick the `.dmg` that matches your Mac: `aarch64` for Apple Silicon (M1 and newer), `x64` for Intel.

1. Open the `.dmg` and drag Blinkers into Applications.
2. Try to open it once. macOS will refuse.
3. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to Blinkers.
4. If macOS says the app is "damaged", run this once in Terminal, then open it again:
   ```bash
   xattr -dr com.apple.quarantine /Applications/blinkers.app
   ```

### Linux

- **AppImage:** `chmod +x blinkers_*.AppImage`, then run it.
- **Debian / Ubuntu:** `sudo apt install ./blinkers_*.deb`
- **Fedora:** `sudo dnf install ./blinkers-*.rpm`

## Your data

Everything is stored locally on your computer. Nothing is uploaded. It lives in a folder named after the app identifier, `com.goostty.blinkers`:

| System | Location |
| --- | --- |
| Windows | `%APPDATA%\com.goostty.blinkers\` |
| macOS | `~/Library/Application Support/com.goostty.blinkers/` |
| Linux | `~/.local/share/com.goostty.blinkers/` |

To back up your data, copy that folder. Uninstalling the app does not delete it.

## Releasing (for maintainers)

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` (all three must match).
2. Commit, then tag and push: `git tag v0.1.1 && git push origin v0.1.1`.
3. GitHub Actions runs the tests, builds Windows, macOS (Apple Silicon and Intel) and Linux installers, and attaches them to a **draft** release.
4. Review the draft on GitHub, then publish it.

The identifier `com.goostty.blinkers` decides where users' data lives. Do not change it after release, or existing users will appear to lose their data.
