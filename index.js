
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');
const ical = require('node-ical');
const fs = require('fs');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
require('dayjs/locale/fr');
dayjs.extend(utc);
dayjs.extend(tz);
dayjs.locale('fr');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const TIMEZONE = process.env.TIMEZONE || 'Europe/Paris';
const ICS_FILE = process.env.ICS_FILE; 
const ICS_URL_GROUPE1  = process.env.ICS_URL_GROUPE1;  
const ICS_URL_GROUPE2  = process.env.ICS_URL_GROUPE2;
const ICS_URL_PM = process.env.ICS_URL_PM;
const GUILD_ID = process.env.GUILD_ID;

// Rôles à mentionner (plusieurs rôles par groupe)
const ROLE_IDS = {
  groupe1: [process.env.ROLE_ID_DEV_WEB, process.env.ROLE_ID_PGE].filter(Boolean),
  groupe2: [process.env.ROLE_ID_DATA_AI, process.env.ROLE_ID_MARKETING].filter(Boolean),
  pm: [process.env.ROLE_ID_PM].filter(Boolean),
};

// Fonction pour générer les mentions d'un groupe
function getMentions(group) {
  const roleIds = ROLE_IDS[group] || [];
  return roleIds.map(id => `<@&${id}>`).join(' ');
}

// Fonction pour obtenir le nom lisible d'un groupe
function getGroupDisplayName(group) {
  const names = {
    groupe1: 'Dev Web / PGE',
    groupe2: 'Data&AI / Marketing',
    pm: 'PM'
  };
  return names[group] || group;
}

// client Discord
const client = new Client({
  intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent],
});

let eventsCache = { groupe1: [], groupe2: [], pm: [] };
const sentKeys = new Set();


function squashSpaces(str = '') {
  return String(str).replace(/\s+/g, ' ').trim();
}

// Helper regexp pour extraire le nom du cours et du prof
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
async function loadCalendar(url, groupName) {
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
    eventsCache[groupName] = items;
    console.log(`✅ Calendrier chargé pour ${groupName} : ${eventsCache[groupName].length} évènements.`);
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

  // Parcourir chaque groupe séparément pour pouvoir mentionner le bon rôle
  for (const [group, events] of Object.entries(eventsCache)) {
    const soon = events.filter(ev => 
      ev.start.isAfter(now) && ev.start.isBefore(now.add(1, 'day'))
    );

    for (const ev of soon) {
      const remindAt = ev.start.subtract(20, 'minute');
      if (now.isSame(remindAt, 'minute')) {
        const key = `${ev.uid}_${ev.start.format('YYYY-MM-DD HH:mm')}`;
        if (sentKeys.has(key)) continue;
        sentKeys.add(key);

        const { course, prof } = parseSummary(ev.summary, ev.description);

        const embed = new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle('🔔 RAPPEL : Cours dans 20 minutes !')
          .addFields(
            { name: '📅 Jour',  value: ev.start.format('dddd DD/MM'), inline: true },
            { name: '⏰ Heure', value: ev.start.format('HH:mm'),      inline: true },
            { name: '🏫 Salle', value: ev.location || '—',            inline: true },
            { name: '📚 Cours', value: course,                        inline: false },
            { name: '👨‍🏫 Prof', value: prof,                          inline: false },
          )
          .setTimestamp();

        // Mention des rôles correspondant au groupe
        const mentions = getMentions(group);
        const mobileText = `${mentions} 🔔 Dans 20 min — ${ev.start.format('HH:mm')} — salle ${ev.location || '—'} — ${course}`;

        await channel.send({ content: mobileText, embeds: [embed] }).catch(e => console.error('❌ Envoi échec :', e.message));
        console.log(`📣 Rappel envoyé pour ${course} (${group}) (${ev.start.format('YYYY-MM-DD HH:mm')})`);
      }
    }
  }
}

