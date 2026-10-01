# Lampe ENIT (LIFX)

```
npm install
npm run discover      # trouve la lampe et sauvegarde son IP dans config.json
npm start             # ouvre http://localhost:3000
```

Si plusieurs lampes : `node discover.js "nom"` pour choisir par label.

Si rien n'est trouvé : autoriser Node.js dans le pare-feu Windows (réseau privé et public, UDP 56700).

## Assistant LLM (Groq)
Mettre la clé dans `.env` : `GROQ_API_KEY=gsk_...` puis relancer `npm start`.
Modèle modifiable avec `GROQ_MODEL` (ex : `llama-3.3-70b-versatile`).
