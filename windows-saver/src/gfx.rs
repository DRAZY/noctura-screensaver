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
    D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP, ID3DBlob,
};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R32_FLOAT, DXGI_FORMAT_R32G32_FLOAT,
    DXGI_FORMAT_R32G32B32A32_FLOAT, DXGI_MODE_DESC, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
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

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FluidParams {
    amount: f32,
    dissipation: f32,
    alpha: f32,
    r_beta: f32,
    delta_time: f32,
    pad0: f32,
    texel: [f32; 2],
    ch_scale: [f32; 4],
    ch_mult: [f32; 4],
    ch_offset: [f32; 4],
}

const _: () = assert!(std::mem::size_of::<FluidParams>() == 80);

#[repr(C)]
#[derive(Clone, Copy)]
struct LineParams {
    grid_size: [f32; 2],
    aspect: f32,
    zoom: f32,
    line_length: f32,
    line_variance: f32,
    vel_gain: f32,
    delta_time: f32,
    line_width: f32,
    begin_offset: f32,
    glow: f32,
    time: f32,
    num_lines: u32,
    gx: u32,
    pad: [f32; 2],
    color_a: [f32; 4],
    color_b: [f32; 4],
    color_c: [f32; 4],
}

const _: () = assert!(std::mem::size_of::<LineParams>() == 112);

const SHADER_SRC: &str = include_str!("shader.hlsl");
const FLUX_SRC: &str = include_str!("flux.hlsl");

const GX: u32 = 128;
const GY: u32 = 72;
const NUM_LINES: u32 = 9216;
const FLUID: u32 = 128;
const TIME_SCALE: f32 = 0.115;
const VEL_GAIN: f32 = 10.0;
const DISSIPATION: f32 = 2.0;
const BASE_LINE_LENGTH: f32 = 0.6;
const VISCOSITY: f32 = 5.0;
const DIFFUSE_ITERS: usize = 3;
const PRESSURE_ITERS: usize = 19;
const STEP: f32 = 1.0 / 60.0;

struct Tex {
    // Ownership anchor: keep the resource alive for the struct's lifetime. The RTV
    // and SRV also hold references, so this is never read directly — hence allow.
    #[allow(dead_code)]
    tex: ID3D11Texture2D,
    rtv: ID3D11RenderTargetView,
    srv: ID3D11ShaderResourceView,
}

impl Tex {
    unsafe fn make(device: &ID3D11Device, w: u32, h: u32, format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT) -> Result<Tex> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            ..Default::default()
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        device.CreateTexture2D(&desc, None, Some(&mut tex))?;
        let tex = tex.ok_or_else(Error::from_win32)?;
        let mut rtv: Option<ID3D11RenderTargetView> = None;
        device.CreateRenderTargetView(&tex, None, Some(&mut rtv))?;
        let mut srv: Option<ID3D11ShaderResourceView> = None;
        device.CreateShaderResourceView(&tex, None, Some(&mut srv))?;
        Ok(Tex {
            tex,
            rtv: rtv.ok_or_else(Error::from_win32)?,
            srv: srv.ok_or_else(Error::from_win32)?,
        })
    }
}

struct FluxFluid {
    fs_vs: ID3D11VertexShader,
    noise_ps: ID3D11PixelShader,
    advect_ps: ID3D11PixelShader,
    adjust_ps: ID3D11PixelShader,
    diffuse_ps: ID3D11PixelShader,
    inject_ps: ID3D11PixelShader,
    divergence_ps: ID3D11PixelShader,
    pressure_ps: ID3D11PixelShader,
    subtract_ps: ID3D11PixelShader,
    spring_ps: ID3D11PixelShader,
    line_vs: ID3D11VertexShader,
    line_ps: ID3D11PixelShader,
    vel_a: Tex,
    vel_b: Tex,
    noise_t: Tex,
    fwd_t: Tex,
    rev_t: Tex,
    prs_a: Tex,
    prs_b: Tex,
    div_t: Tex,
    state_a: Tex,
    state_b: Tex,
    sampler: ID3D11SamplerState,
    add_blend: ID3D11BlendState,
    fluid_cb: ID3D11Buffer,
    line_cb: ID3D11Buffer,
    sim_time: f32,
    last_time: f32,
    accumulator: f32,
    warmed_up: bool,
}

