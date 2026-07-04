# Noctura — native Windows screensaver (`.scr`)

A true Windows screen saver that renders the same gallery as the macOS `.saver`
and the WebGL app, but as a lean native **Direct3D 11** program. No WebView2, no
Tauri, no runtime to install — D3D11 ships with every supported Windows. The
resulting `.scr` is ~200 KB and starts instantly.

This is the Windows counterpart to `../native-saver` (macOS Metal). The two are
kept at **full parity**: same 13 scenes, same 13 palettes, same control ranges,
ported from one canonical shader.

## Why Direct3D 11 + runtime HLSL

The scene shader (`src/shader.hlsl`) is a faithful translation of the macOS
Metal shader (`../native-saver/Sources/AuroraShader.swift`) — a single pixel
shader that branches on `u.scene` to draw all 13 scenes, with the identical
112-byte uniform layout and the same final dither. It is compiled **at runtime**
via `D3DCompile` (`d3dcompiler_47.dll`, present on all Windows), mirroring the
macOS saver's runtime MSL compilation — so there's no offline FXC step.

## Screensaver contract

A `.scr` is just a PE executable Windows launches with flags (`src/main.rs`):

| Invocation        | Behavior                                                        |
|-------------------|----------------------------------------------------------------|
| `/s`              | Full-screen saver: one borderless top-most window **per monitor**, each with its own D3D11 swap chain. Exits on mouse move (>12 px), key, or click. |
| `/p <hwnd>`       | Live preview rendered as a child window inside the Settings mini-pane; stops when that pane closes. |
| `/c` (or none)    | Configuration dialog (Scene · Style · Speed · Intensity · Density · Size · Performance). |

Settings persist per-user in the registry at `HKCU\Software\Noctura`
(`src/settings.rs`), shared by the live saver, the preview, and the dialog.

## Performance modes

The back-buffer can be smaller than the window; Present stretches it to fill
(BitBlt swap chain), so lower modes cut GPU cost and upscale — the same strategy
as macOS. A hard 5120 px longest-edge backstop protects 6K/8K/spanned displays.

| Mode        | Render scale | Frame rate |
|-------------|--------------|------------|
| Auto        | native (adaptive hook reserved) | 60 |
| Full        | native       | 60 |
| Balanced    | 1 / 1.5      | 60 |
| Power Saver | 1 / 2        | 30 |

## Build

### Cross-compile from macOS/Linux (no Windows box)

```bash
cargo install --locked cargo-xwin
rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc
./build-cross.sh        # → windows-saver/dist/windows/Noctura-{x64,arm64}.{scr,exe}
```

`cargo-xwin` downloads the MSVC CRT + Windows SDK import headers and links with
`rust-lld`; the `windows` crate vendors the Win32/D3D11 import libraries, so a
fully native PE links without a Windows host.

### Build natively on Windows

```powershell
rustup target add x86_64-pc-windows-msvc
cargo build --release --target x86_64-pc-windows-msvc
```

## Layout

| File              | Role                                                          |
|-------------------|---------------------------------------------------------------|
| `src/main.rs`     | Flag parsing, multi-monitor saver, preview, input-to-dismiss  |
| `src/gfx.rs`      | D3D11 device, runtime HLSL compile, swap-chain surfaces, draw |
| `src/shader.hlsl` | 13-scene pixel shader (port of the Metal shader)              |
| `src/settings.rs` | Scenes, palettes, ranges, registry persistence                |
| `src/config.rs`   | Programmatic Win32 configuration dialog                        |

## Notes & limits

- Unsigned (local/testing). Wide distribution wants an Authenticode signature so
  SmartScreen stays quiet.
- Visual output can only be confirmed on Windows; the macOS-side gate is a full
  `cargo check`/`cargo xwin build` against the real Win32 API.
- `Auto` performance currently pins native resolution; the measured-GPU-time
  adaptive controller (as on macOS) is the reserved next step.
