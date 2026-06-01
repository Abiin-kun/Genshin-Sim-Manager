const express = require('express');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { exec, execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Directories
const SETTINGS_FILE = path.join(__dirname, 'config.json');
const PROJECTS_DIR = path.join(__dirname, 'projects');
const GCSIM_DIR = path.join(__dirname, 'bin');

if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!fs.existsSync(GCSIM_DIR)) fs.mkdirSync(GCSIM_DIR, { recursive: true });
// ========== LOCAL GCSIM VIEWER SERVER ==========
let activeViewerFile = null;
const viewerApp = express();

viewerApp.get('/data', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allow gcsim.app to fetch this
    if (!activeViewerFile || !fs.existsSync(activeViewerFile)) {
        return res.status(404).json({ error: "No active data" });
    }
    
    const raw = fs.readFileSync(activeViewerFile);
    try {
        // gcsim sometimes gzips the JSON even if the extension isn't .gz
        const unzipped = zlib.gunzipSync(raw);
        res.setHeader('Content-Type', 'application/json');
        res.send(unzipped);
    } catch (e) {
        // If not compressed, send normally
        res.setHeader('Content-Type', 'application/json');
        res.send(raw);
    }
});

viewerApp.listen(8381, () => {
    console.log('Local gcsim viewer server running on port 8381');
}).on('error', () => {
    console.error('Port 8381 might be in use.');
});
// ========== GCSIM VERSION MANAGER ==========

function getPlatformInfo() {
    const platform = os.platform();
    const arch = os.arch();
    let assetName = '';
    let isWindows = false;

    if (platform === 'win32') {
        assetName = 'gcsim_windows_amd64.exe';
        isWindows = true;
    } else if (platform === 'linux') {
        assetName = 'gcsim_linux_amd64';
    } else if (platform === 'darwin') {
        assetName = arch === 'arm64' ? 'gcsim_darwin_arm64' : 'gcsim_darwin_amd64';
    } else {
        throw new Error('Unsupported platform: ' + platform);
    }
    return { assetName, isWindows };
}

let currentVersion = 'Unknown';
const VERSION_FILE = path.join(GCSIM_DIR, 'version.txt');
if (fs.existsSync(VERSION_FILE)) {
    currentVersion = fs.readFileSync(VERSION_FILE, 'utf8').trim();
}

function getGcsimPath() {
    const { assetName } = getPlatformInfo();
    return path.join(GCSIM_DIR, assetName);
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, { headers: { 'User-Agent': 'gcsim-manager' } }, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) {
                return reject(new Error('Failed to get ' + url + ' (' + response.statusCode + ')'));
            }
            const file = fs.createWriteStream(dest);
            response.pipe(file);
            file.on('finish', () => {
                file.close(() => resolve());
            });
            file.on('error', (err) => {
                file.close();
                fs.unlink(dest, () => reject(err));
            });
        });
        request.on('error', reject);
    });
}

function fetchLatestRelease() {
    return new Promise((resolve, reject) => {
        https.get('https://api.github.com/repos/genshinsim/gcsim/releases/latest', { headers: { 'User-Agent': 'gcsim-manager' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.message && json.message.includes('API rate limit')) {
                        reject(new Error('GitHub API rate limit exceeded'));
                    } else {
                        resolve(json);
                    }
                } catch(e) { reject(e); }
            });
        }).on('error', reject);
    });
}

let isUpdating = false;