impl FluxFluid {
    fn new(device: &ID3D11Device, vs_target: PCSTR, ps_target: PCSTR) -> Option<FluxFluid> {
        unsafe {
            (|| -> Result<FluxFluid> {
                let make_vs = |entry: PCSTR, target: PCSTR| -> Result<ID3D11VertexShader> {
                    let blob = compile_src(FLUX_SRC, entry, target)?;
                    let bytes = std::slice::from_raw_parts(
                        blob.GetBufferPointer() as *const u8,
                        blob.GetBufferSize(),
                    );
                    let mut sh = None;
                    device.CreateVertexShader(bytes, None, Some(&mut sh))?;
                    sh.ok_or_else(Error::from_win32)
                };
                let make_ps = |entry: PCSTR, target: PCSTR| -> Result<ID3D11PixelShader> {
                    let blob = compile_src(FLUX_SRC, entry, target)?;
                    let bytes = std::slice::from_raw_parts(
                        blob.GetBufferPointer() as *const u8,
                        blob.GetBufferSize(),
                    );
                    let mut sh = None;
                    device.CreatePixelShader(bytes, None, Some(&mut sh))?;
                    sh.ok_or_else(Error::from_win32)
                };

                let fs_vs = make_vs(s!("fs_vertex"), vs_target)?;
                let line_vs = make_vs(s!("line_vertex"), vs_target)?;
                let noise_ps = make_ps(s!("noise_frag"), ps_target)?;
                let advect_ps = make_ps(s!("advect_frag"), ps_target)?;
                let adjust_ps = make_ps(s!("adjust_frag"), ps_target)?;
                let diffuse_ps = make_ps(s!("diffuse_frag"), ps_target)?;
                let inject_ps = make_ps(s!("inject_frag"), ps_target)?;
                let divergence_ps = make_ps(s!("divergence_frag"), ps_target)?;
                let pressure_ps = make_ps(s!("pressure_frag"), ps_target)?;
                let subtract_ps = make_ps(s!("subtract_frag"), ps_target)?;
                let spring_ps = make_ps(s!("spring_frag"), ps_target)?;
                let line_ps = make_ps(s!("line_fragment"), ps_target)?;

                let vel_a = Tex::make(device, FLUID, FLUID, DXGI_FORMAT_R32G32_FLOAT)?;
                let vel_b = Tex::make(device, FLUID, FLUID, DXGI_FORMAT_R32G32_FLOAT)?;
                let noise_t = Tex::make(device, FLUID, FLUID, DXGI_FORMAT_R32G32_FLOAT)?;
                let fwd_t = Tex::make(device, FLUID, FLUID, DXGI_FORMAT_R32G32_FLOAT)?;
                let rev_t = Tex::make(device, FLUID, FLUID, DXGI_FORMAT_R32G32_FLOAT)?;
                let prs_a = Tex::make(device, FLUID, FLUID, DXGI_FORMAT_R32_FLOAT)?;
                let prs_b = Tex::make(device, FLUID, FLUID, DXGI_FORMAT_R32_FLOAT)?;
                let div_t = Tex::make(device, FLUID, FLUID, DXGI_FORMAT_R32_FLOAT)?;
                let state_a = Tex::make(device, GX, GY, DXGI_FORMAT_R32G32B32A32_FLOAT)?;
                let state_b = Tex::make(device, GX, GY, DXGI_FORMAT_R32G32B32A32_FLOAT)?;

                let sampler_desc = D3D11_SAMPLER_DESC {
                    Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
                    AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                    ComparisonFunc: D3D11_COMPARISON_NEVER,
                    MinLOD: 0.0,
                    MaxLOD: D3D11_FLOAT32_MAX,
                    ..Default::default()
                };
                let mut sampler = None;
                device.CreateSamplerState(&sampler_desc, Some(&mut sampler))?;
                let sampler = sampler.ok_or_else(Error::from_win32)?;

                let mut blend_desc = D3D11_BLEND_DESC::default();
                blend_desc.RenderTarget[0] = D3D11_RENDER_TARGET_BLEND_DESC {
                    BlendEnable: TRUE,
                    SrcBlend: D3D11_BLEND_ONE,
                    DestBlend: D3D11_BLEND_ONE,
                    BlendOp: D3D11_BLEND_OP_ADD,
                    SrcBlendAlpha: D3D11_BLEND_ONE,
                    DestBlendAlpha: D3D11_BLEND_ONE,
                    BlendOpAlpha: D3D11_BLEND_OP_ADD,
                    RenderTargetWriteMask: D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8,
                };
                let mut add_blend = None;
                device.CreateBlendState(&blend_desc, Some(&mut add_blend))?;
                let add_blend = add_blend.ok_or_else(Error::from_win32)?;

                let fluid_desc = D3D11_BUFFER_DESC {
                    ByteWidth: std::mem::size_of::<FluidParams>() as u32,
                    Usage: D3D11_USAGE_DYNAMIC,
                    BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                    CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
                    ..Default::default()
                };
                let mut fluid_cb = None;
                device.CreateBuffer(&fluid_desc, None, Some(&mut fluid_cb))?;
                let fluid_cb = fluid_cb.ok_or_else(Error::from_win32)?;

                let line_desc = D3D11_BUFFER_DESC {
                    ByteWidth: std::mem::size_of::<LineParams>() as u32,
                    Usage: D3D11_USAGE_DYNAMIC,
                    BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                    CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
                    ..Default::default()
                };
                let mut line_cb = None;
                device.CreateBuffer(&line_desc, None, Some(&mut line_cb))?;
                let line_cb = line_cb.ok_or_else(Error::from_win32)?;

                Ok(FluxFluid {
                    fs_vs,
                    noise_ps,
                    advect_ps,
                    adjust_ps,
                    diffuse_ps,
                    inject_ps,
                    divergence_ps,
                    pressure_ps,
                    subtract_ps,
                    spring_ps,
                    line_vs,
                    line_ps,
                    vel_a,
                    vel_b,
                    noise_t,
                    fwd_t,
                    rev_t,
                    prs_a,
                    prs_b,
                    div_t,
                    state_a,
                    state_b,
                    sampler,
                    add_blend,
                    fluid_cb,
                    line_cb,
                    sim_time: 0.0,
                    last_time: -1.0,
                    accumulator: 0.0,
                    warmed_up: false,
                })
            })()
            .map_err(|e| {
                crate::log::line(&format!("FluxFluid::new failed: {e}"));
                e
            })
            .ok()
        }
    }

