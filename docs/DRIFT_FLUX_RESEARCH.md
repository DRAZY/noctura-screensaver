# Drift / Flux — How It Really Renders, and How to Fake It in One Fragment Shader

> Research + implementation spec for reproducing the macOS **Drift** screensaver look
> (via its open-source tribute **Flux**, github.com/sandydoo/flux) inside Noctura's
> single-fullscreen-fragment-shader engine.
>
> Sources read directly from a local clone at `/tmp/flux-ref` (commit = shallow HEAD):
> `flux/src/flux.rs`, `flux/src/grid.rs`, `flux/src/settings.rs`,
> `flux/src/render/{fluid,lines,noise,color}.rs`, and every shader in
> `flux/shader/*.wgsl` (`advect`, `diffuse`, `divergence`, `solve_pressure`,
> `subtract_gradient`, `inject_noise`, `generate_noise`, `adjust_advection`,
> `place_lines`, `line`, `endpoint`).

---

## 0. TL;DR — the one thing that matters

Flux is **NOT** a per-pixel texture effect. It is:

1. A **real Navier–Stokes fluid solver** (Stam "Stable Fluids") running on a
   128×N velocity grid, stirred by evolving multi-octave simplex noise, made
   **divergence-free** every frame by a pressure projection.
2. **Thousands of actual line primitives** (instanced quads, one per grid node),
   each with a **fixed basepoint** and a **moving endpoint** that is integrated
   over time by a **damped-spring / momentum ODE** driven by the sampled fluid
   velocity. Persistent per-line state (`endpoint`, `velocity`, `color`) lives in
   a GPU storage buffer and is updated by a compute shader each frame.
3. Lines are drawn **additively** (`SrcAlpha, One`) on black, **head-bright /
   tail-faded**, with width and opacity scaled by local flow speed.

Our engine gives a scene **one fullscreen quad, `uTime`, and zero persistent
state between frames**. So we cannot run the solver or keep the per-line
momentum buffer. The faithful stateless substitute is:

> **Analytic divergence-free flow field (curl of slowly-evolving multi-octave
> simplex noise) + per-pixel streamline-distance rendering:** for each pixel,
> visit the handful of nearby grid basepoints, integrate a short streamline
> polyline forward through the field from each basepoint, and light the pixel by
> its distance to that polyline — width/opacity from local speed, brightness
> tapering head-to-tail, additive accumulation of overlapping streaks.**

The previous attempt failed because it stamped **one straight dash per grid cell,
capped at ~2 cells long, oriented by the velocity at the anchor only, combined
with `max()`**. Flux lines are **many cells long, follow the curve of the flow,
overlap heavily, and add**. Details in §5.

---

## 1. The fluid simulation (Stam Stable Fluids on the GPU)

### 1.1 Grid, timestep, storage

- **Resolution.** `fluid_size = 128`. The actual texture is
  `128 * scaling_ratio` per axis, where `scaling_ratio = max(cols/171, 1) × max(rows/171, 1)`
  (`grid.rs::ScalingRatio`). On a normal display this is ~128×80 to ~128×128.
- **Velocity texture:** `Rgba16Float`, only `.xy` used. Double-buffered
  (ping-pong) — `velocity_textures[2]`, `last_velocity_index` flips per pass.
- **Timestep:** `fluid_timestep = 1/60 s` (fixed). The sim runs in a
  **fixed-step accumulator** (`flux.rs::compute`): real elapsed time is banked in
  `fluid_frame_time` and the whole solve loop runs `while fluid_frame_time >= 1/60`.
- **Pressure texture:** `R32Float` (falls back to `Rgba16Float` without
  `FLOAT32_FILTERABLE`). Cleared to **0.0 every frame** (`PressureMode::ClearWith(0.0)`).
- **Divergence texture:** `R32Float`.
- **Noise texture:** `Rg32Float` (fallback `Rgba16Float`), size `2*fluid_size*scaling`.

### 1.2 Exact per-frame order (from `flux.rs::compute`)

For each fixed 1/60 s step:

