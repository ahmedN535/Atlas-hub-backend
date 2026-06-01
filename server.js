require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const { createClient } = require("@supabase/supabase-js");

const app = express();
const port = process.env.PORT || 5000;

const supabaseAdmin =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      )
    : null;

const isHostedDatabase =
  process.env.DATABASE_URL?.includes("supabase.com") ||
  process.env.DATABASE_URL?.includes("pooler.supabase.com") ||
  process.env.DATABASE_URL?.includes("sslmode=require");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isHostedDatabase
    ? { rejectUnauthorized: false }
    : false
});

app.use(cors());
app.use(express.json());

async function requireAuth(req, res, next) {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({
        error: "Backend Supabase auth is not configured.",
      });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;

    if (!token) {
      return res.status(401).json({ error: "Sign in required." });
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }

    req.authUser = data.user;
    await ensureProfile(data.user);
    next();

  } catch (error) {
    console.error("[Auth Error]", error);
    return res.status(500).json({ error: "Authentication failed." });
  }
}

async function ensureProfile(user) {
  const metadata = user.user_metadata || {};

  const displayName =
    metadata.display_name ||
    metadata.full_name ||
    user.email?.split("@")[0] ||
    "Atlas user";

  const emailPrefix =
    user.email?.split("@")[0]?.replace(/[^a-zA-Z0-9_]/g, "_") || "user";

  // Add part of the UUID to avoid username unique constraint conflicts.
  const fallbackUsername = `${emailPrefix}_${user.id.slice(0, 8)}`.slice(0, 50);

  const username =
    metadata.username?.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 50) ||
    fallbackUsername;

  await pool.query(
    `
    INSERT INTO profiles (
      id,
      email,
      username,
      display_name
    )
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      display_name = COALESCE(NULLIF(profiles.display_name, ''), EXCLUDED.display_name),
      username = COALESCE(profiles.username, EXCLUDED.username),
      updated_at = NOW()
    `,
    [user.id, user.email, username, displayName]
  );
}

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

function toPgVector(vectorArray) {
  if (!Array.isArray(vectorArray)) {
    throw new Error("Embedding must be an array");
  }
  return `[${vectorArray.join(",")}]`;
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on", "public"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "n", "off", "private"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function getCurrentUserId(req) {
  const rawUserId = req.header("x-user-id") || req.query.userId || "1";
  const userId = Number(rawUserId);

  if (!Number.isInteger(userId) || userId <= 0) {
    return 1;
  }

  return userId;
}

function normalizeVisibility(body) {
  const rawVisibility = body.visibility || body.agentVisibility;

  if (rawVisibility === "private") return "private";
  if (rawVisibility === "followers" || rawVisibility === "followers_only") return "followers";
  if (rawVisibility === "org_only") return "org_only";
  if (rawVisibility === "group_only") return "group_only";
  if (rawVisibility === "public") return "public";

  if (body.isPublic === false || body.isPublic === "false" || body.is_public === false || body.is_public === "false") {
    return "private";
  }

  return "public";
}

function isPublicFromVisibility(visibility) {
  return visibility === "public";
}

function assertValidVisibility(visibility) {
  if (!["public", "private", "followers", "org_only", "group_only"].includes(visibility)) {
    throw new Error("Invalid visibility. Use public, private, followers, org_only, or group_only.");
  }
}

function parseNullableId(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeRole(value, fallback = "member") {
  const role = String(value || "").trim().toLowerCase();
  return ["owner", "admin", "member"].includes(role) ? role : fallback;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getSafeDownloadFileName(fileName, agentName, agentId) {
  const fallbackName = agentName ? `${agentName}.txt` : `agent-${agentId}.txt`;
  const rawName = String(fileName || fallbackName).trim() || fallbackName;
  const sanitized = rawName
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);

  return sanitized || `agent-${agentId}.txt`;
}

async function getOrganizationRole(client, orgId, userId) {
  const result = await client.query(
    `SELECT role
     FROM organization_members
     WHERE org_id = $1 AND user_id = $2`,
    [orgId, String(userId)]
  );

  return result.rows[0]?.role || null;
}

async function requireOrganizationRole(client, orgId, userId, allowedRoles) {
  const role = await getOrganizationRole(client, orgId, userId);

  if (!role || !allowedRoles.includes(role)) {
    const error = new Error("You do not have permission to manage this organization.");
    error.status = 403;
    throw error;
  }

  return role;
}

async function getGroupContext(client, groupId, userId) {
  const result = await client.query(
    `SELECT
      g.id,
      g.org_id,
      g.name,
      g.slug,
      g.description,
      g.created_by,
      g.created_at,
      g.updated_at,
      gm.role AS current_user_group_role,
      om.role AS current_user_org_role
    FROM groups g
    LEFT JOIN group_members gm
      ON gm.group_id = g.id
      AND gm.user_id = $2
    LEFT JOIN organization_members om
      ON om.org_id = g.org_id
      AND om.user_id = $2::text
    WHERE g.id = $1`,
    [groupId, userId]
  );

  return result.rows[0] || null;
}

function canManageGroup(group) {
  return (
    ["owner", "admin"].includes(group?.current_user_group_role) ||
    ["owner", "admin"].includes(group?.current_user_org_role)
  );
}

function canViewGroup(group) {
  return Boolean(group?.current_user_group_role || ["owner", "admin"].includes(group?.current_user_org_role));
}

async function requireGroupRole(client, groupId, userId, mode = "view") {
  const group = await getGroupContext(client, groupId, userId);

  if (!group) {
    const error = new Error("Group not found.");
    error.status = 404;
    throw error;
  }

  const allowed = mode === "manage" ? canManageGroup(group) : canViewGroup(group);

  if (!allowed) {
    const error = new Error("You do not have permission to access this group.");
    error.status = 403;
    throw error;
  }

  return group;
}

async function getOrganizationMembers(client, orgId) {
  const result = await client.query(
    `SELECT
      om.org_id,
      om.user_id,
      om.role,
      om.joined_at,
      u.username,
      u.display_name,
      u.email
    FROM organization_members om
    LEFT JOIN users u ON u.id::text = om.user_id
    WHERE om.org_id = $1
    ORDER BY
      CASE om.role
        WHEN 'owner' THEN 1
        WHEN 'admin' THEN 2
        ELSE 3
      END,
      om.joined_at ASC`,
    [orgId]
  );

  return result.rows.map((member) => ({
    ...member,
    display_name: member.display_name || member.username || `User ${member.user_id}`
  }));
}

async function getOrganizationAgents(client, orgId) {
  const result = await client.query(
    `SELECT
      a.id,
      a.name,
      a.description,
      a.category,
      a.model,
      a.file_name,
      a.is_public,
      a.visibility,
      a.org_id,
      a.group_id,
      g.name AS group_name,
      a.user_id,
      a.user_id AS uploader_id,
      u.username AS owner_username,
      u.display_name AS uploader_name,
      u.display_name AS team,
      a.tags,
      a.created_at
    FROM agents a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN groups g ON g.id = a.group_id
    WHERE a.org_id = $1
      AND a.deleted_at IS NULL
    ORDER BY a.created_at DESC`,
    [orgId]
  );

  return result.rows;
}

async function getOrganizationDetail(client, orgId, userId) {
  const userKey = String(userId);
  const result = await client.query(
    `SELECT
      o.id,
      o.name,
      o.slug,
      o.description,
      o.avatar_url,
      o.created_by,
      o.created_at,
      o.updated_at,
      om.role AS current_user_role,
      (
        SELECT COUNT(*)::int
        FROM organization_members members
        WHERE members.org_id = o.id
      ) AS member_count,
      (
        SELECT COUNT(*)::int
        FROM agents a
        WHERE a.org_id = o.id
          AND a.deleted_at IS NULL
      ) AS agent_count
    FROM organizations o
    LEFT JOIN organization_members om
      ON om.org_id = o.id
      AND om.user_id = $2
    WHERE o.id = $1`,
    [orgId, userKey]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const organization = result.rows[0];
  const [members, agents] = await Promise.all([
    getOrganizationMembers(client, orgId),
    getOrganizationAgents(client, orgId)
  ]);

  return {
    ...organization,
    members,
    agents
  };
}

function sendRouteError(res, error, fallbackMessage = "Internal Server Error") {
  const status = error.status || 500;
  if (status >= 500) console.error("[Route Error]", error);
  res.status(status).json({ error: error.message || fallbackMessage, details: error.details });
}

function parseTags(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  let rawTags = value;

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed);
      rawTags = Array.isArray(parsed) ? parsed : trimmed;
    } catch (_error) {
      rawTags = trimmed;
    }
  }

  const tagList = Array.isArray(rawTags)
    ? rawTags
    : String(rawTags).split(/[,;\n]/);

  const seen = new Set();
  const tags = [];

  for (const tag of tagList) {
    const normalizedTag = String(tag || "").trim();
    const dedupeKey = normalizedTag.toLowerCase();

    if (normalizedTag && !seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      tags.push(normalizedTag);
    }
  }

  return tags;
}

