const cds = require('@sap/cds');
const { SELECT } = require('@sap/cds/lib/ql/cds-ql');
const ExcelJS = require('exceljs');

module.exports = cds.service.impl(async function () {

    const { TemplateMaster, TemplateFieldMapping, FieldMaster } = cds.entities('lockbox.templatebuilder');

    // ================================================================
    // AFTER READ — compute mappingsCount virtual field
    // ================================================================
    this.after('READ', 'TemplateMaster', async (data) => {
        const rows = Array.isArray(data) ? data : (data ? [data] : []);
        if (!rows.length) return;

        const ids = rows.map(r => r.ID).filter(Boolean);
        if (!ids.length) return;

        const counts = await SELECT
            .from(TemplateFieldMapping)
            .columns('template_ID', { func: 'count', args: ['*'], as: 'count' })
            .where({ template_ID: { in: ids } })
            .groupBy('template_ID');

        const countMap = {};
        counts.forEach(c => { countMap[c.template_ID] = c.count; });

        rows.forEach(r => { r.mappingsCount = countMap[r.ID] || 0; });
    });

    // ================================================================
    // AUTO MAP STANDARD — copies standard template mappings to target
    // ================================================================
    this.on('autoMapStandard', async (req) => {
        const { targetTemplateId } = req.data;
        if (!targetTemplateId) return req.error(400, 'Target template ID is required.');

        const standardTemplate = await SELECT.one.from(TemplateMaster).where({ isStandard: true });
        if (!standardTemplate) return req.error(404, 'No standard template has been configured yet.');
        if (standardTemplate.ID === targetTemplateId) return req.error(400, 'Target template is already the standard template.');

        const standardMappings = await SELECT.from(TemplateFieldMapping).where({ template_ID: standardTemplate.ID });
        if (!standardMappings || standardMappings.length === 0) return req.error(404, 'Standard template has no mappings configured.');

        const targetMappings = await SELECT.from(TemplateFieldMapping).where({ template_ID: targetTemplateId });
        if (!targetMappings || targetMappings.length === 0) return req.error(400, 'Target template has no fields added yet. Please add fields first.');

        // Build lookup by field_ID
        const standardLookup = {};
        standardMappings.forEach(m => {
            standardLookup[m.field_ID] = {
                apiField: m.apiField,
                mappingRule: m.mappingRule,
                ruleId: m.ruleId,
                ruleName: m.ruleName,
                sequenceNo: m.sequenceNo,
                targetField: m.targetField,
            };
        });

        let mappedCount = 0;
        let sequenceCounter = 1;
        const dbUpdates = [];

        for (const targetMapping of targetMappings) {
            const match = standardLookup[targetMapping.field_ID];
            if (match) {
                dbUpdates.push(
                    UPDATE(TemplateFieldMapping).set({
                        apiField: match.apiField,
                        mappingRule: match.mappingRule,
                        ruleId: match.ruleId,
                        ruleName: match.ruleName,
                        sequenceNo: sequenceCounter++,
                        targetField: match.targetField
                    }).where({ ID: targetMapping.ID })
                );
                mappedCount++;
            }
        }

        if (dbUpdates.length > 0) {
            try {
                for (const upd of dbUpdates) await cds.run(upd);
            } catch (err) {
                console.error('AutoMap Transaction Failed:', err);
                return req.error(500, `Batch update failed: ${ err.message }`);
            }
        }

        console.log(`AutoMap Standard: ${ mappedCount } of ${ targetMappings.length } fields mapped.`);
        return true;
    });

    // ================================================================
    // AUTO MAP AI — Gemini suggests API fields for unmapped fields
    // ================================================================
    this.on('autoMapAI', async (req) => {
        const { templateId } = req.data;

        // 1. Fetch unmapped rows
        const unmappedMappings = await SELECT
            .from(TemplateFieldMapping)
            .where({ template_ID: templateId, apiField: '' })
            .columns('ID', 'field_ID');

        if (unmappedMappings.length === 0) return true;

        // 2. Fetch their FieldMaster rows — FIX: was 'filedName', correct is 'fieldName'
        const fieldIds = unmappedMappings.map(m => m.field_ID);
        const fields = await SELECT
            .from(FieldMaster)
            .where({ ID: { in: fieldIds } })
            .columns('ID', 'fieldName', 'levelName', 'description');  // FIX: fieldName not filedName

        // 3. Build field lookup — FIX: was 'filedMap', correct is 'fieldMap'
        const fieldMap = {};
        fields.forEach(f => { fieldMap[f.ID] = f; });  // FIX: was 'filedMap'

        // 4. Build prompt using description for richer context
        const fieldList = unmappedMappings.map((m, i) => {
            const f = fieldMap[m.field_ID] || {};
            return `${ i + 1 }. fieldName: ${ f.fieldName || '' }, description: ${ f.description || '' }, level: ${ f.levelName || '' }`;
        }).join('\n');

        // FIX: Updated API field list to match Excel spec exactly (31 unique values)
        const prompt = `You are an SAP ClearIQ Lockbox payment mapping assistant.
Given these source fields, suggest the most appropriate SAP ClearIQ API field for each.
Available API fields:
HEADER level: LockboxBatch, Lockbox, CompanyCode, Destination of Transmission, Source of Transmission, DepositDateTime, IncomingPaymentFile, Number of Checks in Lockbox Batch, Currency, AmountInTransactionCurrency
PAYMENT level: LockboxBatchItem, ValueDate, Cheque, PartnerBankCountry, PartnerBank, PartnerBankAccount, Customer, MemoLine1, Memo Line, PaymentAdvice, AssignmentReference, DocumentItemText, DocumentReferenceID, FiscalYear
CLEARING level: PaymentAdviceItem, PaymentAdviceAccount, PaymentAdviceAccountType, PaymentReference, NetPaymentAmountInPaytCurrency, DeductionAmountInPaytCurrency, PaymentDifferenceReason

Rules:
- Match based on the field description and level
- Only use API fields from the list above
- If no good match exists, use an empty string ""
- Respond ONLY with a JSON array, no explanation, no markdown:
[{"fieldName":"...","suggestedApiField":"..."}]

Fields to map:
${ fieldList }`;

        // 5. Call Gemini
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${ process.env.GEMINI_API_KEY }`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            }
        );

        const data = await response.json();
        let text = data.candidates[0].content.parts[0].text;
        text = text.replace(/```json|```/g, '').trim();  // FIX: was 'rerplace'
        const suggestions = JSON.parse(text);

        // 6. Build suggestion lookup — FIX: was 'suggestionsMap', correct is 'suggestionMap'
        const suggestionMap = {};
        suggestions.forEach(s => { suggestionMap[s.fieldName] = s.suggestedApiField; });  // FIX: was suggestionsMap

        // 7. Apply suggestions — FIX: entity name was 'TemplateFieldMaping' (missing p)
        for (const mapping of unmappedMappings) {
            const field = fieldMap[mapping.field_ID];
            if (field && suggestionMap[field.fieldName]) {
                await UPDATE(TemplateFieldMapping)  // FIX: use entity ref, not string
                    .set({
                        apiField: suggestionMap[field.fieldName],
                        mappingRule: 'Derived'
                    }).where({ ID: mapping.ID });
            }
        }

        return true;
    });

    // ================================================================
    // SET AS STANDARD — admin marks a template as the standard one
    // ================================================================
    this.on('setAsStandard', async (req) => {
        const { templateId } = req.data;

        if (!req.user.is('admin')) return req.error(403, 'Only admins can set the standard template.');

        const template = await SELECT.one.from(TemplateMaster).where({ ID: templateId });
        if (!template) return req.error(404, 'Template not found.');

        await UPDATE(TemplateMaster).set({ isStandard: false });
        await UPDATE(TemplateMaster).set({ isStandard: true }).where({ ID: templateId });

        return true;
    });

    // ================================================================
    // GUARD 1 — Prevent deletion of the standard template
    // ================================================================
    this.before('DELETE', 'TemplateMaster', async (req) => {
        const template = await SELECT.one.from(TemplateMaster).where({ ID: req.data.ID });
        if (template && template.isStandard) {
            return req.error(403, 'The Standard Template is a system baseline and cannot be deleted.');
        }
    });

    // ================================================================
    // GUARD 2 — Prevent non-admins from modifying standard mappings
    // ================================================================
    this.before(['UPDATE', 'DELETE'], 'TemplateFieldMapping', async (req) => {
        const mappingId = req.data.ID;
        if (!mappingId) return;

        const mapping = await SELECT.one.from(TemplateFieldMapping).where({ ID: mappingId });
        if (!mapping) return;

        const template = await SELECT.one.from(TemplateMaster).where({ ID: mapping.template_ID });
        if (!template) return;

        if (template.isStandard) {
            if (req.user && typeof req.user.is === 'function') {
                if (!req.user.is('admin')) {
                    return req.error(403, 'Only authorized administrators can modify rows belonging to the Standard Template.');
                }
            } else {
                return req.error(403, 'Admin authorization context missing. Cannot modify standard reference layout.');
            }
        }
    });

    // ================================================================
    // DOWNLOAD TEMPLATE — exports xlsx
    // ================================================================
    this.on('downloadTemplate', async (req) => {
        const { templateID, exportMode } = req.data;

        const template = await SELECT.one.from(TemplateMaster).where({ ID: templateID });
        if (!template) return req.error(404, 'Template not found.');

        const mappings = await SELECT.from(TemplateFieldMapping)
            .where({ template_ID: templateID })
            .orderBy('sequenceNo');

        if (!mappings.length) return req.error(404, 'Template has no fields configured.');

        const fieldIds = mappings.map(m => m.field_ID).filter(Boolean);
        const fields = await SELECT.from(FieldMaster).where({ ID: { in: fieldIds } });

        const fieldMap = {};
        fields.forEach(f => { fieldMap[f.ID] = f; });
        mappings.forEach(m => { m.field = fieldMap[m.field_ID] || {}; });
        template.mappings = mappings;

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
                    top: { style: 'thin', color: { argb: 'FFFFFFFF' } },
                    left: { style: 'thin', color: { argb: 'FFFFFFFF' } },
                    bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } },
                    right: { style: 'thin', color: { argb: 'FFFFFFFF' } }
                };
            });
            oSheet.columns = headers.map(h => ({ width: Math.max(h.length + 4, 15) }));
            oSheet.views = [{ state: 'frozen', ySplit: 1 }];
            return oSheet;
        };

        if (exportMode === 'SINGLE') {
            const headers = template.mappings.map(m => m.field?.fieldName).filter(Boolean);
            if (!headers.length) return req.error(404, 'No valid fields found for template.');
            createStyledSheet('Template', headers);

        } else if (exportMode === 'MULTIPLE') {
            const oGroupedData = {};
            template.mappings.forEach(m => {
                const level = m.field?.levelName || 'Unassigned';
                if (!oGroupedData[level]) oGroupedData[level] = [];
                if (m.field?.fieldName) oGroupedData[level].push(m.field.fieldName);
            });

            const levelOrder = ['HEADER', 'PAYMENT', 'CLEARING'];
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
            return req.error(400, `Invalid exportMode: "${ exportMode }". Expected "SINGLE" or "MULTIPLE"`);
        }

        const buffer = await oWorkbook.xlsx.writeBuffer();
        req._.res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        req._.res.setHeader('Content-Disposition', `attachment; filename="${ template.templateName }_Template.xlsx"`);
        return req._.res.send(buffer);
    });

}); // Closes module.exports