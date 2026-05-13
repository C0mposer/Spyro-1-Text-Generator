import * as THREE from 'three';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

// Spyro text renderer
const DATA = window.SPYRO_DATA;
const GLYPHS = DATA.glyphs;
const PALETTE = DATA.colors;
const URL_PARAMS = new URLSearchParams(window.location.search);
const OBS_MODE = URL_PARAMS.get('obs') === '1';

if (OBS_MODE) {
  document.body.classList.add('obs-mode');
}

// Default in-game color is yellow: RGB 96,96,0
let currentColorIdx = 11;
let toggleLetterWobble = true;
let toggleShimmer = true;
let wobbleSpeedVal = 1;
let wobbleIntensityVal = 3;
let wobbleDelayVal = 16;
let shimmerSpeedVal = 4 / 5;
let shimmerIntensityVal = 1;
let stretchXVal = 1;
let stretchYVal = 1;

// scene setup
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();


const camera = new THREE.OrthographicCamera(-100, 100, 70, -70, -1000, 5000);
camera.position.set(0, 0, 500);
camera.lookAt(0, 0, 0);

let currentText = 'HELLO WORLD!';
function resize() {
  const r = canvas.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  // Recompute camera distance for current text whenever aspect changes
  if (typeof rebuildText === 'function') {
    refitCamera();
  }
}
window.addEventListener('resize', resize);