// ===============================================================================
//  FONCTION PRINCIPALE : DIGEST envoie chaque soir à 18:00 les cours du lendemain
// ===============================================================================
async function sendDailyDigest(targetUser = null, dateOverride = null) {
  let target = targetUser;
  
  if (!target) {
    target = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  }
  
  if (!target) {
    console.error('❌ Destination (Salon ou User) introuvable pour le digest.');
    return false;
  }

  const baseDate = dateOverride ? dateOverride : dayjs().tz(TIMEZONE);
  const startOfTargetDay = baseDate.add(1, 'day').startOf('day');
  const endOfTargetDay = baseDate.add(1, 'day').endOf('day');

  const groups = ['groupe1', 'groupe2', 'pm'];
  let messageSent = false;

  // Log pour debug
  const mode = targetUser ? 'PRIVÉ (Test)' : 'PUBLIC (Cron)';
  console.log(`🔎 [Digest] Mode: ${mode} | Cible: ${startOfTargetDay.format('DD/MM/YYYY')}`);

  for (const group of groups) {
    const events = eventsCache[group]?.filter(ev => 
      ev.start.isAfter(startOfTargetDay) && ev.start.isBefore(endOfTargetDay)
    ) || [];

    if (events.length === 0) continue;

    const embed = new EmbedBuilder()
      .setColor(0xE67E22) 
      .setTitle(`📅 Cours du ${startOfTargetDay.format('dddd DD/MM')} (${getGroupDisplayName(group)})`)
      .setDescription('Voici les cours prévus. Vérifiez les salles !')
      .setTimestamp();

    // ... code avant (dans sendDailyDigest)

    for (const ev of events) {
      const { course, prof } = parseSummary(ev.summary, ev.description);
      const timeStart = ev.start.format('HH:mm');
      const timeEnd = ev.end.format('HH:mm');
      
      let location = ev.location || 'Inconnue';
      location = location.replace(/^salle\s+/i, ''); 

      const separator = '⎯'.repeat(20); 

      embed.addFields({ 
        name: `⏰ \`${timeStart}\` à \`${timeEnd}\``, 
        value: `**__${course}__**\n\n👨‍🏫 **${prof}**\n📍 Salle ${location}\n${separator}`, 
        inline: false 
      });
    }

    const mentions = getMentions(group);
    
    // Modification du message pour les test en DM (pas de mention, message plus personnalisé)
    const content = targetUser 
      ? `🕵️ **[PREVIEW ADMIN]** Digest pour le **${group}** :` 
      : `👋 Bonsoir ${mentions}, n'oubliez pas vos cours de demain !`;

    await target.send({ content: content, embeds: [embed] })
      .catch(e => console.error(`❌ Erreur envoi digest ${group} :`, e.message));
    
    messageSent = true;
    console.log(`✅ Digest envoyé pour ${group} (${events.length} cours).`);
  }
  
  return messageSent;
}

// Programmer le digest tous les jours à 18:00
cron.schedule('0 18 * * *', async () => {
  console.log('🌇 Lancement du digest quotidien (18h)…');
  await sendDailyDigest();
}, { timezone: TIMEZONE });

// Extraire le groupe d'un utilisateur
function extractGroup(roles){
  const roleNames = roles.map(r => r.name);
  if (roleNames.includes('Developper Web') || roleNames.includes('PGE')) {
    return 'groupe1';
  }
  if (roleNames.includes('Data&AI') || roleNames.includes('Marketing')) {
    return 'groupe2';
  }
  if (roleNames.includes('PM')) {
    return 'pm';
  }
  return null;
}  

// Commandes texte
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content.trim();

  // Commandes de test : !test_digest (admin uniquement) et !test_rappel
  if (content === '!test_digest') {
    if (!msg.member.permissions.has('Administrator')) {
      return msg.reply('❌ Cette commande est réservée aux administrateurs.');
    }
    
    console.log('📋 Commande !test_digest déclenchée par', msg.author.tag);
    await msg.reply('⏳ Génération du digest (Envoyé en MP)...');

    // Pour les tests, si on est vendredi ou samedi, on affiche le planning de lundi
    const now = dayjs().tz(TIMEZONE);
    let dateOverride = null;
    
    // Vendredi (5) ou Samedi (6) => afficher le planning de Lundi (7)
    if (now.day() === 5 || now.day() === 6) {
      dateOverride = now.day(7); 
      await msg.author.send("ℹ️ **Note debug :** Comme on est le week-end, j'affiche le planning de Lundi pour le test.");
    }

    const sent = await sendDailyDigest(msg.author, dateOverride);

    if (!sent) {
      await msg.author.send("📭 Aucun cours trouvé pour le lendemain (ou Lundi). Le bot restera silencieux en prod.");
    } else {
      await msg.reply("✅ Check tes DMs !");
    }
    return;
  }

  // Commande !test_rappel (test utilisateur)
  if (content !== '!test_rappel') return;

  // Extraire le groupe de l'utilisateur
  const roles = msg.member?.roles?.cache;
  const group = roles ? extractGroup(roles) : null;

  if (!group) {
    return msg.reply("❌ Aucun groupe détecté sur tes rôles. Assure-toi d'avoir le rôle 'Developper Web', 'PGE', 'Data&AI', 'Marketing' ou 'PM'.");
  }

  const channel = msg.channel;
  const now = dayjs().tz(TIMEZONE);
  const fakeStart = now.add(20, 'minute');
  const course = 'Test de rappel';
  const prof = 'Prof. Test';
  const location = 'B101';

  const embed = new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle('🔔 RAPPEL (TEST) : Cours dans 20 minutes !')
    .addFields(
      { name: '📅 Jour',  value: fakeStart.format('dddd DD/MM'), inline: true },
      { name: '⏰ Heure', value: fakeStart.format('HH:mm'),      inline: true },
      { name: '🏫 Salle', value: location,                        inline: true },
      { name: '📚 Cours', value: course,                          inline: false },
      { name: '👨‍🏫 Prof', value: prof,                            inline: false },
    )
    .setTimestamp();

  // Mention des rôles correspondant au groupe
  const mentions = getMentions(group);
  const mobileText = `${mentions} 🔔 Dans 20 min — ${fakeStart.format('HH:mm')} — salle ${location} — ${course}`;

  await channel.send({ content: mobileText, embeds: [embed] }).catch(e => console.error('❌ Envoi échec (test) :', e.message));
});

// Slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Commande /demain
  if (interaction.commandName === 'demain') {
    await interaction.deferReply({ ephemeral: true });

    const sent = await sendDailyDigest(interaction.user);

    if (sent) {
      await interaction.editReply('✅ Je t\'ai envoyé le planning de demain en MP !');
    } else {
      await interaction.editReply('📭 Rien de prévu pour demain (ou je n\'ai pas trouvé ton groupe).');
    }
    return;
  }

  // Commande /jour
  if (interaction.commandName === 'jour') {
    await interaction.deferReply({ ephemeral: true });

    const roles = interaction.member?.roles?.cache;
    const group = roles ? extractGroup(roles) : null;
    
    if (!group) {
      return interaction.editReply("❌ Aucun groupe détecté sur tes rôles. Contacte un admin pour obtenir le rôle 'Developper Web', 'PGE', 'Data&AI' ou 'Marketing'.");
    }

    const now = dayjs().tz(TIMEZONE);
    const startOfDay = now.startOf('day');
    const endOfDay = now.endOf('day');

    const dayEvents = eventsCache[group]?.filter(ev => {
      if (!ev.start.isAfter(startOfDay) || !ev.start.isBefore(endOfDay)) return false;
      
      const hour = ev.start.hour();
      const minute = ev.start.minute();
      if (hour === 12 && minute === 30) return false;
      
      return true;
    }) || [];

    if (dayEvents.length === 0) {
      return interaction.reply({ 
        content: 'Aucun cours aujourd\'hui.', 
        ephemeral: true 
      });
    } 

    const embed = new EmbedBuilder()
      .setColor(0xF39C12)
      .setTitle(`📅 Cours du jour (${getGroupDisplayName(group)})`)
      .setTimestamp();

    for (const ev of dayEvents) {
      const { course, prof } = parseSummary(ev.summary, ev.description);
      const timeStart = ev.start.format('HH:mm');
      const timeEnd = ev.end.format('HH:mm');
      
      let location = ev.location || 'Inconnue';
      location = location.replace(/^salle\s+/i, '');

      const separator = '⎯'.repeat(20);

      embed.addFields({ 
        name: `⏰ \`${timeStart}\` à \`${timeEnd}\``, 
        value: `**__${course}__**\n\n👨‍🏫 **${prof}**\n📍 Salle ${location}\n${separator}`, 
        inline: false 
      });
    }

    // Envoyer en DM
    try {
      await interaction.user.send({ embeds: [embed] });
      return interaction.editReply('✅ Je t\'ai envoyé ton planning du jour en MP !');
    } catch (e) {
      return interaction.editReply('❌ Je n\'ai pas pu t\'envoyer de MP. Vérifie que tes DMs sont ouverts.');
    }
  }

  // Commande /semaine
  if (interaction.commandName === 'semaine') {
    await interaction.deferReply({ ephemeral: true });

    const roles = interaction.member?.roles?.cache;
    const group = roles ? extractGroup(roles) : null;
    
    if (!group) {
      return interaction.editReply("❌ Aucun groupe détecté sur tes rôles. Contacte un admin pour obtenir le rôle 'Developper Web', 'PGE', 'Data&AI' ou 'Marketing'.");
    }

    const now = dayjs().tz(TIMEZONE);
    const startOfWeek = now.startOf('week').add(1, 'day'); // Lundi
    const endOfWeek = startOfWeek.add(5, 'day'); // Vendredi soir

    const weekEvents = eventsCache[group]?.filter(ev => 
      ev.start.isAfter(startOfWeek) && ev.start.isBefore(endOfWeek)
    ) || [];

    if (weekEvents.length === 0) {
      return interaction.reply({ 
        content: 'Aucun cours cette semaine.', 
        ephemeral: true 
      });
    }

    // Grouper par jour
    const byDay = {};
    for (const ev of weekEvents) {
      const dayKey = ev.start.format('dddd DD/MM');
      if (!byDay[dayKey]) byDay[dayKey] = [];
      const { course, prof } = parseSummary(ev.summary, ev.description);
      byDay[dayKey].push({ ...ev, course, prof });
    }

    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle(`📅 Cours de la semaine (${getGroupDisplayName(group)})`)
      .setTimestamp();

    const dayEntries = Object.entries(byDay);
    for (let i = 0; i < dayEntries.length; i++) {
      const [day, events] = dayEntries[i];

      // Titre du jour bien visible
      const dayHeader = `\n📆 **__${day.charAt(0).toUpperCase() + day.slice(1)}__**\n${'━'.repeat(25)}`;
      embed.addFields({ name: '\u200b', value: dayHeader, inline: false });

      // Cours de ce jour
      for (const ev of events) {
        const timeStart = ev.start.format('HH:mm');
        const timeEnd = ev.end.format('HH:mm');
        let location = ev.location || 'Inconnue';
        location = location.replace(/^salle\s+/i, '');
        embed.addFields({ 
          name: `⏰ \`${timeStart}\` à \`${timeEnd}\``, 
          value: `**__${ev.course}__**\n👨‍🏫 **${ev.prof}**\n📍 Salle ${location}`, 
          inline: false 
        });
      }
    }

    // Envoyer en DM
    try {
      await interaction.user.send({ embeds: [embed] });
      return interaction.editReply('✅ Je t\'ai envoyé ton planning en MP !');
    } catch (e) {
      return interaction.editReply('❌ Je n\'ai pas pu t\'envoyer de MP. Vérifie que tes DMs sont ouverts.');
    }
  }

  // Commande /prochain_cours
  if (interaction.commandName !== 'prochain_cours') return;

  const roles = interaction.member?.roles?.cache;
  const group = roles ? extractGroup(roles) : null;
  
  if (!group) {
    return interaction.reply({ 
      content: "❌ Aucun groupe détecté sur tes rôles. Contacte un admin pour obtenir le rôle 'Developper Web', 'PGE', 'Data&AI' ou 'Marketing'.", 
      ephemeral: true 
    });
  }

  const now = dayjs().tz(TIMEZONE);
  const next = getNextEvent(now, group);
  
  if (!next) {
    return interaction.reply({ 
      content: 'Aucun cours à venir trouvé.', 
      ephemeral: true 
    });
  }

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

  return interaction.reply({ embeds: [embed] });
});

