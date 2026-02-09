/**
 * ==============================================================================
 * 🏗️ IMPORTATIONS & DÉPENDANCES
 * ==============================================================================
 */
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');
const ical = require('node-ical');

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
require('dayjs/locale/fr');

// Configuration DayJS
dayjs.extend(utc);
dayjs.extend(tz);
dayjs.locale('fr');

/**
 * ==============================================================================
 * ⚙️ CONFIGURATION & CONSTANTES
 * ==============================================================================
 */
const CONFIG = {
  TOKEN: process.env.DISCORD_TOKEN,
  CHANNEL_ID: process.env.CHANNEL_ID,
  GUILD_ID: process.env.GUILD_ID,
  TIMEZONE: process.env.TIMEZONE || 'Europe/Paris',
  ICS: {
    groupe1: process.env.ICS_URL_GROUPE1,
    groupe2: process.env.ICS_URL_GROUPE2,
    pm: process.env.ICS_URL_PM,
  },
  ROLES: {
    groupe1: [process.env.ROLE_ID_DEV_WEB, process.env.ROLE_ID_PGE].filter(Boolean),
    groupe2: [process.env.ROLE_ID_DATA_AI, process.env.ROLE_ID_MARKETING].filter(Boolean),
    pm: [process.env.ROLE_ID_PM].filter(Boolean),
  }
};

/**
 * ==============================================================================
 * 🧠 UTILS & HELPERS
 * ==============================================================================
 */

function squashSpaces(str = '') {
  return String(str).replace(/\s+/g, ' ').trim();
}

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

function getMentions(group) {
  const roleIds = CONFIG.ROLES[group] || [];
  return roleIds.map(id => `<@&${id}>`).join(' ');
}

function getGroupDisplayName(group) {
  const names = {
    groupe1: 'Dev Web / PGE',
    groupe2: 'Data&AI / Marketing',
    pm: 'PM'
  };
  return names[group] || group;
}

function extractGroup(roles) {
  const roleNames = roles.map(r => r.name);
  if (roleNames.includes('Developper Web') || roleNames.includes('PGE')) return 'groupe1';
  if (roleNames.includes('Data&AI') || roleNames.includes('Marketing')) return 'groupe2';
  if (roleNames.includes('PM')) return 'pm';
  return null;
}

/**
 * ==============================================================================
 * 💾 ÉTAT GLOBAL
 * ==============================================================================
 */
let eventsCache = { groupe1: [], groupe2: [], pm: [] };
const sentKeys = new Set(); 

/**
 * ==============================================================================
 * 📅 SERVICE CALENDRIER
 * ==============================================================================
 */

async function loadCalendar(url, groupName) {
  if (!url) {
    console.warn(`⚠️ URL manquante pour ${groupName}`);
    return;
  }
  try {
    const data = await ical.async.fromURL(url);
    const items = [];
    
    for (const v of Object.values(data)) {
      if (v.type !== 'VEVENT' || !v.start || !v.end) continue;
      items.push({
        uid: v.uid || `${v.summary}-${v.start?.toISOString?.()}`,
        start: dayjs(v.start).tz(CONFIG.TIMEZONE),
        end: dayjs(v.end).tz(CONFIG.TIMEZONE),
        summary: v.summary || '(Sans titre)',
        location: v.location || '—',
        description: v.description ? String(v.description) : ''
      });
    }

    items.sort((a, b) => a.start.valueOf() - b.start.valueOf());
    eventsCache[groupName] = items;
    console.log(`✅ [Calendar] Chargé pour ${groupName} : ${items.length} évènements.`);
  } catch (err) {
    console.error(`❌ [Calendar] Erreur chargement ${groupName} :`, err.message);
  }
}

function getNextEvent(now = dayjs().tz(CONFIG.TIMEZONE), group) {
  return eventsCache[group]?.find(ev => ev.start.isAfter(now));
}

/**
 * ==============================================================================
 * 🔔 CONTROLLER : RAPPELS & DIGEST
 * ==============================================================================
 */

// Rappel 20 minutes avant le cours
async function loopReminders() {
  const now = dayjs().tz(CONFIG.TIMEZONE);
  const channel = await client.channels.fetch(CONFIG.CHANNEL_ID).catch(() => null);
  
  if (!channel) {
    console.error('❌ [Rappel] Salon introuvable.');
    return;
  }

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

        const mentions = getMentions(group);
        const groupLabel = getGroupDisplayName(group);
        const mobileText = `${mentions}\n📣 ${groupLabel} — 🔔 Dans 20 min — ${ev.start.format('HH:mm')} — salle ${ev.location || '—'} — ${course}`;

        await channel.send({ content: mobileText, embeds: [embed], allowedMentions: { parse: ['roles'] } })
          .catch(e => console.error('❌ [Rappel] Envoi échec :', e.message));
        
        console.log(`📣 Rappel envoyé pour ${course} (${group})`);
      }
    }
  }
}

