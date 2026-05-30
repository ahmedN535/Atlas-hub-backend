require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.get('/api/health', (req, res) => {
  res.json({ status: "Backend is alive and kicking!" });
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

    // 4. GENERATE SEMANTIC EMBEDDING VECTOR
    console.log("[Embedding] Contacting text embedding services...");
    const textToEmbed = `Title: ${title}\nDescription: ${finalDescription}\nManual: ${finalManual}`;

    // FIXED: Cleaned up the absolute URL string wrapper here
    const embeddingResponse = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://localhost:5000"
      },
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: textToEmbed
      })
    });
    const embeddingData = await embeddingResponse.json();
    let vectorArray = [];

    if (embeddingData && embeddingData.data && embeddingData.data[0]) {
      vectorArray = embeddingData.data[0].embedding;
    } else {
      console.error("[Embedding Diagnostic Log]:", embeddingData);
      throw new Error("Failed validation on semantic vector assembly generation step.");
    }
    
    console.log(`[Success] Processed agent "${title}" successfully!`);
    
    return res.status(200).json({
      message: "Agent processed successfully!",
      data: {
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

app.listen(port, () => {
  console.log(`Server running smoothly on port ${port}`);
});