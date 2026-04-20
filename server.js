const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const https = require("https");

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const PORT            = process.env.PORT || 3000;
const OPENPHONE_KEY   = process.env.OPENPHONE_API_KEY;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const QUO_NUMBER      = process.env.QUO_PHONE_NUMBER;   // "+16234002146"
const KEVIN_PERSONAL  = process.env.KEVIN_PERSONAL_PHONE; // "+18324543136" (or current personal)
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || "";

// ── Brain v6 system prompt ────────────────────────────────────────────────────
const BRAIN_V6 = fs.readFileSync(`${__dirname}/brain-v6.txt`, "utf8");

const SYSTEM_PROMPT = `${BRAIN_V6}

---
CHANNEL CONTEXT: You are responding via SMS text message. Keep all replies SHORT — 2 to 4 sentences max. SMS is not Instagram DM. No walls of text. Get to the point fast. Still sound like Kevin.

IMPORTANT: Do NOT include any preamble, asterisks, markdown, or labels like "Response:". Just the text Kevin would actually send.
`;

const REFERRAL_SYSTEM = `${BRAIN_V6}

---
TASK: Kevin just sent you a referral. Write the FIRST text message Kevin would send to this new lead.
Rules: 2-3 sentences max. Warm, direct, no pressure. Reference what Kevin heard about them from the referral source (context provided). Do NOT reveal it was automated or that Kevin got a referral tip — just reach out naturally as Kevin.
Output ONLY the text message. No labels, no markdown.
`;

// ── State ─────────────────────────────────────────────────────────────────────
// Conversation history: Map<fromPhone, { messages: [], lastActivity: Date }>
const conversations = new Map();
// Dedup: Set of processed message IDs
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

// ── Conversation helpers ──────────────────────────────────────────────────────
function getConversation(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, { messages: [], lastActivity: new Date() });
  }
  const conv = conversations.get(phone);
  conv.lastActivity = new Date();
  return conv;
}

function addToConversation(phone, role, content) {
  const conv = getConversation(phone);
  conv.messages.push({ role, content });
  // Cap history at 20 messages to save tokens
  if (conv.messages.length > 20) {
    conv.messages = conv.messages.slice(-20);
  }
}

// ── Referral parser ───────────────────────────────────────────────────────────
// Kevin texts: "Referral: Sarah Johnson, +16025551234, interested in Botox for her 11s"
function parseReferral(body) {
  const stripped = body.replace(/^referral:\s*/i, "").trim();
  const parts = stripped.split(",").map((s) => s.trim());
  if (parts.length < 2) return null;
  const name    = parts[0];
  const phone   = parts[1].replace(/\s/g, "");
  const context = parts.slice(2).join(", ");
  // Basic phone validation
  if (!/^\+?1?\d{10}$/.test(phone.replace(/\D/g, ""))) return null;
  const normalized = phone.startsWith("+") ? phone : `+1${phone.replace(/\D/g, "")}`;
  return { name, phone: normalized, context };
}

// ── Webhook route ─────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Acknowledge immediately — OpenPhone expects fast 200
  res.sendStatus(200);

  try {
    const event = req.body;
    if (event?.type !== "message.received") return;

    const msg = event?.data?.object;
    if (!msg || msg.direction !== "inbound") return;

    const messageId = msg.id;
    const from      = msg.from;
    const body      = (msg.body || "").trim();

    // Dedup
    if (processedIds.has(messageId)) return;
    processedIds.add(messageId);
    // Clean up old IDs after 1000 entries
    if (processedIds.size > 1000) {
      const oldest = [...processedIds].slice(0, 200);
      oldest.forEach((id) => processedIds.delete(id));
    }

    console.log(`[IN] ${from}: ${body}`);

    // ── Referral trigger (Kevin texting his own number) ─────────────────────
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
      console.log(`[REFERRAL] Sent intro to ${ref.phone}: ${intro}`);
      // Confirm to Kevin
      await sendSMS(from, `Sent to ${ref.name} (${ref.phone}): "${intro}"`);
      return;
    }

    // ── Skip Kevin texting himself (non-referral) ───────────────────────────
    if (isKevin) return;

    // ── Normal inbound — run Brain v6 ──────────────────────────────────────
    addToConversation(from, "user", body);
    const conv = getConversation(from);

    const reply = await askClaude(SYSTEM_PROMPT, conv.messages);
    addToConversation(from, "assistant", reply);

    await sendSMS(from, reply);
    console.log(`[OUT] ${from}: ${reply}`);
  } catch (err) {
    console.error("[ERROR]", err.message);
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// ── Startup ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ALUXÉ SMS Relay running on port ${PORT}`);
  if (!OPENPHONE_KEY || !ANTHROPIC_KEY || !QUO_NUMBER) {
    console.warn("WARNING: Missing env vars. Check .env configuration.");
  }
});
