const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode     = require('qrcode-terminal');
const Anthropic  = require('@anthropic-sdk/sdk');
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const fs         = require('fs');
const path       = require('path');

// ============================================================
//  🔧 CONFIG — fill these in
// ============================================================
const CONFIG = {
  ANTHROPIC_API_KEY: 'YOUR_ANTHROPIC_API_KEY',
  DASHBOARD_PORT:    3000,
  DASHBOARD_PASS:    'admin123',   // change this!
};
// ============================================================

// ── Claude System Prompt ──────────────────────────────────────
const SYSTEM_PROMPT = `Tu es un assistant support client IPTV professionnel. Tu réponds en français, de manière courte et efficace comme sur WhatsApp.

FORFAITS:
• Base (15 mois) → 29€ : +79 000 chaînes, Netflix, Disney+, Ligue 1 HD/4K
• Premium (15 mois) → 39€ : Tout du Base + adultes (mot de passe) — LE PLUS POPULAIRE  
• Gold (15 mois) → 49€ : 2 écrans + tout Premium
• À Vie → 129€ : Paiement unique, 2 écrans, 30j garantie

APPLICATIONS: IBO Player, IPTV Smarters Pro, Televizo, Formuler

ACTIVATION (après réception des codes):
1. Télécharger IBO Player (ou IPTV Smarters)
2. Aller dans "Ajouter une liste" ou "Xtream Codes"
3. Entrer: Serveur + Username + Password
4. Valider et profiter !

RÈGLES IMPORTANTES:
- Commence TOUJOURS par "Bonjour" ou "Bonsoir"
- Réponses TRÈS courtes (1-3 phrases max)
- Si client dit qu'il a payé ou envoie preuve → réponds: "Merci pour votre paiement ! 🙏 Notre équipe vérifie et vous envoie vos accès dans quelques minutes."
- Si client demande essai gratuit → réponds: "Bonjour, oui c'est possible ! Donnez-moi quelques minutes, je prépare votre accès d'essai. 😊"
- Si problème technique APRÈS activation → aide-le (demande l'app, demande screenshot)
- Si tu ne peux PAS résoudre le problème technique → dis exactement: "Je transfère votre demande à notre technicien, il revient vers vous très vite. 🔧"
- Ne demande JAMAIS les credentials toi-même — c'est géré par l'équipe
- La date d'expiration affichée est normale, elle se met à jour automatiquement

SUPPORT TECHNIQUE APRÈS ACTIVATION:
- Chaînes gelées → "Changez de URL dans votre app: essayez URL 2 ou URL 3"
- App ne s'ouvre pas → "Désinstallez et réinstallez IBO Player"  
- Pas de son → "Vérifiez le décodeur audio dans les paramètres de l'app"
- Chaîne introuvable → "Faites une mise à jour de la liste dans votre app"
- Connexion refusée → "Vérifiez votre username et password, attention aux majuscules"
- Problème inconnu → dis que tu transfères au technicien

Réponds UNIQUEMENT en français. Sois bref et professionnel.`;

// ── State ─────────────────────────────────────────────────────
const conversations   = new Map(); // phone → message history
const pendingClients  = new Map(); // phone → { type: 'payment'|'trial'|'support', ... }

const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

// ── Logging ───────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync('bot.log', line + '\n');
}

// ── History helpers ───────────────────────────────────────────
function getHistory(phone) {
  if (!conversations.has(phone)) conversations.set(phone, []);
  return conversations.get(phone);
}
function addHistory(phone, role, content) {
  const h = getHistory(phone);
  h.push({ role, content });
  if (h.length > 30) h.splice(0, h.length - 30);
}

// ── Ask Claude ────────────────────────────────────────────────
async function askClaude(phone, userText) {
  addHistory(phone, 'user', userText);
  const res = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 400,
    system:     SYSTEM_PROMPT,
    messages:   getHistory(phone),
  });
  const reply = res.content[0].text;
  addHistory(phone, 'assistant', reply);
  return reply;
}

// ── Detect message intent ─────────────────────────────────────
function detectIntent(text, hasMedia) {
  const t = text.toLowerCase();
  const payWords   = ['payé','paye','paiement','virement','reçu','recu','j\'ai payé','voici le','preuve','confirmation','screenshot'];
  const trialWords = ['essai','test','gratuit','tester','trial','free'];
  const supportWords = ['marche pas','fonctionne pas','problème','bug','erreur','bloqué','gelé','noir','son','connexion','accès','refusé','expire'];

  if (hasMedia || payWords.some(w => t.includes(w)))     return 'payment';
  if (trialWords.some(w => t.includes(w)))               return 'trial';
  if (supportWords.some(w => t.includes(w)))             return 'support';
  return 'normal';
}

