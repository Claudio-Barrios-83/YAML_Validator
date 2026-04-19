const express = require("express");
const path = require("path");
const yaml = require("js-yaml");

const app = express();

/** Render / Railway set PORT; bind 0.0.0.0 so the container accepts external traffic */
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

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

/** Keep deployment.kubernetes.io/revision — aligns with tools like ValidKube */
const K8S_ANNOTATION_KEYS_STRIP = new Set([
  "kubectl.kubernetes.io/last-applied-configuration",
]);

/**
 * Drops keys whose value is an empty plain object {}, recursively (e.g. securityContext: {}).
 * Applied only under resource spec; omitting {} matches usual Kubernetes defaults.
 */
function pruneEmptyMappingObjects(node) {
  if (node === null || node === undefined) {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => pruneEmptyMappingObjects(item));
  }
  if (typeof node !== "object") {
    return node;
  }
  if (node instanceof Date || Buffer.isBuffer(node)) {
    return node;
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    let child = pruneEmptyMappingObjects(v);
    if (
      child &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      !(child instanceof Date) &&
      !Buffer.isBuffer(child) &&
      Object.keys(child).length === 0
    ) {
      continue;
    }
    out[k] = child;
  }
  return out;
}

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

  if (out.spec !== undefined && typeof out.spec === "object" && out.spec !== null) {
    out.spec = pruneEmptyMappingObjects(out.spec);
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

/**
 * Best-effort Kubernetes summary from the first parsed document (for UI banner).
 */
function detectFromParsed(parsed) {
  if (parsed === undefined || parsed === null) {
    return {
      summary: "Unknown resource",
      kind: null,
      namespace: null,
    };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      summary: "Unknown resource",
      kind: null,
      namespace: null,
    };
  }
  const kind = typeof parsed.kind === "string" ? parsed.kind : null;
  if (!kind) {
    return {
      summary: "Unknown resource",
      kind: null,
      namespace: null,
    };
  }
  const ns =
    parsed.metadata &&
    typeof parsed.metadata === "object" &&
    !Array.isArray(parsed.metadata) &&
    typeof parsed.metadata.namespace === "string"
      ? parsed.metadata.namespace
      : null;
  const summary =
    ns !== null
      ? `${kind} (namespace: ${ns})`
      : `${kind} (no namespace in manifest)`;
  return { summary, kind, namespace: ns };
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
        message: "YAML syntax is valid (empty stream)",
        documentCount: 0,
        json: null,
        detection: detectFromParsed(undefined),
      });
    }
    if (docs.length === 1) {
      const parsed = docs[0];
      return res.json({
        valid: true,
        message: "YAML syntax is valid",
        documentCount: 1,
        json: parsed === undefined ? null : parsed,
        detection: detectFromParsed(parsed),
      });
    }
    return res.json({
      valid: true,
      message: `YAML syntax is valid (${docs.length} documents)`,
      documentCount: docs.length,
      json: docs.map((d) => (d === undefined ? null : d)),
      detection: detectFromParsed(docs[0]),
    });
  } catch (err) {
    res.json(buildValidationError(err));
  }
});

/**
 * POST /format — cosmetic YAML layout only (indent 2, stable dump).
 * Does not strip Kubernetes metadata or nulls (use /clean for that).
 */
app.post("/format", (req, res) => {
  const raw = typeof req.body === "string" ? req.body : "";
  try {
    const documents = yaml.loadAll(raw, YAML_LOAD_OPTIONS);
    const chunks = [];
    for (const doc of documents) {
      chunks.push(yaml.dump(doc, YAML_DUMP_OPTIONS).replace(/\s+$/, ""));
    }
    const yamlText =
      chunks.length === 0 ? "" : chunks.join("\n---\n") + "\n";
    res.json({
      yaml: yamlText,
      detection: detectFromParsed(documents[0]),
    });
  } catch (err) {
    res.status(400).json(buildValidationError(err));
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
    const yamlText =
      chunks.length === 0 ? "" : chunks.join("\n---\n") + "\n";
    res.json({
      yaml: yamlText,
      detection: detectFromParsed(documents[0]),
    });
  } catch (err) {
    res.status(400).json(buildValidationError(err));
  }
});

app.listen(PORT, HOST, () => {
  console.log(`YAML Validator listening on http://${HOST}:${PORT}`);
});
