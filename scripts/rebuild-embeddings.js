require("dotenv").config();

const fetch = require("node-fetch");
const { Pool } = require("pg");

const EMBEDDING_MODEL = "openai/text-embedding-3-small";

const isHostedDatabase =
  process.env.DATABASE_URL?.includes("supabase.com") ||
  process.env.DATABASE_URL?.includes("pooler.supabase.com") ||
  process.env.DATABASE_URL?.includes("sslmode=require");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isHostedDatabase ? { rejectUnauthorized: false } : false,
});

function toPgVector(vectorArray) {
  if (!Array.isArray(vectorArray)) {
    throw new Error("Embedding must be an array");
  }

  return `[${vectorArray.join(",")}]`;
}

async function generateEmbedding(input) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is missing from .env");
  }

  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:5000",
      "X-Title": "AtlasHubSeedEmbeddings",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input,
    }),
  });

  const data = await response.json();

  if (data?.data?.[0]?.embedding) {
    return data.data[0].embedding;
  }

  console.error("[Embedding API Error]", JSON.stringify(data, null, 2));
  throw new Error("Failed to generate embedding");
}

function buildIndexedText(agent) {
  return [
    `Title: ${agent.name}`,
    `Category: ${agent.category || "general"}`,
    `Model: ${agent.model || "unknown"}`,
    `Description: ${agent.description || ""}`,
    `Manual: ${agent.manual || ""}`,
  ].join("\n");
}

async function rebuildEmbeddings() {
  const client = await pool.connect();

  try {
    console.log("Finding agents without embeddings...");

    const agentsResult = await client.query(`
      SELECT
        a.id,
        a.name,
        a.description,
        a.manual,
        a.category,
        a.model
      FROM agents a
      LEFT JOIN agent_embeddings e ON e.agent_id = a.id
      WHERE e.agent_id IS NULL
      ORDER BY a.id;
    `);

    const agents = agentsResult.rows;

    console.log(`Found ${agents.length} agents missing embeddings.`);

    if (agents.length === 0) {
      console.log("Nothing to rebuild.");
      return;
    }

    for (const agent of agents) {
      console.log(`Generating embedding for agent ${agent.id}: ${agent.name}`);

      const indexedText = buildIndexedText(agent);
      const embeddingArray = await generateEmbedding(indexedText);
      const pgVector = toPgVector(embeddingArray);

      await client.query(
        `
        INSERT INTO agent_embeddings (
          agent_id,
          indexed_text,
          embedding,
          embedding_model,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3::vector(1536), $4, NOW(), NOW())
        ON CONFLICT (agent_id)
        DO UPDATE SET
          indexed_text = EXCLUDED.indexed_text,
          embedding = EXCLUDED.embedding,
          embedding_model = EXCLUDED.embedding_model,
          updated_at = NOW();
        `,
        [agent.id, indexedText, pgVector, EMBEDDING_MODEL]
      );

      console.log(`Saved embedding for ${agent.name}`);
    }

    console.log("Finished rebuilding seed embeddings.");
  } finally {
    client.release();
    await pool.end();
  }
}

rebuildEmbeddings().catch((error) => {
  console.error("[Rebuild Embeddings Failed]", error);
  process.exit(1);
});