// Digest quotidien des cours du lendemain à 18h00
async function sendDailyDigest(targetUser = null, dateOverride = null) {
  let target = targetUser;
  if (!target) {
    target = await client.channels.fetch(CONFIG.CHANNEL_ID).catch(() => null);
  }
  
  if (!target) {
    console.error('❌ [Digest] Destination introuvable.');
    return false;
  }

  const baseDate = dateOverride ? dateOverride : dayjs().tz(CONFIG.TIMEZONE);
  const startOfTargetDay = baseDate.add(1, 'day').startOf('day');
  const endOfTargetDay = baseDate.add(1, 'day').endOf('day');

  const groups = ['groupe1', 'groupe2', 'pm'];
  let messageSent = false;

  console.log(`🔎 [Digest] Cible: ${startOfTargetDay.format('DD/MM/YYYY')} (Mode: ${targetUser ? 'PRIVÉ' : 'PUBLIC'})`);

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

    for (const ev of events) {
      const { course, prof } = parseSummary(ev.summary, ev.description);
      let location = (ev.location || 'Inconnue').replace(/^salle\s+/i, ''); 
      const separator = '⎯'.repeat(20); 

      embed.addFields({ 
        name: `⏰ \`${ev.start.format('HH:mm')}\` à \`${ev.end.format('HH:mm')}\``, 
        value: `**__${course}__**\n👨‍🏫 **${prof}**\n📍 Salle ${location}\n${separator}`, 
        inline: false 
      });
    }

    const mentions = getMentions(group);
    const groupLabel = getGroupDisplayName(group);
    const content = targetUser 
      ? `🕵️ **[PREVIEW ADMIN]** Digest pour le **${group}** :` 
      : `👋 Bonsoir ${mentions} (${groupLabel}), n'oubliez pas vos cours de demain !`;

    await target.send({ content: content, embeds: [embed], allowedMentions: { parse: ['roles'] } })
      .catch(e => console.error(`❌ [Digest] Erreur envoi ${group} :`, e.message));
    
    messageSent = true;
  }
  
  return messageSent;
}

/**
 * ==============================================================================
 * 🤖 DISCORD INTERFACE
 * ==============================================================================
 */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

// --- Commandes Texte (Legacy) ---
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content.trim();

  // 1. !test_digest
  if (content === '!test_digest') {
    if (!msg.member.permissions.has('Administrator')) return msg.reply('❌ Admin only.');
    console.log('📋 Commande !test_digest par', msg.author.tag);
    await msg.reply('⏳ Génération du digest (MP)...');

    const now = dayjs().tz(CONFIG.TIMEZONE);
    let dateOverride = null;
    if (now.day() === 5 || now.day() === 6) {
      dateOverride = now.day(7); 
      await msg.author.send("ℹ️ **Note debug :** C'est le week-end, j'affiche le planning de Lundi.");
    }
    const sent = await sendDailyDigest(msg.author, dateOverride);
    if (!sent) await msg.author.send("📭 Aucun cours trouvé.");
    else await msg.reply("✅ Check tes DMs !");
    return;
  }

  // 2. !test_rappel
  if (content === '!test_rappel') {
    if (!msg.member.permissions.has('Administrator')) return msg.reply('❌ Admin only.');
    console.log('📋 Commande !test_rappel par', msg.author.tag);
    await msg.reply('⏳ Envoi d\'un rappel de test...');

    const group = extractGroup(msg.member?.roles?.cache);
    if (!group) return msg.reply("❌ Aucun rôle de groupe détecté sur toi.");

    const now = dayjs().tz(CONFIG.TIMEZONE);
    const fakeStart = now.add(20, 'minute');
    const course = 'Test de rappel';
    const location = 'B101';

    const embed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle('🔔 RAPPEL (TEST) : Cours dans 20 minutes !')
      .addFields(
        { name: '📅 Jour',  value: fakeStart.format('dddd DD/MM'), inline: true },
        { name: '⏰ Heure', value: fakeStart.format('HH:mm'),      inline: true },
        { name: '🏫 Salle', value: location,                        inline: true },
        { name: '📚 Cours', value: course,                          inline: false },
        { name: '👨‍🏫 Prof', value: 'Prof. Test',                    inline: false },
      )
      .setTimestamp();

    const mobileText = `🔔 Dans 20 min — ${fakeStart.format('HH:mm')} — salle ${location} — ${course}`;

    await msg.author.send({ content: mobileText, embeds: [embed] })
      .then(() => msg.reply('✅ Check tes DMs !'))
      .catch(() => msg.reply('❌ Impossible d\'envoyer le DM (ouverts ?).'));
    return;
  }
});

