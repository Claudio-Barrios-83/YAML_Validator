const express = require("express");
const path = require("path");
const yaml = require("js-yaml");

const app = express();

/** Render / Railway set PORT; bind 0.0.0.0 so the container accepts external traffic */
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const OPENAI_API_URL =
  process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const ANALYZE_MAX_CHARS = Number(process.env.OPENAI_ANALYZE_MAX_CHARS || 120000);

const ANALYZE_SYSTEM_PROMPT = `You are an expert in YAML and Kubernetes resource manifests.
When given YAML and parser metadata, respond in Markdown with exactly these sections:

### Validity
Confirm syntactic validity using the parser status provided. If invalid, explain briefly.

### Suggested improvements
Concrete, actionable bullets (style, structure, quoting, anchors, lists, indentation).

### Kubernetes concerns
If this looks like Kubernetes YAML (apiVersion/kind/metadata/spec), call out security, reliability, and ops issues: deprecated APIs, missing resource limits, privileged/hostNetwork/hostPID, missing probes, image tags :latest, empty selectors, ClusterRole risks, Secrets in plain YAML, etc.
If it is clearly not Kubernetes-related, say so in one short sentence.

Be concise. Do not repeat the full YAML back.`;

const YAML_LOAD_OPTIONS = { schema: yaml.DEFAULT_SCHEMA };
const YAML_DUMP_OPTIONS = {
  indent: 2,
  lineWidth: -1,
  noRefs: true,
  sortKeys: false,
  noCompatMode: true,
  flowLevel: -1,
  noArrayIndent: false,
};

/**
 * Drops null/undefined mapping values only (keeps "", {}, [], and nulls inside
 * sequences) so typical Kubernetes manifests stay valid.
 */
function stripNoiseFields(node) {
  if (node === null || node === undefined) {
    return node;
  }
  if (typeof node !== "object") {
    return node;
  }
  if (node instanceof Date || Buffer.isBuffer(node)) {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(stripNoiseFields);
  }
  const out = {};
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (v === null || v === undefined) {
      continue;
    }
    out[key] = stripNoiseFields(v);
  }
  return out;
}

/** Known cluster-managed metadata / annotations safe to strip for “export manifest” workflows */
const K8S_METADATA_KEYS = new Set([
  "creationTimestamp",
  "deletionGracePeriodSeconds",
  "deletionTimestamp",
  "generation",
  "managedFields",
  "resourceVersion",
  "selfLink",
  "uid",
  "clusterName",
]);

const K8S_ANNOTATION_KEYS_STRIP = new Set([
  "kubectl.kubernetes.io/last-applied-configuration",
  "deployment.kubernetes.io/revision",
]);

function looksLikeKubernetesDoc(obj) {
  return (
    obj !== null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    typeof obj.apiVersion === "string" &&
    typeof obj.kind === "string"
  );
}

/**
 * Removes status and read-only metadata so Clean output is suitable for re-apply / GitOps
 * (similar spirit to kubectl-neat). Only runs on objects with apiVersion + kind.
 */
function sanitizeKubernetesResource(obj) {
  if (!looksLikeKubernetesDoc(obj)) {
    return obj;
  }

  const out = { ...obj };
  delete out.status;

  if (out.kind === "List" && Array.isArray(out.items)) {
    out.items = out.items.map((item) =>
      looksLikeKubernetesDoc(item) ? sanitizeKubernetesResource(item) : item,
    );
    return out;
  }

  if (out.metadata && typeof out.metadata === "object" && !Array.isArray(out.metadata)) {
    const md = { ...out.metadata };
    for (const k of K8S_METADATA_KEYS) {
      delete md[k];
    }
    if (md.annotations && typeof md.annotations === "object" && !Array.isArray(md.annotations)) {
      const ann = { ...md.annotations };
      for (const k of K8S_ANNOTATION_KEYS_STRIP) {
        delete ann[k];
      }
      if (Object.keys(ann).length === 0) {
        delete md.annotations;
      } else {
        md.annotations = ann;
      }
    }
    out.metadata = md;
  }

  return out;
}

function cleanParsedDocument(doc) {
  if (doc === undefined) {
    return undefined;
  }
  if (doc === null) {
    return null;
  }
  if (typeof doc === "object") {
    let next = stripNoiseFields(doc);
    if (looksLikeKubernetesDoc(next)) {
      next = sanitizeKubernetesResource(next);
      next = stripNoiseFields(next);
    }
    return next;
  }
  return doc;
}

