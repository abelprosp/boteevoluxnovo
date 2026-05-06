require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "15mb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || "moonshotai/kimi-k2.6";
const DEFAULT_SYSTEM_PROMPT =
  process.env.AI_SYSTEM_PROMPT ||
  "Você é Luiza, assistente de RH da EvoluxRH. Seja educada, clara e objetiva.";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente antes de iniciar."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function normalizeResumePayload(body) {
  const payload = {
    candidate_name: body.fullName ?? body.candidate_name ?? null,
    candidate_email: body.email ?? body.candidate_email ?? null,
    candidate_phone: body.phone ?? body.candidate_phone ?? null,
    city: body.city ?? null,
    position_of_interest: body.jobInterest ?? body.position_of_interest ?? null,
    file_name: body.fileName ?? body.file_name ?? null,
    file_path: body.filePath ?? body.file_path ?? null,
    file_size:
      body.fileSize != null
        ? Number(body.fileSize)
        : body.file_size != null
        ? Number(body.file_size)
        : null,
    file_type: body.mimetype ?? body.file_type ?? null,
    file_url: body.fileUrl ?? body.file_url ?? null,
  };

  if (!payload.candidate_phone) {
    throw new Error("Campo obrigatório ausente: phone/candidate_phone");
  }

  return payload;
}

function normalizeChatPayload(body) {
  const chatInput = String(body.chatInput ?? body.message ?? "").trim();
  const sessionId = String(body.sessionId ?? body.phone ?? "default");
  const phone = String(body.phone ?? "").replace(/\D/g, "");
  const history = Array.isArray(body.history) ? body.history : [];

  if (!chatInput) {
    throw new Error("Campo obrigatório ausente: chatInput/message");
  }

  return { chatInput, sessionId, phone, history };
}

async function askAI({ chatInput, history }) {
  if (!NVIDIA_API_KEY) {
    throw new Error("Defina NVIDIA_API_KEY no ambiente.");
  }

  const messages = [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }];

  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    if (!["system", "user", "assistant"].includes(item.role)) continue;
    if (typeof item.content !== "string") continue;
    messages.push({ role: item.role, content: item.content });
  }

  messages.push({ role: "user", content: chatInput });

  const response = await fetch(
    "https://integrate.api.nvidia.com/v1/chat/completions",
    {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      max_tokens: 16384,
      temperature: 1,
      top_p: 1,
      stream: false,
      chat_template_kwargs: { thinking: true },
      messages,
    }),
  }
  );

  const data = await response.json();

  if (!response.ok) {
    const detail = data?.error?.message || "Erro ao consultar IA da NVIDIA";
    throw new Error(detail);
  }

  return data?.choices?.[0]?.message?.content?.trim() || "";
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/webhook/chat", async (req, res) => {
  try {
    const payload = normalizeChatPayload(req.body);
    const aiMessage = await askAI(payload);

    if (!aiMessage) {
      return res.status(502).json({
        ok: false,
        error: "IA retornou resposta vazia",
      });
    }

    return res.json({
      ok: true,
      sessionId: payload.sessionId,
      phone: payload.phone || null,
      message: aiMessage,
      mychatPayload: {
        number: payload.phone || payload.sessionId,
        body: aiMessage,
        externalKey: `lead_${payload.phone || payload.sessionId}`,
        isClosed: false,
      },
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: "Falha ao processar mensagem com IA",
      details: err.message,
    });
  }
});

app.post("/webhook/resume", async (req, res) => {
  try {
    const data = normalizeResumePayload(req.body);

    const { data: inserted, error } = await supabase
      .from("resumes")
      .insert(data)
      .select("*")
      .single();

    if (error) {
      return res.status(500).json({
        ok: false,
        error: "Erro ao salvar currículo no Supabase",
        details: error.message,
      });
    }

    return res.status(201).json({
      ok: true,
      message: "Currículo salvo com sucesso",
      resume: inserted,
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: "Payload inválido",
      details: err.message,
    });
  }
});

app.get("/jobs", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);

  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return res.status(500).json({
      ok: false,
      error: "Erro ao consultar vagas",
      details: error.message,
    });
  }

  return res.json({
    ok: true,
    count: data.length,
    jobs: data,
  });
});

module.exports = app;
