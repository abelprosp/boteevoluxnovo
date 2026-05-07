/**
 * API mínima: persiste currículos no Supabase + upload no Storage (comportamento alinhado ao evoluxbote).
 */
const crypto = require("crypto");
require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "15mb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "resumes";
/** Se "1", usa URL assinada (útil quando o bucket não é público). */
const STORAGE_SIGNED_URL =
  String(process.env.SUPABASE_STORAGE_SIGNED_URL || "")
    .toLowerCase() === "1" ||
  String(process.env.STORAGE_SIGN_URL || "")
    .toLowerCase() === "1";
const SIGNED_URL_TTL_SEC = Math.min(
  Math.max(
    Number(process.env.SUPABASE_STORAGE_SIGNED_TTL_SEC || 31536000),
    60
  ),
  60 * 60 * 24 * 365 * 10
);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente antes de iniciar."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function extractBase64(body) {
  const raw =
    body.resumeBase64 ??
    body.file_base64 ??
    body.fileBase64 ??
    body.mediaBase64 ??
    body.base64 ??
    null;
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  const m = /^data:([^;]+);base64,(.+)$/is.exec(s);
  if (m) {
    return {
      base64: m[2].replace(/\s/g, ""),
      hintedType: m[1].trim(),
    };
  }
  return { base64: s.replace(/\s/g, ""), hintedType: null };
}

function safeFileName(name) {
  const base = String(name || "curriculo").replace(/[^\w.\-]+/g, "_");
  return base || "curriculo";
}

function isPdfBuffer(buffer) {
  return (
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  );
}

async function storageObjectUrl(objectPath) {
  if (STORAGE_SIGNED_URL) {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(objectPath, SIGNED_URL_TTL_SEC);
    if (error) {
      throw new Error(`URL assinada do Storage: ${error.message}`);
    }
    return data.signedUrl;
  }
  const { data } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(objectPath);
  return data.publicUrl;
}

/**
 * Upload no bucket (mesma ideia do evoluxbote: chave `sessionKey/timestamp-nome`).
 * Retorna null se não houver base64 não vazio.
 */
async function tryUploadResumeFromBody(body, sessionKey) {
  const parsed = extractBase64(body);
  if (!parsed) return null;

  let buffer;
  try {
    buffer = Buffer.from(parsed.base64, "base64");
  } catch {
    throw new Error("Arquivo em base64 inválido");
  }
  if (!buffer.length) return null;

  let safeName = safeFileName(body.fileName ?? body.file_name ?? "curriculo");
  let uploadContentType =
    String(body.mimetype ?? body.file_type ?? "").trim() ||
    (parsed.hintedType && parsed.hintedType.includes("/")
      ? parsed.hintedType
      : "") ||
    "application/octet-stream";

  if (isPdfBuffer(buffer)) {
    uploadContentType = "application/pdf";
    if (!safeName.toLowerCase().endsWith(".pdf")) {
      safeName = safeName.replace(/\.[^.]+$/, "") + ".pdf";
    }
  }

  const folder = String(sessionKey || "unknown").replace(
    /[^a-zA-Z0-9_-]/g,
    "_"
  );
  const objectPath = `${folder}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, buffer, {
      contentType: uploadContentType,
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Upload no bucket "${STORAGE_BUCKET}": ${uploadError.message}`);
  }

  const file_url = await storageObjectUrl(objectPath);

  return {
    file_path: objectPath,
    file_url,
    file_size: buffer.length,
    file_type: uploadContentType,
    file_name: body.fileName ?? body.file_name ?? safeName,
  };
}

/**
 * Campos de arquivo: com upload; ou URL/path explícitos no body; ou null (sem link quebrado).
 */
/**
 * Schema legado da tabela `resumes`: muitos projetos têm NOT NULL em file_* e às vezes em email.
 * Evita HTTP 500 no insert quando o n8n manda sem arquivo/base64 ou email vazio.
 */
