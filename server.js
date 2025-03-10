require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configuración inicial
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const bucketName = process.env.BUCKET_NAME || 'archivos';

// Crear cliente de Supabase
let supabase;
try {
  console.log('Configurando cliente de Supabase');
  console.log('SUPABASE_URL disponible:', !!process.env.SUPABASE_URL);
  console.log('SUPABASE_KEY disponible:', !!process.env.SUPABASE_KEY);
  console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
  
  if (!process.env.SUPABASE_URL) {
    throw new Error('SUPABASE_URL no está configurada en las variables de entorno');
  }
  
  if (!process.env.SUPABASE_KEY) {
    throw new Error('SUPABASE_KEY no está configurada en las variables de entorno');
  }
  
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('Cliente de Supabase configurado correctamente');
} catch (error) {
  console.error('Error al configurar cliente de Supabase:', error);
}

// Configuración de Multer para manejo de archivos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // Límite de 50MB
  }
});

// Ruta de prueba
app.get('/', (req, res) => {
  res.send({
    message: 'API del explorador de archivos funcionando correctamente',
    serverTime: new Date().toISOString(),
    supabaseConfigured: !!supabase
  });
});

// Ruta para verificar la conexión con Supabase
app.get('/api/auth-test', async (req, res) => {
  try {
    // Verificar si Supabase está configurado
    if (!supabase) {
      return res.status(500).json({
        success: false,
        message: 'Cliente de Supabase no configurado correctamente. Verifica las variables de entorno SUPABASE_URL y SUPABASE_KEY.'
      });
    }
    
    // Listar buckets para verificar conexión
    const { data, error } = await supabase.storage.listBuckets();
    
    if (error) {
      throw error;
    }
    
    res.status(200).json({
      success: true,
      message: 'Conexión exitosa con Supabase Storage',
      buckets: data
    });
  } catch (error) {
    console.error('Error en prueba de autenticación:', error);
    
    res.status(500).json({
      success: false,
      message: `Error al conectar con Supabase Storage: ${error.message}`,
      error: error.message
    });
  }
});