// --- Commandes Slash ---
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
  // 1. /demain
  if (interaction.commandName === 'demain') {
    await interaction.deferReply({ flags: 64 });
    const sent = await sendDailyDigest(interaction.user);
    await interaction.editReply(sent ? '✅ Planning envoyé en MP !' : '📭 Rien de prévu pour demain.');
    return;
  }

  // 2. /jour
  if (interaction.commandName === 'jour') {
    await interaction.deferReply({ flags: 64 });
    const group = extractGroup(interaction.member?.roles?.cache);
    if (!group) return interaction.editReply("❌ Groupe introuvable (Rôles manquants).");

    const now = dayjs().tz(CONFIG.TIMEZONE);
    const dayEvents = eventsCache[group]?.filter(ev => {
        const isSameDay = ev.start.isSame(now, 'day');
        const isLunch = (ev.start.hour() === 12 && ev.start.minute() === 30);
        return isSameDay && !isLunch;
    }) || [];

    if (dayEvents.length === 0) return interaction.editReply('Aucun cours aujourd\'hui.');

    const embed = new EmbedBuilder()
      .setColor(0xF39C12)
      .setTitle(`📅 Cours du jour (${getGroupDisplayName(group)})`)
      .setTimestamp();

    for (const ev of dayEvents) {
      const { course, prof } = parseSummary(ev.summary, ev.description);
      let location = (ev.location || 'Inconnue').replace(/^salle\s+/i, '');
      const separator = '⎯'.repeat(20);
      
      embed.addFields({ 
        name: `⏰ \`${ev.start.format('HH:mm')}\` à \`${ev.end.format('HH:mm')}\``, 
        value: `**__${course}__**\n👨‍🏫 **${prof}**\n📍 Salle ${location}\n${separator}`, 
        inline: false 
      });
    }

    try {
        await interaction.user.send({ embeds: [embed] });
        return interaction.editReply('✅ Planning envoyé en MP !');
    } catch (e) {
        return interaction.editReply('❌ Erreur MP (DMs fermés ?).');
    }
  }

  // 3. /semaine
  if (interaction.commandName === 'semaine') {
      await interaction.deferReply({ flags: 64 });
      const group = extractGroup(interaction.member?.roles?.cache);
      if (!group) return interaction.editReply("❌ Groupe introuvable.");
  
      const now = dayjs().tz(CONFIG.TIMEZONE);
      const startOfWeek = now.startOf('week').add(1, 'day'); // Lundi
      const endOfWeek = startOfWeek.add(5, 'day'); // Vendredi soir
  
      const weekEvents = eventsCache[group]?.filter(ev => 
        ev.start.isAfter(startOfWeek) && ev.start.isBefore(endOfWeek)
      ) || [];
  
      if (weekEvents.length === 0) return interaction.editReply('Aucun cours cette semaine.');
  
      // Groupement
      const byDay = {};
      for (const ev of weekEvents) {
        const dayKey = ev.start.format('dddd DD/MM');
        if (!byDay[dayKey]) byDay[dayKey] = [];
        const { course, prof } = parseSummary(ev.summary, ev.description);
        byDay[dayKey].push({ ...ev, course, prof });
      }

      // TRI : On s'assure que Lundi passe avant Mardi
      const sortedDays = Object.entries(byDay).sort((a, b) => {
        // a[1][0] est le premier cours du jour "a"
        return a[1][0].start.valueOf() - b[1][0].start.valueOf();
      });
  
      const embeds = [];
      let currentEmbed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle(`📅 Cours de la semaine (${getGroupDisplayName(group)})`)
        .setTimestamp();
      
      let fieldCount = 0; // Compteur pour la limite de 25 fields Discord

      for (const [day, events] of sortedDays) {
        const dayHeader = `\n📆 **__${day.charAt(0).toUpperCase() + day.slice(1)}__**\n${'━'.repeat(25)}`;
        
        // Sécurité : Si ajouter le header + les cours dépasse 25, on split
        // (Note: on laisse une marge de sécurité)
        if (fieldCount + 1 + events.length > 25) {
          embeds.push(currentEmbed);
          currentEmbed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle(`📅 Suite de la semaine (${getGroupDisplayName(group)})`)
            .setTimestamp();
          fieldCount = 0;
        }

        currentEmbed.addFields({ name: '\u200b', value: dayHeader, inline: false });
        fieldCount++;
  
        for (const ev of events) {
          // Double check sécurité au cas où un jour unique est énorme
          if (fieldCount >= 25) {
            embeds.push(currentEmbed);
            currentEmbed = new EmbedBuilder().setColor(0x9B59B6).setTitle('📅 Suite...').setTimestamp();
            fieldCount = 0;
          }

          let location = (ev.location || 'Inconnue').replace(/^salle\s+/i, '');
          currentEmbed.addFields({ 
            name: `⏰ \`${ev.start.format('HH:mm')}\` à \`${ev.end.format('HH:mm')}\``, 
            value: `**__${ev.course}__**\n👨‍🏫 **${ev.prof}**\n📍 Salle ${location}`, 
            inline: false 
          });
          fieldCount++;
        }
      }
      
      // Ne pas oublier d'ajouter le dernier embed en cours
      embeds.push(currentEmbed);
  
      try {
        await interaction.user.send({ embeds: embeds });
        return interaction.editReply('✅ Planning semaine envoyé en MP !');
      } catch (e) {
        return interaction.editReply('❌ Erreur MP (DMs fermés ?).');
      }
  }

  // 4. /prochain_cours
  if (interaction.commandName === 'prochain_cours') {
    await interaction.deferReply(); 
    
    const group = extractGroup(interaction.member?.roles?.cache);
    if (!group) return interaction.editReply("❌ Rôle introuvable.");
    
    const next = getNextEvent(dayjs().tz(CONFIG.TIMEZONE), group);
    if (!next) return interaction.editReply('Aucun cours à venir.');

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
        
    return interaction.editReply({ embeds: [embed] });
  }

  } catch (err) {
    console.error(`❌ [Slash] Erreur sur /${interaction.commandName} :`, err.message);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('❌ Une erreur est survenue.');
      } else {
        await interaction.reply({ content: '❌ Une erreur est survenue.', flags: 64 });
      }
    } catch (_) {
      // L'interaction est expirée, on ignore
    }
  }
});

