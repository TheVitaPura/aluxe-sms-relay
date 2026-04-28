const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const https = require("https");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 3000;
const OPENPHONE_KEY  = process.env.OPENPHONE_API_KEY;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const QUO_NUMBER     = process.env.QUO_PHONE_NUMBER;    // "+16234002146"
const KEVIN_PERSONAL = process.env.KEVIN_PERSONAL_PHONE;
const DATABASE_URL   = process.env.DATABASE_URL;

// ── Brain v7 system prompt ────────────────────────────────────────────────────
const BRAIN_V7 = fs.readFileSync(`${__dirname}/brain-v7.txt`, "utf8");

const SYSTEM_PROMPT = `${BRAIN_V7}

---
CHANNEL CONTEXT: You are responding via SMS text message. Keep all replies SHORT — 2 to 4 sentences max. SMS is not Instagram DM. No walls of text. Get to the point fast. Still sound like Kevin.

IMPORTANT: Do NOT include any preamble, asterisks, markdown, or labels like "Response:". Just the text Kevin would actually send.
`;

const REFERRAL_SYSTEM = `${BRAIN_V7}

---
TASK: Kevin just sent you a referral. Write the FIRST text message Kevin would send to this new lead.
Rules: 2-3 sentences max. Warm, direct, no pressure. Reference what Kevin heard about them from the referral source (context provided). Do NOT reveal it was automated or that Kevin got a referral tip — just reach out naturally as Kevin.
Output ONLY the text message. No labels, no markdown.
`;

// ── PostgreSQL setup (persistent conversation history) ────────────────────────
let pool = null;

async function initDB() {
  if (!DATABASE_URL) {
    console.log("No DATABASE_URL — using in-memory conversation store.");
    return;
  }
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_conversations (
      phone       TEXT PRIMARY KEY,
      messages    JSONB NOT NULL DEFAULT '[]',
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("PostgreSQL connected — conversation history is persistent.");
}

// ── In-memory fallback (used when no DATABASE_URL) ────────────────────────────
const memStore = new Map();

// ── Conversation helpers ──────────────────────────────────────────────────────
async function getMessages(phone) {
  if (pool) {
    const { rows } = await pool.query(
      "SELECT messages FROM sms_conversations WHERE phone = $1",
      [phone]
    );
    return rows.length ? rows[0].messages : [];
  }
  return memStore.get(phone) || [];
}

async function saveMessages(phone, messages) {
  // Cap at 20 to control token usage
  const capped = messages.slice(-20);
  if (pool) {
    await pool.query(
      `INSERT INTO sms_conversations (phone, messages, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (phone) DO UPDATE
         SET messages = $2, updated_at = NOW()`,
      [phone, JSON.stringify(capped)]
    );
  } else {
    memStore.set(phone, capped);
  }
  return capped;
}

// ── Dedup set ─────────────────────────────────────────────────────────────────
const processedIds = new Set();

const claude = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── OpenPhone API helper ──────────────────────────────────────────────────────
function sendSMS(to, content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ from: QUO_NUMBER, to: [to], content });
    const req = https.request(
      {
        hostname: "api.openphone.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          Authorization: OPENPHONE_KEY,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`OpenPhone ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Claude helper ─────────────────────────────────────────────────────────────
async function askClaude(systemPrompt, messages) {
  const response = await claude.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: systemPrompt,
    messages,
  });
  return response.content[0].text.trim();
}

// ── Referral parser ───────────────────────────────────────────────────────────
function parseReferral(body) {
  const stripped = body.replace(/^referral:\s*/i, "").trim();
  const parts = stripped.split(",").map((s) => s.trim());
  if (parts.length < 2) return null;
  const name    = parts[0];
  const phone   = parts[1].replace(/\s/g, "");
  const context = parts.slice(2).join(", ");
  if (!/^\+?1?\d{10}$/.test(phone.replace(/\D/g, ""))) return null;
  const normalized = phone.startsWith("+") ? phone : `+1${phone.replace(/\D/g, "")}`;
  return { name, phone: normalized, context };
}

// ── Webhook route ─────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const event = req.body;
    if (event?.type !== "message.received") return;

    const msg = event?.data?.object;
    if (!msg || msg.direction !== "inbound") return;

    const messageId = msg.id;
    const from      = msg.from;
    const body      = (msg.body || "").trim();

    if (processedIds.has(messageId)) return;
    processedIds.add(messageId);
    if (processedIds.size > 1000) {
      [...processedIds].slice(0, 200).forEach((id) => processedIds.delete(id));
    }

    console.log(`[IN] ${from}: ${body}`);

    // ── Referral trigger ────────────────────────────────────────────────────
    const isKevin    = KEVIN_PERSONAL && from === KEVIN_PERSONAL;
    const isReferral = isKevin && /^referral:/i.test(body);

    if (isReferral) {
      const ref = parseReferral(body);
      if (!ref) {
        await sendSMS(from, "Couldn't parse that referral. Format: Referral: Name, +1phone, context");
        return;
      }
      const intro = await askClaude(REFERRAL_SYSTEM, [
        {
          role: "user",
          content: `Referral name: ${ref.name}\nReferral context: ${ref.context || "none provided"}\nWrite Kevin's opening text to ${ref.name}.`,
        },
      ]);
      await sendSMS(ref.phone, intro);
      await sendSMS(from, `Sent to ${ref.name} (${ref.phone}): "${intro}"`);
      console.log(`[REFERRAL] Sent intro to ${ref.phone}: ${intro}`);
      return;
    }

    if (isKevin) return;

    // ── Normal inbound — load history, call Claude, save ───────────────────
    const history = await getMessages(from);
    history.push({ role: "user", content: body });

    const reply = await askClaude(SYSTEM_PROMPT, history);
    history.push({ role: "assistant", content: reply });

    await saveMessages(from, history);
    await sendSMS(from, reply);
    console.log(`[OUT] ${from}: ${reply}`);
  } catch (err) {
    console.error("[ERROR]", err.message);
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", ts: new Date().toISOString(), db: !!pool }));

// ── Startup ───────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`ALUXÉ SMS Relay v2 running on port ${PORT}`);
    if (!OPENPHONE_KEY || !ANTHROPIC_KEY || !QUO_NUMBER) {
      console.warn("WARNING: Missing env vars. Check Railway environment variables.");
    }
  });
}).catch((err) => {
  console.error("DB init failed:", err.message);
  process.exit(1);
});