// Ruta para listar archivos
app.get('/api/files', async (req, res) => {
  try {
    // Verificar si Supabase está configurado
    if (!supabase) {
      return res.status(500).json({
        success: false,
        message: 'Cliente de Supabase no configurado correctamente. Verifica las variables de entorno SUPABASE_URL y SUPABASE_KEY.'
      });
    }
    
    const prefix = req.query.prefix || '';
    
    // Normalizar el prefijo
    let normalizedPrefix = prefix;
    if (normalizedPrefix.startsWith('/')) {
      normalizedPrefix = normalizedPrefix.substring(1);
    }
    
    console.log(`Listando archivos con prefijo: "${normalizedPrefix}"`);
    
    const { data, error } = await supabase.storage
      .from(bucketName)
      .list(normalizedPrefix, {
        sortBy: { column: 'name', order: 'asc' }
      });
    
    if (error) {
      throw error;
    }
    
    // Formatear la respuesta
    const formattedFiles = data.map(item => {
      // Identificar si es carpeta o archivo
      const isFolder = !item.metadata || item.metadata.mimetype === 'application/x-directory';
      
      return {
        name: item.name,
        path: normalizedPrefix ? `/${normalizedPrefix}/${item.name}` : `/${item.name}`,
        size: item.metadata?.size || 0,
        contentType: item.metadata?.mimetype || 'application/octet-stream',
        updated: item.updated_at,
        isFolder: isFolder
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
    // Verificar si Supabase está configurado
    if (!supabase) {
      return res.status(500).json({
        success: false,
        message: 'Cliente de Supabase no configurado correctamente. Verifica las variables de entorno SUPABASE_URL y SUPABASE_KEY.'
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No se ha enviado ningún archivo'
      });
    }
    
    const filePath = req.body.path || '';
    const fileName = req.file.originalname;
    
    // Normalizar la ruta
    let normalizedPath = filePath;
    if (normalizedPath.startsWith('/')) {
      normalizedPath = normalizedPath.substring(1);
    }
    
    // Construir la ruta completa del archivo
    const fullPath = normalizedPath 
      ? `${normalizedPath}/${fileName}` 
      : fileName;
    
    console.log(`Subiendo archivo a: ${fullPath}`);
    
    // Subir archivo a Supabase
    const { data, error } = await supabase.storage
      .from(bucketName)
      .upload(fullPath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true
      });
    
    if (error) {
      throw error;
    }
    
    // Obtener URL pública
    const { data: publicUrlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(fullPath);
    
    res.status(200).json({
      success: true,
      message: 'Archivo subido correctamente',
      fileName: fileName,
      filePath: fullPath,
      publicUrl: publicUrlData.publicUrl
    });
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
    // Verificar si Supabase está configurado
    if (!supabase) {
      return res.status(500).json({
        success: false,
        message: 'Cliente de Supabase no configurado correctamente. Verifica las variables de entorno SUPABASE_URL y SUPABASE_KEY.'
      });
    }
    
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
    
    // Obtener la URL pública
    const { data } = supabase.storage
      .from(bucketName)
      .getPublicUrl(normalizedPath);
    
    if (!data || !data.publicUrl) {
      return res.status(404).json({
        success: false,
        message: `No se pudo generar URL para ${normalizedPath}`
      });
    }
    
    // Redireccionar al usuario a la URL pública
    return res.redirect(data.publicUrl);
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
    // Verificar si Supabase está configurado
    if (!supabase) {
      return res.status(500).json({
        success: false,
        message: 'Cliente de Supabase no configurado correctamente. Verifica las variables de entorno SUPABASE_URL y SUPABASE_KEY.'
      });
    }
    
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
    
    // Construir la ruta completa de la carpeta
    const folderPath = normalizedParentPath
      ? `${normalizedParentPath}/${folderName}/.folder`
      : `${folderName}/.folder`;
    
    console.log(`Creando carpeta en: ${folderPath}`);
    
    // En Supabase Storage, las carpetas son implícitas
    // Creamos un archivo vacío oculto para representar la carpeta
    const { error } = await supabase.storage
      .from(bucketName)
      .upload(folderPath, new Uint8Array(0), {
        contentType: 'application/x-directory',
        upsert: true
      });
    
    if (error) {
      throw error;
    }
    
    res.status(200).json({
      success: true,
      message: `Carpeta ${folderName} creada correctamente`,
      folderPath: normalizedParentPath
        ? `${normalizedParentPath}/${folderName}`
        : folderName
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
    // Verificar si Supabase está configurado
    if (!supabase) {
      return res.status(500).json({
        success: false,
        message: 'Cliente de Supabase no configurado correctamente. Verifica las variables de entorno SUPABASE_URL y SUPABASE_KEY.'
      });
    }
    
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
      // Para carpetas, primero listamos su contenido
      const { data, error: listError } = await supabase.storage
        .from(bucketName)
        .list(normalizedPath);
      
      if (listError) {
        throw listError;
      }
      
      // Construimos rutas completas para todos los elementos dentro
      const itemsToDelete = data.map(item => 
        `${normalizedPath}/${item.name}`
      );
      
      // Añadimos el marcador .folder de la carpeta
      itemsToDelete.push(`${normalizedPath}/.folder`);
      
      // Eliminamos todos los elementos
      if (itemsToDelete.length > 0) {
        const { error: deleteError } = await supabase.storage
          .from(bucketName)
          .remove(itemsToDelete);
        
        if (deleteError && deleteError.message !== 'Object not found') {
          throw deleteError;
        }
      }
      
      res.status(200).json({
        success: true,
        message: `Carpeta ${normalizedPath} y su contenido eliminados correctamente`,
        elementsDeleted: itemsToDelete.length
      });
    } else {
      // Para archivos individuales
      const { error } = await supabase.storage
        .from(bucketName)
        .remove([normalizedPath]);
      
      if (error) {
        throw error;
      }
      
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
  console.log(`Supabase URL: ${supabaseUrl}`);
  console.log(`Supabase Key configurada: ${!!supabaseKey}`);
});