```
noise.generate()            // regenerate the forcing noise field
fluid.advect_forward()      // semi-Lagrangian backtrace  (MacCormack step 1)
fluid.advect_reverse()      // advect the forward result forward (MacCormack step 2)
fluid.adjust_advection()    // BFECC error correction + min/max clamp
fluid.diffuse()             // implicit viscosity, 3 Jacobi iterations
fluid.inject_noise()        // velocity += dt * noise   (the stirring force)
fluid.calculate_divergence()
fluid.solve_pressure()      // 19 Jacobi iterations, pressure pre-cleared to 0
fluid.subtract_gradient()   // make velocity divergence-free; zero at boundaries
```
Then **once per rendered frame** (outside the fixed loop):
```
lines.tick_line_uniforms()  // advance line-noise offsets
lines.place_lines()         // integrate every line's endpoint (the ODE, §2)
```

### 1.3 The individual operators (exact math)

**Advection** — `advect.comp.wgsl`. Semi-Lagrangian backtrace:
```
advected_position = ((texel + 0.5) - direction * timestep * velocity) / size
new_velocity      = sample_linear(velocity, advected_position) / decay
decay             = 1 + dissipation * timestep        // = 1.0, dissipation is 0
```
> **Key stylistic note copied from the shader:** the backtrace multiplies velocity
> by `timestep` but does **not** divide the velocity by `dx`. The code comment
> says this "incorrectly scaled coordinate system … is actually a key component
> of the slow, wriggly 'coral reef' look." Keep flow **slow and large-scale**.

MacCormack/BFECC is done in three passes: forward advect → reverse advect the
forward result → `adjust_advection.comp.wgsl` computes
`adjusted = forward + 0.5*(velocity - reverse)` then **clamps to the min/max of
the 4-neighbourhood** (removes overshoot ringing).

**Diffusion (implicit viscosity)** — `diffuse.comp.wgsl`, 3 Jacobi iterations:
```
center_factor  = 1 / (viscosity * timestep) = 1 / (5 * 1/60) = 12
stencil_factor = 1 / (4 + center_factor)     = 1/16
new_velocity   = stencil_factor * (l + r + b + t + center_factor * v)
```

**Noise injection** — `inject_noise.comp.wgsl`:
```
new_velocity = velocity + timestep * noise      // additive body force
```

**Divergence** — `divergence.comp.wgsl`:
```
div = 0.5 * ((r.x - l.x) + (t.y - b.y))
```

**Pressure solve (Jacobi Poisson)** — `solve_pressure.comp.wgsl`, 19 iterations,
with `alpha = -1`, `r_beta = 0.25`:
```
new_pressure = r_beta * (l + r + b + t + alpha * divergence)
             = 0.25 * (l + r + b + t - divergence)
```
Pure-Neumann boundary: outside samples clamp to the edge value (∂p/∂n = 0).

**Subtract pressure gradient (projection)** — `subtract_gradient.comp.wgsl`:
```
new_velocity = boundary * (velocity - 0.5 * vec2(r-l, t-b))   // r,l,t,b = pressure
```
`boundary` zeroes the normal velocity component at the texture edges (no-slip).

### 1.4 The forcing noise (what stirs the fluid)

`generate_noise.comp.wgsl` + `noise.rs`. This is the "wind." It is a sum of
**3 octaves of 2-component simplex noise** (`make_noise_pair(p) =
(snoise(p), snoise(p + (8,-8,0)))`) — a smooth 2D vector field, **not** curl
noise; the fluid solver's projection is what makes the final flow divergence-free.

Default channels (`settings.rs`):

| octave | `scale` | `multiplier` | `offset_increment` (z-scroll / step) |
|-------:|--------:|-------------:|-------------------------------------:|
| 0 | 2.8  | 1.0 | 0.001 |
| 1 | 15.0 | 0.7 | 0.006 |
| 2 | 30.0 | 0.5 | 0.012 |

Global `noise_multiplier = 0.45`. Each octave's scale breathes
`× (1 + 0.15·sin(0.01·t·2π))` and its `offset` (the 3rd noise coordinate) scrolls
by `offset_increment` per step — this is the slow morphing of the flow over
minutes. Injected force per step = `timestep * noise_multiplier * Σ octaves`.