// ── Express + Socket.io ───────────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Send credentials to client ──────────────────────────
app.post('/api/send-credentials', async (req, res) => {
  const { phone, pass, username, password, urls, forfait, note } = req.body;
  if (pass !== CONFIG.DASHBOARD_PASS) return res.status(403).json({ error: 'Wrong password' });

  const urlLines = urls.filter(Boolean).map((u, i) => `• URL ${i+1} : ${u}`).join('\n');

  const msg =
`✅ *Votre abonnement est activé !*

📦 *${forfait || 'Forfait IPTV'}*

🔑 *Vos identifiants personnels:*
• Serveur : http://bob33.xyz:80
• Username : ${username}
• Password : ${password}

🌐 *URLs de connexion:*
${urlLines}

📱 *Installation (2 minutes):*
1. Téléchargez *IBO Player* sur votre appareil
2. Ouvrez → "Ajouter" → "Xtream Codes"
3. Entrez le serveur, username et password
4. Validez et profitez ! 🎉

ℹ️ La date affichée se met à jour automatiquement.
📞 Un problème ? Répondez ici, on vous aide !
${note ? '\n📝 ' + note : ''}`;

  try {
    await whatsappClient.sendMessage(phone, msg);
    pendingClients.delete(phone);
    log(`✅ Credentials sent to ${phone}`);
    io.emit('credentials_sent', { phone, forfait });
    res.json({ ok: true });
  } catch (e) {
    log(`❌ Failed to send to ${phone}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── API: Flag for human intervention ─────────────────────────
app.post('/api/take-over', async (req, res) => {
  const { phone, pass, message } = req.body;
  if (pass !== CONFIG.DASHBOARD_PASS) return res.status(403).json({ error: 'Wrong password' });

  try {
    const msg = message || 'Bonjour, je vous transfère à notre technicien qui va vous contacter très vite. 🔧';
    await whatsappClient.sendMessage(phone, msg);
    pendingClients.delete(phone);
    log(`👨‍💻 Human took over for ${phone}`);
    io.emit('human_takeover', { phone });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Send custom message ──────────────────────────────────
app.post('/api/send-message', async (req, res) => {
  const { phone, pass, message } = req.body;
  if (pass !== CONFIG.DASHBOARD_PASS) return res.status(403).json({ error: 'Wrong password' });

  try {
    await whatsappClient.sendMessage(phone, message);
    log(`📤 Manual message sent to ${phone}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WhatsApp Client ───────────────────────────────────────────
const whatsappClient = new Client({
  authStrategy: new LocalAuth({ clientId: 'iptv-bot' }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

whatsappClient.on('qr', qr => {
  console.log('\n📱 SCAN QR CODE:\n');
  qrcode.generate(qr, { small: true });
  io.emit('qr', qr);
});

whatsappClient.on('ready', () => {
  log('✅ WhatsApp connected!');
  io.emit('wa_status', 'connected');
});

whatsappClient.on('disconnected', () => {
  log('⚠️ WhatsApp disconnected');
  io.emit('wa_status', 'disconnected');
});

// ── MAIN MESSAGE HANDLER ──────────────────────────────────────
whatsappClient.on('message', async (msg) => {
  try {
    if (msg.from.includes('@g.us'))          return; // skip groups
    if (msg.from === 'status@broadcast')     return; // skip status

    const phone   = msg.from;
    const text    = msg.body || '';
    const hasMedia = msg.hasMedia && msg.type === 'image';

    log(`📩 ${phone}: ${text.substring(0, 80)}`);

    // Download image if payment proof
    let imageData = null;
    if (hasMedia) {
      try {
        const media = await msg.downloadMedia();
        imageData = `data:${media.mimetype};base64,${media.data}`;
      } catch (e) { log(`⚠️ Media download failed: ${e.message}`); }
    }

    const intent = detectIntent(text, hasMedia);
    const contact = await msg.getContact();
    const name    = contact.pushname || contact.number || phone;

    // ── PAYMENT ───────────────────────────────────────────────
    if (intent === 'payment') {
      await msg.reply('Merci pour votre paiement ! 🙏\nNotre équipe vérifie votre virement et vous envoie vos accès personnels dans quelques minutes.');

      pendingClients.set(phone, { type: 'payment', phone, name, text, imageData, timestamp: new Date().toISOString() });

      io.emit('new_pending', {
        type: 'payment',
        phone, name, text, imageData,
        timestamp: new Date().toISOString(),
        label: '💳 Paiement reçu',
        urgency: 'high',
      });

      log(`💳 Payment pending: ${phone}`);
      return;
    }

    // ── TRIAL ─────────────────────────────────────────────────
    if (intent === 'trial') {
      const reply = await askClaude(phone, text);
      await msg.reply(reply);

      pendingClients.set(phone, { type: 'trial', phone, name, text, timestamp: new Date().toISOString() });

      io.emit('new_pending', {
        type: 'trial',
        phone, name, text,
        imageData: null,
        timestamp: new Date().toISOString(),
        label: '🆓 Essai gratuit demandé',
        urgency: 'medium',
      });

      log(`🆓 Trial pending: ${phone}`);
      return;
    }

    // ── SUPPORT ───────────────────────────────────────────────
    if (intent === 'support') {
      const reply = await askClaude(phone, text);
      await msg.reply(reply);

      // If Claude says it's transferring → notify dashboard
      if (reply.toLowerCase().includes('technicien') || reply.toLowerCase().includes('transfère')) {
        pendingClients.set(phone, { type: 'support', phone, name, text, timestamp: new Date().toISOString() });

        io.emit('new_pending', {
          type: 'support',
          phone, name, text,
          imageData,
          timestamp: new Date().toISOString(),
          label: '🔧 Support technique requis',
          urgency: 'medium',
        });

        log(`🔧 Support needed: ${phone}`);
      }

      // Forward to dashboard for visibility
      io.emit('new_message', { phone, name, text, reply, timestamp: new Date().toISOString() });
      return;
    }

    // ── NORMAL ────────────────────────────────────────────────
    const reply = await askClaude(phone, text || '[image reçue]');
    await msg.reply(reply);
    io.emit('new_message', { phone, name, text, reply, timestamp: new Date().toISOString() });
    log(`🤖 Normal reply to ${phone}`);

  } catch (err) {
    log(`❌ Error: ${err.message}`);
  }
});

// ── Start ─────────────────────────────────────────────────────
httpServer.listen(CONFIG.DASHBOARD_PORT, () => {
  log(`🌐 Dashboard: http://localhost:${CONFIG.DASHBOARD_PORT}`);
});

log('🚀 Starting bot...');
whatsappClient.initialize();
