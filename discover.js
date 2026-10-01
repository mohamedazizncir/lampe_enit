// 1) Decouverte de la lampe LIFX sur le WiFi, puis sauvegarde de son IP/MAC dans config.json
const fs = require('fs');
const path = require('path');
const Lifx = require('node-lifx-lan');

const CONFIG = path.join(__dirname, 'config.json');
const filtre = (process.argv[2] || '').toLowerCase(); // optionnel : node discover.js "label"

(async () => {
  try {
    console.log('Recherche des lampes LIFX (5 s)...');
    const devices = await Lifx.discover({ wait: 5000 });

    if (devices.length === 0) {
      console.log('Aucune lampe trouvee. Verifie le WiFi et le pare-feu Windows (UDP 56700).');
      return process.exit(1);
    }

    devices.forEach((d, i) => {
      const label = d.deviceInfo ? d.deviceInfo.label : '?';
      console.log(`[${i}] ${d.ip} | ${d.mac} | ${label}`);
    });

    const choix = devices.find(d =>
      filtre && d.deviceInfo && d.deviceInfo.label.toLowerCase().includes(filtre)
    ) || devices[0];

    const config = {
      ip: choix.ip,
      mac: choix.mac,
      label: choix.deviceInfo ? choix.deviceInfo.label : '',
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
    console.log(`\nIP sauvegardee dans config.json : ${config.ip} (${config.label})`);
  } catch (err) {
    console.error('Erreur :', err.message);
  } finally {
    Lifx.destroy();
  }
})();
