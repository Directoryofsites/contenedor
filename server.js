require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Storage } = require('@google-cloud/storage');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Configuración inicial
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuración de Google Cloud Storage
let storage;
try {
  // Si tenemos las credenciales como variable de entorno JSON
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    const tempCredentialPath = path.join(os.tmpdir(), 'gcs-credentials.json');
    fs.writeFileSync(tempCredentialPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    
    storage = new Storage({
      keyFilename: tempCredentialPath
    });
    
    console.log('Credenciales de GCS configuradas desde variable de entorno JSON');
  } else {
    // Uso de la variable de entorno tradicional GOOGLE_APPLICATION_CREDENTIALS
    storage = new Storage();
    console.log('Credenciales de GCS configuradas desde variable de entorno tradicional');
  }
} catch (error) {
  console.error('Error al configurar Google Cloud Storage:', error);
}

// Nombre del bucket
const bucketName = process.env.GCS_BUCKET_NAME || 'gracia-vida-files';
const bucket = storage ? storage.bucket(bucketName) : null;

// Ruta de prueba
app.get('/', (req, res) => {
  res.send({
    message: 'API del explorador de archivos funcionando correctamente',
    serverTime: new Date().toISOString()
  });
});

// Ruta para verificar la autenticación con Google Cloud Storage
app.get('/api/auth-test', async (req, res) => {
  try {
    if (!bucket) {
      throw new Error('Bucket no configurado correctamente');
    }
    
    // Obtener información del bucket
    const [bucketMetadata] = await bucket.getMetadata();
    
    res.status(200).json({
      success: true,
      message: 'Conexión exitosa con Google Cloud Storage',
      bucketInfo: {
        bucketId: bucketMetadata.id,
        bucketName: bucketMetadata.name,
        location: bucketMetadata.location
      }
    });
  } catch (error) {
    console.error('Error en prueba de autenticación:', error);
    
    res.status(500).json({
      success: false,
      message: `Error al conectar con Google Cloud Storage: ${error.message}`,
      error: error.message
    });
  }
});

// Configuración de Multer para manejo de archivos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // Límite de 50MB
  }
});

// Ruta para listar archivos
app.get('/api/files', async (req, res) => {
  try {
    const prefix = req.query.prefix || '';
    
    // Normalizar el prefijo
    let normalizedPrefix = prefix;
    if (normalizedPrefix.startsWith('/')) {
      normalizedPrefix = normalizedPrefix.substring(1);
    }
    
    console.log(`Listando archivos con prefijo: "${normalizedPrefix}"`);
    
    const [files] = await bucket.getFiles({
      prefix: normalizedPrefix,
      delimiter: normalizedPrefix ? '/' : ''
    });
    
    // Formatear la respuesta
    const formattedFiles = files.map(file => {
      const filePath = file.name;
      const fileName = path.basename(filePath);
      
      return {
        name: fileName,
        path: `/${filePath}`,
        size: parseInt(file.metadata.size, 10),
        contentType: file.metadata.contentType,
        updated: file.metadata.updated,
        isFolder: filePath.endsWith('/')
      };
    });
    
    res.status(200).json(formattedFiles);
  } catch (error) {
    console.error('Error al listar archivos:', error);
    
    res.status(500).json({
      success: false,
      message: `Error al listar archivos: ${error.message}`,
      error: error.message
    });
  }
});

// Ruta para subir archivos
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No se ha enviado ningún archivo'
      });
    }
    
    const filePath = req.body.path || req.file.originalname;
    
    // Normalizar la ruta
    let normalizedPath = filePath;
    if (normalizedPath.startsWith('/')) {
      normalizedPath = normalizedPath.substring(1);
    }
    
    console.log(`Subiendo archivo a: ${normalizedPath}`);
    
    // Crear un archivo temporal en GCS
    const file = bucket.file(normalizedPath);
    
    // Crear un stream de escritura
    const stream = file.createWriteStream({
      metadata: {
        contentType: req.file.mimetype
      }
    });
    
    // Manejar eventos del stream
    stream.on('error', (error) => {
      console.error('Error en stream de subida:', error);
      res.status(500).json({
        success: false,
        message: `Error al subir el archivo: ${error.message}`,
        error: error.message
      });
    });
    
    stream.on('finish', async () => {
      // Hacer el archivo público
      await file.makePublic();
      
      const publicUrl = `https://storage.googleapis.com/${bucketName}/${normalizedPath}`;
      
      res.status(200).json({
        success: true,
        message: 'Archivo subido correctamente',
        fileName: path.basename(normalizedPath),
        filePath: normalizedPath,
        publicUrl: publicUrl
      });
    });
    
    // Escribir el buffer del archivo en el stream
    stream.end(req.file.buffer);
    
  } catch (error) {
    console.error('Error al subir archivo:', error);
    
    res.status(500).json({
      success: false,
      message: `Error al subir el archivo: ${error.message}`,
      error: error.message
    });
  }
});

// Ruta para descargar archivos
app.get('/api/download', async (req, res) => {
  try {
    const filePath = req.query.path;
    
    if (!filePath) {
      return res.status(400).json({
        success: false,
        message: 'No se ha especificado la ruta del archivo'
      });
    }
    
    // Normalizar la ruta
    let normalizedPath = filePath;
    if (normalizedPath.startsWith('/')) {
      normalizedPath = normalizedPath.substring(1);
    }
    
    console.log(`Descargando archivo desde: ${normalizedPath}`);
    
    const file = bucket.file(normalizedPath);
    
    // Verificar si el archivo existe
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({
        success: false,
        message: `El archivo ${normalizedPath} no existe`
      });
    }
    
    // Obtener metadatos del archivo
    const [metadata] = await file.getMetadata();
    
    // Configurar headers para la descarga
    res.setHeader('Content-Type', metadata.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(normalizedPath)}"`);
    
    // Crear un stream de lectura y enviarlo como respuesta
    const readStream = file.createReadStream();
    readStream.pipe(res);
    
  } catch (error) {
    console.error('Error al descargar archivo:', error);
    
    res.status(500).json({
      success: false,
      message: `Error al descargar el archivo: ${error.message}`,
      error: error.message
    });
  }
});

// Ruta para crear carpetas
app.post('/api/createFolder', async (req, res) => {
  try {
    const { parentPath, folderName } = req.body;
    
    if (!folderName) {
      return res.status(400).json({
        success: false,
        message: 'No se ha especificado el nombre de la carpeta'
      });
    }
    
    // Normalizar la ruta padre
    let normalizedParentPath = parentPath || '';
    if (normalizedParentPath.startsWith('/')) {
      normalizedParentPath = normalizedParentPath.substring(1);
    }
    
    // Si la ruta padre no está vacía y no termina con /, añadir /
    if (normalizedParentPath && !normalizedParentPath.endsWith('/')) {
      normalizedParentPath += '/';
    }
    
    // Construir la ruta completa de la carpeta
    const folderPath = `${normalizedParentPath}${folderName}/`;
    
    console.log(`Creando carpeta en: ${folderPath}`);
    
    // En Google Cloud
