//! Direct3D 11 backend: device, runtime-compiled HLSL shader, and per-window
//! swap-chain surfaces. One device is shared across every monitor's surface.
//!
//! The shader is compiled at runtime via `D3DCompile` (d3dcompiler_47.dll ships
//! with Windows) — the same approach as the macOS saver's runtime MSL compile,
//! so no offline FXC step is needed. Each surface uses a legacy BitBlt swap
//! chain whose back buffer can be smaller than the window; Present stretches it
//! to fill the window, which is how the performance-scale modes cut GPU cost.

use windows::core::{s, w, Error, Interface, Result, PCSTR, PCWSTR};
use windows::Win32::Foundation::{BOOL, HWND, TRUE};
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_ALPHA_MODE_IGNORE, D2D1_COLOR_F, D2D1_PIXEL_FORMAT, D2D_RECT_F,
};
use windows::Win32::Graphics::Direct2D::{
    D2D1CreateFactory, ID2D1Factory, ID2D1RenderTarget, D2D1_DRAW_TEXT_OPTIONS_NONE,
    D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_FEATURE_LEVEL_DEFAULT, D2D1_RENDER_TARGET_PROPERTIES,
    D2D1_RENDER_TARGET_TYPE_DEFAULT, D2D1_RENDER_TARGET_USAGE_NONE,
};
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, IDWriteTextFormat, DWRITE_FACTORY_TYPE_SHARED,
    DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT,
    DWRITE_FONT_WEIGHT_BLACK, DWRITE_FONT_WEIGHT_LIGHT, DWRITE_FONT_WEIGHT_MEDIUM,
    DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_MEASURING_MODE_NATURAL, DWRITE_PARAGRAPH_ALIGNMENT_NEAR,
    DWRITE_TEXT_ALIGNMENT, DWRITE_TEXT_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT_TRAILING,
};
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN, D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL_10_0,
    D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_11_0, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST,
    ID3DBlob,
};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_MODE_DESC, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory, IDXGIFactory6, IDXGISurface, IDXGISwapChain,
    DXGI_GPU_PREFERENCE_MINIMUM_POWER, DXGI_SWAP_CHAIN_DESC, DXGI_SWAP_EFFECT_DISCARD,
    DXGI_USAGE_RENDER_TARGET_OUTPUT,
};

/// CPU-side mirror of the HLSL `Constants` cbuffer. Field order, types, and
/// padding match the shader exactly. Total size = 112 bytes (7 × 16).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Uniforms {
    pub time: f32,
    pub speed: f32,
    pub intensity: f32,
    pub density: f32,
    pub scene: f32,
    pub month: f32,
    pub ticks: f32,
    pub size: f32,
    pub resolution: [f32; 2],
    pub pad1: [f32; 2],
    pub color_a: [f32; 4],
    pub color_b: [f32; 4],
    pub color_c: [f32; 4],
    pub clock: [f32; 4],
}

const _: () = assert!(std::mem::size_of::<Uniforms>() == 112);

const SHADER_SRC: &str = include_str!("shader.hlsl");

/// Shared Direct3D device, compiled shaders, and constant buffer. Also owns the
/// Direct2D + DirectWrite factories used to draw the clock overlay on top of the
/// rendered scene (sharp vector text, mirroring the macOS / app clock).
pub struct Gfx {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    factory: IDXGIFactory,
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    cbuffer: ID3D11Buffer,
    raster: ID3D11RasterizerState,
    d2d: ID2D1Factory,
    dwrite: IDWriteFactory,
}

/// One frame's clock overlay request: the formatted strings plus the chosen
/// typeface role and position. `date` is `None` for time-only mode.
pub struct ClockDraw<'a> {
    pub time: &'a str,
    pub date: Option<&'a str>,
    pub font: usize,
    pub pos: usize,
}

/// A single window's render target: a swap chain plus its RTV. `bb_*` is the
/// (possibly downscaled) back-buffer size that the shader renders at; the swap
/// chain stretches it to the window on Present.
pub struct Surface {
    swapchain: IDXGISwapChain,
    rtv: ID3D11RenderTargetView,
    /// Direct2D render target wrapping this swap chain's back buffer, used to
    /// paint the clock on top of the scene. `None` if D2D interop is unavailable
    /// (the scene still renders; only the overlay is skipped).
    d2d_rt: Option<ID2D1RenderTarget>,
    pub bb_w: u32,
    pub bb_h: u32,
}

