const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
const NTFY_TOPIC = 'Jarvis-Rick6868';

let lastUpdateId = 0;
let processedUpdates = new Set();
let tasks = [];

// ── Salud del servidor ──
app.get('/', (req, res) => res.send('Jarvis bot activo ✅'));

// ── Enviar mensaje a Telegram ──
async function sendToTelegram(text) {
  try {
    const r = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' })
    });
    const d = await r.json();
    if (!d.ok) console.error('Telegram error:', JSON.stringify(d));
  } catch (e) {
    console.error('Error enviando a Telegram:', e.message);
  }
}

// ── Enviar alarma por ntfy ──
async function sendAlarmNtfy(text) {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        'Title': 'Recordatorio de Jarvis',
        'Priority': 'urgent',
        'Tags': 'alarm_clock',
        'Content-Type': 'text/plain'
      },
      body: text
    });
    console.log('ntfy enviado correctamente');
  } catch (e) {
    console.error('Error enviando a ntfy:', e.message);
  }
}

// ── Transcribir audio con Whisper ──
async function transcribeAudio(fileId) {
  try {
    // 1. Obtener URL del archivo en Telegram
    const fileRes = await fetch(`${TG_API}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    const filePath = fileData.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`;

    console.log(`[AUDIO] Descargando: ${fileUrl}`);

    // 2. Descargar el audio
    const audioRes = await fetch(fileUrl);
    const audioBuffer = await audioRes.buffer();

    // 3. Enviar a Whisper
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-1');
    form.append('language', 'es');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        ...form.getHeaders()
      },
      body: form
    });

    const whisperData = await whisperRes.json();
    console.log(`[AUDIO] Transcripción: ${whisperData.text}`);
    return whisperData.text || null;

  } catch (e) {
    console.error('[AUDIO] Error transcribiendo:', e.message);
    return null;
  }
}

// ── Programar alarma ──
function scheduleAlarm(taskText, alarmTime, repeat) {
  const alarmDate = new Date(alarmTime);
  const diff = alarmDate.getTime() - Date.now();

  console.log(`[ALARM] Programando: "${taskText}" para ${alarmDate.toISOString()} (diff: ${diff}ms)`);

  if (isNaN(diff) || diff <= 0) {
    console.log(`[ALARM] Hora inválida o en el pasado, ignorando.`);
    return;
  }

  setTimeout(async () => {
    console.log(`[ALARM] 🔔 DISPARANDO: ${taskText}`);
    await sendToTelegram(`🔔 *¡Recordatorio!*\n\n${taskText}`);
    await sendAlarmNtfy(taskText);

    if (repeat) {
      const next = new Date(alarmTime);
      if (repeat === 'diario') next.setDate(next.getDate() + 1);
      else if (repeat === 'semanal') next.setDate(next.getDate() + 7);
      scheduleAlarm(taskText, next.toISOString(), repeat);
    }
  }, diff);
}

// ── Procesar mensaje con Claude ──
async function processWithClaude(text) {
  const now = new Date().toLocaleString('es-ES', { timeZone: 'America/Bogota' });
  const isoNow = new Date().toISOString();

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `Eres Jarvis, asistente personal. Hora actual Colombia: ${now}. ISO actual: ${isoNow}.

Devuelve SIEMPRE solo un JSON sin markdown:
{
  "reply": "respuesta en español confirmando con hora exacta",
  "tasks": [{"text": "tarea", "alarmTime": "ISO8601 con offset -05:00", "repeat": "diario|semanal|null"}]
}

IMPORTANTE:
- "en X minutos" = suma X minutos al ISO actual
- "en 1 minuto" = suma 60 segundos al ISO actual
- alarmTime NUNCA puede ser null si el usuario pide recordatorio
- Zona horaria Colombia = UTC-5 = -05:00
- Ejemplo alarmTime correcto: 2026-04-07T13:35:00-05:00`,
        messages: [{ role: 'user', content: text }]
      })
    });

    const data = await res.json();

    if (!data.content || !Array.isArray(data.content)) {
      console.error('Claude error:', JSON.stringify(data));
      return { reply: '⚠️ Error: ' + (data.error?.message || 'respuesta inesperada'), tasks: [] };
    }

    const raw = data.content.map(c => c.text || '').join('');
    console.log('[CLAUDE] Raw:', raw.slice(0, 400));

    try {
      return JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return { reply: raw || 'No pude procesar eso.', tasks: [] };
    }

  } catch (e) {
    console.error('Error Claude:', e.message);
    return { reply: 'Error con la IA.', tasks: [] };
  }
}

// ── Polling de Telegram ──
async function pollTelegram() {
  try {
    const res = await fetch(`${TG_API}/getUpdates?timeout=20&offset=${lastUpdateId + 1}`);
    const data = await res.json();

    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        if (processedUpdates.has(update.update_id)) continue;
        processedUpdates.add(update.update_id);
        lastUpdateId = update.update_id;

        const msg = update.message;
        if (!msg) continue;

        let text = null;

        // Mensaje de texto normal
        if (msg.text) {
          text = msg.text;
          console.log(`[TG] Texto: ${text}`);
        }
        // Mensaje de voz
        else if (msg.voice) {
          console.log(`[TG] Audio recibido, transcribiendo...`);
          await sendToTelegram('🎤 Escuchando tu mensaje de voz...');
          text = await transcribeAudio(msg.voice.file_id);
          if (text) {
            console.log(`[TG] Audio transcrito: ${text}`);
            await sendToTelegram(`📝 Entendí: _"${text}"_`);
          } else {
            await sendToTelegram('No pude entender el audio. ¿Puedes escribirlo?');
            continue;
          }
        }
        // Nota de voz larga
        else if (msg.audio) {
          console.log(`[TG] Audio largo recibido, transcribiendo...`);
          await sendToTelegram('🎤 Escuchando tu mensaje de voz...');
          text = await transcribeAudio(msg.audio.file_id);
          if (text) {
            await sendToTelegram(`📝 Entendí: _"${text}"_`);
          } else {
            await sendToTelegram('No pude entender el audio. ¿Puedes escribirlo?');
            continue;
          }
        } else {
          continue;
        }

        const parsed = await processWithClaude(text);
        await sendToTelegram(parsed.reply);

        if (parsed.tasks && parsed.tasks.length > 0) {
          for (const t of parsed.tasks) {
            console.log(`[TASK] text="${t.text}" alarmTime="${t.alarmTime}" repeat="${t.repeat}"`);
            tasks.push({ text: t.text, alarmTime: t.alarmTime, repeat: t.repeat });
            if (t.alarmTime) {
              scheduleAlarm(t.text, t.alarmTime, t.repeat);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Error polling:', e.message);
  }

  setTimeout(pollTelegram, 3000);
}

// ── Arrancar ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Jarvis corriendo en puerto ${PORT}`);
  sendToTelegram('🤖 *Jarvis está en línea*\n\nEscríbeme o mándame un audio con tu tarea.');
  pollTelegram();
});