### 1.5 Fluid parameter summary

| setting | default | meaning |
|---|---|---|
| `fluid_size` | 128 | base grid resolution |
| `fluid_timestep` | 1/60 | fixed sim step |
| `viscosity` | 5.0 | implicit diffusion strength |
| `velocity_dissipation` | **0.0** | velocity does **not** decay |
| `diffusion_iterations` | 3 | viscosity Jacobi iters |
| `pressure_iterations` | 19 | projection Jacobi iters |
| `pressure_mode` | ClearWith(0.0) | pressure reset each frame |
| `noise_multiplier` | 0.45 | forcing strength |

---

## 2. The lines (the actual visible thing)

### 2.1 Geometry: grid of basepoints, instanced quads

`grid.rs`: basepoints are a regular lattice in `[0,1]²`.
```
columns   = floor(width / grid_spacing)         // grid_spacing = 15 px
rows      = floor((height/width) * columns)
line_count = (rows+1) * (columns+1)
basepoint(u,v) = (u/columns, v/rows)             // one line per node
```
On a 1920-wide display: `columns ≈ 128`, so **~8,000–10,000 lines**. Each line is
**one instanced 6-vertex quad** (`draw_lines`, `LINE_VERTICES`) plus a second
instanced quad for the endpoint sprite (`draw_endpoints`).

### 2.2 The endpoint ODE (the heart of the motion) — `place_lines.comp.wgsl`

Each line keeps persistent state `{endpoint, velocity, color, color_velocity, width}`.
Per frame, in the compute shader:

```wgsl
basepoint = basepoints[i]
velocity  = sample(velocity_texture, basepoint).xy      // fluid velocity at the node

// per-line variance from a slowly-scrolling simplex noise keyed on basepoint
noise    = snoise(vec3(line_noise_scale * basepoint, line_noise_offset))   // ∈ [-1,1]
variance = mix(1 - line_variance, 1, 0.5 + 0.5*noise)   // line_variance = 0.55
velocity_delta_boost = mix(3.0, 25.0, 1 - variance)     // spring stiffness
momentum_boost       = mix(3.0, 5.0,  variance)         // damping

// DAMPED SPRING toward target = line_length * fluid_velocity
new_velocity =
      (1 - dt * momentum_boost) * line.velocity                          // inertia/damping
    + (line_length * velocity - line.endpoint) * velocity_delta_boost * dt // spring pull
new_endpoint = line.endpoint + dt * new_velocity
```

This is the crucial part: the endpoint is a **second-order system** (position +
velocity, damped, pulled toward `line_length * fluidVelocity`). It **lags,
overshoots, and swings** — that is the living, woven, "combed hair in water"
motion. `line_length = 450`, `line_variance = 0.55`. At steady state
`endpoint → line_length * fluidVelocity` (a first-order Euler step along the flow),
so a settled line is **tangent to the flow at its basepoint**, with length
proportional to local speed.

### 2.3 Width & opacity from speed — `place_lines.comp.wgsl`

```wgsl
width_boost = saturate(2.5 * length(velocity))   // full at |v| ≈ 0.4
new_width   = smoothstep(0, 1, width_boost)
opacity     = smoothstep(0, 1, width_boost)      // width and opacity share the easing
```
So **calm water → thin, transparent, near-invisible**; **fast water → wide,
opaque, long**. Still regions fade to black. This single fact is most of the look.

### 2.4 Drawing the line quad — `line.wgsl`

Vertex builds a quad from `basepoint`, `endpoint`, `width`:
```wgsl
x_basis = normalize(vec2(-endpoint.y, endpoint.x))       // perpendicular to the line
point = vec2(aspect,1) * zoom * (basepoint*2 - 1)        // node position in clip space
      + endpoint * vertex.y                              // vertex.y ∈ [0,1] : base→tip
      + line_width * width * x_basis * vertex.x           // vertex.x ∈ [-0.5,0.5] : across
```
Fragment — **head-bright, tail-faded, AA edges**:
```wgsl
line_offset = line_begin_offset / short_line_boost       // line_begin_offset = 0.4
fade        = smoothstep(line_offset, 1.0, f_vertex.y)    // 0 at base, 1 at tip
edge_width  = fwidth(f_vertex.x)
smooth_edges= 1 - smoothstep(0.5 - edge_width, 0.5, abs(f_vertex.x))
out.rgb     = color.rgb
out.a       = color.a * fade * smooth_edges
```
The tail (near the basepoint, `y < 0.4`) fades fully out; the line is brightest at
the endpoint. `short_line_boost = 1 + line_width*width/len(endpoint)` keeps very
short lines from vanishing entirely.

