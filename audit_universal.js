import fs from 'fs';
import path from 'path';

// --- ⚙️ CONFIGURACIÓN UNIVERSAL ---

// Carpetas comunes a ignorar de CUALQUIER proyecto (Node, Python, Java, Go, etc.)
const IGNORE_DIRS = [
    'node_modules',
    '.git',
    '.svn',
    'vendor',      // Común en PHP/Go
    'target',      // Común en Java/Scala
    'build',
    'dist',
    'out',
    'coverage',
    'lib',
    '.vscode',
    '.idea',       // Archivos de IDE
    '__pycache__', // Común en Python
    '.next',
    '.firebase',
    'static',      // A veces solo contiene assets grandes
    'public',      // A veces solo contiene assets grandes
];

// Extensiones de código, configuración y documentación que interesan
const INCLUDE_EXTS = [
    '.ts', '.tsx', '.js', '.jsx', '.json',
    '.yaml', '.yml', '.toml', '.ini', // Configuración
    '.java', '.py', '.go', '.php', '.c', '.cpp', '.cs', // Lenguajes de Backend
    '.html', '.css', '.scss', '.less', // Frontend
    '.md', '.txt', '.log', // Documentación y logs simples
    '.sh', '.bash', '.zsh', '.ps1' // Scripts
];

// Archivos específicos a ignorar por su longitud o poco valor lógico
const IGNORE_FILES = [
    'package-lock.json', // Muy largo
    'yarn.lock',         // Muy largo
    'Gemfile.lock',      // Muy largo
    'audit_universal.js' // Para no escanearnos a nosotros mismos
];

// --- ⚙️ VARIABLES DE EJECUCIÓN ---

const OUTPUT_FILE = 'AUDITORIA_UNIVERSAL.txt';
// Obtiene el directorio actual, o usa el primer argumento de la línea de comandos
const ROOT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

let fileCount = 0;
let contentBuffer = '';

// --- 🛠️ FUNCIONES ---

/**
 * Escanea el directorio, ignorando carpetas configuradas.
 */
function scanDirectory(currentPath) {
    let items;
    try {
        items = fs.readdirSync(currentPath);
    } catch (error) {
        console.error(`❌ Permiso denegado o error leyendo ${currentPath}: ${error.message}`);
        return;
    }

    items.forEach(item => {
        const fullPath = path.join(currentPath, item);
        const relativePath = path.relative(ROOT_DIR, fullPath);

        // 1. Ignorar archivos y carpetas ocultas comunes
        // Excluimos .vscode y .idea para que se puedan escanear si no están en IGNORE_DIRS
        if (item.startsWith('.') && item !== '.vscode' && item !== '.idea') {
            return;
        }

        let stat;
        try {
            stat = fs.statSync(fullPath);
        } catch (error) {
            // Ignorar archivos que desaparecen durante el escaneo (raro)
            return; 
        }

        if (stat.isDirectory()) {
            // Ignorar carpetas si están en la lista de exclusión
            if (!IGNORE_DIRS.includes(item)) {
                scanDirectory(fullPath);
            }
        } else {
            // Procesar archivos
            const ext = path.extname(item).toLowerCase();
            if (INCLUDE_EXTS.includes(ext) && !IGNORE_FILES.includes(item)) {
                readFileContent(fullPath, relativePath, stat);
            }
        }
    });
}

/**
 * Lee el contenido del archivo y lo añade al buffer.
 */
function readFileContent(fullPath, relativePath, stat) {
    // 2. Limitar el tamaño para evitar archivos gigantes (logs, binarios mal identificados)
    const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
    if (stat.size > MAX_SIZE_BYTES) {
        console.log(`⚠️ Ignorado: ${relativePath} (>${(MAX_SIZE_BYTES / 1024 / 1024).toFixed(0)}MB)`);
        return;
    }

    try {
        const content = fs.readFileSync(fullPath, 'utf8');

        // Formato separador claro
        contentBuffer += '\n' + '█'.repeat(20) + ` ARCHIVO ${fileCount + 1} ` + '█'.repeat(20) + '\n';
        contentBuffer += `RUTA: ${relativePath}\n`;
        contentBuffer += '█'.repeat(58) + '\n';
        contentBuffer += content + '\n';
        
        console.log(`✅ Leído: ${relativePath}`);
        fileCount++;
    } catch (error) {
        // 3. Manejo de errores de codificación (archivos binarios, etc.)
        console.error(`❌ Error leyendo ${relativePath} (Skipping): ${error.message}`);
    }
}

// --- 🚀 EJECUCIÓN PRINCIPAL ---

console.log('---'.repeat(15));
console.log('🔍 Iniciando auditoría de código universal...');
console.log(`📂 Directorio raíz: ${ROOT_DIR}`);
console.log(`💾 Salida guardada en: ${OUTPUT_FILE}`);
console.log('---'.repeat(15));

// Escribir cabecera
contentBuffer += '=== AUDITORÍA DE PROYECTO UNIVERSAL ===\n';
contentBuffer += `Fecha: ${new Date().toISOString()}\n`;
contentBuffer += `Directorio analizado: ${ROOT_DIR}\n`;
contentBuffer += '----------------------------------------\n\n';

// Iniciar escaneo
scanDirectory(ROOT_DIR);

// Guardar resultado
fs.writeFileSync(OUTPUT_FILE, contentBuffer);

console.log('\n' + '---'.repeat(15));
console.log(`🎉 Auditoría completada. ${fileCount} archivos procesados.`);
console.log(`💾 Resultado guardado en: ${OUTPUT_FILE}`);
console.log('---'.repeat(15));