function buildValidationError(err) {
  const mark = err && err.mark;
  const line = mark != null && typeof mark.line === "number" ? mark.line + 1 : undefined;
  const fullMessage = err && err.message ? err.message : String(err);
  const reason = fullMessage.split(/\r?\n/)[0].trim() || "Parse error";
  const error =
    line !== undefined ? `Error at line ${line}: ${reason}` : `Error: ${reason}`;

  const payload = {
    valid: false,
    error,
    reason,
  };
  if (line !== undefined) payload.line = line;
  return payload;
}

app.use(express.text({ type: "*/*", limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/validate", (req, res) => {
  const raw = typeof req.body === "string" ? req.body : "";
  try {
    const docs = yaml.loadAll(raw, YAML_LOAD_OPTIONS);
    if (docs.length === 0) {
      return res.json({
        valid: true,
        message: "Valid YAML",
        json: null,
      });
    }
    if (docs.length === 1) {
      const parsed = docs[0];
      return res.json({
        valid: true,
        message: "Valid YAML",
        json: parsed === undefined ? null : parsed,
      });
    }
    return res.json({
      valid: true,
      message: "Valid YAML",
      json: docs.map((d) => (d === undefined ? null : d)),
    });
  } catch (err) {
    res.json(buildValidationError(err));
  }
});

app.post("/clean", (req, res) => {
  const raw = typeof req.body === "string" ? req.body : "";
  try {
    const documents = yaml.loadAll(raw, YAML_LOAD_OPTIONS);
    const chunks = [];
    for (const doc of documents) {
      const cleaned = cleanParsedDocument(doc);
      chunks.push(yaml.dump(cleaned, YAML_DUMP_OPTIONS).replace(/\s+$/, ""));
    }
    const cleanText =
      chunks.length === 0 ? "" : chunks.join("\n---\n") + "\n";
    res.type("text/yaml; charset=utf-8").send(cleanText);
  } catch (err) {
    res.status(400).type("text/plain; charset=utf-8").send(err.message || String(err));
  }
});

app.post("/analyze", async (req, res) => {
  const raw = typeof req.body === "string" ? req.body : "";
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    return res.json({
      ok: true,
      enabled: false,
      message:
        "AI analysis is optional. Set the OPENAI_API_KEY environment variable and restart the server to enable it.",
    });
  }

  let parseValid = false;
  let documentCount = 0;
  let parseError = null;
  try {
    const docs = yaml.loadAll(raw, YAML_LOAD_OPTIONS);
    documentCount = docs.length;
    parseValid = true;
  } catch (err) {
    parseValid = false;
    parseError = err.message || String(err);
  }

  let yamlForModel = raw;
  let truncated = false;
  if (raw.length > ANALYZE_MAX_CHARS) {
    yamlForModel = raw.slice(0, ANALYZE_MAX_CHARS);
    truncated = true;
  }

  const parseSection = parseValid
    ? `Parser (js-yaml): VALID — ${documentCount} document(s).`
    : `Parser (js-yaml): INVALID — ${parseError}`;

  const userContent = [
    parseSection,
    truncated
      ? `Note: input was truncated to ${ANALYZE_MAX_CHARS} characters for analysis.`
      : null,
    "",
    "YAML to analyze:",
    "```yaml",
    yamlForModel,
    "```",
  ]
    .filter((line) => line !== null)
    .join("\n");

  try {
    const oaRes = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.25,
        max_tokens: 4096,
        messages: [
          { role: "system", content: ANALYZE_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });

    const oaText = await oaRes.text();
    if (!oaRes.ok) {
      let detail = oaText;
      try {
        const errJson = JSON.parse(oaText);
        detail = errJson.error?.message || oaText;
      } catch (e) {
        /* keep raw */
      }
      return res.status(502).json({
        ok: false,
        enabled: true,
        error: `OpenAI request failed (${oaRes.status}): ${detail}`,
      });
    }

    const oaJson = JSON.parse(oaText);
    const analysis =
      oaJson.choices?.[0]?.message?.content?.trim() ||
      "No analysis text returned.";

    return res.json({
      ok: true,
      enabled: true,
      parseValid,
      documentCount,
      truncated,
      analysis,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      enabled: true,
      error: err.message || String(err),
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`YAML Validator listening on http://${HOST}:${PORT}`);
  if (process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim()) {
    console.log("POST /analyze: OpenAI enabled (%s)", OPENAI_MODEL);
  }
});