### 2.5 The endpoint sprite — `endpoint.wgsl`

A second instanced quad draws a **soft round dot at the tip** of every line
(radius `~0.5*line_width*width`), split into a bright "top" half and a
blend-corrected "bottom" half so it seamlessly caps the line. It uses a radial
`1 - smoothstep(1-fwidth, 1, dist)` falloff. This is the glowing bead at the head
of each streak.

### 2.6 Blending

`lines.rs` pipeline: `color: SrcAlpha,One,Add` / `alpha: One,One,Add`. **Purely
additive** over a black clear. Overlapping streaks **sum** their brightness —
that is why dense fast regions bloom to near-white.

---

## 3. Color

`place_lines.comp.wgsl` chooses a per-line target color, then **also** runs a
damped-spring on the color** (`color_velocity`, `color_delta_boost = 90`,
`color_momentum_boost = 3`) so colors ease over time. Three modes:

- **Mode 0 — "Original" (default).** By **velocity**:
  ```wgsl
  color = saturate(vec3(1.0*(0.5+v.x), 0.66*(0.5+v.y), 0.5))
  ```
  Pastel field: +x velocity → red, +y → green, constant blue 0.5. This is the
  classic multi-hue Drift wash.
- **Mode 1 — color wheel (presets).** By **direction**:
  `angle = atan2(v.y, v.x); color = wheel(angle + π over 2π)` — a ring buffer of
  6 RGBA stops (`get_color`, linear-interpolated, wraps around).
- **Mode 2 — sample an image texture** by `2*v + 0.5`.

### 3.1 Default presets (`settings.rs`)

- **`Original`** (default): the velocity formula above (no wheel).
- **`Plasma`** (6 stops, RGB 0–1):
  `(0.236,0.146,0.260) (0.671,0.214,0.200) (0.903,0.154,0.022) (0.953,0.370,0.088) (0.951,0.615,0.231) (0.531,0.599,0.716)`
  — deep purple → rust → orange → warm amber → cool grey-blue.
- **`Poolside`** (6 stops): a set of light cyans/blues
  `(0.298,0.612,0.894) (0.549,0.800,0.957) (0.424,0.706,0.925) (0.737,0.894,0.957) (0.486,0.863,0.925) (0.612,0.816,0.925)`.
- **`Freedom`**: enum exists, `to_color_wheel()` returns `None`, i.e. it falls
  back to the Original velocity formula (no dedicated wheel in this source).

Color is **by velocity/direction, not by screen position.** Neighboring lines in
the same flow share a hue because they share a velocity — that is what makes the
big coherent color regions, *not* a position-based color texture.

---

## 4. Complete default settings (`settings.rs::Default`)

```
mode                 = Normal
fluid_size           = 128
fluid_frame_rate     = 60
fluid_timestep       = 1/60
viscosity            = 5.0
velocity_dissipation = 0.0
pressure_mode        = ClearWith(0.0)
diffusion_iterations = 3
pressure_iterations  = 19
color_mode           = Preset(Original)
line_length          = 450.0
line_width           = 9.0
line_begin_offset    = 0.4       // fraction of the line (from base) that is faded
line_variance        = 0.55
grid_spacing         = 15        // px between basepoints
view_scale           = 1.6       // zoom
noise_multiplier     = 0.45
noise_channels       = [ {2.8,1.0,0.001}, {15.0,0.7,0.006}, {30.0,0.5,0.012} ]
```
Derived render uniforms (`lines.rs`): `line_width_px = view_scale*line_width*S`,
`line_length_px = view_scale*line_length*S`, where
`S = 1/min((1-1/aspect)*w + (1/aspect)*h, 2000)` (a screen-size normalizer, i.e.
`line_length` and `line_width` are ~ fractions of screen height). Ratio
**width : length ≈ 9 : 450 ≈ 1 : 50** — the lines are long and thin.