// Glyph geometry
function buildGlyphGeometry(glyph) {
  const positions = [];
  const normals   = [];
  const faceIndices = [];

  let vertCount = 0;

  //   Coordinate remap
  //   glyph.Y  -> world.X
  //   glyph.-Z -> world.Y
  //   glyph.X  -> world.Z
  function remapVert(v) {
    return [ v[1], -v[2], v[0] ];
  }
  function remapNormal(nx, ny, nz) {
    return [ ny, -nz, nx ];
  }

  // Choose winding (a,b,c) or (a,c,b)
  function pushTri(a, b, c, n) {
    const idxBase = vertCount;
    // Compute (b-a) Ã— (c-a)
    const e1x = b[0]-a[0], e1y = b[1]-a[1], e1z = b[2]-a[2];
    const e2x = c[0]-a[0], e2y = c[1]-a[1], e2z = c[2]-a[2];
    const gx = e1y*e2z - e1z*e2y;
    const gy = e1z*e2x - e1x*e2z;
    const gz = e1x*e2y - e1y*e2x;
    const dot = gx*n[0] + gy*n[1] + gz*n[2];
    // If dot < 0, the winding produces an opposing normal, so swap b and c.
    const tri = (dot >= 0) ? [a, b, c] : [a, c, b];
    for (const v of tri) {
      positions.push(v[0], v[1], v[2]);
      normals.push(n[0], n[1], n[2]);
    }
    faceIndices.push(idxBase, idxBase + 1, idxBase + 2);
    vertCount += 3;
  }

  for (const f of glyph.faces) {
    const v0 = remapVert(glyph.verts[f.v0]);
    const v1 = remapVert(glyph.verts[f.v1]);
    const v2 = remapVert(glyph.verts[f.v2]);
    const v3 = remapVert(glyph.verts[f.v3]);

    let [nx, ny, nz] = remapNormal(f.nx || 0, f.ny || 0, f.nz || 0);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const n = [nx, ny, nz];

    if (f.tri) {
      pushTri(v0, v1, v2, n);
    } else {
      pushTri(v0, v1, v2, n);
      pushTri(v1, v3, v2, n);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setIndex(faceIndices);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

// Pre-build geometry cache
const glyphGeomCache = {};
for (const [ch, g] of Object.entries(GLYPHS)) {
  glyphGeomCache[ch] = buildGlyphGeometry(g);
}

// Custom shader to faithfully reproduce the shimmer
const flatLitMat = new THREE.ShaderMaterial({

  side: THREE.DoubleSide,
  uniforms: {
    baseColor:    { value: new THREE.Vector3(96/255, 96/255, 0/255) },
    lightGain:    { value: 1.0 },
    intensity:    { value: 10.0 / 16.0 },
    lightDir:     { value: new THREE.Vector3(0, -0.25, 1) },
    ambient:      { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec3 vNormal;
    void main() {
      // We apply lighting in local space because the
      // light is logically attached to the world, not to each letter's rotation.
      // But we do want the light to be in *world* space so per-letter
      // rotations affect shading too. Convert to world space via modelMatrix.
      vNormal = normalize( mat3(modelMatrix) * normal );
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3 baseColor;
    uniform float intensity;
    uniform float lightGain;
    uniform vec3 lightDir;
    uniform float ambient;
    varying vec3 vNormal;

    void main() {
      // Two-sided lighting: faces facing the light go brighter. The real GTE
      // path keeps signed intermediate values long enough for faces to dip
      // below the palette back color before final clamp, which creates the
      // brief darker shadow pulse seen during stronger shimmer.
      // Spyro feeds a non-unit light vector into the GTE color matrix:
      // X ~= 0.97, Y = -0.25, Z ~= 1.55. Keeping that unequal scale gives the
      // broad moving shadow/shine sweep that a normalized dot product loses.
      float rawLight = dot(normalize(vNormal), lightDir);
      float d = max(0.0, rawLight);
      float shadow = clamp(-rawLight, 0.0, 1.35);

      // The palette color is the back color, and the light
      // adds a white component scaled by the palette's high nibble.
      float lit = d * intensity * lightGain * 0.72;
      float shade = shadow * intensity * 0.38;

      // Compose: base + lit-by-normal white component, with signed shadow
      // reducing the base color on faces opposite the moving light.
      vec3 col = baseColor * (1.0 - shade) + vec3(lit) + vec3(ambient);

      // Clamp to display range
      gl_FragColor = vec4(clamp(col, vec3(0.0), vec3(1.0)), 1.0);
    }
  `,
});

// Text layout
const textRoot = new THREE.Group();
scene.add(textRoot);

const letterMeshes = []; // each entry: { mesh, charIdx, baseRotY }

// DrawTextAll() in Spyro 1 commonly uses 0x10/0x12 spacing. With a  corrected browser
// projection, this better matches the separated PS1 HUD text 
const SPACING = 61;
const SPACE_SPACING = SPACING * 0.75;
const LETTER_SCALE = 1.0;

let currentTotalWidth = 100;
function fitCameraToAspect(aspect, pad = OBS_MODE ? 1.08 : 1) {
  const letterHeight = 70 * stretchYVal;
  const inscriptionWidth = (currentTotalWidth * stretchXVal + 30) * pad;
  const targetW = inscriptionWidth * 1.12;
  const targetH = letterHeight * (pad > 1 ? 1.22 : 1.45);
  let viewW = targetW;
  let viewH = targetW / aspect;
  if (viewH < targetH) {
    viewH = targetH;
    viewW = viewH * aspect;
  }
  camera.left = -viewW / 2;
  camera.right = viewW / 2;
  camera.top = viewH / 2;
  camera.bottom = -viewH / 2;
  camera.position.set(0, 0, 500);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}

function refitCamera() {
  const r = canvas.getBoundingClientRect();
  const aspect = Math.max(0.1, r.width / Math.max(1, r.height));
  fitCameraToAspect(aspect);
}

function rebuildText(str) {
  // Remove old meshes
  while (textRoot.children.length) {
    const m = textRoot.children.pop();
    if (m.geometry) m.geometry.dispose && m.geometry.dispose();
  }
  letterMeshes.length = 0;

  const upper = str.toUpperCase();

  // Lay out characters left to right.
  let cursorX = 0;
  const positionsX = [];
  for (let i = 0; i < upper.length; i++) {
    const ch = upper[i];
    if (ch === ' ') {
      positionsX.push(null);
      cursorX += SPACE_SPACING;
    } else if (glyphGeomCache[ch]) {
      positionsX.push(cursorX);
      cursorX += SPACING;
    } else {
      positionsX.push(null);
      cursorX += SPACING * 0.6;
    }
  }

  // Center the string horizontally
  const totalW = Math.max(SPACING, cursorX - SPACING);
  const offsetX = -totalW / 2;
  currentTotalWidth = totalW;

  // Build meshes
  for (let i = 0; i < upper.length; i++) {
    const ch = upper[i];
    const x = positionsX[i];
    if (x === null) continue;
    const geom = glyphGeomCache[ch];
    if (!geom) continue;
    const mesh = new THREE.Mesh(geom, flatLitMat);
    mesh.position.set(offsetX + x, 0, 0);
    mesh.userData.charIdx = i;
    textRoot.add(mesh);
    letterMeshes.push({ mesh, charIdx: i, baseRotY: 0 });
  }

  textRoot.scale.set(stretchXVal, stretchYVal, 1);
  refitCamera();
}

// Color application
function applyColor(idx) {
  const c = PALETTE[idx];
  if (!c) return;
  flatLitMat.uniforms.baseColor.value.set(c.r / 255, c.g / 255, c.b / 255);
  // unk1 is the "shininess" factor â€” 0..15. Map to a shading gain.
  flatLitMat.uniforms.intensity.value = (c.unk1 || 0) / 16;
  currentColorIdx = idx;

  // Update palette swatch UI
  document.querySelectorAll('.swatch').forEach(s => {
    s.classList.toggle('active', parseInt(s.dataset.idx) === idx);
  });
  const label = document.getElementById('colorLabel');
  const hex = '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('');
  label.textContent = `idx ${idx} Â· RGB(${c.r},${c.g},${c.b}) ${hex}${c.unk1 ? ` Â· gain=${c.unk1}` : ''}`;
}

function parseHexColor(hex) {
  const clean = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function applyColorHex(hex) {
  const c = parseHexColor(hex);
  if (!c) return;
  flatLitMat.uniforms.baseColor.value.set(c.r / 255, c.g / 255, c.b / 255);
  currentColorIdx = null;

  const normalized = '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('');
  document.getElementById('colorLabel').textContent =
    `${normalized.toUpperCase()} Â· RGB(${c.r},${c.g},${c.b})`;
}

function setShimmerIntensity(percent) {
  shimmerIntensityVal = Math.max(0, Math.min(4, percent / 50));
  document.getElementById('shimmerIntensityVal').textContent = `${Math.round(percent)}%`;
}

function setWobbleIntensity(percent) {
  wobbleIntensityVal = Math.max(0, Math.min(6, percent * 3 / 100));
  document.getElementById('wobbleIntensityVal').textContent = `${Math.round(percent)}%`;
}

function setWobbleDelay(value) {
  wobbleDelayVal = Math.max(0, Math.min(24, value * (16 / 7)));
  document.getElementById('wobbleDelayVal').textContent = formatSliderValue(value);
}

function setStretchX(percent) {
  stretchXVal = Math.max(0.25, Math.min(2, percent / 100));
  document.getElementById('stretchXVal').textContent = `${Math.round(percent)}%`;
  textRoot.scale.x = stretchXVal;
  refitCamera();
}

function setStretchY(percent) {
  stretchYVal = Math.max(0.25, Math.min(2, percent / 100));
  document.getElementById('stretchYVal').textContent = `${Math.round(percent)}%`;
  textRoot.scale.y = stretchYVal;
  refitCamera();
}

function formatSliderValue(value) {
  return Number.isInteger(Number(value)) ? `${Math.round(value)}` : Number(value).toFixed(1);
}

function paramNumber(name, fallback, min, max) {
  if (!URL_PARAMS.has(name)) return fallback;
  const n = Number(URL_PARAMS.get(name));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function paramBool(name, fallback) {
  if (!URL_PARAMS.has(name)) return fallback;
  const value = URL_PARAMS.get(name);
  return value === '1' || value === 'true';
}

function applyUrlParamsToControls() {
  const textInput = document.getElementById('textInput');
  const colorInput = document.getElementById('glyphColor');
  const wobbleInput = document.getElementById('toggleLetterWobble');
  const shimmerInput = document.getElementById('toggleShimmer');

  if (URL_PARAMS.has('text')) textInput.value = URL_PARAMS.get('text').slice(0, 32);
  if (URL_PARAMS.has('color')) {
    const raw = URL_PARAMS.get('color').replace('#', '');
    if (/^[0-9a-fA-F]{6}$/.test(raw)) colorInput.value = `#${raw}`;
  }

  wobbleInput.checked = paramBool('wobble', wobbleInput.checked);
  shimmerInput.checked = paramBool('shimmer', shimmerInput.checked);

  document.getElementById('wobbleSpeed').value =
    paramNumber('wobbleSpeed', Number(document.getElementById('wobbleSpeed').value), 0, 10);
  document.getElementById('wobbleIntensity').value =
    paramNumber('wobbleIntensity', Number(document.getElementById('wobbleIntensity').value), 0, 200);
  document.getElementById('wobbleDelay').value =
    paramNumber('wobbleDelay', Number(document.getElementById('wobbleDelay').value), 0, 10);
  document.getElementById('shimmerSpeed').value =
    paramNumber('shimmerSpeed', Number(document.getElementById('shimmerSpeed').value), 0, 10);
  document.getElementById('shimmerIntensity').value =
    paramNumber('shimmerIntensity', Number(document.getElementById('shimmerIntensity').value), 0, 200);
  document.getElementById('stretchX').value =
    paramNumber('stretchX', Number(document.getElementById('stretchX').value), 25, 200);
  document.getElementById('stretchY').value =
    paramNumber('stretchY', Number(document.getElementById('stretchY').value), 25, 200);
}

function syncStateFromControls() {
  const textInput = document.getElementById('textInput');
  const colorInput = document.getElementById('glyphColor');

  toggleLetterWobble = document.getElementById('toggleLetterWobble').checked;
  toggleShimmer = document.getElementById('toggleShimmer').checked;

  wobbleSpeedVal = Number(document.getElementById('wobbleSpeed').value) / 5;
  document.getElementById('wobbleSpeedVal').textContent = document.getElementById('wobbleSpeed').value;
  setWobbleIntensity(Number(document.getElementById('wobbleIntensity').value));
  setWobbleDelay(Number(document.getElementById('wobbleDelay').value));
  shimmerSpeedVal = Number(document.getElementById('shimmerSpeed').value) / 5;
  document.getElementById('shimmerSpeedVal').textContent = document.getElementById('shimmerSpeed').value;
  setShimmerIntensity(Number(document.getElementById('shimmerIntensity').value));
  setStretchX(Number(document.getElementById('stretchX').value));
  setStretchY(Number(document.getElementById('stretchY').value));

  applyColorHex(colorInput.value);
  rebuildText(textInput.value);
}

function buildObsLink() {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('obs', '1');
  url.searchParams.set('text', document.getElementById('textInput').value);
  url.searchParams.set('color', document.getElementById('glyphColor').value.replace('#', ''));
  url.searchParams.set('wobble', document.getElementById('toggleLetterWobble').checked ? '1' : '0');
  url.searchParams.set('shimmer', document.getElementById('toggleShimmer').checked ? '1' : '0');
  url.searchParams.set('wobbleSpeed', document.getElementById('wobbleSpeed').value);
  url.searchParams.set('wobbleIntensity', document.getElementById('wobbleIntensity').value);
  url.searchParams.set('wobbleDelay', document.getElementById('wobbleDelay').value);
  url.searchParams.set('shimmerSpeed', document.getElementById('shimmerSpeed').value);
  url.searchParams.set('shimmerIntensity', document.getElementById('shimmerIntensity').value);
  url.searchParams.set('stretchX', document.getElementById('stretchX').value);
  url.searchParams.set('stretchY', document.getElementById('stretchY').value);
  return url.toString();
}

async function copyObsLink() {
  const status = document.getElementById('copyStatus');
  const link = buildObsLink();
  try {
    await navigator.clipboard.writeText(link);
    status.textContent = 'Browser Source Copied';
  } catch {
    const ta = document.createElement('textarea');
    ta.value = link;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    status.textContent = 'Browser Source Copied';
  }
}

const PRESETS = {
  accurate: {
    wobbleSpeed: 9,
    wobbleIntensity: 80,
    wobbleDelay: 10,
    shimmerSpeed: 4,
    shimmerIntensity: 65,
    stretchX: 100,
    stretchY: 100,
    wobble: true,
    shimmer: true,
  },
  subtle: {
    wobbleSpeed: 5,
    wobbleIntensity: 60,
    wobbleDelay: 10,
    shimmerSpeed: 4,
    shimmerIntensity: 65,
    stretchX: 100,
    stretchY: 100,
    wobble: true,
    shimmer: true,
  },
};

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  document.getElementById('toggleLetterWobble').checked = p.wobble;
  document.getElementById('toggleShimmer').checked = p.shimmer;
  document.getElementById('wobbleSpeed').value = p.wobbleSpeed;
  document.getElementById('wobbleIntensity').value = p.wobbleIntensity;
  document.getElementById('wobbleDelay').value = p.wobbleDelay;
  document.getElementById('shimmerSpeed').value = p.shimmerSpeed;
  document.getElementById('shimmerIntensity').value = p.shimmerIntensity;
  document.getElementById('stretchX').value = p.stretchX;
  document.getElementById('stretchY').value = p.stretchY;
  syncStateFromControls();
}

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}

function lcm(a, b) {
  return Math.abs(a * b) / gcd(a, b);
}

function loopFramesForSpeed(sliderValue, fps) {
  const speed = Math.max(0, Math.round(Number(sliderValue)));
  if (speed === 0) return 1;
  const denom = 32 * fps;
  const numer = 3 * speed;
  return denom / gcd(numer, denom);
}

function computeLoopFrameCount(fps) {
  const counts = [];
  if (toggleLetterWobble) counts.push(loopFramesForSpeed(document.getElementById('wobbleSpeed').value, fps));
  if (toggleShimmer) counts.push(loopFramesForSpeed(document.getElementById('shimmerSpeed').value, fps));
  if (counts.length === 0) return fps;
  return counts.reduce((acc, n) => lcm(acc, n), 1);
}

function frameDelayMs(fps) {
  return Math.round(1000 / fps);
}

function exportFileName() {
  const text = document.getElementById('textInput').value.trim() || 'spyro-text';
  const safe = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `${safe || 'spyro-text'}.gif`;
}

async function exportGif() {
  if (exportingGif) return;

  const status = document.getElementById('gifStatus');
  const button = document.getElementById('exportGif');
  const fps = Number(document.getElementById('gifFps').value);
  const totalFrames = computeLoopFrameCount(fps);
  const delay = frameDelayMs(fps);

  const rect = canvas.getBoundingClientRect();
  const aspect = Math.max(0.1, rect.width / Math.max(1, rect.height));
  const requestedWidth = Number(document.getElementById('gifWidth').value) || 1080;
  const width = Math.max(2, Math.round(requestedWidth));
  const height = Math.max(2, Math.round(width / aspect));

  const oldPixelRatio = renderer.getPixelRatio();
  const oldSize = new THREE.Vector2();
  renderer.getSize(oldSize);
  const oldWobblePhase = wobblePhase;
  const oldShimmerPhase = shimmerPhase;

  const captureCanvas = document.createElement('canvas');
  captureCanvas.width = width;
  captureCanvas.height = height;
  const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });
  const sampleStride = Math.max(1, Math.floor(Math.sqrt(totalFrames / 30)));
  const sampledPixels = [];
  const crop = { minX: width, minY: height, maxX: -1, maxY: -1 };

  function includeOpaqueBounds(image) {
    const data = image.data;
    for (let y = 0; y < image.height; y++) {
      const row = y * image.width * 4;
      for (let x = 0; x < image.width; x++) {
        if (data[row + x * 4 + 3] > 12) {
          if (x < crop.minX) crop.minX = x;
          if (y < crop.minY) crop.minY = y;
          if (x > crop.maxX) crop.maxX = x;
          if (y > crop.maxY) crop.maxY = y;
        }
      }
    }
  }

  function paddedCropRect() {
    if (crop.maxX < crop.minX || crop.maxY < crop.minY) {
      return { x: 0, y: 0, w: width, h: height };
    }
    const pad = Math.max(10, Math.round(Math.min(width, height) * 0.035));
    const x = Math.max(0, crop.minX - pad);
    const y = Math.max(0, crop.minY - pad);
    const right = Math.min(width - 1, crop.maxX + pad);
    const bottom = Math.min(height - 1, crop.maxY + pad);
    return { x, y, w: right - x + 1, h: bottom - y + 1 };
  }

  function cropImageData(rect) {
    return captureCtx.getImageData(rect.x, rect.y, rect.w, rect.h);
  }

  function renderExportFrame(i) {
    const wobbleSlider = Number(document.getElementById('wobbleSpeed').value);
    const shimmerSlider = Number(document.getElementById('shimmerSpeed').value);
    const t = i / fps;
    const exportWobblePhase = (24 * wobbleSlider * t) % 256;
    const exportShimmerPhase = (24 * shimmerSlider * t) % 256;

    updateShimmerAtPhase(exportShimmerPhase);
    updateWobbleAtPhase(exportWobblePhase);
    renderer.render(scene, camera);

    captureCtx.clearRect(0, 0, width, height);
    captureCtx.drawImage(renderer.domElement, 0, 0, width, height);
    return captureCtx.getImageData(0, 0, width, height);
  }

  exportingGif = true;
  button.disabled = true;
  status.textContent = `Building GIF palette at ${fps} FPS...`;

  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    fitCameraToAspect(width / height, 1.35);

    for (let i = 0; i < totalFrames; i++) {
      const image = renderExportFrame(i);
      includeOpaqueBounds(image);
      for (let p = 0; p < image.data.length; p += 4 * sampleStride) {
        if (image.data[p + 3] > 127) {
          sampledPixels.push(image.data[p], image.data[p + 1], image.data[p + 2], 255);
        }
      }
      if (i % 12 === 0 || i === totalFrames - 1) {
        status.textContent = `Sampling loop ${i + 1}/${totalFrames}...`;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    const cropRect = paddedCropRect();
    if (sampledPixels.length === 0) {
      sampledPixels.push(0, 0, 0, 255);
    }

    const opaquePalette = quantize(new Uint8Array(sampledPixels), 255, {
      format: 'rgb565',
    });
    const palette = [[0, 0, 0], ...opaquePalette];
    const transparentIndex = 0;
    const gif = GIFEncoder();

    for (let i = 0; i < totalFrames; i++) {
      renderExportFrame(i);
      const image = cropImageData(cropRect);
      const index = applyPalette(image.data, palette, 'rgb565');
      for (let p = 0, idx = 0; p < image.data.length; p += 4, idx++) {
        if (image.data[p + 3] <= 127) index[idx] = transparentIndex;
      }

      const frameOptions = {
        delay,
        repeat: 0,
        transparent: true,
        transparentIndex,
        dispose: 2,
      };
      if (i === 0) frameOptions.palette = palette;
      gif.writeFrame(index, cropRect.w, cropRect.h, frameOptions);

      if (i % 8 === 0 || i === totalFrames - 1) {
        status.textContent = `Encoding ${i + 1}/${totalFrames} frames...`;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    gif.finish();
    const blob = new Blob([gif.bytes()], { type: 'image/gif' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = exportFileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    status.textContent = `GIF exported (${cropRect.w}x${cropRect.h}, ${totalFrames} frames).`;
  } catch (error) {
    console.error(error);
    status.textContent = 'GIF export failed.';
  } finally {
    wobblePhase = oldWobblePhase;
    shimmerPhase = oldShimmerPhase;
    renderer.setPixelRatio(oldPixelRatio);
    renderer.setSize(oldSize.x, oldSize.y, false);
    refitCamera();
    updateShimmerAtPhase(shimmerPhase);
    updateWobbleAtPhase(wobblePhase);
    renderer.render(scene, camera);
    exportingGif = false;
    button.disabled = false;
    lastTickMs = null;
  }
}

// Animation
// It ticks at ~60fps and increment two phase counters at independently
// configurable speeds. The original game runs at 30fps, so we halve
// our internal speed so the visual feel matches.

let frame = 0;
let shimmerPhase = 0;
let wobblePhase = 0;
let lastTickMs = null;
let exportingGif = false;
const ANIMATION_RATE_COMPENSATION = 2;
const TEXT_WOBBLE_RAD_PER_BYTE = (Math.PI * 2) / 256;
const TEXT_WOBBLE_MAX_BYTE = 8;
const STATIC_LIGHT = new THREE.Vector3(0.6, -0.25, 1.0);
const ANIMATED_LIGHT = new THREE.Vector3();

function sineWave4096(index) {
  return Math.round(Math.sin(((index & 0xff) / 256) * Math.PI * 2) * 4096);
}

function drawTextWobbleByte(phase) {
  // DemoModeText:
  //   byte46 = (ushort)sineWaveArray[((timer*4 + glyphPhase) & 0xff) + 0x40] >> 9
  // The original ps1 MIPS code uses a lhu + logical shift, so the negative half of the
  // sine becomes 120..127 rather than -8..-1.
  const lookup = (phase + 0x40) & 0xff;
  return ((sineWave4096(lookup) & 0xffff) >>> 9) & 0xff;
}

function signedDrawTextWobbleByte(byteValue) {
  // DrawShadedMobys() treats byte 0x46 as a wrapped 0..255 angle index. For the
  // tiny DrawText wobble range, values 120..127 are the negative half-cycle.
  // Mapping them back to -8..-1 gives a symmetric left/right yaw in Three.js.
  return byteValue >= 0x40 ? byteValue - 0x80 : byteValue;
}

function drawTextWobbleAngle(phase) {
  // Same curve as DrawText's byte 0x46 source, but smooth. The real byte path
  // is quantized to whole sine-table steps. We need sub-step
  // delays so the start ripple is visible without turning the word into a
  // large spatial wave.
  const wave = Math.sin(((phase + 0x40) / 256) * Math.PI * 2);
  return wave * TEXT_WOBBLE_MAX_BYTE * TEXT_WOBBLE_RAD_PER_BYTE;
}

function updateShimmerAtPhase(phase) {
  if (toggleShimmer) {
    const theta = (phase / 256) * Math.PI * 2;
    const lx = Math.cos(theta) * 0.97;
    const ly = -0.25;
    const lz = Math.sin(theta) * 1.55;
    ANIMATED_LIGHT.set(lx, ly, lz);
    flatLitMat.uniforms.lightDir.value
      .copy(STATIC_LIGHT)
      .lerp(ANIMATED_LIGHT, shimmerIntensityVal);
  } else {
    flatLitMat.uniforms.lightDir.value.copy(STATIC_LIGHT);
  }
}

function updateWobbleAtPhase(phase) {
  if (toggleLetterWobble) {
    for (let i = 0; i < letterMeshes.length; i++) {
      const lm = letterMeshes[i];
      const letterPhase = phase - i * wobbleDelayVal;
      const tilt = drawTextWobbleAngle(letterPhase) * wobbleIntensityVal;
      lm.mesh.rotation.y = tilt;
      lm.mesh.rotation.z = 0;
    }
  } else {
    for (let i = 0; i < letterMeshes.length; i++) {
      letterMeshes[i].mesh.rotation.y = 0;
      letterMeshes[i].mesh.rotation.z = 0;
    }
  }
}

function tick(t) {
  if (exportingGif) {
    requestAnimationFrame(tick);
    return;
  }

  resize();

  // Advance by elapsed time instead of rendered frames. OBS browser sources can
  // render at a lower cadence than a normal browser tab; this keeps animation
  // speed consistent when frames are missed.
  const dtScale = (lastTickMs == null ? 1 : Math.min(4, Math.max(0, (t - lastTickMs) / (1000 / 60)))) *
    ANIMATION_RATE_COMPENSATION;
  lastTickMs = t;
  frame += 0.5 * dtScale;

  if (toggleShimmer) shimmerPhase = (shimmerPhase + shimmerSpeedVal * dtScale) % 256;
  if (toggleLetterWobble) wobblePhase = (wobblePhase + wobbleSpeedVal * dtScale) % 256;

  updateShimmerAtPhase(shimmerPhase);
  updateWobbleAtPhase(wobblePhase);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
// UI
function buildSwatches() {
  const root = document.getElementById('swatches');
  PALETTE.forEach((c, i) => {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    const hex = `rgb(${c.r}, ${c.g}, ${c.b})`;
    sw.style.background = hex;
    sw.dataset.idx = String(i);
    sw.title = `idx ${i}`;
    sw.addEventListener('click', () => applyColor(i));
    if (c.unk1 > 0) {
      const dot = document.createElement('div');
      dot.style.cssText = 'position:absolute;top:2px;right:2px;width:3px;height:3px;background:white;border-radius:50%;opacity:0.6;';
      sw.appendChild(dot);
    }
    root.appendChild(sw);
  });
}

function buildPresets() {
  const root = document.getElementById('presets');
  const presets = ['SPYRO', 'DEMO MODE', 'PRESS START', 'GAME OVER', 'YEAR OF THE DRAGON', '100%'];
  presets.forEach(p => {
    const b = document.createElement('span');
    b.className = 'preset';
    b.textContent = p;
    b.addEventListener('click', () => {
      document.getElementById('textInput').value = p;
      rebuildText(p);
    });
    root.appendChild(b);
  });
}

// Input handlers
document.getElementById('textInput').addEventListener('input', e => {
  rebuildText(e.target.value);
});

document.getElementById('glyphColor').addEventListener('input', e => {
  applyColorHex(e.target.value);
});

document.getElementById('toggleLetterWobble').addEventListener('change', e => {
  toggleLetterWobble = e.target.checked;
});

document.getElementById('toggleShimmer').addEventListener('change', e => {
  toggleShimmer = e.target.checked;
});

document.getElementById('wobbleSpeed').addEventListener('input', e => {
  wobbleSpeedVal = parseInt(e.target.value) / 5;
  document.getElementById('wobbleSpeedVal').textContent = e.target.value;
});

document.getElementById('wobbleIntensity').addEventListener('input', e => {
  setWobbleIntensity(parseInt(e.target.value));
});

document.getElementById('wobbleDelay').addEventListener('input', e => {
  setWobbleDelay(Number(e.target.value));
});

document.getElementById('stretchX').addEventListener('input', e => {
  setStretchX(parseInt(e.target.value));
});

document.getElementById('stretchY').addEventListener('input', e => {
  setStretchY(parseInt(e.target.value));
});

document.getElementById('shimmerSpeed').addEventListener('input', e => {
  shimmerSpeedVal = parseInt(e.target.value) / 5;
  document.getElementById('shimmerSpeedVal').textContent = e.target.value;
});

document.getElementById('shimmerIntensity').addEventListener('input', e => {
  setShimmerIntensity(parseInt(e.target.value));
});

document.getElementById('copyObsLink').addEventListener('click', copyObsLink);
document.getElementById('exportGif').addEventListener('click', exportGif);

document.querySelectorAll('[data-preset]').forEach(button => {
  button.addEventListener('click', () => applyPreset(button.dataset.preset));
});

// Setup
applyUrlParamsToControls();
syncStateFromControls();
resize();
requestAnimationFrame(tick);

// Hide the loader
setTimeout(() => document.getElementById('loading').classList.add('hide'), 400);
