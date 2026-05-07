require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "15mb" }));

let mammothLib = null;
let mammothLoadError = null;
try {
  mammothLib = require("mammoth");
} catch (e) {
  mammothLoadError = e;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
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
  const fallbackFileName =
    String(body.fileName ?? body.file_name ?? "").trim() || "curriculo";
  /** Caminho sintético para tabelas com `file_path` NOT NULL (confirmação "SIM" vem sem anexo novo). */
  const fallbackFilePath = `webhook/evolux/${String(
    body.sessionId ??
      body.candidate_phone ??
      body.phone ??
      body.fileSessionKey ??
      "sessao"
  ).replace(/\D/g, "") || "sem-sessao"}/${encodeURIComponent(fallbackFileName)}`;
  const file_name = body.fileName ?? body.file_name ?? fallbackFileName;
  const file_path = body.filePath ?? body.file_path ?? fallbackFilePath;
  const file_url =
    body.fileUrl ??
    body.file_url ??
    `https://boteevoluxnovo.vercel.app/files/${encodeURIComponent(file_path)}`;

  const parsedFileSize =
    body.fileSize != null
      ? Number(body.fileSize)
      : body.file_size != null
      ? Number(body.file_size)
      : NaN;
  const safeFileSize = Number.isFinite(parsedFileSize) && parsedFileSize >= 0
    ? parsedFileSize
    : 0;

  const payload = {
    candidate_name: body.fullName ?? body.candidate_name ?? null,
    candidate_email: body.email ?? body.candidate_email ?? null,
    candidate_phone: body.phone ?? body.candidate_phone ?? null,
    city: body.city ?? null,
    position_of_interest: body.jobInterest ?? body.position_of_interest ?? null,
    file_name,
    file_path,
    file_size: safeFileSize,
    file_type: body.mimetype ?? body.file_type ?? null,
    file_url,
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
  if (raw.media || raw.attachment || raw.attachments || raw.document) return true;
  if (raw.messages?.[0]?.message?.documentMessage) return true;
  return false;
}

function deepFindFileHints(obj, depth = 0) {
  if (depth > 12 || !obj || typeof obj !== "object") return {};
  let fileName;
  let mimetype;
  for (const [k, v] of Object.entries(obj)) {
    const kl = k.toLowerCase();
    if (
      typeof v === "string" &&
      v.length > 0 &&
      v.length < 512 &&
      (kl === "filename" ||
        kl === "name" ||
        kl === "originalname" ||
        kl === "file_name")
    ) {
      fileName = fileName || v;
    }
    if (
      typeof v === "string" &&
      v.length < 200 &&
      (kl === "mimetype" ||
        kl === "contenttype" ||
        kl === "content_type" ||
        kl === "mime" ||
        kl === "mime_type")
    ) {
      mimetype = mimetype || String(v).toLowerCase();
    }
    if (typeof v === "object" && v !== null) {
      const inner = deepFindFileHints(v, depth + 1);
      if (inner.fileName && !fileName) fileName = inner.fileName;
      if (inner.mimetype && !mimetype) mimetype = inner.mimetype;
    }
  }
  return { fileName, mimetype };
}

/** Decodifica base64 vinda do WhatsApp/n8n (data URL, URL-safe, padding). */
function decodeBase64ToBuffer(raw) {
  if (raw == null || raw === "") return null;
  let s = String(raw).trim();
  const dataUrl = s.match(/^data:([^;]*);base64,\s*(.+)$/is);
  if (dataUrl) s = dataUrl[2];
  s = s.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const mod = s.length % 4;
  if (mod) s += "=".repeat(4 - mod);
  try {
    const buf = Buffer.from(s, "base64");
    return buf.length ? buf : null;
  } catch (_e) {
    return null;
  }
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

  if (
    (!payload.fileName || !payload.mimetype) &&
    payload.rawPayload &&
    typeof payload.rawPayload === "object"
  ) {
    const hints = deepFindFileHints(payload.rawPayload);
    if (!payload.fileName && hints.fileName) payload.fileName = hints.fileName;
    if (!payload.mimetype && hints.mimetype)
      payload.mimetype = String(hints.mimetype).toLowerCase();
  }
}

/** Mesma conversa sempre na mesma chave (serverless não compartilha memória entre requisições). */
function resolveConversationSessionId(body) {
  const phoneDigits = String(body.phone ?? "").replace(/\D/g, "");
  const rawSid =
    body.sessionId != null && body.sessionId !== ""
      ? String(body.sessionId).trim()
      : "";
  const sidDigits = rawSid.replace(/\D/g, "");
  if (phoneDigits) {
    if (!rawSid || sidDigits === phoneDigits) return phoneDigits;
  }
  if (sidDigits && sidDigits.length >= 10) return sidDigits;
  if (rawSid) return rawSid;
  if (phoneDigits) return phoneDigits;
  return "default";
}

function defaultConversationState() {
  return {
    lastIntent: null,
    pendingConfirmation: false,
    pendingResume: null,
    awaitingResume: false,
    recentTurns: [],
    lastSavedResume: null,
    lastSavedResumeAt: null,
    lastDraftResume: null,
    lastDraftAt: null,
  };
}

function mergeConversationState(raw) {
  let r = raw;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch (_e) {
      r = null;
    }
  }
  if (!r || typeof r !== "object") return defaultConversationState();
  return {
    lastIntent: r.lastIntent ?? null,
    pendingConfirmation: Boolean(r.pendingConfirmation),
    pendingResume:
      r.pendingResume != null && typeof r.pendingResume === "object"
        ? r.pendingResume
        : null,
    awaitingResume: Boolean(r.awaitingResume),
    recentTurns: Array.isArray(r.recentTurns) ? r.recentTurns : [],
    lastSavedResume:
      r.lastSavedResume != null && typeof r.lastSavedResume === "object"
        ? r.lastSavedResume
        : null,
    lastSavedResumeAt: r.lastSavedResumeAt ?? null,
    lastDraftResume:
      r.lastDraftResume != null && typeof r.lastDraftResume === "object"
        ? r.lastDraftResume
        : null,
    lastDraftAt: r.lastDraftAt ?? null,
  };
}

