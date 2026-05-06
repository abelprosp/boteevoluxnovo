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
const contextMemory = new Map();

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

function isDocumentLikeInRaw(raw) {
  if (!raw || typeof raw !== "object") return false;
  const c = raw.content ?? raw.message ?? {};
  const t = String(c.type || raw.type || "").toLowerCase();
  if (t === "document" || t === "image") return true;
  if (c.document || c.image || raw.document || raw.image) return true;
  if (raw.messages?.[0]?.message?.documentMessage) return true;
  return false;
}

function pickFileMetaFromObject(obj) {
  if (!obj || typeof obj !== "object") return {};
  const fileName = obj.fileName || obj.filename || obj.file_name || null;
  const mimetype = String(
    obj.mimetype || obj.mimeType || obj.mime_type || ""
  ).toLowerCase();
  const mediaBase64 =
    obj.base64 || obj.media || obj.mediaBase64 || obj.data || null;
  return { fileName, mimetype, mediaBase64 };
}

function enrichChatPayload(payload, body) {
  const roots = [
    body,
    payload.rawPayload,
    body?.body,
    payload.rawPayload?.body,
  ].filter((x) => x && typeof x === "object");

  for (const root of roots) {
    if (!payload.mediaBase64 && root.mediaBase64) {
      payload.mediaBase64 = root.mediaBase64;
    }
    const c = root.content || root.message || {};
    const doc = c.document || c.documentMessage || c.image || root.document;
    if (doc && typeof doc === "object") {
      const p = pickFileMetaFromObject(doc);
      if (!payload.mediaBase64 && p.mediaBase64)
        payload.mediaBase64 = p.mediaBase64;
      if (!payload.fileName && p.fileName) payload.fileName = p.fileName;
      if (!payload.mimetype && p.mimetype) payload.mimetype = p.mimetype;
    }
    const dm = root.messages?.[0]?.message?.documentMessage;
    if (dm && typeof dm === "object") {
      const p = pickFileMetaFromObject(dm);
      if (!payload.fileName && p.fileName) payload.fileName = p.fileName;
      if (!payload.mimetype && p.mimetype) payload.mimetype = p.mimetype;
    }
  }

  if (!payload.mediaBase64) {
    for (const root of roots) {
      const found = deepFindBase64String(root);
      if (found) {
        payload.mediaBase64 = found;
        break;
      }
    }
  }

  if (!payload.fileName && !payload.mimetype && isDocumentLikeInRaw(payload.rawPayload)) {
    payload.mimetype = payload.mimetype || "application/pdf";
  }
}

