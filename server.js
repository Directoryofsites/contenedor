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
  // Comprueba si tenemos las variables individuales para construir las credenciales
  if (process.env.GCS_PROJECT_ID && process.env.GCS_PRIVATE_KEY && process.env.GCS_CLIENT_EMAIL) {
    console.log('Usando credenciales individuales para GCS');
    
    // Construir el objeto de credenciales manualmente
    const credentials = {
      type: "service_account",
      project_id: process.env.GCS_PROJECT_ID,
      private_key_id: process.env.GCS_PRIVATE_KEY_ID || "",
      private_key: process.env.GCS_PRIVATE_KEY.replace(/\\n/g, "\n"), // Asegura que los saltos de línea se manejen correctamente
      client_email: process.env.GCS_CLIENT_EMAIL,
      client_id: process.env.GCS_CLIENT_ID || "",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.GCS_CLIENT_EMAIL)}`,
      universe_domain: "googleapis.com"
    };
    
    // Usar el objeto de credenciales
    storage = new Storage({
      credentials: credentials
    });
    
    console.log('Credenciales de GCS configuradas desde variables individuales');
  } 
  // Verifica si tenemos el JSON completo
  else if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
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
const bucketName = process.env.GCS_BUCKET_NAME || 'contenedor-files';
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
    
    // En Google Cloud Storage, las carpetas son objetos con una / al final
    const file = bucket.file(folderPath);
    
    // Crear un archivo vacío con ruta terminada en / para simular una carpeta
    await file.save('', { contentType: 'application/x-directory' });
    
    // Hacer la carpeta pública
    await file.makePublic();
    
    res.status(200).json({
      success: true,
      message: `Carpeta ${folderName} creada correctamente`,
      folderPath: folderPath
    });
    
  } catch (error) {
    console.error('Error al crear carpeta:', error);
    
    res.status(500).json({
      success: false,
      message: `Error al crear la carpeta: ${error.message}`,
      error: error.message
    });
  }
});

// Ruta para eliminar archivos o carpetas
app.delete('/api/delete', async (req, res) => {
  try {
    const { path, isFolder } = req.query;
    
    if (!path) {
      return res.status(400).json({
        success: false,
        message: 'No se ha especificado la ruta del elemento a eliminar'
      });
    }
    
    // Normalizar la ruta
    let normalizedPath = path;
    if (normalizedPath.startsWith('/')) {
      normalizedPath = normalizedPath.substring(1);
    }
    
    console.log(`Eliminando elemento en ruta: ${normalizedPath}, es carpeta: ${isFolder}`);
    
    if (isFolder === 'true') {
      // Si es una carpeta, necesitamos eliminar todos los archivos dentro
      
      // Asegurarse de que la ruta de la carpeta termine con /
      if (!normalizedPath.endsWith('/')) {
        normalizedPath += '/';
      }
      
      console.log(`Eliminando contenido de carpeta: ${normalizedPath}`);
      
      // Listar todos los archivos con ese prefijo
      const [files] = await bucket.getFiles({
        prefix: normalizedPath
      });
      
      // Eliminar cada archivo dentro de la carpeta
      const deletePromises = files.map(file => file.delete());
      await Promise.all(deletePromises);
      
      res.status(200).json({
        success: true,
        message: `Carpeta ${normalizedPath} y su contenido eliminados correctamente`,
        elementsDeleted: files.length
      });
    } else {
      // Si es un archivo individual, simplemente lo eliminamos
      const file = bucket.file(normalizedPath);
      
      // Verificar si el archivo existe
      const [exists] = await file.exists();
      if (!exists) {
        return res.status(404).json({
          success: false,
          message: `El elemento ${normalizedPath} no existe`
        });
      }
      
      // Eliminar el archivo
      await file.delete();
      
      res.status(200).json({
        success: true,
        message: `Elemento ${normalizedPath} eliminado correctamente`
      });
    }
    
  } catch (error) {
    console.error('Error al eliminar elemento:', error);
    
    res.status(500).json({
      success: false,
      message: `Error al eliminar el elemento: ${error.message}`,
      error: error.message
    });
  }
});

// Iniciar el servidor
app.listen(PORT, () => {
  console.log(`Servidor iniciado en el puerto ${PORT}`);
  console.log(`Bucket configurado: ${bucketName}`);
});