---

## 5. THE KEY INSIGHT — why "one dash per grid cell" cannot be Flux

The previous `Drift.ts` (per-pixel, 5×5 cell walk, one capsule per cell, `max()`
compositing) fails for **five separable reasons**, in rough order of visual impact:

1. **Lines are far longer than one cell, and overlap.** Flux: `line_length 450`
   vs `grid_spacing 15` — a full-speed line is on the order of **10–30 cell
   spacings long**. Basepoints are only ~1 cell apart, so at any pixel **dozens of
   lines overlap**. The failed shader capped `maxLen ≈ 1.95 * cell` and searched a
   5×5 box — it structurally cannot gather a streak whose basepoint is many cells
   upstream. Result: short disconnected tick-marks instead of long woven strokes.

2. **`max()` instead of additive.** Flux blends `SrcAlpha, One` — overlapping
   streaks **sum** and bloom. `max()` throws away all overlap energy, so dense
   fast regions never brighten and the field looks flat and sparse.

3. **A straight dash along the *local* velocity ≠ a streamline.** Flux's endpoint
   is `line_length * velocity_at_basepoint` — tangent to the flow at the base —
   and, more importantly, the *temporal* integration makes the streak track the
   flow's history. Sampling velocity only at the anchor and drawing a straight
   stub ignores how the flow **curves** across the stroke's length. The fix is to
   **integrate a short streamline** (multi-step) through the field, not draw a
   single straight segment.

4. **No inertia / no temporal coherence.** The real motion (lag, swing,
   overshoot, "combing") comes from the **damped-spring endpoint ODE with
   persistent state**. A stateless per-frame recompute snaps instantly to the
   field and flickers. We cannot keep the buffer, but we recover most of the
   smoothness by making the analytic field **evolve slowly** (so consecutive
   frames give nearly identical streamlines).

5. **Color/width driven wrong.** Flux ties **width AND opacity** to
   `smoothstep(speed)` so calm water genuinely disappears to black, and colors are
   **by velocity/direction** (coherent regions), not a separate position-noise
   tint layered on top.

**Minimum faithful stateless approach:** an analytic **divergence-free** velocity
field that evolves slowly in time, rendered by **per-pixel streamline distance**:
integrate a short polyline forward from each nearby basepoint, light pixels inside
a speed-scaled tube around it, taper brightness head-to-tail, and **accumulate
additively**. This reproduces (1)(2)(3)(5) exactly and approximates (4).

---

## 6. Concrete GLSL spec for Noctura (single fragment shader, no state)

### 6.1 Constants, derived from Flux defaults

Everything is expressed in **grid-cell units** (`cell = 1/uGrid` in aspect-corrected
uv), so the look is resolution-independent.

```glsl
// --- grid ---
// Flux grid_spacing = 15 px. columns = width/15. Match density but cap cost:
//   uGrid ≈ screenWidth / 20   (≈ 96 on 1920w). Trade density for perf freely.
uniform float uGrid;            // columns across the aspect-corrected field. Default ~72–96.

// --- line geometry (Flux ratios, in CELL units) ---
const float LINE_LENGTH   = 6.0;   // max streamline arc length in CELLS at full speed.
                                   // Flux is ~10–30; 6 keeps the neighbourhood search cheap.
const float LINE_WIDTH    = 0.30;  // half-width in CELLS at full speed (Flux width:length ≈ 1:50 →
                                   // at LINE_LENGTH 6 cells, ~0.12 cell; 0.30 reads better on screen).
const float LINE_BEGIN_OFFSET = 0.4;  // Flux line_begin_offset — tail fraction that fades out.
const float LINE_VARIANCE = 0.55;  // Flux line_variance — per-line length/width jitter.
const float SPEED_GAIN    = 2.5;   // Flux width_boost = saturate(2.5*|v|).

// --- streamline integration ---
const int   KSTEPS = 5;            // polyline segments per streamline (Euler/RK2). 4–8.
const int   SEARCH = 4;            // half-width of basepoint neighbourhood: (2*SEARCH+1)^2 nodes.
                                   // Must satisfy SEARCH*cell >= LINE_LENGTH*cell → SEARCH >= LINE_LENGTH... but
                                   // AABB pruning (§6.4) makes a smaller SEARCH acceptable; 4 covers ~4 cells.
```

