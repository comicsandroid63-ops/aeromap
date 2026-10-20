const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Rutas de GDAL en el sistema o fallback de entorno
const GDAL_PATH = process.env.GDAL_PATH || 'C:\\Program Files\\GDAL';
const OGR2OGR_BIN = process.platform === 'win32' 
  ? path.join(GDAL_PATH, 'ogr2ogr.exe')
  : 'ogr2ogr';

const GDAL_ENV = {
  ...process.env,
  PATH: `${GDAL_PATH};${process.env.PATH || ''}`,
  GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'),
  PROJ_LIB: path.join(GDAL_PATH, 'projlib')
};

// Generador ZIP sin dependencias externas usando Buffer y zlib.deflateRawSync
function createZipBuffer(fileEntries) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const entry of fileEntries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const uncompressedData = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const uncompressedSize = uncompressedData.length;
    const crc = zlib.crc32(uncompressedData);
    const compressedData = zlib.deflateRawSync(uncompressedData);
    const compressedSize = compressedData.length;

    // Local file header (30 bytes + nameBuf.length)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    localHeader.writeUInt16LE(20, 4);         // Version needed (2.0)
    localHeader.writeUInt16LE(0, 6);          // General purpose bit flag
    localHeader.writeUInt16LE(8, 8);          // Compression method (8 = Deflate)
    localHeader.writeUInt16LE(0, 10);         // Last mod file time
    localHeader.writeUInt16LE(0, 12);         // Last mod file date
    localHeader.writeUInt32LE(crc, 14);       // CRC-32
    localHeader.writeUInt32LE(compressedSize, 18);   // Compressed size
    localHeader.writeUInt32LE(uncompressedSize, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);   // File name length
    localHeader.writeUInt16LE(0, 28);                // Extra field length
    nameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader, compressedData);

    // Central directory file header (46 bytes + nameBuf.length)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    centralHeader.writeUInt16LE(20, 4);         // Version made by
    centralHeader.writeUInt16LE(20, 6);         // Version needed
    centralHeader.writeUInt16LE(0, 8);          // General purpose bit flag
    centralHeader.writeUInt16LE(8, 10);         // Compression method (8 = Deflate)
    centralHeader.writeUInt16LE(0, 12);         // Last mod file time
    centralHeader.writeUInt16LE(0, 14);         // Last mod file date
    centralHeader.writeUInt32LE(crc, 16);       // CRC-32
    centralHeader.writeUInt32LE(compressedSize, 20);   // Compressed size
    centralHeader.writeUInt32LE(uncompressedSize, 24); // Uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28);   // File name length
    centralHeader.writeUInt16LE(0, 30);                // Extra field length
    centralHeader.writeUInt16LE(0, 32);                // File comment length
    centralHeader.writeUInt16LE(0, 34);                // Disk number start
    centralHeader.writeUInt16LE(0, 36);                // Internal file attributes
    centralHeader.writeUInt32LE(0, 38);                // External file attributes
    centralHeader.writeUInt32LE(offset, 42);           // Relative offset of local header
    nameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
    offset += localHeader.length + compressedData.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) centralDirSize += ch.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);                 // EOCD signature
  eocd.writeUInt16LE(0, 4);                          // Number of this disk
  eocd.writeUInt16LE(0, 6);                          // Disk where central directory starts
  eocd.writeUInt16LE(fileEntries.length, 8);         // Number of central directory records on this disk
  eocd.writeUInt16LE(fileEntries.length, 10);        // Total number of central directory records
  eocd.writeUInt32LE(centralDirSize, 12);            // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16);          // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);                         // Comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { format, geojson, filename, crs, layerName } = req.body || {};

  if (!geojson) {
    return res.status(400).json({ error: 'Falta geojson en el cuerpo de la petición' });
  }

  const exportFormat = (format || 'gpkg').toLowerCase();
  const safeBaseName = (filename || 'capa_exportada').replace(/[^a-zA-Z0-9_\-]/g, '_') || 'capa_exportada';
  const targetLayerName = (layerName || safeBaseName).replace(/[^a-zA-Z0-9_\-]/g, '_') || safeBaseName;
  const targetCrs = crs || 'EPSG:4326';

  const tmpDir = path.join(os.tmpdir(), `export_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const inputGeoJsonPath = path.join(tmpDir, 'input.geojson');
  fs.writeFileSync(inputGeoJsonPath, typeof geojson === 'string' ? geojson : JSON.stringify(geojson));

  try {
    if (exportFormat === 'gpkg') {
      const outGpkgPath = path.join(tmpDir, `${safeBaseName}.gpkg`);
      const args = [
        '-f', 'GPKG',
        outGpkgPath,
        inputGeoJsonPath,
        '-nln', targetLayerName,
        '-s_srs', 'EPSG:4326',
        '-t_srs', targetCrs,
        '-nlt', 'PROMOTE_TO_MULTI',
        '-skipfailures',
        '-overwrite'
      ];

      await execFileAsync(OGR2OGR_BIN, args, { env: GDAL_ENV, timeout: 60000 });

      if (!fs.existsSync(outGpkgPath)) {
        throw new Error('No se generó el archivo GeoPackage');
      }

      const fileBuffer = fs.readFileSync(outGpkgPath);
      res.setHeader('Content-Type', 'application/geopackage+sqlite3');
      res.setHeader('Content-Disposition', `attachment; filename="${safeBaseName}.gpkg"`);
      return res.status(200).send(fileBuffer);

    } else if (exportFormat === 'shp' || exportFormat === 'shapefile') {
      const shpOutDir = path.join(tmpDir, 'shp');
      fs.mkdirSync(shpOutDir, { recursive: true });
      const outShpPath = path.join(shpOutDir, `${safeBaseName}.shp`);

      const args = [
        '-f', 'ESRI Shapefile',
        outShpPath,
        inputGeoJsonPath,
        '-nln', targetLayerName,
        '-s_srs', 'EPSG:4326',
        '-t_srs', targetCrs,
        '-lco', 'ENCODING=UTF-8',
        '-skipfailures',
        '-overwrite'
      ];

      await execFileAsync(OGR2OGR_BIN, args, { env: GDAL_ENV, timeout: 60000 });

      // Empaquetar todo (.shp, .dbf, .shx, .prj, .cpg) en un .zip
      const files = fs.readdirSync(shpOutDir);
      if (files.length === 0) {
        throw new Error('No se generaron los archivos del Shapefile');
      }
      const entries = files.map(f => ({
        name: f,
        data: fs.readFileSync(path.join(shpOutDir, f))
      }));

      const zipBuffer = createZipBuffer(entries);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${safeBaseName}.zip"`);
      return res.status(200).send(zipBuffer);

    } else if (exportFormat === 'geojson') {
      res.setHeader('Content-Type', 'application/geo+json');
      res.setHeader('Content-Disposition', `attachment; filename="${safeBaseName}.geojson"`);
      const content = typeof geojson === 'string' ? geojson : JSON.stringify(geojson, null, 2);
      return res.status(200).send(content);

    } else if (exportFormat === 'kml') {
      const outKmlPath = path.join(tmpDir, `${safeBaseName}.kml`);
      const args = [
        '-f', 'KML',
        outKmlPath,
        inputGeoJsonPath,
        '-nln', targetLayerName,
        '-s_srs', 'EPSG:4326',
        '-t_srs', 'EPSG:4326',
        '-skipfailures',
        '-overwrite'
      ];
      await execFileAsync(OGR2OGR_BIN, args, { env: GDAL_ENV, timeout: 60000 });
      const fileBuffer = fs.readFileSync(outKmlPath);
      res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
      res.setHeader('Content-Disposition', `attachment; filename="${safeBaseName}.kml"`);
      return res.status(200).send(fileBuffer);

    } else {
      return res.status(400).json({ error: `Formato de exportación no soportado: ${format}` });
    }
  } catch (err) {
    console.error('[Export] Error running ogr2ogr:', err);
    return res.status(500).json({ error: 'Error convirtiendo con GDAL: ' + (err.stderr || err.message) });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
};
