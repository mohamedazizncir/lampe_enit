// Agent LLM (Groq) : comprend la demande et pilote la lampe via des outils
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM = `Tu es l'assistant d'une lampe connectee LIFX (couleur, 1 seule ampoule) dans le labo de l'ENIT.
Tu transformes les demandes de l'utilisateur (ambiances, scenes, effets, emotions, situations) en actions sur la lampe en utilisant les outils.
Sois creatif : invente toi-meme les couleurs, les timings et les sequences (lever de soleil, coucher de soleil, ete, nuit, urgence, fete, concentration, orage, feu de camp, police, battement de coeur, etc.).

Unites : hue 0-360 (0 rouge, 30 orange, 60 jaune, 120 vert, 180 cyan, 240 bleu, 280 violet, 320 rose), saturation 0-100, brightness 0-100, kelvin 1500-9000 (utile surtout quand saturation=0 : 1500-2700 chaud, 4000 neutre, 6500+ froid).
Outils :
- set_light : etat fixe, avec transition douce possible.
- play_scene : sequence d'etapes (chaque etape : couleur + transition_ms + hold_ms), repeat=0 pour boucler a l'infini. Ideal pour les ambiances qui evoluent ou les animations.
- waveform : effet materiel continu et tres fluide (pulse = clignoter, sine = respirer/monter-descendre, triangle, saw).
- stop_effects : arrete scene et effets.
- get_state : lire l'etat actuel.
Une nouvelle scene ou un nouvel effet remplace le precedent.
L'utilisateur peut parler francais, anglais, arabe standard ou dialecte tunisien (derja, ex : "chaal edhaw" / "شعل الضو" = allume, "tafi" / "طفي" = eteins, "dhaw" = lumiere).
Apres avoir agi, reponds en 1 ou 2 phrases courtes, dans la langue de l'utilisateur (en arabe si il parle arabe ou tunisien), en disant ce que tu as fait. Si la demande n'a rien a voir avec la lampe, reponds brievement sans outil.`;

const color = {
  hue: { type: 'number', description: '0-360' },
  saturation: { type: 'number', description: '0-100' },
  brightness: { type: 'number', description: '0-100' },
  kelvin: { type: 'number', description: '1500-9000' }
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_light',
      description: 'Regle la lampe sur un etat fixe. Les champs absents gardent leur valeur actuelle.',
      parameters: {
        type: 'object',
        properties: {
          power: { type: 'string', enum: ['on', 'off'] },
          ...color,
          transition_ms: { type: 'number', description: 'duree de la transition en ms' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'play_scene',
      description: 'Joue une sequence d\'etapes en arriere-plan (ex: lever de soleil sur 60 s, alarme, ambiance qui varie).',
      parameters: {
        type: 'object',
        required: ['name', 'steps'],
        properties: {
          name: { type: 'string' },
          repeat: { type: 'number', description: 'nombre de repetitions, 0 = boucle infinie' },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 60,
            items: {
              type: 'object',
              properties: {
                power: { type: 'string', enum: ['on', 'off'] },
                ...color,
                transition_ms: { type: 'number', description: 'fondu vers cette etape' },
                hold_ms: { type: 'number', description: 'temps de maintien apres le fondu' }
              }
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'waveform',
      description: 'Effet continu gere par la lampe : oscille entre la couleur actuelle et la couleur donnee.',
      parameters: {
        type: 'object',
        required: ['type', 'period_ms'],
        properties: {
          type: { type: 'string', enum: ['pulse', 'sine', 'half_sine', 'triangle', 'saw'] },
          ...color,
          period_ms: { type: 'number', description: 'duree d\'un cycle en ms' },
          cycles: { type: 'number', description: 'nombre de cycles (defaut quasi infini)' },
          skew: { type: 'number', description: '0-1, rapport cyclique pour pulse' }
        }
      }
    }
  },
  { type: 'function', function: { name: 'stop_effects', description: 'Arrete scene et effets en cours.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_state', description: 'Etat actuel de la lampe.', parameters: { type: 'object', properties: {} } } }
];

async function runTool(lamp, name, args) {
  switch (name) {
    case 'set_light': {
      lamp.stopScene();
      const { power, transition_ms = 500, ...c } = args;
      if (power === 'off') { await lamp.power(false, transition_ms); return { ok: true, power: 'off' }; }
      if (Object.keys(c).length) await lamp.setColor(c, transition_ms);
      await lamp.power(true, transition_ms);
      return { ok: true };
    }
    case 'play_scene': return lamp.playScene(args);
    case 'waveform': lamp.stopScene(); await lamp.waveform(args); return { ok: true };
    case 'stop_effects': await lamp.stopAll(); return { ok: true };
    case 'get_state': return lamp.state();
    default: return { error: 'outil inconnu' };
  }
}

async function callGroq(messages) {
  const r = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.7
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `Groq HTTP ${r.status}`);
  return j.choices[0].message;
}

// history = [{ role: 'user'|'assistant', content }]
async function chat(lamp, history) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY manquante dans le fichier .env');
  const messages = [{ role: 'system', content: SYSTEM }, ...history.slice(-12)];
  const actions = [];

  for (let i = 0; i < 6; i++) {
    const msg = await callGroq(messages);
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
    if (!msg.tool_calls?.length) return { reply: msg.content || 'OK.', actions };

    for (const call of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      let result;
      try { result = await runTool(lamp, call.function.name, args); }
      catch (e) { result = { error: e.message }; }
      actions.push({ tool: call.function.name, args, result });
      console.log('[LLM]', call.function.name, JSON.stringify(args));
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { reply: 'C\'est fait.', actions };
}

// Speech-to-text : audio (Buffer) -> texte, via Whisper sur Groq
async function transcribe(buffer, mime = 'audio/webm', language = '') {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY manquante dans le fichier .env');
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : mime.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), `voice.${ext}`);
  form.append('model', process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  if (['ar', 'fr', 'en'].includes(language)) form.append('language', language);
  form.append('prompt', language === 'ar'
    ? 'أوامر للضو : شعل الضو، طفي الضو، الإضاءة، لون أحمر، أزرق، أخضر، شروق الشمس.'
    : 'Commandes pour une lampe : allume, eteins, lumiere, couleur, rouge, bleu, luminosite, lever de soleil. Turn the lamp on, off, brightness.');
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `Groq HTTP ${r.status}`);
  return (j.text || '').trim();
}

module.exports = { chat, transcribe };
