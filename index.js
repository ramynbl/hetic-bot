
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

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const TIMEZONE = process.env.TIMEZONE || 'Europe/Paris';
const ICS_FILE = process.env.ICS_FILE; 
const ICS_URL_GROUPE1  = process.env.ICS_URL_GROUPE1;  
const ICS_URL_GROUPE2  = process.env.ICS_URL_GROUPE2;  

// client Discord  
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

let eventsCache = { groupe1: [], groupe2: [] };
const sentKeys = new Set();


function squashSpaces(str = '') {
  return String(str).replace(/\s+/g, ' ').trim();
}

// Helper
function parseSummary(summary, description = '') {
  const s = squashSpaces(summary);


  const firstComma = s.indexOf(',');
  const course = (firstComma === -1 ? s : s.slice(0, firstComma)).trim() || '(Sans titre)';

  let prof = null;
  const profMatch = s.match(/(?:^|,\s*)(M\.|Mme|Mr|Mrs|Ms)\s*[^,]+/i);
  if (profMatch) {
   
    const start = profMatch.index ?? 0;
    let seg = s.slice(start).replace(/^,\s*/, '');

    const nextComma = seg.indexOf(',');
    if (nextComma !== -1) seg = seg.slice(0, nextComma);
    prof = squashSpaces(seg);
  }


  if (!prof && description) {
    const line = description
      .split('\n')
      .map(squashSpaces)
      .find(l => /^(M\.|Mme|Mr|Mrs|Ms)\b/i.test(l));
    if (line) prof = line;
  }

  return { course, prof: prof || '—' };
}

// Lecture du calendrier
async function loadCalendar(url, groupe1) {
  try {
    let data;
      data = await ical.async.fromURL(url);

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
    eventsCache[groupe1] = items;
    console.log(`✅ Calendrier chargé pour ${groupe1} : ${eventsCache[groupe1].length} évènements.`);
  } catch (err) {
    console.error('❌ Erreur chargement iCal :', err.message);
  }
}

// Trouver le prochain cours
function getNextEvent(now = dayjs().tz(TIMEZONE), group) {
  return eventsCache[group]?.find(ev => ev.start.isAfter(now));
}

// Boucle rappels
async function loopReminders() {
  const now = dayjs().tz(TIMEZONE);
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('❌ Salon introuvable. Vérifie CHANNEL_ID et les permissions du bot.');
    return;
  }

  // Filtre rapide: évènements dans les prochaines 24h
  const soon = Object.values(eventsCache)
    .flat()
    .filter(ev => ev.start.isAfter(now) && ev.start.isBefore(now.add(1, 'day')));

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
// Extraire le groupe d'un utilisateur
function extractGroup(roles){
  const roleNames = roles.map(r => r.name);
  if (roleNames.includes('Developper Web') || roleNames.includes('PGE')) {
    return 'groupe1';
  }
  if (roleNames.includes('Data&AI') || roleNames.includes('Marketing')) {
    return 'groupe2';
  }
  return null;
}  

// Commande !prochain_cours
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const roles = msg.member.roles.cache;
  const group = extractGroup(roles);
  console.log(group);
  const content = msg.content?.trim().toLowerCase();
  if (content === '!prochain_cours') {
    const now = dayjs().tz(TIMEZONE);
    const next = getNextEvent(now, group);
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

client.once('ready', async () => {
  console.log(`🤖 Connecté en tant que ${client.user.tag}`);
  client.user.setActivity('tes cours HETIC', { type: 3 });
  await loadCalendar(ICS_URL_GROUPE1, 'groupe1');
  await loadCalendar(ICS_URL_GROUPE2, 'groupe2');

  // Boucle de rappel toutes les 30 secondes
  setInterval(loopReminders, 30 * 1000);

  // Recharger le calendrier chaque lundi à 08:00
  cron.schedule('0 8 * * 1', async () => {
    console.log('🔁 Rechargement hebdo du calendrier…');
    sentKeys.clear();
    await loadCalendar(ICS_URL_GROUPE1, 'groupe1');
    await loadCalendar(ICS_URL_GROUPE2, 'groupe2');
  }, { timezone: TIMEZONE });

  cron.schedule('0 */2 * * *', async () => {
    console.log('🔁 Refresh périodique du calendrier…');
    await loadCalendar(ICS_URL_GROUPE1, 'groupe1');
    await loadCalendar(ICS_URL_GROUPE2, 'groupe2');
  }, { timezone: TIMEZONE });
});

client.login(TOKEN).catch(err => {
  console.error('❌ Échec de connexion Discord :', err.message);
});
