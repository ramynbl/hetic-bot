// index.js
// =====================================================
// Bot Discord "Rappel de cours HETIC" (Discord.js v14)
// Source calendrier : iCal (fichier local .ical ou URL ICS)
// - Envoie un embed 10 minutes avant chaque cours
// - Commande: !prochain_cours
// - Recharge le calendrier régulièrement
// =====================================================

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');
const ical = require('node-ical');
const fs = require('fs');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

// ----- Config depuis .env -----
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const TIMEZONE = process.env.TIMEZONE || 'Europe/Paris';
const ICS_FILE = process.env.ICS_FILE; // si tu testes en local
const ICS_URL  = process.env.ICS_URL;  // quand tu passes à l’URL

// ----- Client Discord -----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ----- Mémoire -----
let eventsCache = []; // { uid, start: Dayjs, end: Dayjs, summary, location, description }
const sentKeys = new Set(); // pour éviter d'envoyer deux fois le même rappel (clé = uid+start)

/**
 * Helper: nettoyage des espaces (les ICS plient les lignes → espaces bizarres)
 */
function squashSpaces(str = '') {
  return String(str).replace(/\s+/g, ' ').trim();
}

/**
 * Helper: extraire le nom du cours (avant la 1ère virgule)
 * et le prof (segment qui commence par M./Mme/Mr/Mrs/Ms jusqu'à la virgule suivante)
 * - robuste aux retours à la ligne ICS et aux espaces multiples.
 */
function parseSummary(summary, description = '') {
  const s = squashSpaces(summary);

  // Cours = texte avant la 1re virgule
  const firstComma = s.indexOf(',');
  const course = (firstComma === -1 ? s : s.slice(0, firstComma)).trim() || '(Sans titre)';

  // Prof = on cherche un segment "M." / "Mme" / "Mr" / "Mrs" / "Ms" suivi de n'importe quoi jusqu'à la prochaine virgule
  let prof = null;
  const profMatch = s.match(/(?:^|,\s*)(M\.|Mme|Mr|Mrs|Ms)\s*[^,]+/i);
  if (profMatch) {
    // extrait le segment trouvé, sans la virgule qui précède
    const start = profMatch.index ?? 0;
    let seg = s.slice(start).replace(/^,\s*/, '');
    // on coupe à la prochaine virgule (fin du segment)
    const nextComma = seg.indexOf(',');
    if (nextComma !== -1) seg = seg.slice(0, nextComma);
    prof = squashSpaces(seg);
  }

  // Si toujours rien, on tente la description (1re ligne qui commence par M./Mme...)
  if (!prof && description) {
    const line = description
      .split('\n')
      .map(squashSpaces)
      .find(l => /^(M\.|Mme|Mr|Mrs|Ms)\b/i.test(l));
    if (line) prof = line;
  }

  return { course, prof: prof || '—' };
}

// ----- Lecture du calendrier -----
async function loadCalendar() {
  try {
    let data;
    if (ICS_FILE) {
      const raw = fs.readFileSync(ICS_FILE, 'utf8');
      data = ical.sync.parseICS(raw);
    } else if (ICS_URL) {
      data = await ical.async.fromURL(ICS_URL);
    } else {
      console.warn('⚠️ Ni ICS_FILE ni ICS_URL définis dans .env');
      eventsCache = [];
      return;
    }

    const items = [];
    for (const v of Object.values(data)) {
      if (v.type !== 'VEVENT' || !v.start || !v.end) continue;
      items.push({
        uid: v.uid || `${v.summary}-${v.start?.toISOString?.()}`,
        start: dayjs(v.start).tz(TIMEZONE),
        end: dayjs(v.end).tz(TIMEZONE),
        summary: v.summary || '(Sans titre)',
        location: v.location || '—',
        description: v.description ? String(v.description) : ''
      });
    }

    items.sort((a, b) => a.start.valueOf() - b.start.valueOf());
    eventsCache = items;
    console.log(`✅ Calendrier chargé : ${eventsCache.length} évènements.`);
  } catch (err) {
    console.error('❌ Erreur chargement iCal :', err.message);
  }
}

