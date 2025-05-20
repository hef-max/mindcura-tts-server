import { exec } from "child_process";
import compression from "compression";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { promises as fs } from "fs";
import fetch from "node-fetch";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

// Konfigurasi
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Direktori temporary untuk file
const TMP_DIR = '/tmp';

// Path ke Rhubarb berdasarkan platform
const isWindows = process.platform === "win32";
// Gunakan path absolut untuk memastikan file dapat ditemukan
const rhubarbPath = isWindows 
    ? path.join("rhubarb", "rhubarb.exe") 
    : path.join("rhubarb", "rhubarb");
const ffmpegPath = isWindows 
    ? path.join("ffmpeg", "bin", "ffmpeg.exe") 
    : path.join("ffmpeg", "bin", "ffmpeg");

// API clients
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Configuration
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const voiceID = process.env.ELEVENLABS_VOICE_ID; 
const port = process.env.PORT || 3000;

// Setup Express
const app = express();
app.use(compression()); // Aktifkan Gzip compression
app.use(express.json());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// Middleware untuk logging requests
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const separator = "=".repeat(80);
  
  console.log(separator);
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  console.log(`Headers: ${JSON.stringify(req.headers)}`);
  
  if (req.method === 'POST' && req.body) {
    // Batasi output untuk body yang besar
    const bodyCopy = { ...req.body };
    
    // Jika ada message, potong jika terlalu panjang
    if (bodyCopy.message && bodyCopy.message.length > 100) {
      bodyCopy.message = bodyCopy.message.substring(0, 100) + "...";
    }
    
    console.log(`Body: ${JSON.stringify(bodyCopy)}`);
  }
  
  // Tambahkan logging untuk response
  const originalSend = res.send;
  res.send = function(body) {
    // Log response summary
    let responseSummary;
    try {
      const parsed = JSON.parse(body);
      // Buat summary response tanpa data besar seperti base64
      const summary = { ...parsed };
      
      if (summary.messages && summary.messages.length > 0) {
        summary.messages = summary.messages.map(msg => {
          const msgCopy = { ...msg };
          if (msgCopy.audio) {
            msgCopy.audio = `[Base64 Audio: ${msgCopy.audio.length} chars]`;
          }
          if (msgCopy.lipsync) {
            msgCopy.lipsync = '[Lipsync Data Object]';
          }
          return msgCopy;
        });
      }
      
      responseSummary = JSON.stringify(summary, null, 2);
    } catch (e) {
      // Jika bukan JSON, potong response jika terlalu panjang
      responseSummary = typeof body === 'string' && body.length > 100 
        ? body.substring(0, 100) + "..." 
        : body;
    }
    
    console.log(`Response: ${responseSummary}`);
    console.log(separator);
    
    originalSend.call(this, body);
  };
  
  next();
});

// Pastikan folder tmp ada
try {
  await fs.mkdir(TMP_DIR, { recursive: true });
} catch (error) {
  console.log("Temp directory already exists or error creating it:", error);
}

// Helper: Eksekusi command dengan Promise
const execCommand = (command) => {
  console.log(`Executing command: ${command}`);
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Exec error: ${error}`);
        console.error(`Command that failed: ${command}`);
        reject(error);
        return;
      }
      if (stderr) {
        console.log(`Command stderr: ${stderr}`);
      }
      console.log(`Command stdout: ${stdout}`);
      resolve(stdout);
    });
  });
};

// Function: Text-to-Speech dengan ElevenLabs
async function textToSpeech(text, outputPath) {
  console.log(`Converting text to speech: "${text.substring(0, 30)}..."`);
  
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceID}`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': elevenLabsApiKey
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`ElevenLabs API error: ${response.status} - ${errorText}`);
      throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(outputPath, Buffer.from(arrayBuffer));
    console.log(`Speech saved to ${outputPath} (Size: ${arrayBuffer.byteLength} bytes)`);
    return true;
  } catch (error) {
    console.error("Error in text-to-speech:", error);
    throw error;
  }
}

