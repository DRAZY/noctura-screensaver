# Noctura

**A cross-platform animated screensaver — 11 curated GPU-rendered scenes, 13 color palettes — for macOS and Windows.**

Noctura runs the *same* scenes everywhere, three ways: a desktop gallery app, a native macOS `.saver`, and a native Windows `.scr`. Every scene is a real-time GPU fragment shader (WebGL on the web build, Metal on macOS, Direct3D 11 on Windows), kept at pixel-level parity across all three.

![Flux Drift](screenshots/scenes/FluxDrift.png)

---

## ⬇️ Download

Grab the latest build from the [**Releases**](../../releases/latest) page.

| Platform | File | Notes |
|---|---|---|
| **macOS** (Apple Silicon) | `Noctura_<ver>_aarch64.dmg` | Smallest; M-series Macs |
| **macOS** (Intel + Apple Silicon) | `Noctura_<ver>_universal.dmg` | Works on any Mac |
| **macOS screensaver** | `Noctura.saver.zip` | Includes `Install-Noctura.command` / `Uninstall-Noctura.command` |
| **Windows** (x64 + ARM64) | `Noctura-Windows.zip` | Includes `Install-Noctura.bat` / `Uninstall-Noctura.bat`; installer auto-detects your CPU |

> Builds are unsigned (ad-hoc signed, no paid Developer ID), so the OS warns on first launch — you can still open them:
> - **macOS:** drag Noctura to Applications, double-click, click **Done** on the warning, then **System Settings → Privacy & Security** → scroll to *"Noctura was blocked"* → **Open Anyway**. Guaranteed alternative: `xattr -dr com.apple.quarantine /Applications/Noctura.app`.
> - **Windows:** SmartScreen → **More info → Run anyway**.

### Uninstall
- **macOS app (DMG):** drag `Noctura.app` from Applications to the Trash.
- **macOS screensaver:** run `Uninstall-Noctura.command` from the zip (removes the saver + its saved settings). Manual: delete `~/Library/Screen Savers/Noctura.saver`.
- **Windows:** run `Uninstall-Noctura.bat` from the zip (self-elevates, removes `Noctura.scr`).

---

## ✨ Scenes

11 curated scenes — **Flux Drift** · Northern Lights · Deep Space · Particle Drift · Plasma Field · Fireflies · Black Hole · Caustics · Nebula Drift · Fractal Bloom · **Particle Swarm**

