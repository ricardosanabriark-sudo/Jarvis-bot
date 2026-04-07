const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

let lastUpdateId = 0;

// ── Salud del servidor ──
app.get('/', (req, res) => res.send('Jarvis bot activo ✅'));

// ── Enviar mensaje a Telegram ──
async function sendToTelegram(text) {
  try {
    await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' })
    });
  } catch (e) {
    console.error('Error enviando a Telegram:', e.message);
  }
}

// ── Procesar mensaje con Claude ──
async function processWithClaude(text) {
  const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

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
        system: `Eres Jarvis, un asistente personal de organización. La fecha y hora actual es: ${now}.

Tu trabajo es interpretar lo que el usuario quiere recordar y devolver SIEMPRE un JSON exacto (sin markdown, sin texto extra):

{
  "reply": "respuesta amigable en español confirmando la tarea",
  "tasks": [
    {
      "text": "descripción clara de la tarea",
      "alarmTime": "ISO 8601 datetime o null",
      "repeat": "diario|semanal|null"
    }
  ]
}

Reglas:
- "mañana" → calcula la fecha real
- Hora sin fecha → asume hoy
- "todos los días" → repeat: "diario"
- "cada semana" → repeat: "semanal"
- Siempre responde en español
- reply debe confirmar la hora exacta programada
- Si el mensaje no es una tarea (saludo, pregunta general, etc.), devuelve tasks: [] y responde amigablemente`,
        messages: [{ role: 'user', content: text }]
      })
    });

    const data = await res.json();
    console.log('Claude status:', res.status, JSON.stringify(data).slice(0, 200));

    if (!data.content || !Array.isArray(data.content)) {
      console.error('Claude error response:', JSON.stringify(data));
      return { reply: '⚠️ Error con la IA: ' + (data.error?.message || 'respuesta inesperada'), tasks: [] };
    }

    const raw = data.content.map(c => c.text || '').join('');
    try {
      return JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return { reply: raw || 'No pude procesar eso. ¿Puedes reformularlo?', tasks: [] };
    }

  } catch (e) {
    console.error('Error llamando a Claude:', e.message);
    return { reply: 'Error conectando con la IA. Intenta de nuevo.', tasks: [] };
  }
}

// ── Almacén de tareas en memoria ──
let tasks = [];

// ── Programar alarmas ──
function scheduleAlarm(task, index) {
  if (!task.alarmTime) return;
  const diff = new Date(task.alarmTime).getTime() - Date.now();
  if (diff <= 0) return;

  setTimeout(async () => {
    await sendToTelegram(`🔔 *¡Recordatorio!*\n\n${task.task_text}`);

    if (task.repeat) {
      const next = new Date(task.alarmTime);
      if (task.repeat === 'diario') next.setDate(next.getDate() + 1);
      else if (task.repeat === 'semanal') next.setDate(next.getDate() + 7);
      tasks[index].alarmTime = next.toISOString();
      scheduleAlarm(tasks[index], index);
    }
  }, diff);
}

// ── Polling de Telegram ──
async function pollTelegram() {
  try {
    const res = await fetch(`${TG_API}/getUpdates?timeout=20&offset=${lastUpdateId + 1}`);
    const data = await res.json();

    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg || !msg.text) continue;

        console.log(`Mensaje recibido: ${msg.text}`);

        const parsed = await processWithClaude(msg.text);

        await sendToTelegram(parsed.reply);

        if (parsed.tasks && parsed.tasks.length > 0) {
          parsed.tasks.forEach(t => {
            const newTask = {
              task_text: t.text,
              alarmTime: t.alarmTime || null,
              repeat: t.repeat || null
            };
            const idx = tasks.length;
            tasks.push(newTask);
            scheduleAlarm(newTask, idx);
            console.log(`Tarea guardada: ${t.text}`);
          });
        }
      }
    }
  } catch (e) {
    console.error('Error polling:', e.message);
  }

  setTimeout(pollTelegram, 3000);
}

// ── API para la app web ──
app.get('/tasks', (req, res) => res.json(tasks));

app.post('/tasks', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Sin texto' });

  const parsed = await processWithClaude(text);

  if (parsed.tasks && parsed.tasks.length > 0) {
    parsed.tasks.forEach(t => {
      const newTask = { task_text: t.text, alarmTime: t.alarmTime || null, repeat: t.repeat || null };
      const idx = tasks.length;
      tasks.push(newTask);
      scheduleAlarm(newTask, idx);
    });
    await sendToTelegram(`✅ *Tarea añadida desde la web*\n\n${parsed.tasks.map(t => `• ${t.text}`).join('\n')}`);
  }

  res.json(parsed);
});

// ── Arrancar ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Jarvis corriendo en puerto ${PORT}`);
  sendToTelegram('🤖 *Jarvis está en línea*\n\nEscríbeme cualquier tarea o recordatorio.');
  pollTelegram();
});
