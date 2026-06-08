import fs from 'fs';
import path from 'path';

const dir = path.join(__dirname, '..', 'src', 'rubrics');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));

const newFmt = `## Output format

Return ONLY valid JSON. Do not include markdown codeblocks or any other text.
The JSON must strictly follow this exact structure:

{
  "score": 0, // integer 0-100
  "band": "weak", // MUST be EXACTLY ONE OF: "exceptional", "strong", "adequate", "weak", "very_weak"
  "raw_text_evidence": "...", // exact quote from text
  "weakness": "...", // weakness identified
  "confidence": "high" // "high", "medium", or "low"
}
`;

for (const f of files) {
  const p = path.join(dir, f);
  let c = fs.readFileSync(p, 'utf8');
  const idx = c.indexOf('## Output format');
  if (idx !== -1) {
    c = c.substring(0, idx) + newFmt;
    fs.writeFileSync(p, c);
    console.log('Fixed', f);
  }
}