function normalizeChatPayload(body) {
  let chatInput = String(body.chatInput ?? body.message ?? "").trim();
  const sessionId = String(body.sessionId ?? body.phone ?? "default");
  const phone = String(body.phone ?? "").replace(/\D/g, "");
  const history = Array.isArray(body.history) ? body.history : [];
  let mediaBase64 = body.mediaBase64 || null;
  const mimetype = String(body.mimetype || "").toLowerCase();
  const fileName = body.fileName || null;
  const rawPayload = body.rawPayload || null;

  const looseMeta =
    rawPayload && typeof rawPayload === "object"
      ? pickFileMetaFromObject(
          rawPayload.content?.document ||
            rawPayload.content?.image ||
            rawPayload.document ||
            {}
        )
      : {};

  if (!mediaBase64 && looseMeta.mediaBase64) mediaBase64 = looseMeta.mediaBase64;

  const hasSomething =
    !!chatInput ||
    !!mediaBase64 ||
    !!String(fileName || "").trim() ||
    !!String(mimetype || "").trim() ||
    !!String(looseMeta.fileName || "").trim() ||
    !!String(looseMeta.mimetype || "").trim() ||
    !!rawPayload;

  if (!hasSomething) {
    throw new Error("Campo obrigatório ausente: chatInput/message ou anexo");
  }

  const ti = chatInput.toLowerCase();
  if (
    (ti === "document" || ti === "image" || ti === "áudio" || ti === "audio") &&
    (fileName || looseMeta.fileName || rawPayload)
  ) {
    chatInput = "";
  }

  return {
    chatInput,
    sessionId,
    phone,
    history,
    mediaBase64,
    mimetype: mimetype || String(looseMeta.mimetype || "").toLowerCase(),
    fileName: fileName || looseMeta.fileName || null,
    rawPayload,
  };
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

function deepFindBase64String(obj, depth = 0) {
  if (depth > 12 || !obj || typeof obj !== "object") return null;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 200) {
      const s = v.replace(/\s/g, "");
      if (/^[A-Za-z0-9+/]+=*$/.test(s.slice(0, 500)) && s.length > 300) return s;
    }
    if (typeof v === "object" && v !== null) {
      const inner = deepFindBase64String(v, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

function hasResumeHint(payload, text) {
  const name = String(payload.fileName || "").toLowerCase();
  const mt = String(payload.mimetype || "").toLowerCase();
  const ti = String(text || "").toLowerCase().trim();
  if (isDocumentLikeInRaw(payload.rawPayload)) return true;
  if ((ti === "document" || ti === "image" || ti === "[anexo]") && payload.rawPayload)
    return true;
  return (
    !!payload.mediaBase64 ||
    name.endsWith(".pdf") ||
    name.endsWith(".doc") ||
    name.endsWith(".docx") ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".png") ||
    mt.includes("pdf") ||
    mt.includes("word") ||
    mt.includes("docx") ||
    mt.includes("document") ||
    mt.includes("officedocument") ||
    mt.startsWith("image/")
  );
}

function isYes(text) {
  return /^(sim|s|confirmo|ok|correto|pode salvar|pode cadastrar|ta certo|tá certo)$/i.test(
    String(text || "").trim()
  );
}

async function loadContext(sessionId) {
  const local = contextMemory.get(sessionId);
  try {
    const { data, error } = await supabase
      .from("conversation_cache")
      .select("state")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (!error && data?.state) return data.state;
  } catch (_e) {}
  return (
    local || {
      lastIntent: null,
      pendingConfirmation: false,
      pendingResume: null,
      awaitingResume: false,
      recentTurns: [],
    }
  );
}

async function saveContext(sessionId, state) {
  contextMemory.set(sessionId, state);
  try {
    await supabase.from("conversation_cache").upsert(
      {
        session_id: sessionId,
        state,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_id" }
    );
  } catch (_e) {}
}

async function classifyIntent(payload, ctx) {
  const history = [
    ...ctx.recentTurns.slice(-4),
    ...payload.history.slice(-4),
    {
      role: "system",
      content:
        'Classifique a intenção e retorne APENAS JSON: {"intent":"candidate|company|jobs|general","reason":"..."}. Regras: se usuário quer se candidatar ou mandou currículo/anexo => candidate; empresa/recrutador => company; saber vagas => jobs; restante => general.',
    },
  ];
  const content = await askAI({
    chatInput: `Mensagem: ${payload.chatInput || "(sem texto)"}; fileName=${
      payload.fileName || ""
    }; mimetype=${payload.mimetype || ""}; hasResumeHint=${hasResumeHint(
      payload,
      payload.chatInput
    )}`,
    history,
  });
  try {
    const match = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : content);
    const intent = String(parsed.intent || "").toLowerCase();
    if (["candidate", "company", "jobs", "general"].includes(intent)) return intent;
  } catch (_e) {}
  return "general";
}

/** Limite de caracteres enviados ao modelo (evita estourar contexto). */
const MAX_RESUME_TEXT_FOR_LLM = 85000;

async function plainTextFromResumeMedia(payload) {
  if (!payload.mediaBase64) return { text: null, error: "sem_base64" };
  let buffer;
  try {
    buffer = Buffer.from(
      String(payload.mediaBase64).replace(/\s/g, ""),
      "base64"
    );
  } catch (_e) {
    return { text: null, error: "decode" };
  }
  if (!buffer.length) return { text: null, error: "vazio" };

  const mt = String(payload.mimetype || "").toLowerCase();
  const name = String(payload.fileName || "").toLowerCase();
  const isPdfMagic = buffer.slice(0, 4).toString("ascii") === "%PDF";
  const isZipMagic = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const minLen = 25;

  const tryPdf = async () => {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);
    return (data.text || "").replace(/\s+/g, " ").trim();
  };

  const tryDocx = async () => {
    const mammoth = require("mammoth");
    const r = await mammoth.extractRawText({ buffer });
    return (r.value || "").replace(/\s+/g, " ").trim();
  };

  try {
    if (isPdfMagic) {
      const t = await tryPdf();
      if (t.length >= minLen) return { text: t, error: null };
      return { text: null, error: "pdf_sem_texto" };
    }
    if (isZipMagic) {
      try {
        const t = await tryDocx();
        if (t.length >= minLen) return { text: t, error: null };
      } catch (_e) {
        /* xlsx também é ZIP; segue para outros fallbacks */
      }
    }
    if (mt.includes("pdf") || name.endsWith(".pdf")) {
      const t = await tryPdf();
      if (t.length >= minLen) return { text: t, error: null };
    }
    if (
      name.endsWith(".docx") ||
      mt.includes("officedocument.wordprocessingml") ||
      mt.includes("wordprocessingml")
    ) {
      const t = await tryDocx();
      if (t.length >= minLen) return { text: t, error: null };
    }
  } catch (e) {
    return { text: null, error: String(e.message || e) };
  }

  if (mt.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(name)) {
    return { text: null, error: "imagem" };
  }

  try {
    const t = await tryPdf();
    if (t.length >= minLen) return { text: t, error: null };
  } catch (_e) {}

  try {
    const t = await tryDocx();
    if (t.length >= minLen) return { text: t, error: null };
  } catch (_e) {}

  return { text: null, error: "formato" };
}

async function extractResumeData(payload) {
  if (!payload.mediaBase64) return null;

  const { text } = await plainTextFromResumeMedia(payload);
  if (!text) return null;

  const body =
    text.length > MAX_RESUME_TEXT_FOR_LLM
      ? `${text.slice(0, MAX_RESUME_TEXT_FOR_LLM)}\n\n[... texto truncado para análise ...]`
      : text;

  const prompt =
    "Extraia dados de currículo a partir do TEXTO abaixo. Retorne APENAS JSON válido: " +
    '{"fullName":null,"email":null,"phone":null,"city":null,"jobInterest":null}\n\n' +
    `Arquivo: ${payload.fileName || "curriculo"}; mimetype: ${
      payload.mimetype || "desconhecido"
    }\n\n` +
    `Texto do currículo:\n${body}`;

  const out = await askAI({
    chatInput: prompt,
    history: [
      {
        role: "system",
        content:
          "Você é extrator de currículo. Responda apenas JSON. Use null se um campo não aparecer no texto.",
      },
    ],
  });
  const match = out.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_e) {
    return null;
  }
}