function coerceRowForSupabaseInsert(row) {
  const out = { ...row };
  const phone = out.candidate_phone || "sem-telefone";

  out.candidate_name =
    out.candidate_name != null && String(out.candidate_name).trim() !== ""
      ? String(out.candidate_name).trim()
      : "";
  out.candidate_email =
    out.candidate_email != null && String(out.candidate_email).trim() !== ""
      ? String(out.candidate_email).trim()
      : "";

  const storageMissing =
    out.file_url == null ||
    String(out.file_url).trim() === "" ||
    out.file_path == null ||
    String(out.file_path).trim() === "";

  if (storageMissing) {
    out.file_path =
      out.file_path && String(out.file_path).trim() !== ""
        ? out.file_path
        : `no-file/${phone}/${Date.now()}`;
    out.file_url = String(out.file_url || "").trim();
    if (out.file_size == null || Number.isNaN(Number(out.file_size))) {
      out.file_size = 0;
    }
    if (!String(out.file_type || "").trim()) {
      out.file_type = "application/octet-stream";
    }
    if (!String(out.file_name || "").trim()) {
      out.file_name = "curriculo";
    }
  } else {
    if (out.file_size == null || Number.isNaN(Number(out.file_size))) {
      out.file_size = 0;
    }
    if (!String(out.file_type || "").trim()) {
      out.file_type = "application/octet-stream";
    }
  }

  return out;
}

function mergeFileFields(body, uploaded) {
  if (uploaded) {
    return {
      file_name: uploaded.file_name,
      file_path: uploaded.file_path,
      file_size: uploaded.file_size,
      file_type: uploaded.file_type,
      file_url: uploaded.file_url,
    };
  }

  const explicitUrl = body.fileUrl ?? body.file_url ?? null;
  if (explicitUrl) {
    const fsz =
      body.fileSize != null
        ? Number(body.fileSize)
        : body.file_size != null
        ? Number(body.file_size)
        : NaN;
    return {
      file_name: body.fileName ?? body.file_name ?? null,
      file_path: body.filePath ?? body.file_path ?? null,
      file_size: Number.isFinite(fsz) ? fsz : null,
      file_type:
        String(body.mimetype ?? body.file_type ?? "").trim() || null,
      file_url: explicitUrl,
    };
  }

  return {
    file_name: body.fileName ?? body.file_name ?? null,
    file_path: null,
    file_url: null,
    file_size: null,
    file_type: body.mimetype ?? body.file_type ?? null,
  };
}

async function buildResumeRow(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Payload inválido");
  }

  const phoneDigits = String(
    body.phone ?? body.candidate_phone ?? ""
  ).replace(/\D/g, "");
  if (!phoneDigits) {
    throw new Error("Campo obrigatório ausente: phone ou candidate_phone");
  }

  const sessionKey = String(
    body.sessionId ?? body.phone ?? phoneDigits ?? "sessao"
  ).replace(/\D/g, "") || "sem_sessao";

  const uploaded = await tryUploadResumeFromBody(body, sessionKey);
  const ff = mergeFileFields(body, uploaded);

  return {
    candidate_name: body.fullName ?? body.candidate_name ?? null,
    candidate_email: body.email ?? body.candidate_email ?? null,
    candidate_phone: phoneDigits,
    city: body.city ?? null,
    position_of_interest:
      body.jobInterest ?? body.position_of_interest ?? null,
    ...ff,
  };
}

const healthHandler = (_req, res) => {
  res.json({
    ok: true,
    service: "evolux-resumes-api",
    storageBucket: STORAGE_BUCKET,
    storageSignedUrl: STORAGE_SIGNED_URL,
  });
};

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

async function insertResume(req, res) {
  try {
    const rawRow = await buildResumeRow(req.body);
    const row = coerceRowForSupabaseInsert(rawRow);
    const { data, error } = await supabase
      .from("resumes")
      .insert(row)
      .select("*")
      .single();

    if (error) {
      return res.status(500).json({
        ok: false,
        error: "Erro ao salvar currículo no Supabase",
        details: error.message,
        code: error.code,
        hint: error.hint,
      });
    }

    return res.status(201).json({
      ok: true,
      message: "Currículo salvo com sucesso",
      resume: data,
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: "Payload inválido ou incompleto",
      details: err.message,
    });
  }
}

app.post("/webhook/resume", insertResume);
app.post("/resume", insertResume);
app.post("/api/webhook/resume", insertResume);
app.post("/api/resume", insertResume);

module.exports = app;