/**
 * ==============================================================================
 * 🚀 STARTUP & SCHEDULING
 * ==============================================================================
 */
client.once('ready', async () => {
  console.log(`🤖 Connecté en tant que ${client.user.tag}`);
  client.user.setActivity('tes cours HETIC', { type: 3 }); 

  // 1. Chargement initial
  await loadCalendar(CONFIG.ICS.groupe1, 'groupe1');
  await loadCalendar(CONFIG.ICS.groupe2, 'groupe2');
  await loadCalendar(CONFIG.ICS.pm, 'pm');

  // DEBUG: Vérification des rôles et événements chargés
  console.log('🔍 [Debug] ROLES configurés :', JSON.stringify(CONFIG.ROLES));
  for (const [group, events] of Object.entries(eventsCache)) {
    console.log(`🔍 [Debug] ${group}: ${events.length} événements en cache`);
  }

  // 2. Enregistrement des commandes
  const commands = [
    { name: 'prochain_cours', description: 'Affiche le prochain cours de ton groupe' },
    { name: 'semaine', description: 'Envoie le planning de la semaine en MP' },
    { name: 'jour', description: 'Envoie le planning du jour en MP' },
    { name: 'demain', description: 'Envoie le résumé des cours de demain en MP' }
  ];

  try {
    if (CONFIG.GUILD_ID) {
      const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
      for (const cmd of commands) await guild.commands.create(cmd);
      console.log('✅ Commandes slash enregistrées (Guild).');
    } else {
      for (const cmd of commands) await client.application.commands.create(cmd);
      console.log('✅ Commandes slash enregistrées (Global).');
    }
  } catch (e) {
    console.error('❌ Erreur slash commands :', e.message);
  }

  // 3. Boucles
  setInterval(loopReminders, 30 * 1000); 

  // Cron Digest (18h00)
  cron.schedule('0 18 * * *', async () => {
    console.log('🌇 [Cron] Digest quotidien…');
    await sendDailyDigest();
  }, { timezone: CONFIG.TIMEZONE });

  // Cron Nettoyage Mémoire (03h00 matin) - Remplacement du cron de 8h qui était incomplet
  cron.schedule('0 3 * * *', () => {
    console.log('🧹 [Cleanup] Nettoyage préventif sentKeys...');
    sentKeys.clear();
  }, { timezone: CONFIG.TIMEZONE });

  // Cron Refresh (Toutes les heures)
  cron.schedule('0 * * * *', async () => {
    console.log('🔁 [Cron] Refresh périodique…');
    await loadCalendar(CONFIG.ICS.groupe1, 'groupe1');
    await loadCalendar(CONFIG.ICS.groupe2, 'groupe2');
    await loadCalendar(CONFIG.ICS.pm, 'pm');
  }, { timezone: CONFIG.TIMEZONE });
});

client.login(CONFIG.TOKEN).catch(err => {
  console.error('❌ Échec connexion Discord :', err.message);
});