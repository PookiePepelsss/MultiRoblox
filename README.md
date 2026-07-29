<div align="center">

<img src="https://raw.githubusercontent.com/PookiePepelsss/MultiRoblox-RAM/main/MultiRoblox/src-tauri/icons/128x128.png" width="88" />

# MultiRoblox

**Run as many Roblox accounts as you want, all at once, on Windows.**

[![platform](https://img.shields.io/badge/platform-windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/PookiePepelsss/MultiRoblox-RAM/releases)
[![built with tauri](https://img.shields.io/badge/built%20with-tauri-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app/)
[![license](https://img.shields.io/badge/license-PolyForm%20-3DDC97?style=for-the-badge)](LICENSE)
[![latest release](https://img.shields.io/github/v/tag/PookiePepelsss/MultiRoblox-RAM?style=for-the-badge&label=latest&color=FF6B6B)](https://github.com/PookiePepelsss/MultiRoblox-RAM/releases)

<br>

<!-- add a screenshot or GIF of the app here -->

</div>

---

## Quick start

No installer needed. Grab the exe from [**Releases**](https://github.com/PookiePepelsss/MultiRoblox-RAM/releases) and run it.

Or build it yourself:

```bash
git clone https://github.com/PookiePepelsss/MultiRoblox-RAM.git
cd MultiRoblox-RAM/MultiRoblox
build.bat
```

> Requires the [Rust toolchain](https://rustup.rs). The finished exe lands in `dist\MultiRoblox.exe`.

---

## Features

### 👤 Accounts
- Launch as many accounts side by side as you want
- Sign in through a real Roblox login window, or paste a cookie directly
- Set a game ID, invite link, or private server link per account so it launches straight there
- Nicknames, search, and filtering across all saved accounts
- Cookies encrypted with AES-256-GCM, stored locally. Nothing leaves your device
- Auto-relaunch on unexpected disconnect, back into the same game (crash-loop protected)
- Right-click a running account to set its process priority (Realtime down to Low)

### 📦 Groups
- Bundle accounts into groups (farm squad, trading alts, etc.)
- Launch or kill an entire group at once, with a shared or per-account game target

### 🎚️ Mixer
- Render quality, FPS cap (10-9999), and volume for all running instances, one panel
- Graphics quality writes to Roblox's fast flags; FPS cap writes Roblox's global client settings
- Works with vanilla Roblox and Bloxstrap / Froststrap / Voidstrap / Fishstrap
- Live, per-instance OS-level volume control
- Kill all instances with one click

### 📸 Tracking
- Automated per-account screenshots sent to a Discord webhook on a timer
- Outline one or more capture spots per account, or grab the full window

### 📊 Charts
- Browse top playing now, top rated, and top earning games
- Search and launch any game straight from the charts page

### 🎲 Generator
- Generate Roblox accounts via a [bloxgen.net](https://bloxgen.net/) API key

### ⚙️ Settings
- **General**: multi-instance status, anti-AFK, relaunch-on-disconnect
- **Performance**: RAM trim (manual or automatic on an interval), block RobloxCrashHandler.exe from starting, lower CPU priority once multiple accounts are running, force a specific rendering engine (Direct3D 11/9, OpenGL, Vulkan) via Fast Flags
- **Data & Privacy**: custom encryption key (AES-256-GCM) or OS-native DPAPI (Windows keychain), clear all accounts
- **Themes**: light/dark and several accent themes
- **Sounds**: custom UI sound profiles with volume control and upload-your-own support

### 🕹️ Anti-AFK
- Taps a benign key into every open Roblox window on a configurable interval, so the idle kick never fires

### 📜 Logs
- Real-time log viewer with in-page search (Ctrl+F)

---

## How it works

Roblox prevents multiple instances by holding a Windows mutex. MultiRoblox grabs that mutex first through a lightweight native helper (`RobloxNative.exe`, written in C#), so Roblox opens a fresh instance every time. Each account gets its own auth ticket before launch, so they all sign in as different accounts.

Login opens a native, chromeless window (no external browser involved) that reads the session cookie directly once you sign in.

If the native helper isn't shipped with a build, it compiles from the bundled source using the .NET Framework `csc.exe` already on every Windows machine.

---

## Disclaimer

Running multiple Roblox accounts isn't something Roblox actively bans for normal use, but using this software is at your own risk. The author is not responsible for any bans, suspensions, or other action taken against your account.

---

## Support

If MultiRoblox saved you time, consider tossing a tip my way.

| Coin | Address |
|---|---|
| BTC | `15kEbCxtNKbQ2g16AmiW8BeEKU3h6i9S46` |
| ETH | `0x179ab005a9CD84769934aB66825D38C347D9AB4d` |
| LTC | `LTLYLK9mUMVUk9Gk5j3W8oYqtq1cYiU3Uy` | 

---

## License

Free to use, modify, and share. You may not sell it, and any copy or fork must credit **pookiepepelss** as the original author.

See [LICENSE](LICENSE) for the full text.

<div align="center">

Not affiliated with Roblox Corporation.

</div>