function normalizeChatPayload(body) {
  let chatInput = String(body.chatInput ?? body.message ?? "").trim();
  const sessionId = resolveConversationSessionId(body);
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

async function askAI({
  chatInput,
  history,
  prependLuizaSystem = true,
  max_tokens: maxTokens,
  temperature = 1,
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("Defina OPENAI_API_KEY no ambiente.");
  }

  const messages = [];
  if (prependLuizaSystem) {
    messages.push({ role: "system", content: DEFAULT_SYSTEM_PROMPT });
  }

  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    if (!["system", "user", "assistant"].includes(item.role)) continue;
    if (typeof item.content !== "string") continue;
    messages.push({ role: item.role, content: item.content });
  }

  messages.push({ role: "user", content: chatInput });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: maxTokens != null ? maxTokens : 4096,
      temperature,
      stream: false,
      messages,
    }),
  });

  let data;
  try {
    data = await response.json();
  } catch (_e) {
    data = {};
  }

  if (!response.ok) {
    const errPart =
      (typeof data?.error === "object" && data.error !== null
        ? data.error.message ||
          data.error.code ||
          JSON.stringify(data.error)
        : null) ||
      (typeof data?.error === "string" ? data.error : null) ||
      data?.message ||
      "";
    const detail = String(errPart || `HTTP ${response.status}`).trim();
    throw new Error(
      detail ? `OpenAI: ${detail}` : "Erro ao consultar a API da OpenAI"
    );
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

/** Indica arquivo de currículo no payload (WhatsApp/n8n), não só envelope genérico. */
function hasInboundResumeFile(payload) {
  const b64Len = payload.mediaBase64
    ? String(payload.mediaBase64).replace(/\s/g, "").length
    : 0;
  if (b64Len > 48) return true;
  const raw = payload.rawPayload;
  if (!raw || typeof raw !== "object") return false;
  const c = raw.content ?? raw.message ?? {};
  if (c.document || c.image || raw.document || raw.image) return true;
  if (raw.messages?.[0]?.message?.documentMessage) return true;
  const typ = String(c.type || raw.type || "").toLowerCase();
  if (typ === "document" || typ === "image") return true;
  if (raw.media && String(raw.media).length > 16) return true;
  if (raw.attachment && typeof raw.attachment === "object") return true;
  if (Array.isArray(raw.attachments) && raw.attachments.length > 0) return true;
  return false;
}

function hasResumeHint(payload, text) {
  if (hasInboundResumeFile(payload)) return true;
  const name = String(payload.fileName || "").toLowerCase();
  const mt = String(payload.mimetype || "").toLowerCase();
  const ti = String(text || "").toLowerCase().trim();
  if ((ti === "document" || ti === "image" || ti === "[anexo]") && payload.rawPayload)
    return true;
  return (
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

function normalizeIntentText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function isYes(text) {
  return quickAffirmativeConfirmation(text);
}

/** Confirmação afirmativa (qualquer “sim” coloquial curto). */
function quickAffirmativeConfirmation(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (/^[\s👍👌✅✔️💚👏]+$/u.test(raw)) return true;

  const n = normalizeIntentText(raw);
  const early = n.replace(/^[`"'„«»¡¿\s\-–.:;]+/, "").trim();

  if (/^(sim|si|sss+)\b([\s,!.;:?…\-–]|$)/.test(early)) return true;
  if (/^(ok|okay|oky)\b([\s,!.;:?…]|$)/.test(early)) return true;
  if (/^(beleza|blz)\b([\s,!.;:?…]|$)/.test(early)) return true;
  if (/^(valeu|thanks)\b/.test(early)) return true;
  if (/^(perfeito|otimo|otima)\b([\s,!.;:?…]|$)/.test(early)) return true;
  if (/^(show)\b([\s,!.;:?…]|$)/.test(early)) return true;
  if (/^(fech(o|ado|ou)?|combinad|concordo)\b([\s,!.;:?…]|$)/.test(early))
    return true;
  if (/^(positivo|exato|^isso)\b([\s,!.;:?…]|$)/.test(early)) return true;
  if (
    /^ta\s+certo|^tao\s+certo|^esta\s+(cert|bom|ok)|^tudo\s+(cert|bem|bom|ok)\b/.test(
      early
    )
  )
    return true;
  if (/^(confirmo|correto)\b([\s,.;:!?]|$)/.test(early)) return true;
  if (/^sim\b.*\bpode\b.*\b(salvar|cadastrar|gravar|registrar)\b/.test(early))
    return true;

  if (
    /\b(sim|confirmo)\b/.test(early) &&
    !/\b(mas|porem|porém|errad)\b/.test(early)
  )
    return true;
  if (/\bpode\b.*\b(salvar|cadastrar|gravar|registrar|incluir)\b/.test(early))
    return true;
  if (
    /\b(manda\s+(ver|bala))|(\b(go ahead))|(\btopo\b)/.test(early)
  )
    return true;
  if (/\btudo\s+certo\b|\bbora\b|\b(está\s+)?ok\b/.test(early))
    return true;

  return /\btudo\s+(bem|bom)\b/.test(n) && !/\bn(ao|ão)\b/.test(early);
}

/** Indica correção antes de registrar (prioridade maior que só “sim”). */
function correctionIntentHeuristic(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const n = normalizeIntentText(raw);
  if (/\b(mas|porem|porém)\b/.test(n)) return true;
  if (/\b(nao|não)\b.*\b(certa|sei|sei se|sei qual)\b/.test(n))
    return true;
  if (/^(nao|não)$/i.test(raw.trim())) return true;
  if (/\best(a|á)\s+errado|\b(erro|errei)|\bincorrecto\b/.test(n))
    return true;
  if (/\bcorrig|\bajeit|\bajust|\balter|\bmud(ar|e)?\b|\btroc(a|ar)\b|\barrum/.test(n))
    return true;
  if (/\b(email|e-mail)\b/.test(n) && /(@|é\s+)[\w.+-]+@/.test(raw))
    return true;
  if (/@\S+\.\S+/.test(raw)) return true;
  if (
    /\b(telefone|fone|celular|whatsapp|ddd)\b/.test(n) &&
    /\d{4,}/.test(raw)
  )
    return true;
  if (
    /\b(cidade|moro\b|cargo|fun(c|ç)ao\b|nome)\b/.test(n) &&
    (/\b(eh|é|seria)\b/.test(n) || /[:=]/.test(raw))
  )
    return true;
  return false;
}

async function classifyPendingResumeIntentAi(userText) {
  const clipped = String(userText || "").slice(0, 520);
  const out = await askAI({
    chatInput: `Mensagem do candidato (após ver os dados cadastrais extraídos): ${JSON.stringify(
      clipped
    )}`,
    history: [
      {
        role: "system",
        content:
          'Classifique em só JSON válido: {"intent":"SAVE"|"CORRECT"|"UNCLEAR"}. SAVE = autoriza cadastro ou concorda (sim, beleza, manda lá, topo, combinado…). CORRECT = ajustes, erro, valores novos. UNCLEAR = fora desses dois. Só o JSON.',
      },
    ],
    prependLuizaSystem: false,
    max_tokens: 80,
    temperature: 0.1,
  });
  const stripped = String(out)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    const match = stripped.match(/\{[\s\S]*\}/);
    const intentRaw = match
      ? String(JSON.parse(match[0]).intent || "").toUpperCase()
      : "";
    if (intentRaw.includes("SAVE")) return "SAVE";
    if (intentRaw.includes("CORRECT")) return "CORRECT";
  } catch (_e) {}
  return "UNCLEAR";
}

function pendingResumeDataOnly(pending) {
  if (!pending || typeof pending !== "object") return {};
  const { fullName, email, phone, city, jobInterest } = pending;
  return { fullName, email, phone, city, jobInterest };
}

async function refinePendingResumeFromMessage(
  pending,
  userMessage,
  whatsappDigits
) {
  const cur = pendingResumeDataOnly(pending);
  const out = await askAI({
    chatInput:
      `Dados_atuais_json: ${JSON.stringify(cur)}\n` +
      `Telefone_whatsapp_da_sessao: ${whatsappDigits}\n\n` +
      `Mensagem_pedindo_ajuste: ${JSON.stringify(String(userMessage || "").slice(0, 800))}`,
    history: [
      {
        role: "system",
        content:
          "Retorne APENAS JSON: " +
          '{"fullName","email","phone","city","jobInterest"}. Atualize só o que o usuário citou; repita os demais valores atuais quando não alterados. Use null só se o usuário pedir para apagar o campo explicitamente.',
      },
    ],
    prependLuizaSystem: false,
    max_tokens: 520,
    temperature: 0.2,
  });
  const stripped = String(out)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("IA não devolveu JSON de correção");
  const parsed = JSON.parse(match[0]);
  const keys = ["fullName", "email", "phone", "city", "jobInterest"];
  const merged = { ...(typeof pending === "object" ? pending : {}) };
  for (const k of keys) {
    if (!(k in parsed) || parsed[k] === undefined) continue;
    merged[k] = parsed[k];
  }
  merged._ingest = pending._ingest;
  return merged;
}

function formatDraftResumeReply(extractedPlain) {
  const e =
    extractedPlain && typeof extractedPlain === "object" ? extractedPlain : {};
  return (
    `Nome: ${e.fullName || "—"}\n` +
    `Email: ${e.email || "—"}\n` +
    `Telefone: ${e.phone || "—"}\n` +
    `Cidade: ${e.city || "—"}\n` +
    `Cargo de interesse: ${e.jobInterest || "—"}`
  );
}

async function reviewResumeAgainstText(resumeTextExcerpt, extractedPlain) {
  const cap =
    resumeTextExcerpt.length > 12000
      ? `${resumeTextExcerpt.slice(0, 12000)}\n[... texto truncado ...]`
      : resumeTextExcerpt;
  const out = await askAI({
    chatInput:
      `Trecho do currículo (texto):\n${cap}\n\n` +
      `Campos extraídos:\n${JSON.stringify(pendingResumeDataOnly(extractedPlain))}`,
    history: [
      {
        role: "system",
        content:
          "Revisor RH. Em 2 a 5 frases em português, diga se os campos parecem coerentes com o texto; aponte inconsistências óbvias. Não relacione campo a campo. Seja objetivo.",
      },
    ],
    prependLuizaSystem: false,
    max_tokens: 260,
    temperature: 0.25,
  });
  return String(out || "").trim();
}

/** Detecta texto de candidatura sem depender de acentos (ex.: currículo vs curriculo). */
function matchesCandidateKeywords(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const n = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (n.includes("interessei") && n.includes("curricul")) return true;

  const patterns = [
    /quero\s+(me\s+)?candidat/,
    /candidatur/,
    /curricul/,
    /me\s+candidatar/,
    /enviar?\s+(o\s+|meu\s+)?curricul/,
    /envio\s+(o\s+|meu\s+)?curricul/,
    /mand(ar|o)?\s+(o\s+|meu\s+)?curricul/,
    /\b(anex(ar|o)|mando)\s+(o\s+)?curricul/,
    /\b(inscreve|me\s+cadastra)\b.*\bvag(a|as)\b/,
    /\bvaga(s)?\b.*\b(empresa|trampo|oportunidade|candidato)\b/,
  ];

  return patterns.some((re) => re.test(n));
}

async function loadContext(sessionId) {
  const local = contextMemory.get(sessionId);
  try {
    const { data, error } = await supabase
      .from("conversation_cache")
      .select("state")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (error) {
      console.error(
        "[conversation_cache] select falhou:",
        sessionId,
        error.message
      );
    }
    if (!error && data != null && data.state != null) {
      return mergeConversationState(data.state);
    }
  } catch (e) {
    console.error(
      "[conversation_cache] load exceção:",
      sessionId,
      String(e?.message || e)
    );
  }
  if (local) return mergeConversationState(local);
  return defaultConversationState();
}

async function saveContext(sessionId, state) {
  const merged = mergeConversationState(state);
  contextMemory.set(sessionId, merged);
  try {
    const { error } = await supabase.from("conversation_cache").upsert(
      {
        session_id: sessionId,
        state: merged,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_id" }
    );
    if (error) {
      console.error(
        "[conversation_cache] upsert falhou:",
        sessionId,
        error.message
      );
      return { error: error.message };
    }
    return { error: null };
  } catch (e) {
    const msg = String(e?.message || e);
    console.error("[conversation_cache] upsert exceção:", sessionId, msg);
    return { error: msg };
  }
}

function digitsOnlySessionKey(v) {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d : "";
}

/** Se o estado foi salvo sob outra chave (ex.: só sessionId vs só phone), recupera confirmação pendente. */
function alternateConversationLookupIds(body, canonicalSessionId) {
  const canonDigits = digitsOnlySessionKey(canonicalSessionId);
  const out = [];
  const add = (v) => {
    const d = digitsOnlySessionKey(v);
    if (!d || d === canonDigits) return;
    if (!out.includes(d)) out.push(d);
  };
  if (!body || typeof body !== "object") return out;
  add(body.phone);
  add(body.sessionId);
  try {
    add(body.contact?.number);
  } catch (_e) {}
  const inner = body.body;
  if (inner && typeof inner === "object") {
    add(inner.phone);
    add(inner.sessionId);
    try {
      add(inner.contact?.number);
    } catch (_e) {}
  }
  try {
    add(body.rawPayload?.contact?.number);
    add(body.rawPayload?.phone);
    add(body.rawPayload?.sessionId);
  } catch (_e) {}
  return out;
}

async function loadConversationContextForRequest(payload, rawBody) {
  const canonKey = payload.sessionId;
  let ctx = await loadContext(canonKey);
  if (ctx.pendingConfirmation && ctx.pendingResume) return ctx;
  for (const alt of alternateConversationLookupIds(rawBody, canonKey)) {
    const altCtx = await loadContext(alt);
    if (altCtx.pendingConfirmation && altCtx.pendingResume) {
      return altCtx;
    }
  }
  return ctx;
}

async function saveConversationContextForRequest(payload, rawBody, state) {
  const keys = [
    payload.sessionId,
    ...alternateConversationLookupIds(rawBody, payload.sessionId),
  ].filter(Boolean);
  let firstError = null;
  for (const k of keys) {
    const r = await saveContext(k, state);
    if (!firstError && r?.error) firstError = r.error;
  }
  return { error: firstError };
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
    max_tokens: 256,
    temperature: 0.2,
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

/**
 * Texto extraído de PDF via `unpdf` (PDF.js empacotado para serverless — evita falhas do bundle da Vercel com `pdf-parse`).
 */
async function extractPdfTextBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let unpdf;
  try {
    unpdf = require("unpdf");
  } catch (e) {
    throw new Error(`pdf_extract_indisponivel: ${String(e?.message || e)}`);
  }
  const { extractText, getDocumentProxy } = unpdf;
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return (text || "").replace(/\s+/g, " ").trim();
}

async function plainTextFromResumeMedia(payload) {
  if (!payload.mediaBase64) return { text: null, error: "sem_base64" };
  const buffer = decodeBase64ToBuffer(payload.mediaBase64);
  if (!buffer || !buffer.length) return { text: null, error: "decode" };

  const mt = String(payload.mimetype || "").toLowerCase();
  const name = String(payload.fileName || "").toLowerCase();
  const isPdfMagic = buffer.slice(0, 4).toString("ascii") === "%PDF";
  const isZipMagic = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const isJpegMagic = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
  const isPngMagic =
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  /** Texto mínimo (currículos com poucas linhas ou PDF com pouco texto legível). */
  const minLen = 8;

  const tryDocx = async () => {
    if (!mammothLib) {
      const detail = String(mammothLoadError?.message || "modulo_indisponivel");
      throw new Error(`mammoth_indisponivel: ${detail}`);
    }
    const r = await mammothLib.extractRawText({ buffer });
    return (r.value || "").replace(/\s+/g, " ").trim();
  };

  if (!isPdfMagic && (isJpegMagic || isPngMagic)) {
    return { text: null, error: "imagem" };
  }

  try {
    if (isPdfMagic) {
      const t = await extractPdfTextBuffer(buffer);
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
      const t = await extractPdfTextBuffer(buffer);
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
    const t = await extractPdfTextBuffer(buffer);
    if (t.length >= minLen) return { text: t, error: null };
  } catch (_e) {}

  try {
    const t = await tryDocx();
    if (t.length >= minLen) return { text: t, error: null };
  } catch (_e) {}

  return { text: null, error: "formato" };
}

async function extractResumeData(payload) {
  if (!payload.mediaBase64) return { data: null, error: "sem_base64" };

  const { text, error: mediaError } = await plainTextFromResumeMedia(payload);
  if (!text) return { data: null, error: mediaError || "sem_texto" };

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
    prependLuizaSystem: false,
    max_tokens: 2048,
    temperature: 0.2,
  });
  const stripped = String(out)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return { data: null, error: "json_ausente" };
  try {
    return {
      data: JSON.parse(match[0]),
      error: null,
      resumeTextForReview: body,
    };
  } catch (_e) {
    return { data: null, error: "json_invalido" };
  }
}

async function saveResumeFromContext(phone, payload, extracted) {
  const ingest =
    extracted && typeof extracted === "object" ? extracted._ingest || {} : {};
  const nameFromPrior =
    String(ingest.fileName || ingest.displayName || "").trim() ||
    "";
  const fileNameMerged =
    String(payload.fileName || nameFromPrior || "").trim() || null;
  const mimeMerged =
    String(payload.mimetype || ingest.mimetype || "").trim() || null;

  const resume = normalizeResumePayload({
    fullName: extracted?.fullName ?? null,
    email: extracted?.email ?? null,
    phone: phone,
    city: extracted?.city ?? null,
    jobInterest: extracted?.jobInterest ?? null,
    fileName: fileNameMerged,
    fileSize: ingest.fileSize != null ? ingest.fileSize : null,
    mimetype:
      mimeMerged ||
      (nameFromPrior.toLowerCase().endsWith(".pdf") ? "application/pdf" : null),
    filePath:
      ingest.filePath ||
      (ingest.bucketKey ? String(ingest.bucketKey) : null) ||
      null,
    fileSessionKey: ingest.sessionId || payload.sessionId,
  });
  // Mantém histórico e também tenta atualizar o último currículo do mesmo telefone.
  // Se não encontrar registro anterior, faz INSERT normalmente.
  try {
    const byUpdated = await supabase
      .from("resumes")
      .select("id")
      .eq("candidate_phone", resume.candidate_phone)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    let existingId = !byUpdated.error && byUpdated.data?.id ? byUpdated.data.id : null;

    if (!existingId) {
      const byCreated = await supabase
        .from("resumes")
        .select("id")
        .eq("candidate_phone", resume.candidate_phone)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      existingId = !byCreated.error && byCreated.data?.id ? byCreated.data.id : null;
    }

    if (existingId) {
      const { data, error } = await supabase
        .from("resumes")
        .update(resume)
        .eq("id", existingId)
        .select("*")
        .single();
      if (!error && data) return data;
      if (error) {
        // Fallback para insert caso schema/coluna de update seja diferente.
        const { data: inserted, error: insertError } = await supabase
          .from("resumes")
          .insert(resume)
          .select("*")
          .single();
        if (insertError) throw new Error(insertError.message);
        return inserted;
      }
    }
  } catch (_e) {
    // segue para insert abaixo
  }

  const { data: inserted, error: insertError } = await supabase
    .from("resumes")
    .insert(resume)
    .select("*")
    .single();
  if (insertError) throw new Error(insertError.message);
  return inserted;
}

async function ensureResumeSavedOrThrow(phone, payload, extracted) {
  const saved = await saveResumeFromContext(phone, payload, extracted);
  if (!saved || typeof saved !== "object") {
    throw new Error("Falha ao salvar currículo: retorno vazio");
  }
  if (!saved.id) {
    throw new Error("Falha ao salvar currículo: id ausente no retorno");
  }
  return saved;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "evolux-api" });
});

function unwrapIncomingBody(reqBody) {
  const b = reqBody;
  if (!b || typeof b !== "object") return b;
  const inner = b.body;
  if (
    inner &&
    typeof inner === "object" &&
    !Array.isArray(inner) &&
    (inner.sessionId != null ||
      inner.phone != null ||
      inner.chatInput != null ||
      inner.mediaBase64 != null)
  ) {
    return inner;
  }
  return b;
}

app.post("/webhook/chat", async (req, res) => {
  try {
    const rawBody = unwrapIncomingBody(req.body);
    const payload = normalizeChatPayload(rawBody);
    enrichChatPayload(payload, rawBody);
    const ctx = await loadConversationContextForRequest(payload, rawBody);
    const text = String(payload.chatInput || "").trim();
    const resumeHint = hasResumeHint(payload, text);
    const textualCandidateCue = matchesCandidateKeywords(text);
    const draftAgeMs = ctx.lastDraftAt
      ? Date.now() - new Date(ctx.lastDraftAt).getTime()
      : Number.POSITIVE_INFINITY;
    const hasRecoverableDraft =
      !!ctx.lastDraftResume && Number.isFinite(draftAgeMs) && draftAgeMs <= 48 * 60 * 60 * 1000;

    // 1) Triagem: anexo OU mensagem clara de candidatura/interesse não chama OpenAI só para classificar
    let intent = "general";
    if (resumeHint || textualCandidateCue) {
      intent = "candidate";
    } else {
      try {
        intent = await classifyIntent(payload, ctx);
      } catch (_e) {
        intent = "general";
      }
    }
    if (matchesCandidateKeywords(text)) intent = "candidate";

    let aiMessage = "";
    let lastOpenAiError = null;
    let lastResumeExtractionError = null;
    let conversationCacheError = null;

    // 2) Aguardando confirmação afirmativa ou ajustes nos dados extraídos
    if (ctx.pendingConfirmation && ctx.pendingResume) {
      const whatsappDig = String(payload.phone || payload.sessionId || "");
      const trimmed = text.trim();

      const doSave = async () => {
        const sourceResume =
          ctx.pendingResume ||
          ctx.lastDraftResume ||
          null;
        if (!sourceResume) {
          aiMessage =
            "Perdi o rascunho desta candidatura. Reenvie o currículo para eu continuar do ponto certo.";
          return;
        }
        const saved = await ensureResumeSavedOrThrow(whatsappDig, payload, sourceResume);
        ctx.pendingConfirmation = false;
        ctx.pendingResume = null;
        ctx.lastIntent = "candidate";
        ctx.lastSavedResume = saved || null;
        ctx.lastSavedResumeAt = new Date().toISOString();
        ctx.lastDraftResume = null;
        ctx.lastDraftAt = null;
        aiMessage = "Perfeito! Candidatura registrada com sucesso. Obrigado.";
      };

      const doRefine = async (msg) => {
        try {
          const updated = await refinePendingResumeFromMessage(
            ctx.pendingResume || ctx.lastDraftResume || {},
            msg,
            whatsappDig.replace(/\D/g, "")
          );
          ctx.pendingResume = updated;
          ctx.pendingConfirmation = true;
          ctx.lastDraftResume = updated;
          ctx.lastDraftAt = new Date().toISOString();
          aiMessage =
            `Atualizei conforme você pediu:\n${formatDraftResumeReply(
              pendingResumeDataOnly(updated)
            )}\n\n` +
            `Se estiver bom, confirme com qualquer mensagem positiva (sim, ok, pode salvar, beleza…). Se faltar mais algum ajuste, é só escrever.`;
        } catch (err) {
          lastOpenAiError = String(err?.message || err);
          aiMessage =
            "Não consegui aplicar essa alteração agora. Tente de novo (ex.: “meu email é …”) ou confirme se os dados anteriores já servem.";
        }
      };

      if (trimmed.length && correctionIntentHeuristic(trimmed)) {
        await doRefine(trimmed);
      } else if (trimmed.length && quickAffirmativeConfirmation(trimmed)) {
        try {
          await doSave();
        } catch (e) {
          lastOpenAiError = String(e?.message || e);
          ctx.pendingConfirmation = true;
          aiMessage =
            "Não consegui concluir o salvamento agora (instabilidade momentânea). Seu rascunho foi mantido e posso tentar novamente se você confirmar de novo com 'sim'.";
        }
      } else if (trimmed.length) {
        try {
          const kind = await classifyPendingResumeIntentAi(trimmed);
          if (kind === "SAVE") {
            try {
              await doSave();
            } catch (e) {
              lastOpenAiError = String(e?.message || e);
              ctx.pendingConfirmation = true;
              aiMessage =
                "Tentei salvar e não consegui agora. O rascunho segue guardado; responda 'sim' novamente para tentar salvar.";
            }
          }
          else if (kind === "CORRECT") await doRefine(trimmed);
          else {
            aiMessage =
              "Para cadastrar, envie qualquer confirmação positiva (sim, ok, beleza, pode salvar, manda ver…). Se algo estiver errado, diga só a correção (ex.: cidade é …, email é …).";
          }
        } catch (e) {
          lastOpenAiError = String(e?.message || e);
          aiMessage =
            "Não entendi a resposta. Confirme de forma positiva para salvar ou descreva o que corrigir.";
        }
      } else {
        aiMessage =
          "Envie uma confirmação (sim, ok, pode salvar…) ou diga o que deseja corrigir nos dados.";
      }
    } else if (quickAffirmativeConfirmation(text) && hasRecoverableDraft) {
      try {
        const saved = await ensureResumeSavedOrThrow(
          String(payload.phone || payload.sessionId || ""),
          payload,
          ctx.lastDraftResume
        );
        ctx.pendingConfirmation = false;
        ctx.pendingResume = null;
        ctx.lastSavedResume = saved || null;
        ctx.lastSavedResumeAt = new Date().toISOString();
        ctx.lastDraftResume = null;
        ctx.lastDraftAt = null;
        ctx.lastIntent = "candidate";
        aiMessage =
          "Confirmação recebida. Recuperei o rascunho interrompido e registrei a candidatura com sucesso.";
      } catch (e) {
        lastOpenAiError = String(e?.message || e);
        ctx.pendingConfirmation = true;
        aiMessage =
          "Recuperei o rascunho interrompido, mas ainda não consegui salvar no banco. Pode confirmar novamente com 'sim' que eu tento de novo.";
      }
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
      const resumeBytesLen = payload.mediaBase64
        ? String(payload.mediaBase64).replace(/\s/g, "").length
        : 0;
      const hasResumeBinary = resumeBytesLen > 48;

      if (resumeHint && hasResumeBinary) {
        ctx.awaitingResume = false;
        try {
          const {
            data: extracted,
            error: extractionError,
            resumeTextForReview,
          } = await extractResumeData(payload);
          lastResumeExtractionError = extractionError || null;
          if (!extracted) {
            aiMessage =
              "Não consegui extrair os dados do currículo. Pode reenviar o arquivo, por favor?";
          } else {
            ctx.pendingResume = {
              ...extracted,
              _ingest: {
                fileName: payload.fileName,
                mimetype: payload.mimetype,
                sessionId: payload.sessionId,
              },
            };
            ctx.pendingConfirmation = true;
            ctx.lastDraftResume = ctx.pendingResume;
            ctx.lastDraftAt = new Date().toISOString();

            let analise = "";
            try {
              if (resumeTextForReview && resumeTextForReview.length > 80) {
                analise = await reviewResumeAgainstText(
                  resumeTextForReview,
                  extracted
                );
              }
            } catch (_e) {}

            const blocoDados = formatDraftResumeReply(
              pendingResumeDataOnly(ctx.pendingResume)
            );
            aiMessage =
              (analise ? `${analise}\n\n` : "") +
              `📋 Dados para cadastro:\n${blocoDados}\n\n` +
              `— Se estiver correto, responda de qualquer forma afirmativa (sim, ok, beleza, pode salvar, manda ver…).\n` +
              `— Se algo estiver errado, escreva só a correção (ex.: meu email é nome@empresa.com).`;
          }
        } catch (e) {
          lastOpenAiError = String(e?.message || e);
          aiMessage =
            "Não consegui concluir a leitura com a IA neste momento. Tente de novo em alguns instantes; se continuar, envie o currículo em PDF com texto selecionável ou em Word.";
          intent = "candidate";
        }
      } else if (resumeHint && !hasResumeBinary) {
        ctx.awaitingResume = false;
        aiMessage =
          "Recebi o arquivo, mas sem o conteúdo para leitura. Reenvie o currículo como PDF/imagem/DOCX com o arquivo anexado corretamente para eu extrair os dados.";
      } else {
        ctx.awaitingResume = true;
        aiMessage =
          "Perfeito! Para se candidatar, envie seu currículo em PDF, imagem ou DOCX para eu extrair os dados e confirmar com você.";
      }
    } else {
      try {
        aiMessage = await askAI({
          chatInput: text || "Olá",
          history: ctx.recentTurns.slice(-6),
        });
      } catch (e) {
        aiMessage =
          "Desculpe, não consegui contactar o serviço de IA agora. Tente mais tarde ou escreva se quer candidatar-se, vagas ou falar como empresa.";
        lastOpenAiError = String(e?.message || e);
      }
    }

    ctx.recentTurns = [
      ...ctx.recentTurns.slice(-10),
      { role: "user", content: text || "[anexo]" },
      { role: "assistant", content: aiMessage },
    ];
    const cacheSave = await saveConversationContextForRequest(payload, rawBody, ctx);
    conversationCacheError = cacheSave?.error || null;

    return res.json({
      ok: true,
      sessionId: payload.sessionId,
      phone: payload.phone || null,
      intent,
      message: aiMessage,
      ...(lastOpenAiError
        ? { openai_error: lastOpenAiError.slice(0, 500) }
        : {}),
      ...(lastResumeExtractionError
        ? { resume_extraction_error: lastResumeExtractionError }
        : {}),
      ...(conversationCacheError
        ? { conversation_cache_error: conversationCacheError.slice(0, 300) }
        : {}),
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
