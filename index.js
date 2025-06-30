require('dotenv').config();
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// Multer para manejar subida de archivos
const upload = multer({ dest: 'uploads/' });

// Configurar Google OAuth2 Client
const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth });

// Función para crear carpeta en Drive
async function createDriveFolder(name, parentId) {
  const fileMetadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: parentId ? [parentId] : [],
  };
  const folder = await drive.files.create({
    resource: fileMetadata,
    fields: 'id',
  });
  return folder.data.id;
}

// Función para subir archivo a carpeta Drive
async function uploadFileToDrive(filePath, fileName, folderId) {
  const fileMetadata = {
    name: fileName,
    parents: [folderId],
  };
  const media = {
    mimeType: 'image/png',
    body: fs.createReadStream(filePath),
  };
  const file = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id',
  });

  // Hacer archivo público
  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  const result = await drive.files.get({
    fileId: file.data.id,
    fields: 'webViewLink, webContentLink',
  });

  return result.data.webContentLink || result.data.webViewLink;
}

// Endpoint para obtener duración del video
app.post('/api/duracion', upload.single('video'), (req, res) => {
  const videoPath = req.file.path;
  ffmpeg.ffprobe(videoPath, (err, metadata) => {
    fs.unlinkSync(videoPath);
    if (err) return res.status(500).json({ error: err.message });
    res.json({ duration: metadata.format.duration });
  });
});

// Endpoint para extraer screenshots y subir a Drive
app.post('/api/extract', upload.single('video'), async (req, res) => {
  const videoPath = req.file.path;
  const { interval = 5, name = 'video' } = req.body;

  try {
    const baseFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const folderName = `${name}-${Date.now()}`;
    const folderId = await createDriveFolder(folderName, baseFolderId);

    const outputDir = path.join(__dirname, 'screenshots', folderName);
    fs.mkdirSync(outputDir, { recursive: true });

    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });

    const duration = metadata.format.duration;
    const count = Math.floor(duration / interval) || 1;

    ffmpeg(videoPath)
      .on('end', async () => {
        fs.unlinkSync(videoPath);

        const files = fs.readdirSync(outputDir);
        const urls = [];

        for (const file of files) {
          const filePath = path.join(outputDir, file);
          const url = await uploadFileToDrive(filePath, file, folderId);
          urls.push(url);
          fs.unlinkSync(filePath);
        }

        fs.rmdirSync(outputDir);

        const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;

        res.json({ screenshots: urls, folderUrl });
      })
      .on('error', (err) => {
        fs.unlinkSync(videoPath);
        res.status(500).json({ error: err.message });
      })
      .screenshots({
        count,
        folder: outputDir,
        filename: 'screenshot-%03d.png',
        size: '640x360',
      });
  } catch (error) {
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend corriendo en puerto ${PORT}`));
