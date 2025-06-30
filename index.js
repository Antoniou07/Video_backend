require('dotenv').config();
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const stream = require('stream');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// Evitar error 404 favicon
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Multer en memoria
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Configurar Google OAuth2 Client
const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth });

// Crear carpeta en Drive
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

// Subir archivo a Drive desde buffer
async function uploadBufferToDrive(buffer, filename, folderId) {
  const fileMetadata = {
    name: filename,
    parents: [folderId],
  };
  const media = {
    mimeType: 'image/png',
    body: stream.Readable.from(buffer),
  };
  const file = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id',
  });

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

app.post('/api/extract', upload.single('video'), async (req, res) => {
  try {
    const { interval = 5, name = 'video' } = req.body;
    const videoBuffer = req.file.buffer;

    // Crear carpeta en Drive
    const baseFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const folderName = `${name}-${Date.now()}`;
    const folderId = await createDriveFolder(folderName, baseFolderId);

    // Duración del video usando ffprobe desde buffer (usa un truco con stream)
    const getVideoDuration = () => {
      return new Promise((resolve, reject) => {
        const videoStream = stream.Readable.from(videoBuffer);
        ffmpeg(videoStream)
          .ffprobe((err, data) => {
            if (err) reject(err);
            else resolve(data.format.duration);
          });
      });
    };

    const duration = await getVideoDuration();
    const count = Math.floor(duration / interval) || 1;

    // Extraer screenshots y subir directamente a Drive
    const screenshots = [];
    let screenshotIndex = 0;

    for (let i = 0; i < count; i++) {
      const time = i * interval;
      const buffer = await new Promise((resolve, reject) => {
        const chunks = [];
        const videoStream = stream.Readable.from(videoBuffer);

        ffmpeg(videoStream)
          .seekInput(time)
          .frames(1)
          .format('image2')
          .outputOptions('-vframes', '1')
          .on('error', reject)
          .on('end', () => {
            resolve(Buffer.concat(chunks));
          })
          .pipe()
          .on('data', (chunk) => chunks.push(chunk));
      });

      screenshotIndex++;
      const filename = `screenshot-${String(screenshotIndex).padStart(3, '0')}.png`;
      const url = await uploadBufferToDrive(buffer, filename, folderId);
      screenshots.push(url);
    }

    const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;

    res.json({ screenshots, folderUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend corriendo en puerto ${PORT}`));