    unsafe fn upload_fluid(&self, ctx: &ID3D11DeviceContext, p: &FluidParams) {
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        if ctx
            .Map(&self.fluid_cb, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut mapped))
            .is_ok()
        {
            std::ptr::copy_nonoverlapping(
                p as *const FluidParams as *const u8,
                mapped.pData as *mut u8,
                std::mem::size_of::<FluidParams>(),
            );
            ctx.Unmap(&self.fluid_cb, 0);
        }
    }

    unsafe fn upload_line(&self, ctx: &ID3D11DeviceContext, p: &LineParams) {
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        if ctx
            .Map(&self.line_cb, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut mapped))
            .is_ok()
        {
            std::ptr::copy_nonoverlapping(
                p as *const LineParams as *const u8,
                mapped.pData as *mut u8,
                std::mem::size_of::<LineParams>(),
            );
            ctx.Unmap(&self.line_cb, 0);
        }
    }

    unsafe fn set_viewport(ctx: &ID3D11DeviceContext, w: u32, h: u32) {
        ctx.RSSetViewports(Some(&[D3D11_VIEWPORT {
            Width: w as f32,
            Height: h as f32,
            MinDepth: 0.0,
            MaxDepth: 1.0,
            ..Default::default()
        }]));
    }

    unsafe fn fluid_pass(
        &self,
        ctx: &ID3D11DeviceContext,
        ps: &ID3D11PixelShader,
        target: &Tex,
        inputs: &[Option<ID3D11ShaderResourceView>],
        p: &FluidParams,
    ) {
        Self::set_viewport(ctx, FLUID, FLUID);
        ctx.OMSetRenderTargets(Some(&[Some(target.rtv.clone())]), None);
        self.upload_fluid(ctx, p);
        ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
        ctx.PSSetShaderResources(0, Some(inputs));
        ctx.PSSetConstantBuffers(1, Some(&[Some(self.fluid_cb.clone())]));
        ctx.VSSetShader(&self.fs_vs, None);
        ctx.PSSetShader(ps, None);
        ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ctx.Draw(3, 0);
    }

    unsafe fn fluid_step(&mut self, ctx: &ID3D11DeviceContext, dt: f32, noise_mult: f32) {
        let texel = [1.0 / FLUID as f32, 1.0 / FLUID as f32];
        let srv = |t: &Tex| Some(t.srv.clone());

        let mut p = FluidParams {
            delta_time: dt,
            texel,
            ..Default::default()
        };

        p.ch_scale = [2.5, 15.0, 30.0, 0.0];
        p.ch_mult = [1.0 * noise_mult, 0.7 * noise_mult, 0.5 * noise_mult, 0.0];
        p.ch_offset = [
            0.0015 * self.sim_time * 60.0,
            0.009 * self.sim_time * 60.0,
            0.018 * self.sim_time * 60.0,
            0.0,
        ];
        self.fluid_pass(ctx, &self.noise_ps, &self.noise_t, &[], &p);

        p.dissipation = DISSIPATION;
        p.amount = dt;
        let advect_inputs = [srv(&self.vel_a)];
        self.fluid_pass(ctx, &self.advect_ps, &self.fwd_t, &advect_inputs, &p);

        p.amount = -dt;
        let rev_inputs = [srv(&self.vel_a)];
        self.fluid_pass(ctx, &self.advect_ps, &self.rev_t, &rev_inputs, &p);

        let adjust_inputs = [srv(&self.vel_a), srv(&self.fwd_t), srv(&self.rev_t)];
        self.fluid_pass(ctx, &self.adjust_ps, &self.vel_b, &adjust_inputs, &p);
        std::mem::swap(&mut self.vel_a, &mut self.vel_b);

        let center = 1.0 / (VISCOSITY * dt);
        p.alpha = center;
        p.r_beta = 1.0 / (4.0 + center);
        for _ in 0..DIFFUSE_ITERS {
            let diffuse_inputs = [srv(&self.vel_a)];
            self.fluid_pass(ctx, &self.diffuse_ps, &self.vel_b, &diffuse_inputs, &p);
            std::mem::swap(&mut self.vel_a, &mut self.vel_b);
        }

        let inject_inputs = [srv(&self.vel_a), srv(&self.noise_t)];
        self.fluid_pass(ctx, &self.inject_ps, &self.vel_b, &inject_inputs, &p);
        std::mem::swap(&mut self.vel_a, &mut self.vel_b);

        let divergence_inputs = [srv(&self.vel_a)];
        self.fluid_pass(ctx, &self.divergence_ps, &self.div_t, &divergence_inputs, &p);

        p.alpha = -1.0;
        p.r_beta = 0.25;
        for _ in 0..PRESSURE_ITERS {
            let pressure_inputs = [srv(&self.prs_a), srv(&self.div_t)];
            self.fluid_pass(ctx, &self.pressure_ps, &self.prs_b, &pressure_inputs, &p);
            std::mem::swap(&mut self.prs_a, &mut self.prs_b);
        }

        let subtract_inputs = [srv(&self.vel_a), srv(&self.prs_a)];
        self.fluid_pass(ctx, &self.subtract_ps, &self.vel_b, &subtract_inputs, &p);
        std::mem::swap(&mut self.vel_a, &mut self.vel_b);
    }

    unsafe fn spring_step(&mut self, ctx: &ID3D11DeviceContext, line: &LineParams) {
        Self::set_viewport(ctx, GX, GY);
        ctx.OMSetRenderTargets(Some(&[Some(self.state_b.rtv.clone())]), None);
        self.upload_line(ctx, line);
        ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
        ctx.PSSetShaderResources(
            0,
            Some(&[Some(self.vel_a.srv.clone()), Some(self.state_a.srv.clone())]),
        );
        ctx.PSSetConstantBuffers(2, Some(&[Some(self.line_cb.clone())]));
        ctx.VSSetShader(&self.fs_vs, None);
        ctx.PSSetShader(&self.spring_ps, None);
        ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ctx.Draw(3, 0);
        std::mem::swap(&mut self.state_a, &mut self.state_b);
    }

    unsafe fn encode(&mut self, ctx: &ID3D11DeviceContext, surf: &Surface, u: &Uniforms) {
        let now = u.time;
        let real_delta = if self.last_time < 0.0 {
            1.0 / 60.0
        } else {
            (now - self.last_time).clamp(0.0, 0.25)
        };
        self.last_time = now;

        let noise_mult = 0.75 + 0.30 * (u.size - 0.85) / 0.85;
        let mut line = LineParams {
            grid_size: [GX as f32, GY as f32],
            aspect: u.resolution[0] / u.resolution[1].max(1.0),
            zoom: 1.6,
            line_length: BASE_LINE_LENGTH * (1.0 + 0.5 * (u.size - 0.85)),
            line_variance: 0.45,
            vel_gain: VEL_GAIN,
            delta_time: STEP,
            line_width: 0.011,
            begin_offset: 0.4,
            glow: 1.0 + u.intensity,
            time: self.sim_time,
            num_lines: NUM_LINES,
            gx: GX,
            pad: [0.0, 0.0],
            color_a: u.color_a,
            color_b: u.color_b,
            color_c: u.color_c,
        };

        if !self.warmed_up {
            self.warmed_up = true;
            for t in [
                &self.vel_a,
                &self.vel_b,
                &self.noise_t,
                &self.fwd_t,
                &self.rev_t,
                &self.prs_a,
                &self.prs_b,
                &self.div_t,
                &self.state_a,
                &self.state_b,
            ] {
                ctx.ClearRenderTargetView(&t.rtv, &[0.0, 0.0, 0.0, 0.0]);
            }
            for _ in 0..150 {
                self.sim_time += STEP;
                self.fluid_step(ctx, STEP, noise_mult);
            }
        }

        self.accumulator += real_delta * TIME_SCALE * (u.speed / 0.3);
        let mut steps = 0;
        while self.accumulator >= STEP && steps < 4 {
            self.sim_time += STEP;
            if self.sim_time > 1000.0 {
                self.sim_time -= 1000.0;
            }
            self.fluid_step(ctx, STEP, noise_mult);
            line.delta_time = STEP;
            self.spring_step(ctx, &line);
            self.accumulator -= STEP;
            steps += 1;
        }
        if self.accumulator > STEP {
            self.accumulator = STEP;
        }
        line.time = self.sim_time;

        Self::set_viewport(ctx, surf.bb_w, surf.bb_h);
        ctx.OMSetRenderTargets(Some(&[Some(surf.rtv.clone())]), None);
        ctx.ClearRenderTargetView(&surf.rtv, &[0.02, 0.016, 0.047, 1.0]);
        ctx.OMSetBlendState(Some(&self.add_blend), None, 0xffffffff);
        self.upload_line(ctx, &line);
        ctx.VSSetShaderResources(
            0,
            Some(&[Some(self.state_a.srv.clone()), Some(self.vel_a.srv.clone())]),
        );
        ctx.VSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
        let line_cbs = [Some(self.line_cb.clone())];
        ctx.VSSetConstantBuffers(2, Some(&line_cbs));
        ctx.PSSetConstantBuffers(2, Some(&line_cbs));
        ctx.VSSetShader(&self.line_vs, None);
        ctx.PSSetShader(&self.line_ps, None);
        ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
        let draw_count = ((NUM_LINES as f32) * (0.65 + 0.35 * u.density))
            .floor()
            .max(1.0) as u32;
        ctx.DrawInstanced(4, draw_count, 0, 0);

        ctx.OMSetBlendState(None, None, 0xffffffff);
        ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ctx.VSSetShaderResources(0, Some(&[None, None]));
        ctx.PSSetShaderResources(0, Some(&[None, None, None]));
    }
}

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
    flux: std::cell::RefCell<Option<FluxFluid>>,
    flux_tried: std::cell::Cell<bool>,
    flux_sm5: bool,
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

