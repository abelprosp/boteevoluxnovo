/**
 * API mínima: persiste candidato currículo no Supabase (+ upload opcional no Storage).
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

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente antes de iniciar."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const BASE_PUBLIC_URL =
  process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ||
  "";

function extractBase64(body) {
  const raw =
    body.file_base64 ??
    body.fileBase64 ??
    body.mediaBase64 ??
    body.base64 ??
    null;
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  const m = /^data:([^;]+);base64,(.+)$/is.exec(s);
  if (m) {
    return { base64: m[2].replace(/\s/g, ""), hintedType: m[1].trim() };
  }
  return { base64: s.replace(/\s/g, ""), hintedType: null };
}

function sanitizeFileName(name) {
  const base = String(name || "curriculo")
    .replace(/[\\/]/g, "_")
    .replace(/[^\w.\-+ ]/gu, "_")
    .slice(0, 180);
  return base.trim() || "curriculo";
}

async function uploadResumeFile({
  sessionKey,
  fallbackFileName,
  file_type,
  body,
}) {
  const parsed = extractBase64(body);
  if (!parsed) return null;

  let buffer;
  try {
    buffer = Buffer.from(parsed.base64, "base64");
  } catch {
    throw new Error("Arquivo em base64 inválido");
  }
  if (!buffer.length) throw new Error("Arquivo vazio após decodificar base64");

  const fname = sanitizeFileName(body.fileName ?? body.file_name ?? fallbackFileName);
  const id = crypto.randomBytes(8).toString("hex");
  const objectPath = `evolux/${sessionKey}/${Date.now()}_${id}_${fname}`;

  const contentType =
    String(file_type || "").trim() ||
    parsed.hintedType ||
    "application/octet-stream";

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, buffer, {
      contentType,
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Upload no bucket "${STORAGE_BUCKET}": ${uploadError.message}`);
  }

  const { data: pub } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(objectPath);

  return {
    file_path: objectPath,
    file_url: pub.publicUrl,
    file_size: buffer.length,
  };
}

function fallbackSyntheticFileFields({
  body,
  sessionKey,
  fallbackFileName,
  uploaded,
}) {
  const fallbackFilePath = `webhook/evolux/${sessionKey}/${encodeURIComponent(
    fallbackFileName
  )}`;

  const file_path =
    uploaded?.file_path ??
    body.filePath ??
    body.file_path ??
    fallbackFilePath;

  let file_url =
    uploaded?.file_url ?? body.fileUrl ?? body.file_url ?? null;

  if (!file_url) {
    if (BASE_PUBLIC_URL) {
      file_url = `${BASE_PUBLIC_URL}/files/${encodeURIComponent(file_path)}`;
    } else {
      file_url = `https://app.local/files/${encodeURIComponent(file_path)}`;
    }
  }

  const parsedFileSize =
    body.fileSize != null
      ? Number(body.fileSize)
      : body.file_size != null
      ? Number(body.file_size)
      : uploaded?.file_size ?? NaN;
  const safeFileSize =
    uploaded?.file_size != null
      ? uploaded.file_size
      : Number.isFinite(parsedFileSize) && parsedFileSize >= 0
      ? parsedFileSize
      : 0;

  return { file_path, file_url, file_size: safeFileSize };
}

/**
 * Aceita tanto camelCase quanto snake_case (útil quando o payload vem já pronto do n8n).
 */
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

  const fallbackFileName =
    String(body.fileName ?? body.file_name ?? "").trim() || "curriculo";

  const sessionKey = String(
    body.sessionId ?? body.phone ?? phoneDigits ?? "sessao"
  ).replace(/\D/g, "") || "sem-sessao";

  const file_type =
    String(body.mimetype ?? body.file_type ?? "").trim() ||
    "application/octet-stream";

  const uploaded = await uploadResumeFile({
    sessionKey,
    fallbackFileName,
    file_type,
    body,
  });

  const { file_path, file_url, file_size } = fallbackSyntheticFileFields({
    body,
    sessionKey,
    fallbackFileName,
    uploaded,
  });

  return {
    candidate_name: body.fullName ?? body.candidate_name ?? null,
    candidate_email: body.email ?? body.candidate_email ?? null,
    candidate_phone: phoneDigits,
    city: body.city ?? null,
    position_of_interest:
      body.jobInterest ?? body.position_of_interest ?? null,
    file_name: body.fileName ?? body.file_name ?? fallbackFileName,
    file_path,
    file_size,
    file_type,
    file_url,
  };
}

const healthHandler = (_req, res) => {
  res.json({ ok: true, service: "evolux-resumes-api", storageBucket: STORAGE_BUCKET });
};

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

/**
 * POST /webhook/resume | /resume
 * Body: fullName, email, phone, city, jobInterest,
 * opcional: file_base64 ou mediaBase64 (conteúdo do arquivo),
 * fileName, mimetype,
 * opcionalmente filePath, file_url, file_size
 */
async function insertResume(req, res) {
  try {
    const row = await buildResumeRow(req.body);
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
