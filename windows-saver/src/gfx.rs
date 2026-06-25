//! Direct3D 11 backend: device, runtime-compiled HLSL shader, and per-window
//! swap-chain surfaces. One device is shared across every monitor's surface.
//!
//! The shader is compiled at runtime via `D3DCompile` (d3dcompiler_47.dll ships
//! with Windows) — the same approach as the macOS saver's runtime MSL compile,
//! so no offline FXC step is needed. Each surface uses a legacy BitBlt swap
//! chain whose back buffer can be smaller than the window; Present stretches it
//! to fill the window, which is how the performance-scale modes cut GPU cost.

use windows::core::{s, Error, Result, PCSTR};
use windows::Win32::Foundation::{BOOL, HWND, TRUE};
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL_11_0,
    D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST, ID3DBlob,
};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_MODE_DESC, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory, IDXGISwapChain, DXGI_SWAP_CHAIN_DESC,
    DXGI_SWAP_EFFECT_DISCARD, DXGI_USAGE_RENDER_TARGET_OUTPUT,
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

/// Shared Direct3D device, compiled shaders, and constant buffer.
pub struct Gfx {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    factory: IDXGIFactory,
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    cbuffer: ID3D11Buffer,
}

/// A single window's render target: a swap chain plus its RTV. `bb_*` is the
/// (possibly downscaled) back-buffer size that the shader renders at; the swap
/// chain stretches it to the window on Present.
pub struct Surface {
    swapchain: IDXGISwapChain,
    rtv: ID3D11RenderTargetView,
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
    hr?;
    blob.ok_or_else(|| Error::from_win32())
}

impl Gfx {
    pub fn new() -> Result<Gfx> {
        unsafe {
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            let levels = [D3D_FEATURE_LEVEL_11_0];
            // Prefer the real GPU; fall back to WARP (software) so the saver
            // still runs in VMs, RDP sessions, and GPU-less servers.
            let hw = D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                None,
                D3D11_CREATE_DEVICE_FLAG(0),
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            );
            if hw.is_err() {
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_WARP,
                    None,
                    D3D11_CREATE_DEVICE_FLAG(0),
                    Some(&levels),
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )?;
            }
            let device = device.ok_or_else(Error::from_win32)?;
            let context = context.ok_or_else(Error::from_win32)?;
            let factory: IDXGIFactory = CreateDXGIFactory1()?;

            let vs_blob = compile(s!("VSMain"), s!("vs_5_0"))?;
            let ps_blob = compile(s!("PSMain"), s!("ps_5_0"))?;
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

            let cb_desc = D3D11_BUFFER_DESC {
                ByteWidth: std::mem::size_of::<Uniforms>() as u32,
                Usage: D3D11_USAGE_DYNAMIC,
                BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
                ..Default::default()
            };
            let mut cbuffer: Option<ID3D11Buffer> = None;
            device.CreateBuffer(&cb_desc, None, Some(&mut cbuffer))?;

            Ok(Gfx {
                device,
                context,
                factory,
                vs: vs.ok_or_else(Error::from_win32)?,
                ps: ps.ok_or_else(Error::from_win32)?,
                cbuffer: cbuffer.ok_or_else(Error::from_win32)?,
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
            Ok(Surface {
                swapchain,
                rtv: rtv.ok_or_else(Error::from_win32)?,
                bb_w,
                bb_h,
            })
        }
    }

    /// Render one frame of `u` into `surf` and present it. Returns `false` if
    /// Present reports device loss (TDR / driver reset / GPU switch) so the
    /// caller can exit instead of freezing on a stale frame.
    pub fn render(&self, surf: &Surface, u: &Uniforms, vsync: u32) -> bool {
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
            let hr = surf
                .swapchain
                .Present(vsync, windows::Win32::Graphics::Dxgi::DXGI_PRESENT(0));
            hr.is_ok()
        }
    }
}

// SAFETY: D3D11 device/context are used single-threaded from the message loop.
unsafe impl Send for Gfx {}

#[allow(dead_code)]
fn _bool_is_used(_: BOOL) {}
