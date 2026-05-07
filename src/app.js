/**
 * API mínima: apenas persiste candidato currículo no Supabase.
 * O fluxo n8n (agente/chamadas OpenAI) chama esta API após confirmação/extração.
 */
require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "5mb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

/**
 * Aceita tanto camelCase quanto snake_case (útil quando o payload vem já pronto do n8n).
 */
function normalizeResumePayload(body) {
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

  const fallbackFilePath = `webhook/evolux/${sessionKey}/${encodeURIComponent(
    fallbackFileName
  )}`;

  const file_path = body.filePath ?? body.file_path ?? fallbackFilePath;

  let file_url = body.fileUrl ?? body.file_url ?? null;
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
      : NaN;
  const safeFileSize =
    Number.isFinite(parsedFileSize) && parsedFileSize >= 0 ? parsedFileSize : 0;

  const file_type =
    String(body.mimetype ?? body.file_type ?? "").trim() ||
    "application/octet-stream";

  return {
    candidate_name: body.fullName ?? body.candidate_name ?? null,
    candidate_email: body.email ?? body.candidate_email ?? null,
    candidate_phone: phoneDigits,
    city: body.city ?? null,
    position_of_interest:
      body.jobInterest ?? body.position_of_interest ?? null,
    file_name: body.fileName ?? body.file_name ?? fallbackFileName,
    file_path,
    file_size: safeFileSize,
    file_type,
    file_url,
  };
}

const healthHandler = (_req, res) => {
  res.json({ ok: true, service: "evolux-resumes-api" });
};

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

/**
 * POST /webhook/resume
 * Body (exemplo n8n após agente): fullName, email, phone, city, jobInterest,
 * opcionalmente fileName, filePath, file_url, file_size, mimetype
 */
async function insertResume(req, res) {
  try {
    const row = normalizeResumePayload(req.body);
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
// Aliases quando o projeto ainda está sob prefixo `/api/` no servidor.
app.post("/api/webhook/resume", insertResume);
app.post("/api/resume", insertResume);

module.exports = app;