> Note the length tension: a streamline up to `LINE_LENGTH` cells long can be
> touched by a basepoint up to `LINE_LENGTH` cells upstream, which argues for
> `SEARCH ≥ LINE_LENGTH`. That is expensive. Resolve it by (a) keeping
> `LINE_LENGTH` modest (≈4–6), (b) the cheap AABB reject in §6.4, and (c)
> early-out on calm cells. If you want Flux-long streaks, raise `LINE_LENGTH` and
> `SEARCH` together and accept the cost, or lower `uGrid`.

### 6.2 The analytic velocity field (curl of evolving multi-octave noise)

Replaces the whole Navier–Stokes solver. Curl of a scalar potential is
**divergence-free by construction** (that is exactly what Flux's pressure
projection guarantees). Keep it **UN-normalized** so magnitude = flow speed
(drives length/width, like Flux). Evolve slowly for temporal coherence.

```glsl
// Scalar stream-function potential: sum of octaves, each scrolling in its own
// "z" like Flux's per-octave noise offsets. snoise() is 3D simplex noise.
float streamPsi(vec2 p, float t) {
  // scales & weights mirror Flux noise_channels (relative ratios), retuned for uv space
  float psi  = 1.00 * snoise(vec3(p * 0.9,  t * 0.05));   // octave 0  (big, slow)
        psi += 0.70 * snoise(vec3(p * 2.4,  t * 0.12));   // octave 1
        psi += 0.50 * snoise(vec3(p * 4.8,  t * 0.20));   // octave 2  (fine, faster)
  return psi;
}

// Velocity = curl of psi = (dPsi/dy, -dPsi/dx). Central differences.
// UN-normalized: |velocity| is the local flow speed.
vec2 velocityAt(vec2 p, float t) {
  const float e = 0.75;                 // finite-diff step in uFlow-space (tune with uFlow)
  float px1 = streamPsi(p + vec2(e,0), t), px0 = streamPsi(p - vec2(e,0), t);
  float py1 = streamPsi(p + vec2(0,e), t), py0 = streamPsi(p - vec2(0,e), t);
  vec2 v = vec2(py1 - py0, -(px1 - px0)) / (2.0 * e);
  return v;                             // add a tiny constant bias for gentle global drift if desired
}
```

`uFlow` (a uniform, ~2–3) scales `p` before sampling: larger = smaller, tighter
vortices. `t = uTime * uSpeed`.

### 6.3 Line color (Flux "Original" velocity mode)

```glsl
vec3 lineColor(vec2 v) {
  // Flux mode 0:  r = sat(1.0*(0.5+vx)), g = sat(0.66*(0.5+vy)), b = 0.5
  return clamp(vec3(0.5 + v.x, 0.66 * (0.5 + v.y), 0.5), 0.0, 1.0);
}
// For a "preset wheel" look instead, color by direction:
//   float a = atan(v.y, v.x); vec3 c = wheel(a);   // ring buffer of 6 stops
// Blend with a slow position-noise hue if you want the multi-hue Nebula palette.
```

### 6.4 The streamline-distance renderer (core)