unsafe fn compile_src(src: &str, entry: PCSTR, target: PCSTR) -> Result<ID3DBlob> {
    let mut blob: Option<ID3DBlob> = None;
    let mut errors: Option<ID3DBlob> = None;
    let hr = D3DCompile(
        src.as_ptr() as *const _,
        src.len(),
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

unsafe fn compile(entry: PCSTR, target: PCSTR) -> Result<ID3DBlob> {
    compile_src(SHADER_SRC, entry, target)
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
                flux: std::cell::RefCell::new(None),
                flux_tried: std::cell::Cell::new(false),
                flux_sm5: fl11,
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
            let mut scene_drawn = false;
            if (u.scene + 0.5) as i32 == 16 {
                if !self.flux_tried.get() {
                    self.flux_tried.set(true);
                    let targets = if self.flux_sm5 {
                        (s!("vs_5_0"), s!("ps_5_0"))
                    } else {
                        (s!("vs_4_0"), s!("ps_4_0"))
                    };
                    *self.flux.borrow_mut() = FluxFluid::new(&self.device, targets.0, targets.1);
                }
                if let Some(flux) = self.flux.borrow_mut().as_mut() {
                    flux.encode(&self.context, surf, u);
                    scene_drawn = true;
                }
            }
            if !scene_drawn {
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
            }

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
