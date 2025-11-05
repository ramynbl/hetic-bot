
require('dotenv').config();
const ical = require('node-ical');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const TIMEZONE = process.env.TIMEZONE || 'Europe/Paris';
const ICS_URL_GROUPE1  = process.env.ICS_URL_GROUPE1
const ICS_URL_GROUPE2  = process.env.ICS_URL_GROUPE2;
const ICS_FILE = process.env.ICS_FILE; 

// Fonction principale
async function readCalendar(group) {
  try {
    let data;
    if (group === 'groupe1') {
      data = await ical.async.fromURL(ICS_URL_GROUPE1);
    } else if (group === 'groupe2') {
      data = await ical.async.fromURL(ICS_URL_GROUPE2);
    }

    // événements à venir sur 7 jours
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

    // affichage des cours
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

    // affichage du prochain cours
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

readCalendar('groupe1');
