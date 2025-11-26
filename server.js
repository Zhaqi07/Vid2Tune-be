const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

const PORT = process.env.PORT || 4000;
const CLOUDCONVERT_API_KEY = process.env.CLOUDCONVERT_API_KEY;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

if (!CLOUDCONVERT_API_KEY || !ASSEMBLYAI_API_KEY) {
  console.warn(
    "[WARN] Missing CLOUDCONVERT_API_KEY or ASSEMBLYAI_API_KEY. Update your .env file."
  );
}

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const CLOUDCONVERT_BASE = "https://api.cloudconvert.com/v2";
const ASSEMBLYAI_BASE = "https://api.assemblyai.com/v2";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCloudConvertJob(jobId) {
  while (true) {
    const { data } = await axios.get(`${CLOUDCONVERT_BASE}/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${CLOUDCONVERT_API_KEY}` },
    });

    const status = data?.data?.status;
    if (status === "finished") return data.data;
    if (status === "error") {
      throw new Error(
        data?.data?.tasks?.map((t) => t.message).join(", ") ||
          "CloudConvert job failed"
      );
    }
    await sleep(3000);
  }
}

async function waitForAssemblyAITranscription(transcriptId) {
  while (true) {
    const { data } = await axios.get(
      `${ASSEMBLYAI_BASE}/transcript/${transcriptId}`,
      {
        headers: {
          authorization: ASSEMBLYAI_API_KEY,
        },
      }
    );

    if (data.status === "completed") return data;
    if (data.status === "error") {
      throw new Error(data.error || "AssemblyAI transcription failed");
    }

    await sleep(3000);
  }
}

app.post("/api/video-to-audio", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Video file is required" });
    }

    const ext = path.extname(req.file.originalname).replace(".", "") || "mp4";

    const jobResponse = await axios.post(
      `${CLOUDCONVERT_BASE}/jobs`,
      {
        tasks: {
          "import-upload": {
            operation: "import/upload",
          },
          "convert-file": {
            operation: "convert",
            input: "import-upload",
            input_format: ext,
            output_format: "mp3",
            audio_codec: "mp3",
          },
          "export-file": {
            operation: "export/url",
            input: "convert-file",
          },
        },
      },
      {
        headers: { Authorization: `Bearer ${CLOUDCONVERT_API_KEY}` },
      }
    );

    const importTask = jobResponse.data?.data?.tasks?.find(
      (task) => task.name === "import-upload"
    );

    if (!importTask) {
      throw new Error("Failed to prepare import task for CloudConvert");
    }

    const uploadForm = new FormData();
    Object.entries(importTask.result?.form?.parameters || {}).forEach(
      ([key, value]) => uploadForm.append(key, value)
    );
    uploadForm.append("file", req.file.buffer, req.file.originalname);

    await axios.post(importTask.result.form.url, uploadForm, {
      headers: uploadForm.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const finishedJob = await waitForCloudConvertJob(jobResponse.data.data.id);
    const exportTask = finishedJob.tasks.find(
      (task) => task.name === "export-file"
    );

    const downloadUrl = exportTask?.result?.files?.[0]?.url;
    if (!downloadUrl) {
      throw new Error("Failed to retrieve exported file URL");
    }

    res.json({ downloadUrl });
  } catch (error) {
    console.error("CloudConvert error:", error.message);
    res.status(500).json({ error: "Video to audio conversion failed" });
  }
});

app.post("/api/audio-to-text", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Audio file is required" });
    }

    const uploadResponse = await axios.post(
      `${ASSEMBLYAI_BASE}/upload`,
      req.file.buffer,
      {
        headers: {
          authorization: ASSEMBLYAI_API_KEY,
          "content-type": "application/octet-stream",
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    const transcriptResponse = await axios.post(
      `${ASSEMBLYAI_BASE}/transcript`,
      {
        audio_url: uploadResponse.data.upload_url,
      },
      {
        headers: {
          authorization: ASSEMBLYAI_API_KEY,
          "content-type": "application/json",
        },
      }
    );

    const transcriptResult = await waitForAssemblyAITranscription(
      transcriptResponse.data.id
    );

    res.json({ text: transcriptResult.text });
  } catch (error) {
    console.error("AssemblyAI error:", error.message);
    res.status(500).json({ error: "Audio to text conversion failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Vid2Tune backend running on http://localhost:${PORT}`);
});