// Auto-check and update on boot asynchronously
async function autoUpdateCheck() {
    try {
        const release = await fetchLatestRelease();
        const latestVersion = release.tag_name;
        if (!fs.existsSync(getGcsimPath()) || currentVersion !== latestVersion) {
            console.log(`Downloading gcsim ${latestVersion}...`);
            isUpdating = true;
            const { assetName, isWindows } = getPlatformInfo();
            const asset = release.assets.find(a => a.name === assetName);
            if (asset) {
                const dest = getGcsimPath();
                const tmpDest = dest + '.tmp';
                await downloadFile(asset.browser_download_url, tmpDest);
                
                if (fs.existsSync(dest)) fs.unlinkSync(dest);
                fs.renameSync(tmpDest, dest);
                
                if (!isWindows) {
                    fs.chmodSync(dest, 0o755); // Make executable on Linux/Mac
                }
                
                currentVersion = latestVersion;
                fs.writeFileSync(VERSION_FILE, currentVersion, 'utf8');
                console.log('gcsim downloaded successfully.');
            } else {
                console.log(`Asset ${assetName} not found in release ${latestVersion}`);
            }
            isUpdating = false;
        } else {
            console.log(`gcsim is up to date (v${currentVersion})`);
        }
    } catch (e) {
        console.error('Auto-update check failed:', e.message);
        isUpdating = false;
    }
}
autoUpdateCheck();

app.get('/api/gcsim/status', async (req, res) => {
    try {
        const release = await fetchLatestRelease();
        const latestVersion = release.tag_name;
        res.json({
            currentVersion,
            latestVersion,
            hasBinary: fs.existsSync(getGcsimPath()),
            isUpdating
        });
    } catch (e) {
        res.json({ 
            error: e.message, 
            currentVersion, 
            latestVersion: currentVersion, 
            hasBinary: fs.existsSync(getGcsimPath()), 
            isUpdating 
        });
    }
});

app.post('/api/gcsim/update', async (req, res) => {
    if (isUpdating) return res.status(400).json({ error: 'Update already in progress' });
    isUpdating = true;
    try {
        const release = await fetchLatestRelease();
        const latestVersion = release.tag_name;
        
        if (currentVersion === latestVersion && fs.existsSync(getGcsimPath())) {
            isUpdating = false;
            return res.json({ message: 'Already up to date', version: currentVersion });
        }
        
        const { assetName, isWindows } = getPlatformInfo();
        const asset = release.assets.find(a => a.name === assetName);
        if (!asset) throw new Error(`Asset ${assetName} not found in release ${latestVersion}`);
        
        const dest = getGcsimPath();
        const tmpDest = dest + '.tmp';
        await downloadFile(asset.browser_download_url, tmpDest);
        
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        fs.renameSync(tmpDest, dest);
        
        if (!isWindows) fs.chmodSync(dest, 0o755);
        
        currentVersion = latestVersion;
        fs.writeFileSync(VERSION_FILE, currentVersion, 'utf8');
        
        isUpdating = false;
        res.json({ message: 'Update successful', version: currentVersion });
    } catch (e) {
        isUpdating = false;
        res.status(500).json({ error: e.message });
    }
});


// ========== SETTINGS API ==========
function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
            return { project_name: raw.project_name || '' };
        }
    } catch (e) {
        console.error('Error loading settings:', e);
    }
    return { project_name: '' };
}

function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

app.get('/api/settings', (req, res) => {
    res.json(loadSettings());
});

app.post('/api/settings', (req, res) => {
    const settings = req.body;
    saveSettings({ project_name: settings.project_name || '' });
    res.json({ success: true });
});