unsafe fn compile(entry: PCSTR, target: PCSTR) -> Result<ID3DBlob> {
    let mut blob: Option<ID3DBlob> = None;
    let mut errors: Option<ID3DBlob> = None;
    let hr = D3DCompile(
        SHADER_SRC.as_ptr() as *const _,
        SHADER_SRC.len(),
        PCSTR::null(),
        None,
        None,
        entry,
        target,
        0,
        0,
        &mut blob,
        Some(&mut errors),
    );
    if hr.is_err() {
        // Surface the compiler's message — the single most useful thing to have
        // when a shader fails to build on a user's GPU/driver.
        if let Some(err_blob) = &errors {
            let bytes = std::slice::from_raw_parts(
                err_blob.GetBufferPointer() as *const u8,
                err_blob.GetBufferSize(),
            );
            crate::log::line(&format!(
                "D3DCompile failed: {}",
                String::from_utf8_lossy(bytes).trim_end()
            ));
        } else {
            crate::log::line("D3DCompile failed (no error blob)");
        }
    }
    hr?;
    blob.ok_or_else(|| Error::from_win32())
}

/// The DXGI adapter with the lowest power draw (the integrated GPU on a dual-GPU
/// laptop), or `None` if it can't be determined — in which case the caller uses
/// the default adapter. Uses `IDXGIFactory6::EnumAdapterByGpuPreference`, which
/// exists on Windows 10 1803+; on older systems the factory cast fails and we
/// return `None` (safe fallback to today's behaviour).
fn low_power_adapter() -> Option<IDXGIAdapter> {
    unsafe {
        let factory: IDXGIFactory6 = CreateDXGIFactory1().ok()?;
        factory
            .EnumAdapterByGpuPreference::<IDXGIAdapter>(0, DXGI_GPU_PREFERENCE_MINIMUM_POWER)
            .ok()
    }
}

