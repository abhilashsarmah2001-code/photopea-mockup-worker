const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '100mb' }));

// Verified Direct Download PSD Links
const PSD_A = "https://drive.google.com/uc?export=download&id=1HwQTBETW8d1UhkLcdc2Usubssjcbvge-";
const PSD_B = "https://drive.google.com/uc?export=download&id=1vLsCsc3F_2z8rwUkcRf_N9vdHJZCsQyb";
const PSD_C = "https://drive.google.com/uc?export=download&id=1ne19kNLFbVXr2sIURpdG0XSdEhYtBfFV";

async function runPhotopeaExport(browser, templatePsdUrl, layersToReplace, hideBackground = false) {
    const page = await browser.newPage();
    
    // files[0] is the PSD; the rest are the cover images
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

        var bg = getLayer(doc, "BACKGROUND");
        if (bg && ${hideBackground}) {
            bg.visible = false;
        }

        app.activeDocument = doc;
        doc.saveToOE("png");
    `;

    const config = { files, script };
    const targetUrl = `https://www.photopea.com#${encodeURIComponent(JSON.stringify(config))}`;

    return new Promise(async (resolve, reject) => {
        const timeout = setTimeout(async () => {
            await page.close();
            reject(new Error("Photopea processing timed out (300s)."));
        }, 300000);

        await page.exposeFunction('onReceiveBuffer', async (base64) => {
            clearTimeout(timeout);
            await page.close();
            resolve(base64);
        });

        await page.evaluateOnNewDocument(() => {
            window.addEventListener("message", function(e) {
                if (e.data instanceof ArrayBuffer) {
                    var binary = '';
                    var bytes = new Uint8Array(e.data);
                    var len = bytes.byteLength;
                    for (var i = 0; i < len; i++) {
                        binary += String.fromCharCode(bytes[i]);
                    }
                    window.onReceiveBuffer(window.btoa(binary));
                }
            });
        });

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 300000 });
    });
}

app.post('/generate-mockups', async (req, res) => {
    const { frontUrl, spineUrl, backUrl } = req.body;
    
    if (!frontUrl || !spineUrl || !backUrl) {
        return res.status(400).json({ error: "Missing frontUrl, spineUrl, or backUrl in body." });
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        // Template A (Front + Spine)
        console.log("Generating Template A (Background)...");
        const a_normal = await runPhotopeaExport(browser, PSD_A, [
            { name: "SO_FRONT", url: frontUrl },
            { name: "SO_SPINE", url: spineUrl }
        ], false);

        console.log("Generating Template A (Transparent)...");
        const a_transparent = await runPhotopeaExport(browser, PSD_A, [
            { name: "SO_FRONT", url: frontUrl },
            { name: "SO_SPINE", url: spineUrl }
        ], true);

        // Template B (Front + Spine + Back)
        console.log("Generating Template B (Background)...");
        const b_normal = await runPhotopeaExport(browser, PSD_B, [
            { name: "SO_FRONT", url: frontUrl },
            { name: "SO_SPINE", url: spineUrl },
            { name: "SO_BACK", url: backUrl }
        ], false);

        console.log("Generating Template B (Transparent)...");
        const b_transparent = await runPhotopeaExport(browser, PSD_B, [
            { name: "SO_FRONT", url: frontUrl },
            { name: "SO_SPINE", url: spineUrl },
            { name: "SO_BACK", url: backUrl }
        ], true);

        // Template C (Back Only)
        console.log("Generating Template C...");
        const c_normal = await runPhotopeaExport(browser, PSD_C, [
            { name: "SO_BACK", url: backUrl }
        ], false);

        await browser.close();

        res.json({
            template_a_bg: a_normal,
            template_a_trans: a_transparent,
            template_b_bg: b_normal,
            template_b_trans: b_transparent,
            template_c: c_normal
        });

    } catch (err) {
        if (browser) await browser.close();
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker live on port ${PORT}`));