function pickText(body, camelName, snakeName, defaultValue = "") {
  const value = body[camelName] ?? body[snakeName];

  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean).join("\n");
  }

  return String(value).trim();
}

function buildIndexedText(agentMetadata) {
  const sections = [
    ["Title", agentMetadata.title],
    ["Category", agentMetadata.category],
    ["Model", agentMetadata.model],
    ["Description", agentMetadata.description],
    ["Manual", agentMetadata.manual],
    ["Tools and integrations", agentMetadata.toolsIntegrations],
    ["Prerequisites", agentMetadata.prerequisites],
    ["Input format", agentMetadata.inputFormat],
    ["Output format", agentMetadata.outputFormat],
    ["Use cases", agentMetadata.useCases],
    ["Example prompts", agentMetadata.examplePrompts],
    ["Limitations", agentMetadata.limitations],
    ["When to use", agentMetadata.whenToUse],
    ["When not to use", agentMetadata.whenNotToUse],
    ["Setup instructions", agentMetadata.setupInstructions],
    ["Expected users", agentMetadata.expectedUsers],
    ["Tags", Array.isArray(agentMetadata.tags) ? agentMetadata.tags.join(", ") : agentMetadata.tags],
    ["File content summary", agentMetadata.fileContentSummary]
  ];

  return sections
    .filter(([_label, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([label, value]) => `${label}: ${String(value).trim()}`)
    .join("\n\n");
}

function normalizeAgentMetadata(body) {
  const title = pickText(body, "title", "name") || "Untitled Agent";

  return {
    title,
    category: pickText(body, "category", "category") || "general",
    model: pickText(body, "model", "model") || "unknown",
    description: pickText(body, "description", "description") || pickText(body, "userDescription", "user_description"),
    manual: pickText(body, "manual", "manual") || pickText(body, "userManual", "user_manual"),
    isPublic: parseBoolean(body.isPublic ?? body.is_public, true),
    toolsIntegrations: pickText(body, "toolsIntegrations", "tools_integrations"),
    prerequisites: pickText(body, "prerequisites", "prerequisites"),
    inputFormat: pickText(body, "inputFormat", "input_format"),
    outputFormat: pickText(body, "outputFormat", "output_format"),
    useCases: pickText(body, "useCases", "use_cases"),
    examplePrompts: pickText(body, "examplePrompts", "example_prompts"),
    limitations: pickText(body, "limitations", "limitations"),
    whenToUse: pickText(body, "whenToUse", "when_to_use"),
    whenNotToUse: pickText(body, "whenNotToUse", "when_not_to_use"),
    setupInstructions: pickText(body, "setupInstructions", "setup_instructions"),
    expectedUsers: pickText(body, "expectedUsers", "expected_users"),
    tags: parseTags(body.tags)
  };
}

function normalizeAiText(value) {
  if (value === undefined || value === null) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean).join("\n");
  }

  return String(value).trim();
}

function normalizeAiArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return parseTags(value);
  }

  return [];
}

function extractJsonObject(rawText) {
  let cleanJsonString = String(rawText || "").trim();

  if (cleanJsonString.startsWith("```")) {
    cleanJsonString = cleanJsonString
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();
  }

  if (cleanJsonString.includes("{")) {
    const firstBracket = cleanJsonString.indexOf("{");
    const lastBracket = cleanJsonString.lastIndexOf("}");
    cleanJsonString = cleanJsonString.substring(firstBracket, lastBracket + 1);
  }

  return JSON.parse(cleanJsonString);
}

function mergeAnalyzedMetadata(metadata, parsedAiResult) {
  return {
    title: normalizeAiText(parsedAiResult.title) || metadata.title,
    category: normalizeAiText(parsedAiResult.category) || metadata.category,
    model: normalizeAiText(parsedAiResult.model) || metadata.model,
    description: normalizeAiText(parsedAiResult.description) || metadata.description,
    manual: normalizeAiText(parsedAiResult.manual) || metadata.manual,
    toolsIntegrations: normalizeAiText(parsedAiResult.toolsIntegrations) || metadata.toolsIntegrations,
    prerequisites: normalizeAiText(parsedAiResult.prerequisites) || metadata.prerequisites,
    inputFormat: normalizeAiText(parsedAiResult.inputFormat) || metadata.inputFormat,
    outputFormat: normalizeAiText(parsedAiResult.outputFormat) || metadata.outputFormat,
    useCases: normalizeAiText(parsedAiResult.useCases) || metadata.useCases,
    examplePrompts: normalizeAiText(parsedAiResult.examplePrompts) || metadata.examplePrompts,
    limitations: normalizeAiText(parsedAiResult.limitations) || metadata.limitations,
    whenToUse: normalizeAiText(parsedAiResult.whenToUse) || metadata.whenToUse,
    whenNotToUse: normalizeAiText(parsedAiResult.whenNotToUse) || metadata.whenNotToUse,
    setupInstructions: normalizeAiText(parsedAiResult.setupInstructions) || metadata.setupInstructions,
    expectedUsers: normalizeAiText(parsedAiResult.expectedUsers) || metadata.expectedUsers,
    tags: parseTags(parsedAiResult.tags?.length ? parsedAiResult.tags : metadata.tags),
    missingFields: normalizeAiArray(parsedAiResult.missingFields),
    warnings: normalizeAiArray(parsedAiResult.warnings),
    suggestedSearchQueries: normalizeAiArray(parsedAiResult.suggestedSearchQueries)
  };
}

async function analyzeAgentWithAI(apiKey, fileContent, metadata) {
  const systemPrompt = `You are an expert AI agent marketplace reviewer.
Analyze the uploaded agent file and the user-provided metadata.
Return ONLY one raw JSON object. Do not include markdown, backticks, prose, or a JSON wrapper.

The JSON object must use these exact keys:
title, category, model, description, manual, toolsIntegrations, prerequisites, inputFormat, outputFormat, useCases, examplePrompts, limitations, whenToUse, whenNotToUse, setupInstructions, expectedUsers, tags, missingFields, warnings, suggestedSearchQueries.

String fields must be concise and useful for a marketplace listing.
tags, missingFields, warnings, and suggestedSearchQueries must be arrays of strings.
Prefer the user's supplied metadata when it is accurate, but fill gaps from the file content.`;

  const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://localhost:5000",
      "X-Title": "AgentSharePointHackathon"
    },
    body: JSON.stringify({
      model: "anthropic/claude-3.5-sonnet",
      models: [
        "anthropic/claude-3.5-sonnet",
        "anthropic/claude-3.5-haiku",
        "openai/gpt-4o"
      ],
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            userMetadata: metadata,
            agentFileContent: fileContent
          })
        }
      ],
      temperature: 0.2,
      max_tokens: 4096
    })
  });

  const aiData = await aiResponse.json();

  if (!aiResponse.ok || aiData.error) {
    console.error("[OpenRouter Analyze Error]:", aiData.error || aiData);
    throw new Error(aiData.error?.message || "OpenRouter analysis request failed.");
  }

  if (!aiData?.choices?.[0]?.message?.content) {
    console.error("[OpenRouter Analyze Structural Mismatch]:", aiData);
    throw new Error("OpenRouter analysis response did not include usable content.");
  }

  try {
    const parsedAiResult = extractJsonObject(aiData.choices[0].message.content);
    return mergeAnalyzedMetadata(metadata, parsedAiResult);
  } catch (jsonParseError) {
    console.error("[OpenRouter Analyze JSON Parse Error]:", jsonParseError.message);
    throw new Error("OpenRouter analysis response was not valid JSON.");
  }
}

