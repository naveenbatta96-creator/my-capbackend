// const cds = require('@sap/cds');
// const XLSX = require('xlsx');

// module.exports = cds.service.impl(async function() {
    
//     this.on('downloadTemplate', async (req) => {
//         const {templateID, exportMode} = req.data;
        
//         // 1. Fetch template with all mapping details
//         const template = await SELECT.one.from('TemplateMaster')
//         .where({ID : templateID})
//         .columns(t => { 
//             t.templateName, 
//             t.mappings(m => {
//                 m('*'),
//                 m.field(f => {
//                     f('*')
//                 })
//          })  
//         });

//         // 2. Validation
//         if(!template || !template.mappings) {
//             return req.error(404, 'Template not found');
//         }

//         // 3. Transform field data with all properties
//         const aExcelData = template.mappings.map(m  => {
//             return {
//                "Field Name" : m.field.fieldName,
//                "Level" : m.field.levelName,
//                "SAP Type" : m.field.sapType,
//                "Field Length" : m.field.fieldLength,
//                "Property Type" : m.field.propertyType,
//                "Is Required" : m.field.isRequired ? 'Yes' : 'No'
//             }
//         });

//         // 4. Create a new workbook
//         const oWorkbook = XLSX.utils.book_new();

//         if(exportMode === 'SINGLE') {
//             const oWorksheet = XLSX.utils.json_to_sheet(aExcelData);
//             XLSX.utils.book_append_sheet(oWorkbook, oWorksheet, 'Template');
            
//         } else if (exportMode === 'MULTIPLE') {
//             // Group data by level
//             const oGroupedData = {};
            
//             aExcelData.forEach(row => {
//                 const level = row["Level"] || "Unassigned";
                
//                 if(!oGroupedData[level]) { 
//                     oGroupedData[level] = [];
//                 }
//                 oGroupedData[level].push(row); 
//             });
            
//             // Create separate sheet for each level with proper capitalization
//             const levelOrder = ['HEADER', 'PAYMENT', 'CLEARING'];
            
//             for (const levelName of levelOrder) {
//                 if(oGroupedData[levelName]) {
//                     const oSheet = XLSX.utils.json_to_sheet(oGroupedData[levelName]);
//                     const displayName = levelName.charAt(0) + levelName.slice(1).toLowerCase();
//                     XLSX.utils.book_append_sheet(oWorkbook, oSheet, displayName);
//                 }
//             }
//         }

//         // 5. Convert to binary and send to browser
//         const buffer = XLSX.write(oWorkbook, { type : 'buffer', bookType : 'xlsx'});

//         // Set response headers for file download
//         req._.res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
//         req._.res.setHeader('Content-Disposition', `attachment; filename="${template.templateName}_Configuration.xlsx"`);
        
//         return req._.res.send(buffer);
        
//     }); // <-- Closes this.on

// }); // <-- Closes module.exports

const cds = require('@sap/cds');
const ExcelJS = require('exceljs');

module.exports = cds.service.impl(async function() {

    this.on('downloadTemplate', async (req) => {
        const { templateID, exportMode } = req.data;

        // 1. Fetch template with only the selected/mapped fields
        const template = await SELECT.one.from('TemplateMaster')
            .where({ ID: templateID })
            .columns(t => {
                t.templateName,
                t.mappings(m => {
                    m('*'),
                    m.field(f => {
                        f('*')
                    })
                })
            });

        // 2. Validation
        if (!template || !template.mappings || template.mappings.length === 0) {
            return req.error(404, 'Template not found or has no fields configured');
        }

        // 3. Create workbook
        const oWorkbook = new ExcelJS.Workbook();

        // ✅ Reusable function to create a styled sheet
        const createStyledSheet = (sheetName, headers) => {
            const oSheet = oWorkbook.addWorksheet(sheetName);

            // Add header row
            oSheet.addRow(headers);

            // Style the header row
            const headerRow = oSheet.getRow(1);
            headerRow.eachCell((cell) => {
                // Blue background
                cell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FF1E6EBF' } // Blue color
                };
                // White bold text
                cell.font = {
                    bold: true,
                    color: { argb: 'FFFFFFFF' },
                    size: 11
                };
                // Center align
                cell.alignment = {
                    vertical: 'middle',
                    horizontal: 'center'
                };
                // Border
                cell.border = {
                    top:    { style: 'thin', color: { argb: 'FFFFFFFF' } },
                    left:   { style: 'thin', color: { argb: 'FFFFFFFF' } },
                    bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } },
                    right:  { style: 'thin', color: { argb: 'FFFFFFFF' } }
                };
            });

            // Auto-fit column widths based on header text length
            oSheet.columns = headers.map(header => ({
                width: Math.max(header.length + 4, 15)
            }));

            // Freeze the header row so it stays visible while scrolling
            oSheet.views = [{ state: 'frozen', ySplit: 1 }];

            return oSheet;
        };

        // 4. SINGLE mode — all selected fields as columns in one sheet
        if (exportMode === 'SINGLE') {

            const headers = template.mappings.map(m => m.field.fieldName);
            createStyledSheet('Template', headers);

        // 5. MULTIPLE mode — sheets divided by level
        } else if (exportMode === 'MULTIPLE') {

            // Group selected fields by their level
            const oGroupedData = {};

            template.mappings.forEach(m => {
                const level = m.field.levelName || "Unassigned";
                if (!oGroupedData[level]) {
                    oGroupedData[level] = [];
                }
                oGroupedData[level].push(m.field.fieldName);
            });

            // Maintain consistent sheet order
            const levelOrder = ['HEADER', 'ITEM', 'PAYMENT', 'CLEARING'];

            for (const levelName of levelOrder) {
                if (oGroupedData[levelName]) {
                    const displayName = levelName.charAt(0) + levelName.slice(1).toLowerCase();
                    createStyledSheet(displayName, oGroupedData[levelName]);
                }
            }

            // Handle any levels outside the standard order
            Object.keys(oGroupedData).forEach(level => {
                if (!levelOrder.includes(level)) {
                    const displayName = level.charAt(0) + level.slice(1).toLowerCase();
                    createStyledSheet(displayName, oGroupedData[level]);
                }
            });

        } else {
            return req.error(400, `Invalid exportMode: "${exportMode}". Expected "SINGLE" or "MULTIPLE"`);
        }

        // 6. Write buffer and send to browser
        const buffer = await oWorkbook.xlsx.writeBuffer();

        req._.res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        req._.res.setHeader('Content-Disposition', `attachment; filename="${template.templateName}_Template.xlsx"`);

        return req._.res.send(buffer);

    }); // Closes this.on('downloadTemplate')

}); // Closes module.exports