// Function: Generate Lipsync
const generateLipsync = async (audioFilePath, outputFilePath) => {
  const time = new Date().getTime();
  console.log(`Starting lipsync for ${audioFilePath}`);
  
  try {
    // Convert mp3 to wav
    const wavFilePath = audioFilePath.replace('.mp3', '.wav');
    await execCommand(
      `${ffmpegPath} -y -i ${audioFilePath} ${wavFilePath}`
    );
    console.log(`Conversion done in ${new Date().getTime() - time}ms`);
    
    // Generate lipsync data
    await execCommand(
      `${rhubarbPath} -f json -o ${outputFilePath} ${wavFilePath} -r phonetic`
    );
    console.log(`Lip sync done in ${new Date().getTime() - time}ms`);
    
    // Validate lipsync file exists and is valid JSON
    const lipsyncData = await fs.readFile(outputFilePath, 'utf8');
    try {
      JSON.parse(lipsyncData);
      console.log(`Lipsync data validated: ${outputFilePath} (Size: ${lipsyncData.length} chars)`);
      return true;
    } catch (e) {
      console.error(`Generated lipsync data is not valid JSON: ${e.message}`);
      throw new Error("Invalid lipsync data generated");
    }
  } catch (error) {
    console.error("Error in generateLipsync:", error);
    throw error;
  }
};