async function generateEmbedding(apiKey, input) {
  const embeddingResponse = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://localhost:5000"
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input
    })
  });

  const embeddingData = await embeddingResponse.json();

  if (embeddingData && embeddingData.data && embeddingData.data[0]) {
    return embeddingData.data[0].embedding;
  }

  console.error("[Embedding Diagnostic Log]:", embeddingData);
  throw new Error("Failed validation on semantic vector assembly generation step.");
}

function getOpenRouterApiKey() {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey || apiKey.includes("your_actual")) {
    console.error("[CRITICAL] OPENROUTER_API_KEY is missing or still set to a placeholder.");
    return null;
  }

  return apiKey;
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: "ok",
      backend: "alive",
      database: "connected"
    });
  } catch (error) {
    console.error("[Database Health Check Failed]:", error);
    res.status(500).json({
      status: "error",
      backend: "alive",
      database: "disconnected",
      details: error.message
    });
  }
});

app.post('/api/users/:id/follow', async (req, res) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const targetUserId = Number(req.params.id);

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "User id must be a positive integer" });
    }

    if (targetUserId === currentUserId) {
      return res.status(400).json({ error: "You cannot follow yourself" });
    }

    const targetUser = await pool.query(
      `SELECT id, username, email
      FROM users
      WHERE id = $1`,
      [targetUserId]
    );

    if (targetUser.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    await pool.query(
      `INSERT INTO follows (follower_id, following_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING`,
      [currentUserId, targetUserId]
    );

    res.status(200).json({
      message: "User followed successfully",
      following: targetUser.rows[0]
    });
  } catch (error) {
    console.error("User Follow Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.delete('/api/users/:id/follow', async (req, res) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const targetUserId = Number(req.params.id);

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "User id must be a positive integer" });
    }

    await pool.query(
      `DELETE FROM follows
      WHERE follower_id = $1
        AND following_id = $2`,
      [currentUserId, targetUserId]
    );

    res.status(200).json({
      message: "User unfollowed successfully",
      following_id: targetUserId
    });
  } catch (error) {
    console.error("User Unfollow Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.get('/api/users/:id/followers', async (req, res) => {
  try {
    const targetUserId = Number(req.params.id);

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "User id must be a positive integer" });
    }

    const result = await pool.query(
      `SELECT
        u.id,
        u.username,
        u.email,
        f.created_at AS followed_at
      FROM follows f
      JOIN users u ON u.id = f.follower_id
      WHERE f.following_id = $1
      ORDER BY f.created_at DESC`,
      [targetUserId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("User Followers Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.get('/api/users/:id/following', async (req, res) => {
  try {
    const targetUserId = Number(req.params.id);

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "User id must be a positive integer" });
    }

    const result = await pool.query(
      `SELECT
        u.id,
        u.username,
        u.email,
        f.created_at AS followed_at
      FROM follows f
      JOIN users u ON u.id = f.following_id
      WHERE f.follower_id = $1
      ORDER BY f.created_at DESC`,
      [targetUserId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("User Following Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.get('/api/users/:id/activity', async (req, res) => {
  try {
    const profileUserId = Number(req.params.id);
    const currentUserId = getCurrentUserId(req);

    if (!Number.isInteger(profileUserId) || profileUserId <= 0) {
      return res.status(400).json({ error: "User id must be a positive integer." });
    }

    const result = await pool.query(
      `WITH visible_agents AS (
        SELECT
          a.id,
          a.name,
          a.description,
          a.visibility,
          a.org_id,
          a.group_id,
          a.user_id,
          a.created_at
        FROM agents a
        WHERE a.deleted_at IS NULL
          AND (
            a.visibility = 'public'
            OR a.user_id = $2
            OR (
              a.visibility = 'followers'
              AND EXISTS (
                SELECT 1
                FROM follows f
                WHERE f.follower_id = $2
                  AND f.following_id = a.user_id
              )
            )
            OR (
              a.visibility = 'org_only'
              AND a.org_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM organization_members om
                WHERE om.org_id = a.org_id
                  AND om.user_id = $2::text
              )
            )
            OR (
              a.visibility = 'group_only'
              AND a.group_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM group_members gm
                WHERE gm.group_id = a.group_id
                  AND gm.user_id = $2
              )
            )
          )
      ),
      upload_activity AS (
        SELECT
          'agent_upload'::text AS type,
          va.created_at,
          va.id AS agent_id,
          va.name AS agent_name,
          va.description AS agent_description,
          va.visibility,
          va.org_id,
          va.group_id,
          NULL::bigint AS review_id,
          NULL::float AS rating,
          NULL::text AS review_title,
          NULL::text AS review_body
        FROM visible_agents va
        WHERE va.user_id = $1
      ),
      review_activity AS (
        SELECT
          'review'::text AS type,
          r.created_at,
          va.id AS agent_id,
          va.name AS agent_name,
          va.description AS agent_description,
          va.visibility,
          va.org_id,
          va.group_id,
          r.id AS review_id,
          r.rating_x2 / 2.0 AS rating,
          r.title AS review_title,
          r.experience AS review_body
        FROM agent_reviews r
        JOIN visible_agents va ON va.id = r.agent_id
        WHERE r.user_id = $1
      )
      SELECT *
      FROM (
        SELECT * FROM upload_activity
        UNION ALL
        SELECT * FROM review_activity
      ) activity
      ORDER BY created_at DESC
      LIMIT 50`,
      [profileUserId, currentUserId]
    );

    res.json({
      user_id: profileUserId,
      activity: result.rows
    });
  } catch (error) {
    console.error("User Activity Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const targetUserId = Number(req.params.id);

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "User id must be a positive integer" });
    }

    const result = await pool.query(
      `SELECT
        u.id,
        u.username,
        u.email,
        COUNT(DISTINCT followers.follower_id)::int AS follower_count,
        COUNT(DISTINCT following.following_id)::int AS following_count,
        EXISTS (
          SELECT 1
          FROM follows current_follow
          WHERE current_follow.follower_id = $2
            AND current_follow.following_id = u.id
        ) AS is_following
      FROM users u
      LEFT JOIN follows followers ON followers.following_id = u.id
      LEFT JOIN follows following ON following.follower_id = u.id
      WHERE u.id = $1
      GROUP BY u.id, u.username, u.email`,
      [targetUserId, currentUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("User Detail Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.get('/api/feed/following', async (req, res) => {
  try {
    const currentUserId = getCurrentUserId(req);

    const result = await pool.query(
      `SELECT
        a.id,
        a.name,
        a.description,
        a.category,
        a.model,
        a.file_name,
        a.is_public,
        a.visibility,
        a.org_id,
        a.user_id,
        u.username AS owner_username,
        a.created_at,
        a.tags
      FROM follows f
      JOIN agents a ON a.user_id = f.following_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE f.follower_id = $1
        AND a.deleted_at IS NULL
        AND (
          a.visibility IN ('public', 'followers')
          OR (
            a.visibility = 'org_only'
            AND EXISTS (
              SELECT 1
              FROM organization_members om
              WHERE om.org_id = a.org_id
                AND om.user_id = $1::text
            )
          )
          OR (
            a.visibility = 'group_only'
            AND a.group_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM group_members gm
              WHERE gm.group_id = a.group_id
                AND gm.user_id = $1
            )
          )
        )
      ORDER BY a.created_at DESC`,
      [currentUserId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Following Feed Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.post('/api/agents/analyze', upload.single('agentFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Please upload an agent file script." });
    }

    const apiKey = getOpenRouterApiKey();

    if (!apiKey) {
      return res.status(500).json({ error: "Backend configuration error: API key missing." });
    }

    const fileContent = req.file.buffer.toString('utf-8');
    const metadata = normalizeAgentMetadata(req.body);
    const analyzedMetadata = await analyzeAgentWithAI(apiKey, fileContent, metadata);

    return res.status(200).json({
      message: "Agent analyzed successfully",
      data: analyzedMetadata
    });
  } catch (error) {
    console.error("Agent Analyze Exception Stack:", error);
    return res.status(500).json({ error: "Agent analysis failed", details: error.message });
  }
});

app.post('/api/agents/upload', upload.single('agentFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Please upload an agent file script." });
    }

    const currentUserId = getCurrentUserId(req);
    const visibility = normalizeVisibility(req.body);
    assertValidVisibility(visibility);
    const isPublic = isPublicFromVisibility(visibility);
    const requestedOrgId = parseNullableId(req.body.org_id ?? req.body.orgId);
    const requestedGroupId = parseNullableId(req.body.group_id ?? req.body.groupId);
    let orgId = visibility === "org_only" || visibility === "group_only" ? requestedOrgId : null;
    const groupId = visibility === "group_only" ? requestedGroupId : null;

    const apiKey = getOpenRouterApiKey();

    if (!apiKey) {
      return res.status(500).json({ error: "Backend configuration error: API key missing." });
    }

    const fileContent = req.file.buffer.toString('utf-8');
    const metadata = normalizeAgentMetadata(req.body);
    const fileContentSummary = fileContent.slice(0, 4000);
    const indexedText = buildIndexedText({ ...metadata, fileContentSummary });

    console.log("[Embedding] Contacting text embedding services...");
    const vectorArray = await generateEmbedding(apiKey, indexedText);
    const pgVector = toPgVector(vectorArray);

    const client = await pool.connect();
    let savedAgent;

    try {
      await client.query('BEGIN');

      if (visibility === "org_only") {
        if (!orgId) {
          const error = new Error("Choose an organization before publishing an org-only agent.");
          error.status = 400;
          throw error;
        }

        await requireOrganizationRole(client, orgId, currentUserId, ["owner", "admin"]);
      }

      if (visibility === "group_only") {
        if (!groupId) {
          const error = new Error("Choose a group before publishing a group-only agent.");
          error.status = 400;
          throw error;
        }

        const group = await getGroupContext(client, groupId, currentUserId);

        if (!group) {
          const error = new Error("Group not found.");
          error.status = 400;
          throw error;
        }

        if (orgId && Number(group.org_id) !== Number(orgId)) {
          const error = new Error("Selected group does not belong to the selected organization.");
          error.status = 400;
          throw error;
        }

        if (!canViewGroup(group)) {
          const error = new Error("You do not have permission to publish into this group.");
          error.status = 403;
          throw error;
        }

        orgId = group.org_id;
      }

      const agentResult = await client.query(
        `INSERT INTO agents (
          user_id,
          name,
          description,
          manual,
          category,
          model,
          file_name,
          file_content,
          is_public,
          visibility,
          org_id,
          group_id,
          tools_integrations,
          prerequisites,
          input_format,
          output_format,
          use_cases,
          example_prompts,
          limitations,
          when_to_use,
          when_not_to_use,
          setup_instructions,
          expected_users,
          tags
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
        RETURNING
          id,
          name,
          name AS title,
          description,
          manual,
          category,
          model,
          file_name,
          is_public,
          is_public AS "isPublic",
          visibility,
          org_id,
          group_id,
          tools_integrations AS "toolsIntegrations",
          prerequisites,
          input_format AS "inputFormat",
          output_format AS "outputFormat",
          use_cases AS "useCases",
          example_prompts AS "examplePrompts",
          limitations,
          when_to_use AS "whenToUse",
          when_not_to_use AS "whenNotToUse",
          setup_instructions AS "setupInstructions",
          expected_users AS "expectedUsers",
          tags,
          created_at`,
        [
          currentUserId,
          metadata.title,
          metadata.description,
          metadata.manual,
          metadata.category,
          metadata.model,
          req.file.originalname,
          fileContent,
          isPublic,
          visibility,
          orgId,
          groupId,
          metadata.toolsIntegrations,
          metadata.prerequisites,
          metadata.inputFormat,
          metadata.outputFormat,
          metadata.useCases,
          metadata.examplePrompts,
          metadata.limitations,
          metadata.whenToUse,
          metadata.whenNotToUse,
          metadata.setupInstructions,
          metadata.expectedUsers,
          metadata.tags
        ]
      );

      savedAgent = agentResult.rows[0];

      await client.query(
        `INSERT INTO agent_embeddings (
          agent_id,
          indexed_text,
          embedding,
          embedding_model
        )
        VALUES ($1, $2, $3::vector, $4)`,
        [
          savedAgent.id,
          indexedText,
          pgVector,
          "openai/text-embedding-3-small"
        ]
      );

      await client.query('COMMIT');
    } catch (dbError) {
      await client.query('ROLLBACK');
      throw dbError;
    } finally {
      client.release();
    }

    console.log(`[Success] Saved agent "${metadata.title}" successfully.`);

    return res.status(200).json({
      message: "Agent saved successfully",
      data: {
        agent: savedAgent,
        id: savedAgent.id,
        title: savedAgent.title,
        name: savedAgent.name,
        visibility: savedAgent.visibility,
        isPublic: savedAgent.isPublic,
        is_public: savedAgent.is_public,
        org_id: savedAgent.org_id,
        group_id: savedAgent.group_id,
        description: savedAgent.description,
        manual: savedAgent.manual,
        vectorLength: vectorArray.length
      }
    });
  } catch (error) {
    console.error("Agent Upload Exception Stack:", error);
    const status = error.status || 500;
    return res.status(status).json({
      error: status === 500 ? "Agent upload failed" : error.message,
      details: error.message
    });
  }
});

app.get('/api/agents', async (req, res) => {
  try {
    const currentUserId = getCurrentUserId(req);

    const result = await pool.query(
      `WITH review_stats AS (
        SELECT
          agent_id,
          COUNT(*)::int AS review_count,
          COALESCE(AVG(rating_x2) / 2.0, 0)::float AS average_rating
        FROM agent_reviews
        GROUP BY agent_id
      )
      SELECT
        a.id,
        a.name,
        a.description,
        a.category,
        a.model,
        a.file_name,
        a.is_public,
        a.visibility,
        a.org_id,
        o.name AS org_name,
        a.group_id,
        g.name AS group_name,
        a.user_id,
        u.username AS owner_username,
        u.display_name AS owner_display_name,
        u.display_name AS uploader_name,
        a.created_at,
        a.tags,
        COALESCE(rs.review_count, 0) AS review_count,
        COALESCE(rs.average_rating, 0) AS average_rating
      FROM agents a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN organizations o ON o.id = a.org_id
      LEFT JOIN groups g ON g.id = a.group_id
      LEFT JOIN review_stats rs ON rs.agent_id = a.id
      WHERE a.deleted_at IS NULL
        AND (
          a.visibility = 'public'
          OR a.user_id = $1
          OR (
            a.visibility = 'followers'
            AND EXISTS (
              SELECT 1
              FROM follows f
              WHERE f.follower_id = $1
                AND f.following_id = a.user_id
            )
          )
          OR (
            a.visibility = 'org_only'
            AND EXISTS (
              SELECT 1
              FROM organization_members om
              WHERE om.org_id = a.org_id
                AND om.user_id = $1::text
            )
          )
          OR (
            a.visibility = 'group_only'
            AND a.group_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM group_members gm
              WHERE gm.group_id = a.group_id
                AND gm.user_id = $1
            )
          )
        )
      ORDER BY a.created_at DESC`,
      [currentUserId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Agent List Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.get('/api/me/agents', async (req, res) => {
  try {
    const currentUserId = getCurrentUserId(req);

    const result = await pool.query(
      `SELECT
        id,
        name,
        description,
        category,
        model,
        file_name,
        is_public,
        visibility,
        org_id,
        group_id,
        created_at,
        updated_at,
        tags
      FROM agents
      WHERE user_id = $1
        AND deleted_at IS NULL
      ORDER BY created_at DESC`,
      [currentUserId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("My Agents List Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.get('/api/organizations', async (req, res) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const currentUserKey = String(currentUserId);

    const result = await pool.query(
      `SELECT
        o.id,
        o.name,
        o.slug,
        o.description,
        o.avatar_url,
        o.created_by,
        o.created_at,
        o.updated_at,
        om.role AS current_user_role,
        COUNT(DISTINCT members.user_id)::int AS member_count,
        COUNT(DISTINCT a.id)::int AS agent_count
      FROM organization_members om
      JOIN organizations o ON o.id = om.org_id
      LEFT JOIN organization_members members ON members.org_id = o.id
      LEFT JOIN agents a
        ON a.org_id = o.id
        AND a.deleted_at IS NULL
      WHERE om.user_id = $1
      GROUP BY
        o.id,
        o.name,
        o.slug,
        o.description,
        o.avatar_url,
        o.created_by,
        o.created_at,
        o.updated_at,
        om.role
      ORDER BY o.updated_at DESC, o.created_at DESC`,
      [currentUserKey]
    );

    res.json(result.rows);
  } catch (error) {
    sendRouteError(res, error);
  }
});

app.post('/api/organizations', async (req, res) => {
  const client = await pool.connect();

  try {
    const currentUserId = getCurrentUserId(req);
    const currentUserKey = String(currentUserId);
    const name = String(req.body.name || "").trim();
    const description = String(req.body.description || "").trim();
    const avatarUrl = String(req.body.avatar_url || req.body.avatarUrl || "").trim();
    const slug = slugify(req.body.slug || name);

    if (!name) {
      return res.status(400).json({ error: "Organization name is required." });
    }

    if (!slug) {
      return res.status(400).json({ error: "Organization slug could not be generated." });
    }

    await client.query('BEGIN');

    const orgResult = await client.query(
      `INSERT INTO organizations (
        name,
        slug,
        description,
        avatar_url,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING
        id,
        name,
        slug,
        description,
        avatar_url,
        created_by,
        created_at,
        updated_at`,
      [name, slug, description, avatarUrl, currentUserKey]
    );

    const org = orgResult.rows[0];

    await client.query(
      `INSERT INTO organization_members (org_id, user_id, role)
      VALUES ($1, $2, 'owner')
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'owner'`,
      [org.id, currentUserKey]
    );

    const detail = await getOrganizationDetail(client, org.id, currentUserKey);

    await client.query('COMMIT');

    res.status(201).json({
      ...org,
      ...detail,
      current_user_role: "owner"
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    if (error.code === "23505") {
      error.status = 409;
      error.message = "An organization with that slug already exists.";
    }

    sendRouteError(res, error, "Could not create organization.");
  } finally {
    client.release();
  }
});

app.get('/api/organizations/:orgId/groups', async (req, res) => {
  const client = await pool.connect();

  try {
    const currentUserId = getCurrentUserId(req);
    const orgId = parseNullableId(req.params.orgId);

    if (!orgId) {
      return res.status(400).json({ error: "Organization id must be a positive integer." });
    }

    const orgExists = await client.query(
      `SELECT id
      FROM organizations
      WHERE id = $1`,
      [orgId]
    );

    if (orgExists.rows.length === 0) {
      return res.status(404).json({ error: "Organization not found." });
    }

    const role = await getOrganizationRole(client, orgId, currentUserId);

    if (!role) {
      return res.status(403).json({ error: "You do not have permission to view this organization's groups." });
    }

    const result = await client.query(
      `SELECT
        g.id,
        g.org_id,
        g.name,
        g.slug,
        g.description,
        g.created_by,
        g.created_at,
        g.updated_at,
        COUNT(gm.user_id)::int AS member_count
      FROM groups g
      LEFT JOIN group_members gm ON gm.group_id = g.id
      WHERE g.org_id = $1
      GROUP BY g.id
      ORDER BY g.name ASC`,
      [orgId]
    );

    res.json({ groups: result.rows });
  } catch (error) {
    sendRouteError(res, error, "Could not load groups.");
  } finally {
    client.release();
  }
});

app.post('/api/organizations/:orgId/groups', async (req, res) => {
  const client = await pool.connect();

  try {
    const currentUserId = getCurrentUserId(req);
    const orgId = parseNullableId(req.params.orgId);
    const name = String(req.body.name || "").trim();
    const description = String(req.body.description || "").trim();
    const slug = slugify(req.body.slug || name);

    if (!orgId) {
      return res.status(400).json({ error: "Organization id must be a positive integer." });
    }

    if (!name) {
      return res.status(400).json({ error: "Group name is required." });
    }

    if (!slug) {
      return res.status(400).json({ error: "Group slug could not be generated." });
    }

    await requireOrganizationRole(client, orgId, currentUserId, ["owner", "admin"]);
    await client.query('BEGIN');

    const groupResult = await client.query(
      `INSERT INTO groups (
        org_id,
        name,
        slug,
        description,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING
        id,
        org_id,
        name,
        slug,
        description,
        created_by,
        created_at,
        updated_at`,
      [orgId, name, slug, description, currentUserId]
    );

    const group = groupResult.rows[0];

    await client.query(
      `INSERT INTO group_members (group_id, user_id, role)
      VALUES ($1, $2, 'owner')
      ON CONFLICT (group_id, user_id) DO UPDATE SET role = 'owner'`,
      [group.id, currentUserId]
    );

    await client.query('COMMIT');

    res.status(201).json({
      ...group,
      current_user_group_role: "owner",
      member_count: 1
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    if (error.code === "23505") {
      error.status = 409;
      error.message = "A group with that slug already exists in this organization.";
    }

    sendRouteError(res, error, "Could not create group.");
  } finally {
    client.release();
  }
});

app.get('/api/groups/:groupId', async (req, res) => {
  const client = await pool.connect();

  try {
    const currentUserId = getCurrentUserId(req);
    const groupId = parseNullableId(req.params.groupId);

    if (!groupId) {
      return res.status(400).json({ error: "Group id must be a positive integer." });
    }

    const group = await requireGroupRole(client, groupId, currentUserId, "view");
    const members = await client.query(
      `SELECT
        gm.group_id,
        gm.user_id,
        gm.role,
        gm.joined_at,
        u.username,
        u.display_name,
        u.email
      FROM group_members gm
      LEFT JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = $1
      ORDER BY
        CASE gm.role
          WHEN 'owner' THEN 1
          WHEN 'admin' THEN 2
          ELSE 3
        END,
        gm.joined_at ASC`,
      [groupId]
    );

    res.json({
      ...group,
      members: members.rows.map((member) => ({
        ...member,
        display_name: member.display_name || member.username || `User ${member.user_id}`
      }))
    });
  } catch (error) {
    sendRouteError(res, error, "Could not load group.");
  } finally {
    client.release();
  }
});

app.post('/api/groups/:groupId/members', async (req, res) => {
  const client = await pool.connect();

  try {
    const currentUserId = getCurrentUserId(req);
    const groupId = parseNullableId(req.params.groupId);
    const targetUserId = parseNullableId(req.body.user_id ?? req.body.userId);
    const role = normalizeRole(req.body.role);

    if (!groupId || !targetUserId) {
      return res.status(400).json({ error: "Group id and member user id are required." });
    }

    const group = await requireGroupRole(client, groupId, currentUserId, "manage");

    if (role === "owner" && !["owner"].includes(group.current_user_group_role) && group.current_user_org_role !== "owner") {
      return res.status(403).json({ error: "Only owners can add another owner." });
    }

    const result = await client.query(
      `INSERT INTO group_members (group_id, user_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (group_id, user_id) DO UPDATE SET role = EXCLUDED.role
      RETURNING group_id, user_id, role, joined_at`,
      [groupId, targetUserId, role]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    sendRouteError(res, error, "Could not add group member.");
  } finally {
    client.release();
  }
});

app.delete('/api/groups/:groupId/members/:userId', async (req, res) => {
  const client = await pool.connect();

  try {
    const currentUserId = getCurrentUserId(req);
    const groupId = parseNullableId(req.params.groupId);
    const targetUserId = parseNullableId(req.params.userId);

    if (!groupId || !targetUserId) {
      return res.status(400).json({ error: "Group id and member user id are required." });
    }

    await requireGroupRole(client, groupId, currentUserId, "manage");

    await client.query(
      `DELETE FROM group_members
      WHERE group_id = $1 AND user_id = $2`,
      [groupId, targetUserId]
    );

    res.json({ message: "Group member removed successfully." });
  } catch (error) {
    sendRouteError(res, error, "Could not remove group member.");
  } finally {
    client.release();
  }
});

app.get('/api/organizations/:id', async (req, res) => {
  const client = await pool.connect();

  try {
    const currentUserId = getCurrentUserId(req);
    const orgId = parseNullableId(req.params.id);

    if (!orgId) {
      return res.status(400).json({ error: "Organization id must be a positive integer." });
    }

    await requireOrganizationRole(client, orgId, currentUserId, ["owner", "admin", "member"]);

    const organization = await getOrganizationDetail(client, orgId, currentUserId);

    if (!organization) {
      return res.status(404).json({ error: "Organization not found." });
    }

    res.json(organization);
  } catch (error) {
    sendRouteError(res, error);
  } finally {
    client.release();
  }
});

app.patch('/api/organizations/:id', async (req, res) => {
  const client = await pool.connect();

  try {
    const currentUserId = getCurrentUserId(req);
    const orgId = parseNullableId(req.params.id);

    if (!orgId) {
      return res.status(400).json({ error: "Organization id must be a positive integer." });
    }

    await requireOrganizationRole(client, orgId, currentUserId, ["owner", "admin"]);

    const name = req.body.name === undefined ? null : String(req.body.name || "").trim();
    const description =
      req.body.description === undefined ? null : String(req.body.description || "").trim();
    const avatarUrl =
      req.body.avatar_url === undefined && req.body.avatarUrl === undefined
        ? null
        : String(req.body.avatar_url || req.body.avatarUrl || "").trim();
    const slug =
      req.body.slug === undefined
        ? null
        : slugify(req.body.slug);

    if (name !== null && !name) {
      return res.status(400).json({ error: "Organization name cannot be empty." });
    }

    if (req.body.slug !== undefined && !slug) {
      return res.status(400).json({ error: "Organization slug cannot be empty." });
    }

    await client.query(
      `UPDATE organizations
      SET
        name = COALESCE($2, name),
        slug = COALESCE($3, slug),
        description = COALESCE($4, description),
        avatar_url = COALESCE($5, avatar_url),
        updated_at = NOW()
      WHERE id = $1`,
      [orgId, name, slug, description, avatarUrl]
    );

    const organization = await getOrganizationDetail(client, orgId, currentUserId);

    res.json(organization);
  } catch (error) {
    if (error.code === "23505") {
      error.status = 409;
      error.message = "An organization with that slug already exists.";
    }

    sendRouteError(res, error, "Could not update organization.");
  } finally {
    client.release();
  }
});

app.delete('/api/organizations/:id', async (req, res) => {
  const client = await pool.connect();

  try {
    const currentUserId = getCurrentUserId(req);
    const orgId = parseNullableId(req.params.id);

    if (!orgId) {
      return res.status(400).json({ error: "Organization id must be a positive integer." });
    }

    await requireOrganizationRole(client, orgId, currentUserId, ["owner"]);

    await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);

    res.json({ message: "Organization deleted successfully." });
  } catch (error) {
    sendRouteError(res, error, "Could not delete organization.");
  } finally {
    client.release();
  }
});

app.post('/api/organizations/:id/members', async (req, res) => {
  const client = await pool.connect();

  try {
    const currentUserId = getCurrentUserId(req);
    const orgId = parseNullableId(req.params.id);
    const userKey = String(req.body.user_id ?? req.body.userId ?? "").trim();
    const role = normalizeRole(req.body.role);

    if (!orgId) {
      return res.status(400).json({ error: "Organization id must be a positive integer." });
    }

    if (!userKey) {
      return res.status(400).json({ error: "Member user id is required." });
    }

    const actorRole = await requireOrganizationRole(client, orgId, currentUserId, ["owner", "admin"]);

    if (role === "owner" && actorRole !== "owner") {
      return res.status(403).json({ error: "Only owners can add another owner." });
    }

    const result = await client.query(
      `INSERT INTO organization_members (org_id, user_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role
      RETURNING org_id, user_id, role, joined_at`,
      [orgId, userKey, role]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    sendRouteError(res, error, "Could not add organization member.");
  } finally {
    client.release();
  }
});

app.patch('/api/organizations/:id/members/:userId', async (req, res) => {
  const client = await pool.connect();

  try {
    const currentUserId = getCurrentUserId(req);
    const orgId = parseNullableId(req.params.id);
    const targetUserKey = String(req.params.userId || "").trim();
    const nextRole = normalizeRole(req.body.role);

    if (!orgId || !targetUserKey) {
      return res.status(400).json({ error: "Organization id and member user id are required." });
    }

    const actorRole = await requireOrganizationRole(client, orgId, currentUserId, ["owner", "admin"]);

    if (nextRole === "owner" && actorRole !== "owner") {
      return res.status(403).json({ error: "Only owners can promote another owner." });
    }

    const existing = await client.query(
      `SELECT role
      FROM organization_members
      WHERE org_id = $1 AND user_id = $2`,
      [orgId, targetUserKey]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Organization member not found." });
    }

    if (existing.rows[0].role === "owner" && actorRole !== "owner") {
      return res.status(403).json({ error: "Only owners can change an owner role." });
    }

    if (existing.rows[0].role === "owner" && nextRole !== "owner") {
      const ownerCount = await client.query(
        `SELECT COUNT(*)::int AS count
        FROM organization_members
        WHERE org_id = $1 AND role = 'owner'`,
        [orgId]
      );

      if (ownerCount.rows[0].count <= 1) {
        return res.status(400).json({ error: "An organization must keep at least one owner." });
      }
    }

    const result = await client.query(
      `UPDATE organization_members
      SET role = $3
      WHERE org_id = $1 AND user_id = $2
      RETURNING org_id, user_id, role, joined_at`,
      [orgId, targetUserKey, nextRole]
    );

    res.json(result.rows[0]);
  } catch (error) {
    sendRouteError(res, error, "Could not update organization member.");
  } finally {
    client.release();
  }
});

app.delete('/api/organizations/:id/members/:userId', async (req, res) => {
  const client = await pool.connect();

  try {
    const currentUserId = getCurrentUserId(req);
    const currentUserKey = String(currentUserId);
    const orgId = parseNullableId(req.params.id);
    const targetUserKey = String(req.params.userId || "").trim();

    if (!orgId || !targetUserKey) {
      return res.status(400).json({ error: "Organization id and member user id are required." });
    }

    const isSelf = targetUserKey === currentUserKey;
    const actorRole = await getOrganizationRole(client, orgId, currentUserId);

    if (!actorRole) {
      return res.status(403).json({ error: "You are not a member of this organization." });
    }

    if (!isSelf && !["owner", "admin"].includes(actorRole)) {
      return res.status(403).json({ error: "You do not have permission to remove this member." });
    }

    const target = await client.query(
      `SELECT role
      FROM organization_members
      WHERE org_id = $1 AND user_id = $2`,
      [orgId, targetUserKey]
    );

    if (target.rows.length === 0) {
      return res.status(404).json({ error: "Organization member not found." });
    }

    if (target.rows[0].role === "owner") {
      if (actorRole !== "owner") {
        return res.status(403).json({ error: "Only owners can remove an owner." });
      }

      const ownerCount = await client.query(
        `SELECT COUNT(*)::int AS count
        FROM organization_members
        WHERE org_id = $1 AND role = 'owner'`,
        [orgId]
      );

      if (ownerCount.rows[0].count <= 1) {
        return res.status(400).json({ error: "An organization must keep at least one owner." });
      }
    }

    await client.query(
      `DELETE FROM organization_members
      WHERE org_id = $1 AND user_id = $2`,
      [orgId, targetUserKey]
    );

    res.json({ message: "Organization member removed successfully." });
  } catch (error) {
    sendRouteError(res, error, "Could not remove organization member.");
  } finally {
    client.release();
  }
});

app.patch('/api/agents/:id/visibility', async (req, res) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const agentId = Number(req.params.id);

    if (!Number.isInteger(agentId) || agentId <= 0) {
      return res.status(400).json({ error: "Agent id must be a positive integer" });
    }

    const visibility = normalizeVisibility(req.body);
    assertValidVisibility(visibility);
    const isPublic = isPublicFromVisibility(visibility);
    const requestedOrgId = parseNullableId(req.body.org_id ?? req.body.orgId);
    const requestedGroupId = parseNullableId(req.body.group_id ?? req.body.groupId);
    let orgId = visibility === "org_only" || visibility === "group_only" ? requestedOrgId : null;
    const groupId = visibility === "group_only" ? requestedGroupId : null;

    if (visibility === "org_only" && !orgId) {
      return res.status(400).json({ error: "Choose an organization before using org-only visibility." });
    }

    if (visibility === "group_only" && !groupId) {
      return res.status(400).json({ error: "Choose a group before using group-only visibility." });
    }

    const client = await pool.connect();
    let result;

    try {
      if (visibility === "org_only") {
        await requireOrganizationRole(client, orgId, currentUserId, ["owner", "admin"]);
      }

      if (visibility === "group_only") {
        const group = await getGroupContext(client, groupId, currentUserId);

        if (!group) {
          const error = new Error("Group not found.");
          error.status = 400;
          throw error;
        }

        if (orgId && Number(group.org_id) !== Number(orgId)) {
          const error = new Error("Selected group does not belong to the selected organization.");
          error.status = 400;
          throw error;
        }

        if (!canViewGroup(group)) {
          const error = new Error("You do not have permission to publish into this group.");
          error.status = 403;
          throw error;
        }

        orgId = group.org_id;
      }

      result = await client.query(
        `UPDATE agents
        SET
          visibility = $3,
          is_public = $4,
          org_id = $5,
          group_id = $6,
          updated_at = NOW()
        WHERE id = $1
          AND user_id = $2
          AND deleted_at IS NULL
        RETURNING
          id,
          name,
          user_id,
          visibility,
          is_public,
          org_id,
          group_id,
          updated_at`,
        [agentId, currentUserId, visibility, isPublic, orgId, groupId]
      );
    } finally {
      client.release();
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Agent not found or you do not have permission to update it" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Agent Visibility Update Exception Stack:", error);
    const status = error.status || 500;
    res.status(status).json({ error: status === 500 ? "Internal Server Error" : error.message, details: error.message });
  }
});

app.delete('/api/agents/:id', async (req, res) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const agentId = Number(req.params.id);

    if (!Number.isInteger(agentId) || agentId <= 0) {
      return res.status(400).json({ error: "Agent id must be a positive integer" });
    }

    const result = await pool.query(
      `UPDATE agents
      SET
        deleted_at = NOW(),
        is_public = false,
        visibility = 'private',
        updated_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND deleted_at IS NULL
      RETURNING
        id,
        name,
        deleted_at`,
      [agentId, currentUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Agent not found or you do not have permission to delete it" });
    }

    res.json({
      message: "Agent deleted successfully",
      agent: result.rows[0]
    });
  } catch (error) {
    console.error("Agent Delete Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.get('/api/agents/:id/download', async (req, res) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const agentId = Number(req.params.id);

    if (!Number.isInteger(agentId) || agentId <= 0) {
      return res.status(400).json({ error: "Agent id must be a positive integer" });
    }

    const result = await pool.query(
      `SELECT
        a.id,
        a.name,
        a.file_name,
        a.file_content
      FROM agents a
      WHERE a.id = $1
        AND a.deleted_at IS NULL
        AND (
          a.visibility = 'public'
          OR a.user_id = $2
          OR (
            a.visibility = 'followers'
            AND EXISTS (
              SELECT 1
              FROM follows f
              WHERE f.follower_id = $2
                AND f.following_id = a.user_id
            )
          )
          OR (
            a.visibility = 'org_only'
            AND a.org_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM organization_members om
              WHERE om.org_id = a.org_id
                AND om.user_id = $2::text
            )
          )
          OR (
            a.visibility = 'group_only'
            AND a.group_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM group_members gm
              WHERE gm.group_id = a.group_id
                AND gm.user_id = $2
            )
          )
        )`,
      [agentId, currentUserId]
    );

    if (result.rows.length === 0 || !result.rows[0].file_content) {
      return res.status(404).json({ error: "Agent file not found." });
    }

    const agent = result.rows[0];
    const filename = getSafeDownloadFileName(agent.file_name, agent.name, agent.id);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
    res.send(agent.file_content);
  } catch (error) {
    console.error("Agent Download Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.get('/api/agents/:id', async (req, res) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const agentId = Number(req.params.id);

    if (!Number.isInteger(agentId) || agentId <= 0) {
      return res.status(400).json({ error: "Agent id must be a positive integer" });
    }

    const result = await pool.query(
      `SELECT
        a.id,
        a.user_id,
        a.name,
        a.name AS title,
        a.description,
        a.manual,
        a.category,
        a.model,
        a.file_name,
        a.is_public,
        a.visibility,
        a.org_id,
        o.name AS org_name,
        a.group_id,
        g.name AS group_name,
        u.username AS owner_username,
        a.tools_integrations,
        a.tools_integrations AS "toolsIntegrations",
        a.prerequisites,
        a.input_format,
        a.input_format AS "inputFormat",
        a.output_format,
        a.output_format AS "outputFormat",
        a.use_cases,
        a.use_cases AS "useCases",
        a.example_prompts,
        a.example_prompts AS "examplePrompts",
        a.limitations,
        a.when_to_use,
        a.when_to_use AS "whenToUse",
        a.when_not_to_use,
        a.when_not_to_use AS "whenNotToUse",
        a.setup_instructions,
        a.setup_instructions AS "setupInstructions",
        a.expected_users,
        a.expected_users AS "expectedUsers",
        a.tags,
        a.created_at,
        a.updated_at,
        a.deleted_at,
        e.indexed_text,
        e.embedding_model,
        COALESCE(rs.review_count, 0) AS review_count,
        COALESCE(rs.average_rating, 0) AS average_rating
      FROM agents a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN organizations o ON o.id = a.org_id
      LEFT JOIN groups g ON g.id = a.group_id
      LEFT JOIN agent_embeddings e ON e.agent_id = a.id
      LEFT JOIN (
        SELECT
          agent_id,
          COUNT(*)::int AS review_count,
          COALESCE(AVG(rating_x2) / 2.0, 0)::float AS average_rating
        FROM agent_reviews
        GROUP BY agent_id
      ) rs ON rs.agent_id = a.id
      WHERE a.id = $1
        AND a.deleted_at IS NULL
        AND (
          a.visibility = 'public'
          OR a.user_id = $2
          OR (
            a.visibility = 'followers'
            AND EXISTS (
              SELECT 1
              FROM follows f
              WHERE f.follower_id = $2
                AND f.following_id = a.user_id
            )
          )
          OR (
            a.visibility = 'org_only'
            AND a.org_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM organization_members om
              WHERE om.org_id = a.org_id
                AND om.user_id = $2::text
            )
          )
          OR (
            a.visibility = 'group_only'
            AND a.group_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM group_members gm
              WHERE gm.group_id = a.group_id
                AND gm.user_id = $2
            )
          )
        )`,
      [agentId, currentUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Agent not found or not visible" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Agent Detail Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

function normalizeReviewResponse(row) {
  return {
    id: row.id,
    agent_id: row.agent_id,
    user_id: row.user_id,
    rating: Number(row.rating),
    title: row.title || "",
    experience: row.experience || "",
    downsides: row.downsides || "",

    // These match your current frontend review shape too.
    authorName: row.author_name || "Atlas Reviewer",
    authorTeam: row.author_username || "Contributor",
    body: row.experience || "",
    constraints: row.downsides || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

app.get("/api/agents/:id/reviews", async (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const currentUserId = getCurrentUserId(req);

    if (!Number.isInteger(agentId)) {
      return res.status(400).json({ error: "Invalid agent id." });
    }

    const agentCheck = await pool.query(
      `
      SELECT a.id
      FROM agents a
      WHERE a.id = $1
        AND a.deleted_at IS NULL
        AND (
          a.visibility = 'public'
          OR a.user_id = $2
          OR (
            a.visibility = 'followers'
            AND EXISTS (
              SELECT 1
              FROM follows f
              WHERE f.follower_id = $2
                AND f.following_id = a.user_id
            )
          )
          OR (
            a.visibility = 'org_only'
            AND a.org_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM organization_members om
              WHERE om.org_id = a.org_id
                AND om.user_id = $2::text
            )
          )
          OR (
            a.visibility = 'group_only'
            AND a.group_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM group_members gm
              WHERE gm.group_id = a.group_id
                AND gm.user_id = $2
            )
          )
        )
      `,
      [agentId, currentUserId]
    );

    if (agentCheck.rows.length === 0) {
      return res.status(404).json({ error: "Agent not found." });
    }

    const reviewsResult = await pool.query(
      `
      SELECT
        r.id,
        r.agent_id,
        r.user_id,
        r.rating_x2,
        r.rating_x2 / 2.0 AS rating,
        r.title,
        r.experience,
        r.downsides,
        r.created_at,
        r.updated_at,
        u.display_name AS author_name,
        u.username AS author_username
      FROM agent_reviews r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.agent_id = $1
      ORDER BY r.created_at DESC
      `,
      [agentId]
    );

    const summaryResult = await pool.query(
      `
      SELECT
        COUNT(*)::int AS review_count,
        COALESCE(AVG(rating_x2) / 2.0, 0)::float AS average_rating
      FROM agent_reviews
      WHERE agent_id = $1
      `,
      [agentId]
    );

    res.json({
      reviews: reviewsResult.rows.map(normalizeReviewResponse),
      summary: summaryResult.rows[0],
    });
  } catch (error) {
    console.error("[Get Reviews Error]", error);
    res.status(500).json({
      error: "Could not load reviews.",
      details: error.message,
    });
  }
});

app.post("/api/agents/:id/reviews", async (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const userId = getCurrentUserId(req);

    if (!Number.isInteger(agentId)) {
      return res.status(400).json({ error: "Invalid agent id." });
    }

    const rating = Number(req.body.rating);

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({
        error: "Rating must be a whole number between 1 and 5.",
      });
    }

    const title = String(req.body.title || "").trim();

    // Supports both your current frontend names and the cleaner backend names.
    const experience = String(req.body.experience || req.body.body || "").trim();
    const downsides = String(req.body.downsides || req.body.constraints || "").trim();

    if (!experience) {
      return res.status(400).json({
        error: "Experience description is required.",
      });
    }

    if (!downsides) {
      return res.status(400).json({
        error: "Downsides or shortcomings are required.",
      });
    }

    const agentCheck = await pool.query(
      `
      SELECT a.id
      FROM agents a
      WHERE a.id = $1
        AND a.deleted_at IS NULL
        AND (
          a.visibility = 'public'
          OR a.user_id = $2
          OR (
            a.visibility = 'followers'
            AND EXISTS (
              SELECT 1
              FROM follows f
              WHERE f.follower_id = $2
                AND f.following_id = a.user_id
            )
          )
          OR (
            a.visibility = 'org_only'
            AND a.org_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM organization_members om
              WHERE om.org_id = a.org_id
                AND om.user_id = $2::text
            )
          )
          OR (
            a.visibility = 'group_only'
            AND a.group_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM group_members gm
              WHERE gm.group_id = a.group_id
                AND gm.user_id = $2
            )
          )
        )
      `,
      [agentId, userId]
    );

    if (agentCheck.rows.length === 0) {
      return res.status(404).json({ error: "Agent not found." });
    }

    const ratingX2 = rating * 2;

    const result = await pool.query(
      `
      WITH saved_review AS (
        INSERT INTO agent_reviews (
          agent_id,
          user_id,
          rating_x2,
          title,
          experience,
          downsides
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (agent_id, user_id)
        DO UPDATE SET
          rating_x2 = EXCLUDED.rating_x2,
          title = EXCLUDED.title,
          experience = EXCLUDED.experience,
          downsides = EXCLUDED.downsides,
          updated_at = NOW()
        RETURNING
          id,
          agent_id,
          user_id,
          rating_x2,
          title,
          experience,
          downsides,
          created_at,
          updated_at
      )
      SELECT
        sr.id,
        sr.agent_id,
        sr.user_id,
        sr.rating_x2,
        sr.rating_x2 / 2.0 AS rating,
        sr.title,
        sr.experience,
        sr.downsides,
        sr.created_at,
        sr.updated_at,
        u.display_name AS author_name,
        u.username AS author_username
      FROM saved_review sr
      LEFT JOIN users u ON u.id = sr.user_id
      `,
      [agentId, userId, ratingX2, title, experience, downsides]
    );

    res.status(201).json({
      message: "Review saved.",
      review: normalizeReviewResponse(result.rows[0]),
    });
  } catch (error) {
    console.error("[Save Review Error]", error);
    res.status(500).json({
      error: "Could not save review.",
      details: error.message,
    });
  }
});

app.post('/api/agents/search', async (req, res) => {
  try {
    const { query } = req.body;
    const currentUserId = getCurrentUserId(req);

    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Search query is required." });
    }

    const apiKey = getOpenRouterApiKey();

    if (!apiKey) {
      return res.status(500).json({ error: "Backend configuration error: API key missing." });
    }

    const queryVectorArray = await generateEmbedding(apiKey, query);
    const queryVector = toPgVector(queryVectorArray);

    const result = await pool.query(
      `
      WITH review_stats AS (
        SELECT
          agent_id,
          COUNT(*)::int AS review_count,
          COALESCE(AVG(rating_x2) / 2.0, 0)::float AS average_rating
        FROM agent_reviews
        GROUP BY agent_id
      ),
      semantic_results AS (
        SELECT
          a.id,
          a.name,
          a.description,
          a.category,
          a.model,
          a.file_name,
          a.visibility,
          a.org_id,
          o.name AS org_name,
          a.group_id,
          g.name AS group_name,
          a.is_public,
          a.user_id,
          u.username AS owner_username,
          a.tags,
          1 - (e.embedding <=> $1::vector(1536)) AS similarity,
          COALESCE(rs.review_count, 0) AS review_count,
          COALESCE(rs.average_rating, 0) AS average_rating
        FROM agents a
        JOIN agent_embeddings e ON e.agent_id = a.id
        LEFT JOIN users u ON u.id = a.user_id
        LEFT JOIN organizations o ON o.id = a.org_id
        LEFT JOIN groups g ON g.id = a.group_id
        LEFT JOIN review_stats rs ON rs.agent_id = a.id
        WHERE a.deleted_at IS NULL
          AND e.embedding IS NOT NULL
          AND (
            a.visibility = 'public'
            OR a.user_id = $2
            OR (
              a.visibility = 'followers'
              AND EXISTS (
                SELECT 1
                FROM follows f
                WHERE f.follower_id = $2
                  AND f.following_id = a.user_id
              )
            )
            OR (
              a.visibility = 'org_only'
              AND a.org_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM organization_members om
                WHERE om.org_id = a.org_id
                  AND om.user_id = $2::text
              )
            )
            OR (
              a.visibility = 'group_only'
              AND a.group_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM group_members gm
                WHERE gm.group_id = a.group_id
                  AND gm.user_id = $2
              )
            )
          )
      )
      SELECT *,
        (
          similarity * 0.80
          + (average_rating / 5.0) * 0.15
          + LEAST(review_count, 20) / 20.0 * 0.05
        ) AS ranking_score
      FROM semantic_results
      ORDER BY ranking_score DESC
      LIMIT 10
      `,
      [queryVector, currentUserId]
    );

    res.json({
      query,
      results: result.rows.map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        category: agent.category,
        model: agent.model,
        file_name: agent.file_name,
        visibility: agent.visibility,
        org_id: agent.org_id,
        org_name: agent.org_name,
        group_id: agent.group_id,
        group_name: agent.group_name,
        is_public: agent.is_public,
        user_id: agent.user_id,
        owner_username: agent.owner_username,
        tags: agent.tags || [],
        similarity: Number(agent.similarity),
        average_rating: Number(agent.average_rating),
        review_count: Number(agent.review_count),
        ranking_score: Number(agent.ranking_score),
        reason: "Matched by semantic similarity, with review trust signals included."
      }))
    });
  } catch (error) {
    console.error("Agent Search Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

const server = app.listen(port, () => {
  console.log(`Server running smoothly on port ${port}`);
  console.log(`Health check: http://localhost:${port}/api/health`);
});

server.on("error", (error) => {
  console.error("[Server Error]", error);
});

server.on("close", () => {
  console.log("[Server Closed] Express server closed unexpectedly.");
});

process.on("beforeExit", (code) => {
  console.log("[Process beforeExit]", code);
});

process.on("exit", (code) => {
  console.log("[Process exit]", code);
});

process.on("uncaughtException", (error) => {
  console.error("[Uncaught Exception]", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Unhandled Rejection]", reason);
});
