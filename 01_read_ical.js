// 01_read_ical.js
// ===============================
// Objectif : lire ton planning iCal (via URL ou fichier local)
// et afficher les cours à venir dans la semaine
// ===============================

// 1) On charge les librairies
require('dotenv').config();
const ical = require('node-ical');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

// 2) On récupère les infos du fichier .env
const TIMEZONE = process.env.TIMEZONE || 'Europe/Paris';
const ICS_URL  = process.env.ICS_URL;
const ICS_FILE = process.env.ICS_FILE; // si tu veux utiliser ton fichier local .ical

// 3) Fonction principale
async function readCalendar() {
  try {
    let data;

    // --- Si on a un fichier local ---
    if (ICS_FILE) {
      const fs = require('fs');
      const raw = fs.readFileSync(ICS_FILE, 'utf8');
      data = ical.sync.parseICS(raw);
    }
    // --- Sinon on va chercher directement l'URL du planning ---
    else {
      data = await ical.async.fromURL(ICS_URL);
    }

    // --- On prend les événements à venir sur 7 jours ---
    const now = dayjs().tz(TIMEZONE);
    const in7 = now.add(7, 'day');

    const events = Object.values(data)
      .filter(e => e.type === 'VEVENT' && e.start && e.end)
      .filter(e => {
        const start = dayjs(e.start).tz(TIMEZONE);
        return start.isAfter(now) && start.isBefore(in7);
      })
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    if (events.length === 0) {
      console.log('Aucun cours dans les 7 prochains jours.');
      return;
    }

    // --- On affiche chaque cours trouvé ---
    console.log(`=== Prochains cours (jusqu'à ${in7.format('DD/MM HH:mm')}) ===`);
    for (const ev of events) {
      const start = dayjs(ev.start).tz(TIMEZONE).format('dddd DD/MM HH:mm');
      const end   = dayjs(ev.end).tz(TIMEZONE).format('HH:mm');
      console.log(`• ${start}–${end} | ${ev.summary || '(Sans titre)'} | Salle: ${ev.location || '—'}`);
      if (ev.description) {
        const firstLine = String(ev.description).split('\n').find(Boolean);
        if (firstLine) console.log(`    ${firstLine}`);
      }
    }

    // --- On affiche le prochain cours ---
    const next = events[0];
    const nextStart = dayjs(next.start).tz(TIMEZONE);
    console.log('\nProchain cours →');
    console.log({
      jour: nextStart.format('dddd'),
      date: nextStart.format('DD/MM'),
      heure: nextStart.format('HH:mm'),
      salle: next.location || '—',
      cours: next.summary || '(Sans titre)',
      prof: next.description ? String(next.description).split('\n').find(Boolean) : '—'
    });

  } catch (err) {
    console.error('Erreur de lecture iCal :', err.message);
    console.error('Astuce : si l’URL échoue, ajoute ICS_FILE=./file.ical dans .env et place file.ical dans le dossier.');
  }
}

// 4) On lance la fonction
readCalendar();