// Helper: Read JSON file
const readJsonFile = async (file) => {
  try {
    const data = await fs.readFile(file, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading JSON file ${file}:`, error);
    throw error;
  }
};

// Helper: Convert file to base64
const fileToBase64 = async (file) => {
  try {
    const data = await fs.readFile(file);
    const base64 = data.toString("base64");
    console.log(`File ${file} converted to base64 (Size: ${base64.length} chars)`);
    return base64;
  } catch (error) {
    console.error(`Error reading file ${file}:`, error);
    throw error;
  }
};

// Function: Deteksi emosi dari teks
function detectEmotion(text) {
  text = text.toLowerCase();
  
  if (text.includes("senang") || text.includes("baik") || text.includes("bagus") || text.includes("hebat")) {
    return "smile";
  } else if (text.includes("sedih") || text.includes("maaf") || text.includes("kecewa")) {
    return "sad";
  } else if (text.includes("wow") || text.includes("mengejutkan") || text.includes("luar biasa")) {
    return "surprised";
  } else if (text.includes("khawatir") || text.includes("cemas") || text.includes("takut")) {
    return "sad";
  } else if (text.includes("marah") || text.includes("frustrasi") || text.includes("kesal")) {
    return "angry";
  } else {
    return "default";
  }
}

// Function: Dapatkan nama animasi berdasarkan emosi
function getAnimationFromEmotion(emotion) {
  switch (emotion) {
    case "smile":
      return "Laughing";
    case "sad":
      return "Crying";
    case "surprised":
      return "Laughing";
    case "angry":
      return "Angry";
    default:
      return "Talking_1";
  }
}

// Endpoint: Test server
app.get("/test", (req, res) => {
  res.json({
    status: "ok",
    message: "MindCura TTS Server is running",
    timestamp: new Date().toISOString(),
    config: {
      openai_key_set: !!process.env.OPENAI_API_KEY,
      elevenlabs_key_set: !!elevenLabsApiKey,
      voice_id: !!voiceID,
      rhubarb_path: rhubarbPath
    }
  });
});

// Endpoint: Chat
app.post("/chat", async (req, res) => {
  const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);
  console.log(`Processing chat request [ID: ${requestId}]`);
  
  try {
    // Validasi input
    const userMessage = req.body.message;
    if (!userMessage) {
      return res.status(400).json({ error: "No message provided" });
    }
    
    // Validasi API keys
    if (!elevenLabsApiKey || !process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "API keys not configured" });
    }

    // Step 1: Buat respons dari ChatGPT
    console.log(`[${requestId}] Sending request to OpenAI`);
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      max_tokens: 150,
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content: `
          Kamu adalah Mira (Mental Health Intelligence Response Assistant),
          asisten virtual yang ramah dan empatik, fokus mendukung kesehatan mental secara ilmiah.
          Kamu menggunakan pendekatan terapi kognitif perilaku (CBT) untuk membantu pengguna melihat pikiran secara lebih rasional.
          Berikan respons yang sangat singkat: maksimal 2–3 kalimat pendek, setara 1–2 baris.
          Gunakan kalimat sederhana, hindari penjelasan panjang atau bahasa teknis.
          `
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    const responseText = completion.choices[0].message.content;
    console.log(`[${requestId}] Got response from OpenAI: "${responseText}"`);
    
    // Step 2: Deteksi emosi dan tentukan animasi
    const emotion = detectEmotion(responseText);
    const animation = getAnimationFromEmotion(emotion);
    console.log(`[${requestId}] Detected emotion: ${emotion}, animation: ${animation}`);
    
    // Step 3: Generate audio dengan ElevenLabs
    const audioFilePath = `${TMP_DIR}/message_${requestId}.mp3`;
    console.log(`[${requestId}] Generating audio with ElevenLabs`);
    await textToSpeech(responseText, audioFilePath);
    
    // Step 4: Generate lipsync data
    const lipsyncFilePath = `${TMP_DIR}/message_${requestId}.json`;
    console.log(`[${requestId}] Generating lipsync data`);
    await generateLipsync(audioFilePath, lipsyncFilePath);
    
    // Step 5: Baca file audio dan lipsync
    console.log(`[${requestId}] Reading audio and lipsync files`);
    const audioBase64 = await fileToBase64(audioFilePath);
    const lipsyncData = await readJsonFile(lipsyncFilePath);
    
    // Log data sizes for debugging
    console.log(`[${requestId}] Text length: ${responseText.length} chars`);
    console.log(`[${requestId}] Audio base64 length: ${audioBase64.length} chars`);
    console.log(`[${requestId}] Lipsync data size: ${JSON.stringify(lipsyncData).length} chars`);
    
    // Step 6: Kirim respons lengkap
    console.log(`[${requestId}] Sending complete response to client`);
    res.json({
      messages: [
        {
          text: responseText,
          audio: audioBase64,
          lipsync: lipsyncData,
          facialExpression: "smile",
          animation: "Talking_1"
        }
      ]
    });
    
    // Optional: Clean up temporary files after a delay
    setTimeout(async () => {
      try {
        await fs.unlink(audioFilePath);
        await fs.unlink(lipsyncFilePath);
        await fs.unlink(audioFilePath.replace('.mp3', '.wav'));
        console.log(`[${requestId}] Temporary files cleaned up`);
      } catch (e) {
        console.warn(`[${requestId}] Could not clean up some temp files:`, e.message);
      }
    }, 60000); // Clean up after 1 minute
    
  } catch (error) {
    console.error(`[${requestId}] Error processing chat:`, error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Endpoint: Audio file (alternatif untuk transfer audio besar)
app.get("/audio/:id", async (req, res) => {
  try {
    const audioFile = path.resolve(`${TMP_DIR}/message_${req.params.id}.mp3`);
    res.sendFile(audioFile);
  } catch (error) {
    res.status(500).json({ error: "Error sending audio file" });
  }
});

// Start server
app.listen(port, () => {
  const separator = "=".repeat(80);
  console.log(separator);
  console.log(`MindCura TTS Server listening on port ${port}`);
  console.log(`Access server at http://YOUR_IP_ADDRESS:${port}/test`);
  console.log(`Make sure FFmpeg and Rhubarb are installed and available`);
  
  // Log path info
  console.log(`Working directory: ${process.cwd()}`);
  console.log(`Rhubarb path: ${rhubarbPath}`);
  console.log(separator);
});