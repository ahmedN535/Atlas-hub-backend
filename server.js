require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 5000;

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

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

function toPgVector(vectorArray) {
  if (!Array.isArray(vectorArray)) {
    throw new Error("Embedding must be an array");
  }
  return `[${vectorArray.join(",")}]`;
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

app.post('/api/agents/upload', upload.single('agentFile'), async (req, res) => {
  try {
    const { title, userDescription, userManual, useAiGeneration } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "Please upload an agent file script." });
    }

    const fileContent = req.file.buffer.toString('utf-8');
    let finalDescription = userDescription || "";
    let finalManual = userManual || "";

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey.includes("your_actual")) {
      console.error("[CRITICAL] Your OPENROUTER_API_KEY inside the .env file is missing or default!");
      return res.status(500).json({ error: "Backend configuration error: API key missing." });
    }

    if (useAiGeneration === 'true' || useAiGeneration === true) {
      console.log(`[AI] Dispatching code request to Claude 3.5 Sonnet...`);
      
      const systemPrompt = `You are an expert AI solution architect. Analyze the provided source code file. 
You must return a valid JSON object with EXACTLY two keys:
"suggested_description": A catchy, 2-3 sentence marketing summary of what this agent does for a non-technical user.
"suggested_manual": A beautiful, step-by-step Markdown guide on how to configure, run, and interact with this agent.

Return ONLY raw JSON text data. Do not include markdown code block backticks (like \`\`\`) or the word "json" in your response wrapper.`;

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
            { role: "user", content: `Here is the agent code file content:\n\n${fileContent}` }
          ],
          temperature: 0.3,
          max_tokens: 2048
        })
      });

      const aiData = await aiResponse.json();
      
      if (aiData.error) {
        console.error("--- OPENROUTER REJECTION DETAILS ---");
        console.log(JSON.stringify(aiData.error, null, 2)); // FIXED: Changed print() to console.log()
        return res.status(400).json({ error: "OpenRouter provider rejected request", details: aiData.error.message });
      }

      if (aiData && aiData.choices && aiData.choices[0] && aiData.choices[0].message) {
        let rawJsonText = aiData.choices[0].message.content.trim();
        
        if (rawJsonText.startsWith("```")) {
          rawJsonText = rawJsonText.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
        }

        try {
            // Clean up any weird invisible spaces, line breaks, or markdown block hangers
            let cleanJsonString = rawJsonText.trim();
            
            // Regex fallback: If Claude wrapped the JSON inside ```json ... ``` blocks anyway, extract just the object
            if (cleanJsonString.includes("{")) {
              const firstBracket = cleanJsonString.indexOf("{");
              const lastBracket = cleanJsonString.lastIndexOf("}");
              cleanJsonString = cleanJsonString.substring(firstBracket, lastBracket + 1);
            }
  
            const parsedAiResult = JSON.parse(cleanJsonString);
            
            finalDescription = userDescription || parsedAiResult.suggested_description;
            finalManual = userManual || parsedAiResult.suggested_manual;
          } catch (jsonParseErr) {
            console.error("[CRITICAL JSON CRASH] Claude string failed to parse. Raw output was:", rawJsonText);
            throw new Error("Formatting constraints fell out of standard parsable parameters.");
          }
      } else {
        console.error("[Diagnostic Log] Raw structural mismatch payload return:", aiData);
        throw new Error("Returned structured array state configuration error or drop.");
      }
    }

    console.log("[Embedding] Contacting text embedding services...");
    const textToEmbed = `Title: ${title}\nDescription: ${finalDescription}\nManual: ${finalManual}`;
    const vectorArray = await generateEmbedding(apiKey, textToEmbed);
    const pgVector = toPgVector(vectorArray);

    const client = await pool.connect();
    let savedAgent;

    try {
      await client.query('BEGIN');

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
          is_public
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, name, description, manual`,
        [
          1,
          title,
          finalDescription,
          finalManual,
          req.body.category || "general",
          req.body.model || "unknown",
          req.file.originalname,
          fileContent,
          true
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
          textToEmbed,
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
    
    console.log(`[Success] Processed and saved agent "${title}" successfully!`);
    
    return res.status(200).json({
      message: "Agent processed and saved successfully!",
      data: {
        id: savedAgent.id,
        title,
        description: finalDescription,
        manual: finalManual,
        vectorLength: vectorArray.length,
        vectorPreview: vectorArray.slice(0, 5)
      }
    });

  } catch (error) {
    console.error("Pipeline Exception Stack:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.get('/api/agents', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        id,
        name,
        description,
        category,
        model,
        file_name,
        is_public,
        created_at
      FROM agents
      WHERE is_public = TRUE
      ORDER BY created_at DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Agent List Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.get('/api/agents/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        a.id,
        a.name,
        a.description,
        a.manual,
        a.category,
        a.model,
        a.file_name,
        a.is_public,
        a.created_at,
        e.indexed_text,
        e.embedding_model
      FROM agents a
      LEFT JOIN agent_embeddings e ON e.agent_id = a.id
      WHERE a.id = $1 AND a.is_public = TRUE`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Agent not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Agent Detail Exception Stack:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.post('/api/agents/search', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Search query is required." });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey.includes("your_actual")) {
      console.error("[CRITICAL] Your OPENROUTER_API_KEY inside the .env file is missing or default!");
      return res.status(500).json({ error: "Backend configuration error: API key missing." });
    }

    const queryVectorArray = await generateEmbedding(apiKey, query);
    const queryVector = toPgVector(queryVectorArray);

    const result = await pool.query(
      `SELECT
        a.id,
        a.name,
        a.description,
        a.category,
        a.model,
        a.file_name,
        1 - (e.embedding <=> $1::vector) AS similarity
      FROM agents a
      JOIN agent_embeddings e ON e.agent_id = a.id
      WHERE a.is_public = TRUE
        AND e.embedding IS NOT NULL
      ORDER BY e.embedding <=> $1::vector
      LIMIT 10`,
      [queryVector]
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
        similarity: Number(agent.similarity),
        reason: "Matched by semantic similarity to the search query."
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