impl Gfx {
    pub fn new() -> Result<Gfx> {
        unsafe {
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            // Request a ladder of feature levels so a genuine FL10 GPU still
            // gets a HARDWARE device instead of silently dropping to the WARP
            // software rasterizer — WARP frequently cannot present to the
            // locked screensaver desktop or the Settings preview pane, which is
            // the classic "black screensaver" trap. WARP stays as a true last
            // resort for GPU-less VMs / RDP sessions.
            let levels = [
                D3D_FEATURE_LEVEL_11_0,
                D3D_FEATURE_LEVEL_10_1,
                D3D_FEATURE_LEVEL_10_0,
            ];
            let mut achieved = D3D_FEATURE_LEVEL_11_0;

            // Prefer the LOW-POWER (integrated) GPU: a screensaver is ambient
            // background work, and the default adapter on a dual-GPU laptop is the
            // discrete GPU, which then stays awake burning battery for the whole
            // run. Ask DXGI for the minimum-power adapter and create the device on
            // it explicitly (driver type UNKNOWN is required when an adapter is
            // passed). This is best-effort: if IDXGIFactory6 / enumeration / the
            // device create on that adapter fails for any reason, we fall straight
            // through to the exact default-adapter HARDWARE path we shipped before,
            // so this can never introduce the "black screensaver" trap.
            let low_power = low_power_adapter();
            let mut driver = "";
            if let Some(adapter) = &low_power {
                let hr = D3D11CreateDevice(
                    adapter,
                    D3D_DRIVER_TYPE_UNKNOWN,
                    None,
                    D3D11_CREATE_DEVICE_FLAG(0),
                    Some(&levels),
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    Some(&mut achieved),
                    Some(&mut context),
                );
                if hr.is_ok() {
                    driver = "hardware(low-power)";
                } else {
                    crate::log::line(&format!("low-power adapter device failed ({hr:?}); using default"));
                    device = None;
                    context = None;
                }
            }

            if device.is_none() {
                let hw = D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    None,
                    D3D11_CREATE_DEVICE_FLAG(0),
                    Some(&levels),
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    Some(&mut achieved),
                    Some(&mut context),
                );
                driver = if hw.is_err() {
                    crate::log::line(&format!(
                        "hardware device failed ({hw:?}); falling back to WARP"
                    ));
                    D3D11CreateDevice(
                        None,
                        D3D_DRIVER_TYPE_WARP,
                        None,
                        D3D11_CREATE_DEVICE_FLAG(0),
                        Some(&levels),
                        D3D11_SDK_VERSION,
                        Some(&mut device),
                        Some(&mut achieved),
                        Some(&mut context),
                    )?;
                    "warp"
                } else {
                    "hardware"
                };
            }
            let device = device.ok_or_else(Error::from_win32)?;
            let context = context.ok_or_else(Error::from_win32)?;
            let factory: IDXGIFactory = CreateDXGIFactory1()?;

            // Pick the shader model the achieved feature level can actually run:
            // SM5 (`*_5_0`) needs FL11+; on a FL10 device the SM5 blob would
            // fail at CreateVertexShader, so fall back to SM4 (`*_4_0`).
            let fl11 = achieved.0 >= D3D_FEATURE_LEVEL_11_0.0;
            let (vs_target, ps_target) = if fl11 {
                (s!("vs_5_0"), s!("ps_5_0"))
            } else {
                (s!("vs_4_0"), s!("ps_4_0"))
            };
            crate::log::line(&format!(
                "device={driver} feature_level=0x{:x} shader_model={}",
                achieved.0,
                if fl11 { "5_0" } else { "4_0" }
            ));

            let vs_blob = compile(s!("VSMain"), vs_target)?;
            let ps_blob = compile(s!("PSMain"), ps_target)?;
            let vs_bytes = std::slice::from_raw_parts(
                vs_blob.GetBufferPointer() as *const u8,
                vs_blob.GetBufferSize(),
            );
            let ps_bytes = std::slice::from_raw_parts(
                ps_blob.GetBufferPointer() as *const u8,
                ps_blob.GetBufferSize(),
            );
            let mut vs: Option<ID3D11VertexShader> = None;
            device.CreateVertexShader(vs_bytes, None, Some(&mut vs))?;
            let mut ps: Option<ID3D11PixelShader> = None;
            device.CreatePixelShader(ps_bytes, None, Some(&mut ps))?;
            crate::log::line("shaders compiled and created ok");

            // Pin an explicit rasterizer state with culling OFF. The fullscreen
            // triangle uses the canonical winding that survives default
            // back-face culling, but relying on the driver default is fragile —
            // CULL_NONE removes triangle winding as a black-screen variable.
            let raster_desc = D3D11_RASTERIZER_DESC {
                FillMode: D3D11_FILL_SOLID,
                CullMode: D3D11_CULL_NONE,
                DepthClipEnable: TRUE,
                ..Default::default()
            };
            let mut raster: Option<ID3D11RasterizerState> = None;
            device.CreateRasterizerState(&raster_desc, Some(&mut raster))?;

            let cb_desc = D3D11_BUFFER_DESC {
                ByteWidth: std::mem::size_of::<Uniforms>() as u32,
                Usage: D3D11_USAGE_DYNAMIC,
                BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
                ..Default::default()
            };
            let mut cbuffer: Option<ID3D11Buffer> = None;
            device.CreateBuffer(&cb_desc, None, Some(&mut cbuffer))?;

            // Direct2D + DirectWrite for the clock overlay. Single-threaded factory
            // (we only ever draw from the message-loop thread).
            let d2d: ID2D1Factory = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
            let dwrite: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;

            Ok(Gfx {
                device,
                context,
                factory,
                vs: vs.ok_or_else(Error::from_win32)?,
                ps: ps.ok_or_else(Error::from_win32)?,
                cbuffer: cbuffer.ok_or_else(Error::from_win32)?,
                raster: raster.ok_or_else(Error::from_win32)?,
                d2d,
                dwrite,
            })
        }
    }

    /// Create a render surface for a window. `bb_w`/`bb_h` are the back-buffer
    /// (render) dimensions, which may be smaller than the window for perf.
    pub fn create_surface(&self, hwnd: HWND, bb_w: u32, bb_h: u32) -> Result<Surface> {
        let bb_w = bb_w.max(1);
        let bb_h = bb_h.max(1);
        unsafe {
            let desc = DXGI_SWAP_CHAIN_DESC {
                BufferDesc: DXGI_MODE_DESC {
                    Width: bb_w,
                    Height: bb_h,
                    RefreshRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    ..Default::default()
                },
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
                BufferCount: 1,
                OutputWindow: hwnd,
                Windowed: TRUE,
                SwapEffect: DXGI_SWAP_EFFECT_DISCARD,
                ..Default::default()
            };
            let mut swapchain: Option<IDXGISwapChain> = None;
            self.factory
                .CreateSwapChain(&self.device, &desc, &mut swapchain)
                .ok()?;
            let swapchain = swapchain.ok_or_else(Error::from_win32)?;
            let backbuffer: ID3D11Texture2D = swapchain.GetBuffer(0)?;
            let mut rtv: Option<ID3D11RenderTargetView> = None;
            self.device
                .CreateRenderTargetView(&backbuffer, None, Some(&mut rtv))?;

            // A Direct2D render target over the same back buffer (BGRA, D2D-
            // compatible). DPI pinned to 96 so D2D coordinates == pixels. If this
            // fails on some driver, the clock is simply skipped, never the scene.
            let d2d_rt = backbuffer.cast::<IDXGISurface>().ok().and_then(|surf| {
                let props = D2D1_RENDER_TARGET_PROPERTIES {
                    r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
                    pixelFormat: D2D1_PIXEL_FORMAT {
                        format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        alphaMode: D2D1_ALPHA_MODE_IGNORE,
                    },
                    dpiX: 96.0,
                    dpiY: 96.0,
                    usage: D2D1_RENDER_TARGET_USAGE_NONE,
                    minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
                };
                self.d2d.CreateDxgiSurfaceRenderTarget(&surf, &props).ok()
            });

            Ok(Surface {
                swapchain,
                rtv: rtv.ok_or_else(Error::from_win32)?,
                d2d_rt,
                bb_w,
                bb_h,
            })
        }
    }

    /// Render one frame of `u` into `surf` and present it. When `clock` is
    /// `Some`, the time/date overlay is painted on top of the scene before
    /// Present. Returns `false` if Present reports device loss (TDR / driver
    /// reset / GPU switch) so the caller can exit instead of freezing.
    pub fn render(&self, surf: &Surface, u: &Uniforms, vsync: u32, clock: Option<&ClockDraw>) -> bool {
        unsafe {
            // Upload uniforms.
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            if self
                .context
                .Map(&self.cbuffer, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut mapped))
                .is_ok()
            {
                std::ptr::copy_nonoverlapping(
                    u as *const Uniforms as *const u8,
                    mapped.pData as *mut u8,
                    std::mem::size_of::<Uniforms>(),
                );
                self.context.Unmap(&self.cbuffer, 0);
            }

            let rtvs = [Some(surf.rtv.clone())];
            self.context.OMSetRenderTargets(Some(&rtvs), None);
            let vp = D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: surf.bb_w as f32,
                Height: surf.bb_h as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            };
            self.context.RSSetViewports(Some(&[vp]));
            self.context.RSSetState(&self.raster);
            let clear = [0.0f32, 0.0, 0.0, 1.0];
            self.context.ClearRenderTargetView(&surf.rtv, &clear);
            self.context.VSSetShader(&self.vs, None);
            self.context.PSSetShader(&self.ps, None);
            let cbs = [Some(self.cbuffer.clone())];
            self.context.VSSetConstantBuffers(0, Some(&cbs));
            self.context.PSSetConstantBuffers(0, Some(&cbs));
            self.context
                .IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            self.context.Draw(3, 0);

            // Clock overlay. Unbind the back buffer from D3D and flush so the
            // scene is committed before Direct2D (a separate device) paints text
            // onto the same surface, then Present composites the result.
            if let Some(c) = clock {
                if let Some(rt) = &surf.d2d_rt {
                    self.context.OMSetRenderTargets(Some(&[None]), None);
                    self.context.Flush();
                    self.draw_clock(rt, surf.bb_w as f32, surf.bb_h as f32, c);
                }
            }

            let hr = surf
                .swapchain
                .Present(vsync, windows::Win32::Graphics::Dxgi::DXGI_PRESENT(0));
            hr.is_ok()
        }
    }

    /// Build a DirectWrite text format for a clock typeface role.
    unsafe fn text_format(
        &self,
        family: PCWSTR,
        weight: DWRITE_FONT_WEIGHT,
        align: DWRITE_TEXT_ALIGNMENT,
        size: f32,
    ) -> Option<IDWriteTextFormat> {
        let f = self
            .dwrite
            .CreateTextFormat(
                family,
                None,
                weight,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                size,
                w!(""),
            )
            .ok()?;
        let _ = f.SetTextAlignment(align);
        let _ = f.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
        Some(f)
    }

    /// Paint the clock onto `rt` (a D2D target over the back buffer). Mirrors the
    /// macOS/app layout: time line plus an optional date line beneath, sized and
    /// positioned by `bb` dimensions and the chosen role/position. Each line is
    /// drawn twice — a soft dark shadow then white — for legibility over any scene.
    unsafe fn draw_clock(&self, rt: &ID2D1RenderTarget, w: f32, h: f32, c: &ClockDraw) {
        let (family, weight): (PCWSTR, DWRITE_FONT_WEIGHT) = match c.font {
            0 => (w!("Segoe UI"), DWRITE_FONT_WEIGHT_LIGHT),      // Light
            2 => (w!("Segoe UI"), DWRITE_FONT_WEIGHT_BLACK),      // Bold
            3 => (w!("Consolas"), DWRITE_FONT_WEIGHT_MEDIUM),     // Mono
            _ => (w!("Segoe UI"), DWRITE_FONT_WEIGHT_SEMI_BOLD),  // Modern
        };
        let align = if c.pos == 3 {
            DWRITE_TEXT_ALIGNMENT_TRAILING
        } else {
            DWRITE_TEXT_ALIGNMENT_CENTER
        };
        let time_size = (h * 0.12).clamp(28.0, 240.0);
        let date_size = time_size * 0.20;

        let Some(time_fmt) = self.text_format(family, weight, align, time_size) else { return };

        let white = match rt.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 1.0, g: 1.0, b: 1.0, a: 0.95 },
            None,
        ) {
            Ok(b) => b,
            Err(_) => return,
        };
        let shadow = match rt.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 0.0, g: 0.0, b: 0.0, a: 0.55 },
            None,
        ) {
            Ok(b) => b,
            Err(_) => return,
        };

        let time_h = time_size * 1.3;
        let date_h = date_size * 1.6;
        let gap = 6.0_f32;
        let has_date = c.date.is_some();
        let block_h = time_h + if has_date { date_h + gap } else { 0.0 };
        let pad = h * 0.06;
        let side = if c.pos == 3 { w * 0.06 } else { 0.0 };
        let top = match c.pos {
            1 => pad,                       // Top
            2 | 3 => h - pad - block_h,     // Bottom / Corner
            _ => (h - block_h) / 2.0,       // Center
        };

        let draw_line = |s: &str, fmt: &IDWriteTextFormat, y: f32, lh: f32| unsafe {
            let u: Vec<u16> = s.encode_utf16().collect();
            let sh = D2D_RECT_F { left: side + 2.0, top: y + 3.0, right: w - side + 2.0, bottom: y + lh + 3.0 };
            let r = D2D_RECT_F { left: side, top: y, right: w - side, bottom: y + lh };
            rt.DrawText(&u, fmt, &sh, &shadow, D2D1_DRAW_TEXT_OPTIONS_NONE, DWRITE_MEASURING_MODE_NATURAL);
            rt.DrawText(&u, fmt, &r, &white, D2D1_DRAW_TEXT_OPTIONS_NONE, DWRITE_MEASURING_MODE_NATURAL);
        };

        rt.BeginDraw();
        draw_line(c.time, &time_fmt, top, time_h);
        if let Some(date) = c.date {
            if let Some(date_fmt) = self.text_format(family, weight, align, date_size) {
                draw_line(date, &date_fmt, top + time_h + gap, date_h);
            }
        }
        let _ = rt.EndDraw(None, None);
    }
}

// SAFETY: D3D11 device/context are used single-threaded from the message loop.
unsafe impl Send for Gfx {}

#[allow(dead_code)]
fn _bool_is_used(_: BOOL) {}