client.once('ready', async () => {
  console.log(`🤖 Connecté en tant que ${client.user.tag}`);
  client.user.setActivity('tes cours HETIC', { type: 3 });
  await loadCalendar(ICS_URL_GROUPE1, 'groupe1');
  await loadCalendar(ICS_URL_GROUPE2, 'groupe2');
  await loadCalendar(ICS_URL_PM, 'pm');

  // Enregistrement des commandes slash
  async function registerSlashCommands() {
    const commands = [
      {
        name: 'prochain_cours',
        description: 'Affiche le prochain cours de ton groupe',
      },
      {
        name: 'semaine',
        description: 'Envoie le planning de la semaine en message privé',
      },
      {
        name: 'jour',
        description: 'Envoie le planning du jour en message privé',
      },
      {
        name: 'demain',
        description: 'Envoie le résumé des cours de demain en message privé',
      }
    ];
    try {
      if (GUILD_ID) {
        const guild = await client.guilds.fetch(GUILD_ID);
        for (const cmd of commands) {
          await guild.commands.create(cmd);
        }
        console.log('✅ Commandes slash enregistrées (guild)');
      } else {
        for (const cmd of commands) {
          await client.application.commands.create(cmd);
        }
        console.log('✅ Commandes slash enregistrées (globale) — propagation ~1h');
      }
    } catch (e) {
      console.error('❌ Enregistrement des commandes slash échoué :', e.message);
    }
  }
  await registerSlashCommands();

  // Boucle de rappel toutes les 30 secondes
  setInterval(loopReminders, 30 * 1000);

  // Recharger le calendrier chaque lundi à 08:00
  cron.schedule('0 8 * * 1', async () => {
    console.log('🔁 Rechargement hebdo du calendrier…');
    sentKeys.clear();
    await loadCalendar(ICS_URL_GROUPE1, 'groupe1');
    await loadCalendar(ICS_URL_GROUPE2, 'groupe2');
    await loadCalendar(ICS_URL_PM, 'pm');
  }, { timezone: TIMEZONE });

  // Recharger le calendrier toutes les heures (au cas où)
  
  cron.schedule('0 * * * *', async () => {
    console.log('🔁 Refresh périodique du calendrier…');
    await loadCalendar(ICS_URL_GROUPE1, 'groupe1');
    await loadCalendar(ICS_URL_GROUPE2, 'groupe2');
    await loadCalendar(ICS_URL_PM, 'pm');
  }, { timezone: TIMEZONE });
});

client.login(TOKEN).catch(err => {
  console.error('❌ Échec de connexion Discord :', err.message);
});
