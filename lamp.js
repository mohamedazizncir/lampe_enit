// Couche d'acces a la lampe + lecteur de sequences (scenes) annulable
const Lifx = require('node-lifx-lan');

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function createLamp({ ip, mac }) {
  let dev = null;
  const get = async () => (dev ||= await Lifx.createDevice({ ip, mac }));

  // ---------- Scene en cours ----------
  let scene = null; // { id, name, cancelled }
  let sceneId = 0;

  function stopScene() {
    if (scene) scene.cancelled = true;
    scene = null;
  }

  // Couleur "humaine" (hue 0-360, sat/bri 0-100) -> LIFX (0-1)
  function toLifx(c, base) {
    return {
      hue: c.hue !== undefined ? (clamp(c.hue, 0, 360) % 360) / 360 : base.hue,
      saturation: c.saturation !== undefined ? clamp(c.saturation, 0, 100) / 100 : base.saturation,
      brightness: c.brightness !== undefined ? clamp(c.brightness, 0, 100) / 100 : base.brightness,
      kelvin: c.kelvin !== undefined ? Math.round(clamp(c.kelvin, 1500, 9000)) : base.kelvin
    };
  }

  async function state() {
    const d = await get();
    const s = await d.lightGet();
    return {
      label: s.label,
      power: s.power === 1,
      hue: Math.round(s.color.hue * 360),
      saturation: Math.round(s.color.saturation * 100),
      brightness: Math.round(s.color.brightness * 100),
      kelvin: s.color.kelvin,
      scene: scene ? scene.name : null
    };
  }

  async function power(on, duration = 300) {
    const d = await get();
    await d.lightSetPower({ level: on ? 1 : 0, duration });
  }

  // Change seulement les champs fournis, garde le reste
  async function setColor(c, duration = 200) {
    const d = await get();
    const { color } = await d.lightGet();
    const target = toLifx(c, color);
    await d.lightSetColor({ color: target, duration: Math.round(clamp(duration, 0, 600000)) });
    return target;
  }

  async function waveform({ type = 'pulse', hue, saturation, brightness, kelvin, period_ms = 1000, cycles = 100000, skew = 0.5 }) {
    const d = await get();
    const { color } = await d.lightGet();
    const types = { saw: 0, sine: 1, half_sine: 2, triangle: 3, pulse: 4 };
    await d.lightSetPower({ level: 1, duration: 0 });
    await d.lightSetWaveform({
      transient: 1,
      color: toLifx({ hue, saturation, brightness, kelvin }, color),
      period: Math.round(clamp(period_ms, 50, 60000)),
      cycles: clamp(cycles, 1, 100000),
      skew_ratio: clamp(skew, 0, 1),
      waveform: types[type] ?? 4
    });
  }

  // Joue une sequence d'etapes en arriere-plan
  // step = { hue?, saturation?, brightness?, kelvin?, power?: "on"|"off", transition_ms?, hold_ms? }
  function playScene({ name = 'scene', steps = [], repeat = 1 }) {
    stopScene();
    const me = { id: ++sceneId, name, cancelled: false };
    scene = me;
    const loops = repeat === 0 ? Infinity : clamp(repeat, 1, 1000);

    (async () => {
      try {
        const d = await get();
        let { color: cur } = await d.lightGet();
        for (let i = 0; i < loops && !me.cancelled; i++) {
          for (const st of steps) {
            if (me.cancelled) break;
            const t = Math.round(clamp(st.transition_ms ?? 0, 0, 600000));
            if (st.power === 'off') {
              await d.lightSetPower({ level: 0, duration: t });
            } else {
              cur = toLifx(st, cur);
              await d.lightSetColor({ color: cur, duration: t });
              if (st.power === 'on' || i === 0) await d.lightSetPower({ level: 1, duration: 0 });
            }
            // attente decoupee pour pouvoir annuler vite
            let wait = t + Math.round(clamp(st.hold_ms ?? 0, 0, 600000));
            while (wait > 0 && !me.cancelled) { const s = Math.min(wait, 100); await sleep(s); wait -= s; }
          }
        }
      } catch (e) {
        console.error('Scene interrompue :', e.message);
      } finally {
        if (scene === me) scene = null;
      }
    })();

    const one = steps.reduce((t, s) => t + (s.transition_ms || 0) + (s.hold_ms || 0), 0);
    return { started: name, steps: steps.length, duration_s: loops === Infinity ? 'infini' : Math.round(one * loops / 1000) };
  }

  // Annule scene + waveform en reappliquant la couleur actuelle
  async function stopAll() {
    stopScene();
    const d = await get();
    const { color } = await d.lightGet();
    await d.lightSetColor({ color, duration: 0 });
  }

  return { get, state, power, setColor, waveform, playScene, stopScene, stopAll };
}

module.exports = { createLamp, clamp };