// ----- Trouver le prochain cours (après maintenant) -----
function getNextEvent(now = dayjs().tz(TIMEZONE)) {
  return eventsCache.find(ev => ev.start.isAfter(now));
}

// ----- Boucle de rappel toutes les 30s -----
async function loopReminders() {
  const now = dayjs().tz(TIMEZONE);
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('❌ Salon introuvable. Vérifie CHANNEL_ID et les permissions du bot.');
    return;
  }

  // Filtre rapide: évènements dans les prochaines 24h
  const soon = eventsCache.filter(ev => ev.start.isAfter(now) && ev.start.isBefore(now.add(1, 'day')));

  for (const ev of soon) {
    const remindAt = ev.start.subtract(10, 'minute');
    if (now.isSame(remindAt, 'minute')) {
      const key = `${ev.uid}_${ev.start.format('YYYY-MM-DD HH:mm')}`;
      if (sentKeys.has(key)) continue;
      sentKeys.add(key);

      const { course, prof } = parseSummary(ev.summary, ev.description);

      const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('🔔 RAPPEL : Cours dans 10 minutes !')
        .addFields(
          { name: '📅 Jour',  value: ev.start.format('dddd DD/MM'), inline: true },
          { name: '⏰ Heure', value: ev.start.format('HH:mm'),      inline: true },
          { name: '🏫 Salle', value: ev.location || '—',            inline: true },
          { name: '📚 Cours', value: course,                        inline: false },
          { name: '👨‍🏫 Prof', value: prof,                          inline: false },
        )
        .setTimestamp();

      await channel.send({ embeds: [embed] }).catch(e => console.error('❌ Envoi échec :', e.message));
      console.log(`📣 Rappel envoyé pour ${course} (${ev.start.format('YYYY-MM-DD HH:mm')})`);
    }
  }
}

// ----- Commande !prochain_cours -----
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content?.trim().toLowerCase();
  if (content === '!prochain_cours') {
    const now = dayjs().tz(TIMEZONE);
    const next = getNextEvent(now);
    if (!next) return msg.reply('Aucun cours à venir trouvé.');

    const { course, prof } = parseSummary(next.summary, next.description);

    const embed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle('📌 Prochain cours')
      .addFields(
        { name: '📅 Jour',  value: next.start.format('dddd DD/MM'), inline: true },
        { name: '⏰ Heure', value: next.start.format('HH:mm'),      inline: true },
        { name: '🏫 Salle', value: next.location || '—',            inline: true },
        { name: '📚 Cours', value: course,                          inline: false },
        { name: '👨‍🏫 Prof', value: prof,                            inline: false },
      )
      .setTimestamp();

    return msg.reply({ embeds: [embed] });
  }
});

// ----- Ready -----
client.once('ready', async () => {
  console.log(`🤖 Connecté en tant que ${client.user.tag}`);
  client.user.setActivity('tes cours HETIC', { type: 3 }); // LISTENING
  await loadCalendar();

  // Boucle de rappel toutes les 30 secondes
  setInterval(loopReminders, 30 * 1000);

  // Recharger le calendrier chaque lundi à 08:00 (Europe/Paris)
  cron.schedule('0 8 * * 1', async () => {
    console.log('🔁 Rechargement hebdo du calendrier…');
    sentKeys.clear();
    await loadCalendar();
  }, { timezone: TIMEZONE });

  // Refresh périodique (utile quand tu utilises l’URL ICS)
  cron.schedule('0 */2 * * *', async () => {
    console.log('🔁 Refresh périodique du calendrier…');
    await loadCalendar();
  }, { timezone: TIMEZONE });
});

// ----- Démarrage -----
client.login(TOKEN).catch(err => {
  console.error('❌ Échec de connexion Discord :', err.message);
});
