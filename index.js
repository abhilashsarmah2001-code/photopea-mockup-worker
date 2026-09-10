const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PSD_A = "https://drive.google.com/uc?export=download&id=1HwQTBETW8d1UhkLcdc2Usubssjcbvge-";
const PSD_B = "https://drive.google.com/uc?export=download&id=1vLsCsc3F_2z8rwUkcRf_N9vdHJZCsQyb";
const PSD_C = "https://drive.google.com/uc?export=download&id=1ne19kNLFbVXr2sIURpdG0XSdEhYtBfFV";

const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-gpu',
    '--js-flags="--max-old-space-size=256"'
];

// Helper: processes one PSD and can export both Normal and Transparent in a single load
async function processTemplate(page, templatePsdUrl, layersToReplace, exportBoth = false) {
    const files = [templatePsdUrl, ...layersToReplace.map(l => l.url)];

    // Photopea script handles dual export if exportBoth is true
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
        // First export: Full with background
        doc.saveToOE("png");

        if (${exportBoth}) {
            var bg = getLayer(doc, "BACKGROUND");
            if (bg) {
                bg.visible = false;
            }
            // Second export: Transparent
            doc.saveToOE("png");
        }
    `;

    const config = { files, script };
    const targetUrl = `https://www.photopea.com#${encodeURIComponent(JSON.stringify(config))}`;

    return new Promise(async (resolve, reject) => {
        const receivedBuffers = [];
        const requiredCount = exportBoth ? 2 : 1;

        const timeout = setTimeout(async () => {
            reject(new Error("Photopea processing timed out on template."));
        }, 180000);

        await page.exposeFunction('onReceiveBuffer', async (base64) => {
            receivedBuffers.push(base64);
            if (receivedBuffers.length === requiredCount) {
                clearTimeout(timeout);
                resolve(receivedBuffers);
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
}

app.get('/', (req, res) => res.send("Photopea Worker is live!"));

app.post('/generate-mockups', async (req, res) => {
    const { frontUrl, spineUrl, backUrl } = req.body;
    if (!frontUrl || !spineUrl || !backUrl) {
        return res.status(400).json({ error: "Missing frontUrl, spineUrl, or backUrl in body." });
    }

    let browser;
    try {
        console.log("Launching low-memory Chrome instance...");
        browser = await puppeteer.launch({
            headless: "new",
            args: PUPPETEER_ARGS
        });

        // --- TEMPLATE A (Generates both Full & Transparent in 1 load) ---
        console.log("Processing Template A (Full & Transparent)...");
        let page = await browser.newPage();
        const [a_normal, a_transparent] = await processTemplate(page, PSD_A, [
            { name: "SO_FRONT", url: frontUrl },
            { name: "SO_SPINE", url: spineUrl }
        ], true);
        await page.goto("about:blank");
        await page.close();

        // --- TEMPLATE B (Generates both Full & Transparent in 1 load) ---
        console.log("Processing Template B (Full & Transparent)...");
        page = await browser.newPage();
        const [b_normal, b_transparent] = await processTemplate(page, PSD_B, [
            { name: "SO_FRONT", url: frontUrl },
            { name: "SO_SPINE", url: spineUrl },
            { name: "SO_BACK", url: backUrl }
        ], true);
        await page.goto("about:blank");
        await page.close();

        // --- TEMPLATE C (Straight Back) ---
        console.log("Processing Template C...");
        page = await browser.newPage();
        const [c_normal] = await processTemplate(page, PSD_C, [
            { name: "SO_BACK", url: backUrl }
        ], false);
        await page.goto("about:blank");
        await page.close();

        await browser.close();

        console.log("All 5 mockups exported successfully!");
        res.json({
            template_a_bg: a_normal,
            template_a_trans: a_transparent,
            template_b_bg: b_normal,
            template_b_trans: b_transparent,
            template_c: c_normal
        });

    } catch (err) {
        if (browser) await browser.close();
        console.error("Worker Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker live on port ${PORT}`));