// ========== PROJECTS API ==========
app.get('/api/projects', (req, res) => {
    try {
        if (fs.existsSync(PROJECTS_DIR)) {
            const projects = fs.readdirSync(PROJECTS_DIR)
                .filter(d => fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory());
            res.json(projects);
        } else {
            res.json([]);
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/projects', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Project name required' });
    const projectDir = path.join(PROJECTS_DIR, name);
    try {
        fs.mkdirSync(path.join(projectDir, 'configs'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'outputs'), { recursive: true });
        res.json({ success: true, path: projectDir });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/projects/:project/rename', (req, res) => {
    const { newName } = req.body;
    if (!newName) return res.status(400).json({ error: 'New name required' });
    const oldDir = path.join(PROJECTS_DIR, req.params.project);
    const newDir = path.join(PROJECTS_DIR, newName);
    try {
        if (!fs.existsSync(oldDir)) return res.status(404).json({ error: 'Project not found' });
        if (fs.existsSync(newDir)) return res.status(400).json({ error: 'A project with that name already exists' });
        fs.renameSync(oldDir, newDir);
        res.json({ success: true, name: newName });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/projects/:project', (req, res) => {
    const projectDir = path.join(PROJECTS_DIR, req.params.project);
    try {
        if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });
        fs.rmSync(projectDir, { recursive: true, force: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ========== CONFIGS API ==========
function getProjectPath(projectName) {
    return path.join(PROJECTS_DIR, projectName, 'configs');
}
function getSortOrderPath(configsDir) {
    return path.join(configsDir, '.sortorder.json');
}
function loadSortOrder(configsDir) {
    const sortPath = getSortOrderPath(configsDir);
    try { if (fs.existsSync(sortPath)) return JSON.parse(fs.readFileSync(sortPath, 'utf8')); } catch (e) {}
    return [];
}
function saveSortOrder(configsDir, order) {
    fs.writeFileSync(getSortOrderPath(configsDir), JSON.stringify(order, null, 2), 'utf8');
}

app.get('/api/projects/:project/configs', (req, res) => {
    const configsDir = getProjectPath(req.params.project);
    try {
        if (fs.existsSync(configsDir)) {
            var allFiles = fs.readdirSync(configsDir)
                .filter(f => f.endsWith('.txt'))
                .map(f => ({
                    name: f,
                    path: path.join(configsDir, f),
                    size: fs.statSync(path.join(configsDir, f)).size,
                    modified: fs.statSync(path.join(configsDir, f)).mtime
                }));
            
            var sortOrder = loadSortOrder(configsDir);
            let needsSave = false;

            // --- NEW AUTO-REPAIR LOGIC ---
            const actualFileNames = allFiles.map(f => f.name);
            
            // 1. Clean up deleted/renamed files from the sort list
            const initialLength = sortOrder.length;
            sortOrder = sortOrder.filter(name => actualFileNames.includes(name));
            if (sortOrder.length !== initialLength) needsSave = true;

            // 2. Add newly created files to the bottom of the sort list
            actualFileNames.forEach(name => {
                if (!sortOrder.includes(name)) {
                    sortOrder.push(name);
                    needsSave = true;
                }
            });

            // Save the repaired list
            if (needsSave) {
                saveSortOrder(configsDir, sortOrder);
            }
            // -----------------------------
            
            if (sortOrder.length > 0) {
                var orderMap = {};
                sortOrder.forEach(function(name, idx) { orderMap[name] = idx; });
                allFiles.sort(function(a, b) {
                    var ai = (orderMap[a.name] !== undefined) ? orderMap[a.name] : 999999;
                    var bi = (orderMap[b.name] !== undefined) ? orderMap[b.name] : 999999;
                    return ai - bi;
                });
            }
            res.json(allFiles);
        } else {
            res.json([]);
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:project/configs/swap', (req, res) => {
    const { nameA, nameB } = req.body;
    if (!nameA || !nameB) return res.status(400).json({ error: 'Two filenames required' });
    const configsDir = getProjectPath(req.params.project);
    const pathA = path.join(configsDir, nameA);
    const pathB = path.join(configsDir, nameB);
    
    try {
        if (!fs.existsSync(pathA) || !fs.existsSync(pathB)) return res.status(404).json({ error: 'Files not found' });
        
        var sortOrder = loadSortOrder(configsDir);
        
        // Final safety catch: ensure sortOrder is synced right before swapping
        const actualFiles = fs.readdirSync(configsDir).filter(f => f.endsWith('.txt'));
        sortOrder = sortOrder.filter(f => actualFiles.includes(f));
        actualFiles.forEach(f => { if (!sortOrder.includes(f)) sortOrder.push(f); });
        
        var idxA = sortOrder.indexOf(nameA);
        var idxB = sortOrder.indexOf(nameB);
        
        if (idxA !== -1 && idxB !== -1) {
            // Swap array items
            sortOrder[idxA] = nameB;
            sortOrder[idxB] = nameA;
            
            saveSortOrder(configsDir, sortOrder);
            return res.json({ success: true });
        }
        res.status(500).json({ error: 'Could not find files in sort order' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/projects/:project/configs/:filename', (req, res) => {
    const filePath = path.join(getProjectPath(req.params.project), req.params.filename);
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            res.json({ content, name: req.params.filename });
        } else { res.status(404).json({ error: 'File not found' }); }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:project/configs/:filename', (req, res) => {
    const filePath = path.join(getProjectPath(req.params.project), req.params.filename);
    const { content } = req.body;
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content || '', 'utf8');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/projects/:project/configs', (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'Filename required' });
    let fname = filename.endsWith('.txt') ? filename : filename + '.txt';
    const filePath = path.join(getProjectPath(req.params.project), fname);
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) return res.status(400).json({ error: 'Project does not exist' });
        if (fs.existsSync(filePath)) return res.status(400).json({ error: 'File already exists' });
        fs.writeFileSync(filePath, '', 'utf8');
        res.json({ success: true, name: fname });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:project/configs/:filename', (req, res) => {
    const filePath = path.join(getProjectPath(req.params.project), req.params.filename);
    try {
        if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); res.json({ success: true }); } 
        else res.status(404).json({ error: 'File not found' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/projects/:project/configs/:filename/rename', (req, res) => {
    const { newName } = req.body;
    if (!newName) return res.status(400).json({ error: 'New name required' });
    let newFname = newName.endsWith('.txt') ? newName : newName + '.txt';
    const oldPath = path.join(getProjectPath(req.params.project), req.params.filename);
    const newPath = path.join(getProjectPath(req.params.project), newFname);
    try {
        if (fs.existsSync(newPath)) return res.status(400).json({ error: 'File already exists' });
        if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'File not found' });
        fs.renameSync(oldPath, newPath);
        res.json({ success: true, name: newFname });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:project/configs/:filename/duplicate', (req, res) => {
    const filePath = path.join(getProjectPath(req.params.project), req.params.filename);
    try {
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
        const ext = path.extname(req.params.filename);
        const base = path.basename(req.params.filename, ext);
        let copyName = `${base}_copy${ext}`;
        let copyPath = path.join(getProjectPath(req.params.project), copyName);
        let counter = 1;
        while (fs.existsSync(copyPath)) {
            copyName = `${base}_copy_${counter}${ext}`;
            copyPath = path.join(getProjectPath(req.params.project), copyName);
            counter++;
        }
        fs.copyFileSync(filePath, copyPath);
        res.json({ success: true, name: copyName });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== EXPORT / IMPORT ==========
app.get('/api/projects/:project/export', (req, res) => {
    const configsDir = getProjectPath(req.params.project);
    try {
        if (!fs.existsSync(configsDir)) return res.status(400).json({ error: 'Project not found' });
        const files = fs.readdirSync(configsDir).filter(f => f.endsWith('.txt'));
        let exportContent = `# gcsim Config Export - Project: ${req.params.project}\n`;
        exportContent += `# Exported: ${new Date().toISOString()}\n`;
        exportContent += `# Total configs: ${files.length}\n`;
        exportContent += `# ========================================\n\n`;
        for (const file of files) {
            const content = fs.readFileSync(path.join(configsDir, file), 'utf8');
            exportContent += `# ======== START: ${file} ========\n`;
            exportContent += content;
            if (!content.endsWith('\n')) exportContent += '\n';
            exportContent += `# ======== END: ${file} ========\n\n`;
        }
        res.json({ content: exportContent, filename: `${req.params.project}_configs_export.txt` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:project/import', (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'No content provided' });
    const configsDir = getProjectPath(req.params.project);
    try {
        if (!fs.existsSync(configsDir)) return res.status(400).json({ error: 'Project not found' });
        const fileRegex = /# ======== START:\s*(.+?) ========\n([\s\S]*?)\n# ======== END:\s*\1 ========/g;
        let match;
        let imported = 0;
        let skipped = 0;
        while ((match = fileRegex.exec(content)) !== null) {
            const filename = match[1].trim();
            const fileContent = match[2];
            if (!filename.endsWith('.txt')) { skipped++; continue; }
            const filePath = path.join(configsDir, filename);
            fs.writeFileSync(filePath, fileContent, 'utf8');
            imported++;
        }
        res.json({ success: true, imported, skipped });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== SIMULATION API ==========
const runningProcesses = {};

app.post('/api/projects/:project/run', (req, res) => {
    const { filename } = req.body;
    const gcsim = getGcsimPath();
    
    if (!fs.existsSync(gcsim) || isUpdating) {
        return res.status(400).json({ error: 'Sim executable not found or downloading. Please wait and try again.' });
    }
    
    const projectDir = path.join(PROJECTS_DIR, req.params.project);
    const configsDir = path.join(projectDir, 'configs');
    const outputsDir = path.join(projectDir, 'outputs');
    if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });
    
    const runId = uuidv4();
    const filesToRun = filename 
        ? [path.join(configsDir, filename)]
        : fs.readdirSync(configsDir).filter(f => f.endsWith('.txt')).map(f => path.join(configsDir, f));
    
    if (filesToRun.length === 0) return res.status(400).json({ error: 'No config files found' });
    
    res.json({ runId, message: `Starting ${filesToRun.length} simulation(s)` });
    runSimulations(filesToRun, gcsim, outputsDir, runId, 'run');
});

app.post('/api/projects/:project/optimize', (req, res) => {
    const { filename } = req.body;
    const gcsim = getGcsimPath();
    
    if (!fs.existsSync(gcsim) || isUpdating) {
        return res.status(400).json({ error: 'Sim executable not found or downloading. Please wait and try again.' });
    }
    
    const projectDir = path.join(PROJECTS_DIR, req.params.project);
    const configsDir = path.join(projectDir, 'configs');
    const outputsDir = path.join(projectDir, 'outputs');
    if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });
    
    const runId = uuidv4();
    const filesToRun = filename 
        ? [path.join(configsDir, filename)]
        : fs.readdirSync(configsDir).filter(f => f.endsWith('.txt')).map(f => path.join(configsDir, f));
    
    if (filesToRun.length === 0) return res.status(400).json({ error: 'No config files found' });
    
    res.json({ runId, message: `Starting ${filesToRun.length} optimization(s)` });
    runSimulations(filesToRun, gcsim, outputsDir, runId, 'optimize');
});

function openUrl(url) {
    let cmd;
    if (process.platform === 'win32') {
        cmd = `start "" "${url}"`;
    } else if (process.platform === 'darwin') {
        cmd = `open "${url}"`;
    } else {
        cmd = `xdg-open "${url}"`;
    }
    exec(cmd, (err) => {
        if (err) console.error('Error opening URL:', err);
    });
}

function runSimulations(files, gcsimPath, outputsDir, runId, mode) {
    const maxWorkers = Math.max(1, os.cpus().length - 1); 
    runningProcesses[runId] = { status: 'running', current: files.length > 1 ? 'Running Multiple...' : path.basename(files[0]), log: [], mode, childProcesses: new Set() };
    
    let index = 0;
    let activeWorkers = 0;
    
    function worker() {
        if (runningProcesses[runId] && runningProcesses[runId].status === 'terminated') return;
        
        if (index >= files.length) {
            if (activeWorkers === 0 && runningProcesses[runId].status !== 'terminated') {
                runningProcesses[runId].status = 'completed';
                runningProcesses[runId].log.push(`\nAll ${mode === 'optimize' ? 'optimizations' : 'simulations'} completed\n`);
            }
            return;
        }
        
        const filePath = files[index++];
        const fileName = path.basename(filePath);
        const baseName = fileName.replace('.txt', '');
        activeWorkers++;
        
        runningProcesses[runId].log.push(`\n[${baseName}] Starting...\n`);
        
        let cmd;
        if (mode === 'optimize') {
            const optOutPath = path.join(outputsDir, `${baseName}_opt.json`);
            cmd = `"${gcsimPath}" -c "${filePath}" -out "${optOutPath}" -substatOptimFull`;
        } else {
            const outPath = path.join(outputsDir, `${baseName}.json`);
            cmd = `"${gcsimPath}" -c "${filePath}" -out "${outPath}"`;
        }
        
        const proc = exec(cmd, { timeout: 300000, maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
            if (runningProcesses[runId]) runningProcesses[runId].childProcesses.delete(proc);
            if (err) runningProcesses[runId].log.push(`\n[${baseName}] Error: ${stderr}\n`);
            else runningProcesses[runId].log.push(`\n[${baseName}] Completed\n`);
            activeWorkers--;
            worker(); 
        });

        if (runningProcesses[runId]) runningProcesses[runId].childProcesses.add(proc);

        proc.stdout.on('data', (data) => {
            const text = data.toString().split('\n').filter(l => l.trim()).map(l => `[${baseName}] ${l}\n`).join('');
            if (text && runningProcesses[runId]) runningProcesses[runId].log.push(text);
        });
        proc.stderr.on('data', (data) => {
            const text = data.toString().split('\n').filter(l => l.trim()).map(l => `[${baseName}] ${l}\n`).join('');
            if (text && runningProcesses[runId]) runningProcesses[runId].log.push(text);
        });
    }

    const concurrency = Math.min(maxWorkers, files.length);
    for (let i = 0; i < concurrency; i++) worker();
}

app.get('/api/runs/:runId', (req, res) => {
    const run = runningProcesses[req.params.runId];
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json({ status: run.status, current: run.current, mode: run.mode, log: run.log });
});
function readGcsimJson(filePath) {
    const raw = fs.readFileSync(filePath);
    try { return JSON.parse(zlib.gunzipSync(raw).toString('utf8')); } 
    catch (e) { return JSON.parse(raw.toString('utf8')); }
}

app.get('/api/projects/:project/results', (req, res) => {
    const outputsDir = path.join(PROJECTS_DIR, req.params.project, 'outputs');
    if (!fs.existsSync(outputsDir)) return res.json([]);
    
    const files = fs.readdirSync(outputsDir).filter(f => f.endsWith('.json'));
    const results = [];
    
    for (const f of files) {
        try {
            const filePath = path.join(outputsDir, f);
            const stat = fs.statSync(filePath);
            const data = readGcsimJson(filePath);
            
            results.push({
                filename: f,
                configName: f.replace('_opt.json', '').replace('.json', ''),
                mode: f.endsWith('_opt.json') ? 'Optimize' : 'Run',
                dps: data.statistics?.dps?.mean || 0,
                date: stat.mtimeMs
            });
        } catch(e) {} // Skip broken/incomplete JSON files
    }
    results.sort((a,b) => b.date - a.date); // Sort newest first
    res.json(results);
});

app.post('/api/view/:project/:filename', (req, res) => {
    const filePath = path.join(PROJECTS_DIR, req.params.project, 'outputs', req.params.filename);
    if (fs.existsSync(filePath)) {
        activeViewerFile = filePath;
        openUrl('https://gcsim.app/local');
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});
app.post('/api/runs/:runId/terminate', (req, res) => {
    const run = runningProcesses[req.params.runId];
    if (run) {
        run.status = 'terminated';
        run.log.push('\nTerminated by user\n');
        
        if (run.childProcesses) {
            run.childProcesses.forEach(proc => {
                try {
                    if (process.platform === 'win32') {
                        const pid = proc.pid;
                        if (pid) execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000 });
                    } else {
                        proc.kill('SIGKILL');
                    }
                } catch (e) {
                    try { proc.kill('SIGKILL'); } catch (e2) {}
                }
            });
            run.childProcesses.clear();
        }
    }
    res.json({ success: true });
});

// ========== OUTPUT FILES API ==========
app.get('/api/projects/:project/outputs', (req, res) => {
    const outputsDir = path.join(PROJECTS_DIR, req.params.project, 'outputs');
    try {
        if (fs.existsSync(outputsDir)) {
            const files = fs.readdirSync(outputsDir).filter(f => f.endsWith('.txt'));
            res.json(files);
        } else {
            res.json([]);
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects/:project/outputs/:filename', (req, res) => {
    const filePath = path.join(PROJECTS_DIR, req.params.project, 'outputs', req.params.filename);
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            res.json({ content, name: req.params.filename });
        } else { res.status(404).json({ error: 'File not found' }); }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
    console.log(`gcsim Manager running on http://localhost:${PORT}`);
});