async function saveResumeFromContext(phone, payload, extracted) {
  const resume = normalizeResumePayload({
    fullName: extracted?.fullName ?? null,
    email: extracted?.email ?? null,
    phone: phone,
    city: extracted?.city ?? null,
    jobInterest: extracted?.jobInterest ?? null,
    fileName: payload.fileName ?? null,
    fileSize: null,
    mimetype: payload.mimetype ?? null,
  });
  const { data, error } = await supabase
    .from("resumes")
    .insert(resume)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/webhook/chat", async (req, res) => {
  try {
    const payload = normalizeChatPayload(req.body);
    enrichChatPayload(payload, req.body);
    const ctx = await loadContext(payload.sessionId);
    const text = String(payload.chatInput || "").trim();
    const resumeHint = hasResumeHint(payload, text);

    // 1) Primeiro conversa/entende intenção (triagem com contexto)
    let intent = await classifyIntent(payload, ctx);
    if (resumeHint) intent = "candidate";
    if (/candidatar|curricul|currículo/i.test(text)) intent = "candidate";

    let aiMessage = "";

    // 2) Se já está pendente de confirmação e usuário confirmou, salva
    if (ctx.pendingConfirmation && isYes(text) && ctx.pendingResume) {
      await saveResumeFromContext(payload.phone || payload.sessionId, payload, ctx.pendingResume);
      ctx.pendingConfirmation = false;
      ctx.pendingResume = null;
      ctx.lastIntent = "candidate";
      aiMessage = "Perfeito! Candidatura registrada com sucesso. Obrigado.";
    } else if (intent === "company") {
      ctx.lastIntent = "company";
      aiMessage =
        "Obrigado pelo contato. Recebemos sua mensagem como empresa e nossa equipe de RH vai analisar e retornar em breve. Se quiser conhecer vagas abertas, acesse: https://evoluxrh.com.br";
    } else if (intent === "jobs") {
      ctx.lastIntent = "jobs";
      aiMessage =
        "Temos vagas sim. Veja todas as oportunidades atualizadas em https://evoluxrh.com.br";
    } else if (intent === "candidate") {
      ctx.lastIntent = "candidate";
      if (resumeHint) {
        ctx.awaitingResume = false;
        if (!payload.mediaBase64) {
          aiMessage =
            "Recebi o arquivo, mas sem o conteúdo para leitura. Reenvie o currículo como PDF/imagem/DOCX com o arquivo anexado corretamente para eu extrair os dados.";
        } else {
          const extracted = await extractResumeData(payload);
          if (!extracted) {
            aiMessage =
              "Não consegui extrair os dados do currículo. Pode reenviar o arquivo, por favor?";
          } else {
            ctx.pendingResume = extracted;
            ctx.pendingConfirmation = true;
            aiMessage =
              `Encontrei estes dados no currículo:\n` +
              `Nome: ${extracted.fullName || "Não encontrado"}\n` +
              `Email: ${extracted.email || "Não encontrado"}\n` +
              `Telefone: ${extracted.phone || payload.phone || "Não encontrado"}\n` +
              `Cidade: ${extracted.city || "Não encontrado"}\n` +
              `Cargo de interesse: ${extracted.jobInterest || "Não encontrado"}\n\n` +
              `Se estiver tudo certo, responda SIM para eu salvar.`;
          }
        }
      } else {
        ctx.awaitingResume = true;
        aiMessage =
          "Perfeito! Para se candidatar, envie seu currículo em PDF, imagem ou DOCX para eu extrair os dados e confirmar com você.";
      }
    } else {
      aiMessage = await askAI({
        chatInput: text || "Olá",
        history: ctx.recentTurns.slice(-6),
      });
    }

    ctx.recentTurns = [
      ...ctx.recentTurns.slice(-10),
      { role: "user", content: text || "[anexo]" },
      { role: "assistant", content: aiMessage },
    ];
    await saveContext(payload.sessionId, ctx);

    return res.json({
      ok: true,
      sessionId: payload.sessionId,
      phone: payload.phone || null,
      intent,
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
      error: "Falha ao processar mensagem",
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