```glsl
// Returns additive brightness at `uv`; writes weighted color into `tint`.
float streakField(vec2 uv, float t, out vec3 tint) {
  float cell   = 1.0 / uGrid;                  // grid spacing in uv units
  vec2  baseId = floor(uv / cell);
  float accum  = 0.0;
  vec3  colSum = vec3(0.0);

  for (int j = -SEARCH; j <= SEARCH; j++)
  for (int i = -SEARCH; i <= SEARCH; i++) {
    vec2 cellId = baseId + vec2(float(i), float(j));
    vec2 bp     = (cellId + 0.5) * cell;       // basepoint = grid node (cell centre)

    // --- local speed at the basepoint -> Flux width_boost -> width & opacity ---
    vec2  v0    = velocityAt(bp * uFlow, t);
    float speed = length(v0);
    float wb    = clamp(SPEED_GAIN * speed, 0.0, 1.0);
    float boost = smoothstep(0.0, 1.0, wb);    // Flux: smoothstep(0,1,width_boost)
    if (boost < 0.01) continue;                // calm water -> no line (early-out)

    // --- per-line variance (Flux line_variance) ---
    float rnd      = hash21(cellId);
    float variance = mix(1.0 - LINE_VARIANCE, 1.0, rnd);

    // --- streamline length & tube half-width, in uv units, scaled by speed ---
    float lineLen = LINE_LENGTH * cell * boost * variance;
    float halfW   = LINE_WIDTH  * cell * boost;
    if (lineLen < 1e-5) continue;

    // --- cheap AABB reject: whole streamline lies within lineLen+halfW of bp ---
    if (dot(uv - bp, uv - bp) > (lineLen + halfW) * (lineLen + halfW)) continue;

    // --- integrate the streamline polyline forward, track nearest point ---
    float ds   = lineLen / float(KSTEPS);
    vec2  pPrev = bp;
    float best = 1e9, bestS = 0.0, arc = 0.0;
    for (int k = 0; k < KSTEPS; k++) {
      // RK2 (midpoint) is smoother than Euler; Euler is fine if KSTEPS >= 6.
      vec2 vk = velocityAt(pPrev * uFlow, t);
      vec2 dk = vk / max(length(vk), 1e-5);
      vec2 pMid = pPrev + dk * (0.5 * ds);
      vec2 vm = velocityAt(pMid * uFlow, t);
      vec2 dm = vm / max(length(vm), 1e-5);
      vec2 pNext = pPrev + dm * ds;

      // distance from uv to segment [pPrev, pNext]
      vec2  pa = uv - pPrev, ba = pNext - pPrev;
      float h  = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      float d  = length(pa - ba * h);
      float s  = (arc + h * ds) / lineLen;     // arc param: 0 at base, 1 at tip
      if (d < best) { best = d; bestS = s; }
      arc += ds; pPrev = pNext;
    }

    // --- Flux fragment shading: head-bright / tail-faded + AA edge ---
    float fade = smoothstep(LINE_BEGIN_OFFSET, 1.0, bestS);   // tail fades out
    float aa   = fwidth(best) + 1e-5;
    float edge = 1.0 - smoothstep(halfW - aa, halfW, best);   // soft width edge
    float alpha = boost * fade * edge;                        // opacity ~ speed*fade*edge
    if (alpha <= 0.0) continue;

    // --- endpoint bead (Flux draw_endpoints): extra glow near the tip ---
    float head = smoothstep(0.8, 1.0, bestS);
    alpha += 0.6 * head * edge * boost;

    // --- additive accumulation (Flux SrcAlpha, One) ---
    vec3 lc = lineColor(v0);
    accum  += alpha;
    colSum += lc * alpha;
  }

  tint = (accum > 0.0) ? colSum / accum : vec3(0.0);
  return accum;                                 // additive brightness on black
}
```

### 6.5 Main / compositing

```glsl
void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2  uv = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);   // aspect-corrected, centred
  float t  = uTime * uSpeed;

  vec3  tint;
  float b = streakField(uv, t, tint);          // additive streak brightness + hue

  // black background; additive streaks. Optional: gentle tone-map so dense
  // overlaps bloom to near-white like Flux's additive stack.
  vec3 col = uSky + tint * b * uGlow;
  col = col / (col + 0.85);                     // Reinhard-ish soft clamp (optional)
  col = pow(col, vec3(0.85));                   // mild gamma lift (optional)
  gl_FragColor = vec4(col + dither(gl_FragCoord.xy), 1.0);
}
```

### 6.6 Mapping Flux uniforms → Noctura uniforms

