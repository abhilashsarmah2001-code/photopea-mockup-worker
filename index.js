const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '50mb' }));

const TEMPLATES = {
    A: "https://drive.google.com/uc?export=download&id=1HwQTBETW8d1UhkLcdc2Usubssjcbvge-",
    B: "https://drive.google.com/uc?export=download&id=1vLsCsc3F_2z8rwUkcRf_N9vdHJZCsQyb",
    C: "https://drive.google.com/uc?export=download&id=1ne19kNLFbVXr2sIURpdG0XSdEhYtBfFV"
};

const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-gpu'
];

async function renderTemplate(templatePsdUrl, layersToReplace, exportBoth = false) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: PUPPETEER_ARGS
        });

        const page = await browser.newPage();
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resource = req.resourceType();
            if (resource === 'font' || resource === 'stylesheet') {
                req.abort();
            } else {
                req.continue();
            }
        });

        const files = [templatePsdUrl, ...layersToReplace.map(l => l.url)];

        const script = `
            var doc = app.documents[0];
            function getLayer(container, name) {
                for (var i = 0; i < container.layers.length; i++) {
                    var l = container.layers[i];
                    if (l.name.toUpperCase() === name.toUpperCase()) return l;
                    if (l.typename === "LayerSet") {
                        var found = getLayer(l, name);
                        if (found) return found;
                    }
                }
                return null;
            }

            function replaceSmartObject(layerName, docIndex) {
                var layer = getLayer(doc, layerName);
                if (layer) {
                    doc.activeLayer = layer;
                    executeAction(stringIDToTypeID("placedLayerEditContents"));
                    var psbDoc = app.activeDocument;
                    
                    app.activeDocument = app.documents[docIndex];
                    app.activeDocument.selection.selectAll();
                    app.activeDocument.selection.copy();
                    
                    app.activeDocument = psbDoc;
                    app.activeDocument.paste();
                    psbDoc.save();
                    psbDoc.close();
                }
            }

            ${layersToReplace.map((item, idx) => `replaceSmartObject("${item.name}", ${idx + 1});`).join('\n')}

            app.activeDocument = doc;
            doc.saveToOE("png");

            if (${exportBoth}) {
                var bg = getLayer(doc, "BACKGROUND");
                if (bg) {
                    bg.visible = false;
                }
                doc.saveToOE("png");
            }
        `;

        const config = { files, script };
        const targetUrl = `https://www.photopea.com#${encodeURIComponent(JSON.stringify(config))}`;

        const results = await new Promise(async (resolve, reject) => {
            const received = [];
            const requiredCount = exportBoth ? 2 : 1;

            const timeout = setTimeout(async () => {
                reject(new Error("Photopea export timed out."));
            }, 180000);

            await page.exposeFunction('onReceiveBuffer', async (base64) => {
                received.push(base64);
                if (received.length === requiredCount) {
                    clearTimeout(timeout);
                    resolve(received);
                }
            });

            await page.evaluateOnNewDocument(() => {
                window.addEventListener("message", function(e) {
                    if (e.data instanceof ArrayBuffer) {
                        var binary = '';
                        var bytes = new Uint8Array(e.data);
                        for (var i = 0; i < bytes.byteLength; i++) {
                            binary += String.fromCharCode(bytes[i]);
                        }
                        window.onReceiveBuffer(window.btoa(binary));
                    }
                });
            });

            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 180000 });
        });

        await page.close();
        await browser.close();
        return results;

    } catch (err) {
        if (browser) await browser.close();
        throw err;
    }
}

app.get('/', (req, res) => res.send("Photopea Worker is live!"));

// Render single template endpoint
app.post('/render-single', async (req, res) => {
    const { template, frontUrl, spineUrl, backUrl } = req.body;
    
    if (!template) {
        return res.status(400).json({ error: "Missing 'template' parameter (A, B, or C)." });
    }

    try {
        console.log(`Processing Template ${template}...`);
        
        if (template === 'A') {
            const [bg, trans] = await renderTemplate(TEMPLATES.A, [
                { name: "SO_FRONT", url: frontUrl },
                { name: "SO_SPINE", url: spineUrl }
            ], true);
            return res.json({ normal: bg, transparent: trans });
        } 
        
        if (template === 'B') {
            const [bg, trans] = await renderTemplate(TEMPLATES.B, [
                { name: "SO_FRONT", url: frontUrl },
                { name: "SO_SPINE", url: spineUrl },
                { name: "SO_BACK", url: backUrl }
            ], true);
            return res.json({ normal: bg, transparent: trans });
        } 
        
        if (template === 'C') {
            const [backOnly] = await renderTemplate(TEMPLATES.C, [
                { name: "SO_BACK", url: backUrl }
            ], false);
            return res.json({ back: backOnly });
        }

        return res.status(400).json({ error: "Invalid template name. Use A, B, or C." });

    } catch (err) {
        console.error(`Error on template ${template}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker live on port ${PORT}`));