**Flux Drift** is the flagship scene: a **faithful port of [Flux](https://flux.sandydoo.me/)** (sandydoo's open-source tribute to the macOS Drift screensaver), rebuilt from its source. A real GPU **Stable-Fluids** simulation (Jos Stam Navier–Stokes, 128² grid) runs at true 60 Hz; thousands of line "blades" — one per 15 logical pixels of your display — chase the fluid with damped-spring physics, and even their *colors* have inertia, smoothed by a second spring from the local flow velocity. Lines accumulate in linear color space with a final sRGB encode, exactly like the reference's rendering pipeline.

Each scene below is shown in a **different one of the 13 color Styles**, to hint at the range — every scene works with every palette.

<p>
<img src="screenshots/scenes/FluxDrift.png" width="32%" alt="Flux Drift — Aurora style">
<img src="screenshots/scenes/NorthernLights.png" width="32%" alt="Northern Lights — Mint style">
<img src="screenshots/scenes/DeepSpace.png" width="32%" alt="Deep Space — Deep Space style">
<img src="screenshots/scenes/ParticleDrift.png" width="32%" alt="Particle Drift — Monochrome style">
<img src="screenshots/scenes/PlasmaField.png" width="32%" alt="Plasma Field — Synthwave style">
<img src="screenshots/scenes/Fireflies.png" width="32%" alt="Fireflies — Gold style">
<img src="screenshots/scenes/BlackHole.png" width="32%" alt="Black Hole — Ember style">
<img src="screenshots/scenes/Caustics.png" width="32%" alt="Caustics — Ocean style">
<img src="screenshots/scenes/NebulaDrift.png" width="32%" alt="Nebula Drift — Nebula style">
<img src="screenshots/scenes/FractalBloom.png" width="32%" alt="Fractal Bloom — Sunset style">
<img src="screenshots/scenes/ParticleSwarm.png" width="32%" alt="Particle Swarm — Gold style">
</p>

Each scene is tunable: **Style** (13 palettes — Aurora, Borealis, Deep Space, Ocean, Ember, Synthwave, Sunset, Nebula, Mint, Gold, Ice, Rose, Monochrome), **Speed**, **Intensity**, **Density**, **Size**, and a **Performance** mode (Auto / Full / Balanced / Power Saver) that scales render resolution to stay smooth on any GPU.

### 🕒 Clock & lock

All three builds can overlay the **time** (or **time + date**) on top of the scene — choose a typeface (**Light · Modern · Bold · Mono**, mapped to each OS's best modern system font), a position (**Center · Top · Bottom · Corner**), and **12- or 24-hour** format.

<p><img src="screenshots/16-clock-fonts.png" width="48%" alt="Clock overlay"></p>

**Lock on resume:** require sign-in when the screensaver ends. On **Windows** this is a one-click toggle in the saver's settings. On **macOS** it's an OS-owned setting a screensaver can't change itself — enable **System Settings → Lock Screen → "Require password after screen saver begins" → Immediately** and macOS locks automatically the moment the screensaver starts; the saver's Options sheet points you there.

---

## 🖥️ Three builds, one gallery

| Build | Tech | What it is |
|---|---|---|
| **Desktop app** | Tauri 2 · React · WebGL | A standalone window with the full gallery, slideshow, favorites, and clock overlay. |
| **macOS `.saver`** | Swift · Metal | A true system screensaver in System Settings → Screen Saver. See [`native-saver/`](native-saver/). |
| **Windows `.scr`** | Rust · Direct3D 11 | A true Windows screensaver (`/s` `/p` `/c`), ~200 KB, no runtime to install. See [`windows-saver/`](windows-saver/). |

The macOS Metal shader and the Windows HLSL shader are faithful ports of the same canonical scene shader, sharing an identical uniform layout — so all three platforms render the same image. **Flux Drift** goes further: all three renderers run the same multi-pass architecture ported from the Flux source — a 128² Navier-Stokes solver stepped at a fixed 60 Hz, a per-line state pass carrying 12 floats of spring physics per blade (endpoint, velocity, color, color-velocity, width) in MRT float textures, an endpoint pass with Flux's blend-compensation trick, and linear-space accumulation with an sRGB encode — so the fluid look **and motion** match across web, macOS, and Windows (verified against the live reference with side-by-side captures and motion-decorrelation measurement).

---

## 🔧 Build from source

**Prerequisites:** [Bun](https://bun.sh), [Rust](https://rustup.rs).

### Desktop app (macOS / Windows / Linux)
```bash
bun install
bun run tauri build          # → src-tauri/target/release/bundle/
```
macOS Universal:
```bash
rustup target add x86_64-apple-darwin
bun run tauri build --target universal-apple-darwin
```

### macOS screensaver (`.saver`)
```bash
cd native-saver
./build.sh --install         # builds + installs into ~/Library/Screen Savers/
```

### Windows screensaver (`.scr`)
Native on Windows:
```powershell
cd windows-saver
cargo build --release --target x86_64-pc-windows-msvc
```
Or cross-compile from macOS/Linux (no Windows box needed):
```bash
cargo install --locked cargo-xwin
rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc
cd windows-saver && ./build-cross.sh    # → dist/windows/
```

---

## 📁 Layout

```
src/             Web gallery (React + WebGL scenes)
src-tauri/       Tauri desktop app shell (Rust)
native-saver/    macOS .saver (Swift + Metal)
windows-saver/   Windows .scr (Rust + Direct3D 11)
screenshots/     Scene captures
```

## 📄 License

MIT — see [LICENSE](LICENSE). Created by Andre Hall.
