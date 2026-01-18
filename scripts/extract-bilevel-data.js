import { parse } from 'node-html-parser';
import fs from 'fs';

function extractData(html, seriesName) {
    const root = parse(html);
    const results = {};

    // Find all tables
    const tables = root.querySelectorAll('table');

    for (const table of tables) {
        // Find the preceding headline to determine car type
        let carType = 'Coach';
        let prev = table.previousElementSibling;
        while (prev && !['H2', 'H3'].includes(prev.tagName)) {
            prev = prev.previousElementSibling;
        }
        if (prev) {
            const headline = prev.text.toLowerCase();
            if (headline.includes('cab')) carType = 'Cab';
            else if (headline.includes('accessible')) carType = 'Accessible Coach';
            else if (headline.includes('coach')) carType = 'Coach';
        }

        const rows = table.querySelectorAll('tr');
        if (rows.length < 1) continue;

        const headers = rows[0].querySelectorAll('th').map(th => th.text.trim().toLowerCase());
        const fleetIdx = headers.findIndex(h => h.includes('fleet'));
        const dateIdx = headers.findIndex(h => h.includes('date'));
        const serialIdx = headers.findIndex(h => h.includes('serial'));
        const statusIdx = headers.findIndex(h => h.includes('status'));
        const notesIdx = headers.findIndex(h => h.includes('notes'));

        if (fleetIdx === -1) continue;

        for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length === 0) continue;

            const fleetNumber = cells[fleetIdx].text.trim();
            if (!fleetNumber) continue;

            const dateText = dateIdx !== -1 ? cells[dateIdx].text.trim() : null;
            const serialNumber = serialIdx !== -1 ? cells[serialIdx].text.trim() : null;
            const statusContent = statusIdx !== -1 ? cells[statusIdx].innerHTML : '';
            const notesContent = notesIdx !== -1 ? cells[notesIdx].innerHTML : '';

            // Clean up delivery date
            let deliveryDate = null;
            if (dateText) {
                const yearMatch = dateText.match(/\d{4}/);
                if (yearMatch) {
                    deliveryDate = `${yearMatch[0]}-01-01`;
                }
            }

            // Combine status and notes
            const notes = [];

            const processContent = (content) => {
                if (!content) return;
                // Split by <br>, <li>, <p>, <hr />
                const lines = content.split(/<br\s*\/?>|<li>|<\/li>|<p>|<\/p>|<hr\s*\/?>|<ul>|<\/ul>/i);
                for (let line of lines) {
                    line = line.replace(/<[^>]+>/g, '').trim();
                    line = line.replace(/&nbsp;/g, ' ');
                    if (line && !notes.includes(line)) {
                        notes.push(line);
                    }
                }
            };

            processContent(statusContent);
            processContent(notesContent);

            results[fleetNumber] = {
                serial_number: serialNumber || null,
                delivery_date: deliveryDate,
                notes: notes,
                series: seriesName,
                is_accessible: carType.includes('Accessible')
            };
        }
    }
    return results;
}

// Simple CLI
const filePath = process.argv[2];
const series = process.argv[3] || 'Unknown';

if (!filePath) {
    console.error("Usage: node extract.js <file.html> <Series>");
    process.exit(1);
}

const html = fs.readFileSync(filePath, 'utf8');
const data = extractData(html, series);
console.log(JSON.stringify(data, null, 2));
