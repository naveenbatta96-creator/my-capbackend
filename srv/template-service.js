const cds = require('@sap/cds');
const ExcelJS = require('exceljs');

module.exports = cds.service.impl(async function () {

    const { TemplateMaster, TemplateFieldMapping } = cds.entities('lockbox.templatebuilder');

    // ================================================================
    // AUTO MAP STANDARD — copies standard template mappings to target
    // ================================================================
    this.on('autoMapStandard', async (req) => {
        const { targetTemplateId } = req.data;

        // 1. Find the standard template
        const standardTemplate = await SELECT.one.from(TemplateMaster)
            .where({ isStandard: true });

        if (!standardTemplate) {
            return req.error(404, 'No standard template has been configured yet. Please ask your admin to set one.');
        }

        // 2. Get standard template's field mappings
        const standardMappings = await SELECT.from(TemplateFieldMapping)
            .where({ template_ID: standardTemplate.ID });

        if (!standardMappings || standardMappings.length === 0) {
            return req.error(404, 'Standard template has no mappings configured.');
        }

        // 3. Get target template's existing fields (to match by field_ID)
        const targetMappings = await SELECT.from(TemplateFieldMapping)
            .where({ template_ID: targetTemplateId });

        if (!targetMappings || targetMappings.length === 0) {
            return req.error(400, 'Target template has no fields added yet. Please add fields first.');
        }

        // 4. Build a lookup map from standard: field_ID → { apiField, mappingRule, ruleId }
        const standardLookup = {};
        standardMappings.forEach(m => {
            standardLookup[m.field_ID] = {
                apiField   : m.apiField,
                mappingRule: m.mappingRule,
                ruleId     : m.ruleId
            };
        });

        // 5. Update target mappings where field_ID matches standard
        let mappedCount = 0;
        for (const targetMapping of targetMappings) {
            const match = standardLookup[targetMapping.field_ID];
            if (match) {
                await UPDATE(TemplateFieldMapping)
                    .set({
                        apiField   : match.apiField,
                        mappingRule: match.mappingRule,
                        ruleId     : match.ruleId
                    })
                    .where({ ID: targetMapping.ID });
                mappedCount++;
            }
        }

        console.log(`Auto Map Standard: ${mappedCount} of ${targetMappings.length} fields mapped.`);
        return true;
    });

    // ================================================================
    // SET AS STANDARD — admin marks a template as the standard one
    // ================================================================
    this.on('setAsStandard', async (req) => {
        const { templateId } = req.data;

        // Optional: check admin role
         if (!req.user.is('admin')) return req.error(403, 'Only admins can set the standard template.');

        // 1. Remove isStandard from all templates
        await UPDATE(TemplateMaster).set({ isStandard: false });

        // 2. Set the selected template as standard
        await UPDATE(TemplateMaster)
            .set({ isStandard: true })
            .where({ ID: templateId });

        return true;
    });

    // ================================================================
    // GUARD — prevent non-admins from editing standard template
    // ================================================================
    // ✅ NEW — prevent anyone from deleting the standard template
this.before('DELETE', 'TemplateMaster', async (req) => {
    const template = await SELECT.one.from(TemplateMaster)
        .where({ ID: req.data.ID });

    if (template && template.isStandard) {
        return req.error(403, 'The Standard Template cannot be deleted.');
    }
});
    this.before(['UPDATE', 'DELETE'], 'TemplateFieldMapping', async (req) => {
        const mappingId = req.data.ID;
        if (!mappingId) return;

        const mapping = await SELECT.one.from(TemplateFieldMapping)
            .where({ ID: mappingId });
        if (!mapping) return;

        const template = await SELECT.one.from(TemplateMaster)
            .where({ ID: mapping.template_ID });

        if (template && template.isStandard) {
            // Optional: uncomment when auth is set up
            if (!req.user.is('admin')) {
                return req.error(403, 'Only admins can modify the Standard Template.');
            }
        }
    });

    // ================================================================
    // EXISTING — downloadTemplate handler (unchanged)
    // ================================================================
    this.on('downloadTemplate', async (req) => {
        const { templateID, exportMode } = req.data;

        const template = await SELECT.one.from('TemplateMaster')
            .where({ ID: templateID })
            .columns(t => {
                t.templateName,
                t.mappings(m => {
                    m('*'),
                    m.field(f => { f('*') })
                })
            });

        if (!template || !template.mappings || template.mappings.length === 0) {
            return req.error(404, 'Template not found or has no fields configured');
        }

        const oWorkbook = new ExcelJS.Workbook();

        const createStyledSheet = (sheetName, headers) => {
            const oSheet = oWorkbook.addWorksheet(sheetName);
            oSheet.addRow(headers);
            const headerRow = oSheet.getRow(1);
            headerRow.eachCell((cell) => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E6EBF' } };
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
                cell.alignment = { vertical: 'middle', horizontal: 'center' };
                cell.border = {
                    top:    { style: 'thin', color: { argb: 'FFFFFFFF' } },
                    left:   { style: 'thin', color: { argb: 'FFFFFFFF' } },
                    bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } },
                    right:  { style: 'thin', color: { argb: 'FFFFFFFF' } }
                };
            });
            oSheet.columns = headers.map(header => ({ width: Math.max(header.length + 4, 15) }));
            oSheet.views = [{ state: 'frozen', ySplit: 1 }];
            return oSheet;
        };

        if (exportMode === 'SINGLE') {
            const headers = template.mappings.map(m => m.field.fieldName);
            createStyledSheet('Template', headers);
        } else if (exportMode === 'MULTIPLE') {
            const oGroupedData = {};
            template.mappings.forEach(m => {
                const level = m.field.levelName || "Unassigned";
                if (!oGroupedData[level]) oGroupedData[level] = [];
                oGroupedData[level].push(m.field.fieldName);
            });
            const levelOrder = ['HEADER', 'ITEM', 'PAYMENT', 'CLEARING'];
            for (const levelName of levelOrder) {
                if (oGroupedData[levelName]) {
                    const displayName = levelName.charAt(0) + levelName.slice(1).toLowerCase();
                    createStyledSheet(displayName, oGroupedData[levelName]);
                }
            }
            Object.keys(oGroupedData).forEach(level => {
                if (!levelOrder.includes(level)) {
                    const displayName = level.charAt(0) + level.slice(1).toLowerCase();
                    createStyledSheet(displayName, oGroupedData[level]);
                }
            });
        } else {
            return req.error(400, `Invalid exportMode: "${exportMode}". Expected "SINGLE" or "MULTIPLE"`);
        }

        const buffer = await oWorkbook.xlsx.writeBuffer();
        req._.res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        req._.res.setHeader('Content-Disposition', `attachment; filename="${template.templateName}_Template.xlsx"`);
        return req._.res.send(buffer);
    });

}); // Closes module.exports