| Flux | default | Noctura uniform | suggested default |
|---|---|---|---|
| `grid_spacing` 15px | dense | `uGrid` (columns) | 72–96 |
| `line_length` 450 | long | `LINE_LENGTH` (cells) | 6 (raise for longer streaks) |
| `line_width` 9 | thin | `LINE_WIDTH` (half, cells) | 0.30 |
| `line_begin_offset` 0.4 | tail fade | `LINE_BEGIN_OFFSET` | 0.4 |
| `line_variance` 0.55 | jitter | `LINE_VARIANCE` | 0.55 |
| `width_boost 2.5·|v|` | speed→width | `SPEED_GAIN` | 2.5 |
| noise octaves 2.8/15/30 @ .001/.006/.012 | flow field | `streamPsi` scales/time | 0.9/2.4/4.8 @ .05/.12/.20 |
| `noise_multiplier` 0.45 | force | overall field amplitude | tune so typical `boost∈[0.2,0.9]` |
| additive blend | bloom | accumulate + soft tone-map | as in §6.5 |
| view_scale 1.6 | zoom | `uFlow` (inverse) | 2.0–3.0 |

### 6.7 Performance notes

- Cost ≈ `(2·SEARCH+1)² × KSTEPS × 4` noise evals/pixel. With SEARCH=4, KSTEPS=5
  that's ~1620 `snoise` calls worst-case — but the **`boost<0.01` early-out** and
  **AABB reject** cut it to a handful of active basepoints in calm/empty regions.
- If too slow: lower `uGrid`, drop `SEARCH` to 3, `KSTEPS` to 4, precompute
  `velocityAt` per basepoint once (hoist `v0`/`speed` out — already done), or
  approximate `streamPsi` with 2 octaves.
- `fwidth(best)` gives resolution-correct AA for the tube edge — keep it.

---

## 7. What we deliberately drop vs. Flux (and how close it still looks)

| Flux feature | Stateless port | Visual cost |
|---|---|---|
| Real Navier–Stokes flow | curl of evolving multi-octave noise | Low — both are slow divergence-free swirl. Flux's advection "coral wriggle" is slightly richer; multi-octave noise is a good stand-in. |
| Damped-spring endpoint (inertia, overshoot) | streamlines from a slowly-evolving field | Medium — we lose lag/overshoot; recovered partly by slow time evolution. Streamlines actually **curve with the flow**, which straight Flux lines do not — arguably nicer. |
| Persistent per-line color spring | color by velocity per pixel | Low — colors still coherent per region; they just don't ease over time. |
| ~8000 instanced quads | per-pixel neighbourhood gather | Perf, not looks — identical image if neighbourhood + additive are correct. |
| Endpoint sprite bead | `head` glow term in §6.4 | Low — approximated. |

The two non-negotiables that make it read as Flux and not as the failed
grid-stamp: **(1) streamlines long enough to overlap + additive accumulation**,
and **(2) width/opacity that collapse to zero in calm water**. Get those right
first; everything else is polish.

---

## 8. Sources

- Flux source (read directly): https://github.com/sandydoo/flux —
  `flux/src/{flux,grid,settings}.rs`, `flux/src/render/{fluid,lines,noise,color}.rs`,
  `flux/shader/*.wgsl`.
- [Flux — open-source tribute to the macOS Drift screensaver](https://flux.sandydoo.me/)
- [Flux (Gumroad build)](https://sandydoo.gumroad.com/l/flux)
- [GPU Gems 3, Ch. 38 — Fast Fluid Dynamics Simulation on the GPU](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu) (Stam Stable Fluids reference the solver follows)
- [Fluid Simulation for Dummies (mikeash)](https://mikeash.com/pyblog/fluid-simulation-for-dummies.html)
- [Fluid Simulation in WebGL: the Advection Step](https://ostefani.dev/tech-notes/webgl-fluid-advection)
- [Beautiful Streamlines for Visualizing 2D Vector Fields](https://www.allnans.com/jekyll/update/2018/04/04/beautiful-streamlines.html)
- [Illustration of Streamlines, Streaklines and Pathlines (MIT)](https://web.mit.edu/fluids-modules/www/potential_flows/LecturesHTML/lec02/tutorial/tutorial-spsl.html)
- [2D Navier–Stokes (VisualPDE)](https://visualpde.com/fluids/navier_stokes.html)
```
